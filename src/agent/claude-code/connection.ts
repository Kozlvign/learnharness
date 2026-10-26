/** Claude connection state: whether Claude Code is installed and signed in,
 * which models the account offers, plan usage, and the background-use
 * consent. Claude Code keeps its own credentials; nothing here reads them.
 * Sign-in runs Claude Code's own `claude auth login` in a terminal window. */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ModelInfo, SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";
import { PATHS } from "../../../config.ts";
import { emit } from "../../core/events.ts";
import type { ClaudeCodeAccount, ClaudeCodeStatus, ClaudeCodeUsageWindow } from "../../core/contracts/claude-code.ts";
import type { AdmissionScope } from "../subscription-request-cycle.ts";
import { claudeCodeEnv } from "./environment.ts";
import { findClaudeExecutable, runClaude, type ClaudeExecutable } from "./executable.ts";

const STATUS_TTL_MS = 5 * 60_000;
const LOGIN_POLL_MS = 3_000;
const LOGIN_WINDOW_MS = 10 * 60_000;

interface State {
	status: ClaudeCodeStatus;
	models: ModelInfo[];
	executable?: ClaudeExecutable;
	probing?: Promise<ClaudeCodeStatus>;
	listeners: Set<() => void>;
	controllers: Map<AbortController, { background: boolean }>;
	loginTimer?: ReturnType<typeof setInterval>;
	/** Changes when the account or availability changes; admission scopes pin it. */
	epoch: number;
	contextWindows: Map<string, number>;
}

const KEY = Symbol.for("lh.claudeCode");
function state(): State {
	const global = globalThis as typeof globalThis & { [KEY]?: State };
	return global[KEY] ??= {
		status: {
			state: "checking", connected: false, version: null, executable: null, account: null, models: [],
			allowBackgroundUse: readConsent(), usage: [], loginPending: false, checkedAt: null, revision: 0,
		},
		models: [],
		listeners: new Set(),
		controllers: new Map(),
		epoch: 1,
		contextWindows: new Map(),
	};
}

export function claudeCodeDir(): string { return path.join(PATHS.data, "claude-code"); }
function settingsFile(): string { return path.join(claudeCodeDir(), "settings.json"); }

function readConsent(): boolean {
	try {
		const value = JSON.parse(readFileSync(settingsFile(), "utf8")) as { allowBackgroundUse?: unknown };
		return value.allowBackgroundUse !== false;
	} catch { return true; }
}
function writeConsent(enabled: boolean): void {
	mkdirSync(claudeCodeDir(), { recursive: true });
	const file = settingsFile(), temp = `${file}.${process.pid}.tmp`;
	writeFileSync(temp, JSON.stringify({ allowBackgroundUse: enabled }, null, "\t") + "\n", { mode: 0o600 });
	renameSync(temp, file);
}

function update(patch: Partial<ClaudeCodeStatus>): void {
	const s = state();
	const before = s.status;
	s.status = { ...before, ...patch, revision: before.revision + 1 };
	if (before.connected !== s.status.connected || before.account?.email !== s.status.account?.email) s.epoch++;
	for (const listener of s.listeners) {
		try { listener(); } catch { /* a listener must not break the others */ }
	}
	emit("subscriptions-changed", {});
}

export function onClaudeCodeChange(listener: () => void): () => void {
	const s = state();
	s.listeners.add(listener);
	return () => { s.listeners.delete(listener); };
}

/** The current snapshot, without side effects. */
export function claudeCodeStatus(): ClaudeCodeStatus { return state().status; }
function stale(s: State): boolean { return s.status.checkedAt === null || Date.now() - s.status.checkedAt > STATUS_TTL_MS; }
/** The snapshot for the settings UI; refreshes a stale one in the background. */
export function claudeCodeStatusForDisplay(): ClaudeCodeStatus {
	const s = state();
	if (stale(s) && !s.probing) void refreshClaudeCode();
	return s.status;
}
export function claudeCodeConnected(): boolean { return claudeCodeStatus().connected; }
export function claudeCodeModelInfos(): ModelInfo[] { return state().models; }
export function claudeCodeExecutable(): ClaudeExecutable | undefined { return state().executable; }
export function claudeCodeBackgroundAllowed(): boolean { return state().status.allowBackgroundUse; }
export function claudeCodeContextWindow(model: string): number | undefined { return state().contextWindows.get(model); }
export function rememberClaudeCodeContextWindow(model: string, contextWindow: number): void {
	if (contextWindow > 0) state().contextWindows.set(model, contextWindow);
}

/** Waits for an in-flight or first probe; a stale one refreshes in the background. */
export async function ensureClaudeCodeStatus(): Promise<ClaudeCodeStatus> {
	const s = state();
	if (s.probing) return s.probing;
	if (s.status.checkedAt === null) return refreshClaudeCode();
	if (stale(s)) void refreshClaudeCode();
	return s.status;
}

interface AuthStatus { loggedIn?: boolean; authMethod?: string; subscriptionType?: string; email?: string; orgName?: string; apiProvider?: string }

function planName(value: string | undefined): string | undefined {
	if (!value) return undefined;
	if (/^claude /i.test(value)) return value;
	return `Claude ${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

/** Reads the account and model list from an initialized, idle session. The
 * prompt never yields, so no model request is made. */
async function probeSession(executable: ClaudeExecutable, env: Record<string, string>): Promise<{ models: ModelInfo[]; account: Record<string, unknown> }> {
	const { query } = await import("@anthropic-ai/claude-agent-sdk");
	const abort = new AbortController();
	const idle = (async function* () { await new Promise<void>((resolve) => abort.signal.addEventListener("abort", () => resolve())); })();
	mkdirSync(claudeCodeDir(), { recursive: true });
	const session = query({
		prompt: idle as AsyncIterable<never>,
		options: {
			pathToClaudeCodeExecutable: executable.path,
			...(executable.script ? { executable: "node" as const } : {}),
			abortController: abort, persistSession: false, settingSources: [], tools: [], mcpServers: {}, strictMcpConfig: true,
			cwd: claudeCodeDir(), env, stderr: () => {},
		},
	});
	const timer = setTimeout(() => abort.abort(), 30_000);
	try {
		const init = await session.initializationResult();
		return { models: init.models ?? [], account: (init.account ?? {}) as Record<string, unknown> };
	} finally {
		clearTimeout(timer);
		abort.abort();
		session.close();
	}
}

export function refreshClaudeCode(): Promise<ClaudeCodeStatus> {
	const s = state();
	if (s.probing) return s.probing;
	s.probing = (async () => {
		// Tests never start the real CLI unless they opt in.
		if (process.env.NODE_ENV === "test" && process.env.LH_CLAUDE_CODE_PROBE !== "1") {
			update({ state: "missing", connected: false, version: null, executable: null, account: null, models: [], error: undefined, checkedAt: Date.now() });
			return s.status;
		}
		const executable = findClaudeExecutable();
		s.executable = executable;
		if (!executable) {
			s.models = [];
			update({ state: "missing", connected: false, version: null, executable: null, account: null, models: [], error: undefined, checkedAt: Date.now() });
			return s.status;
		}
		const env = claudeCodeEnv();
		try {
			const [versionText, authText, session] = await Promise.all([
				runClaude(executable, ["--version"], env).catch(() => ""),
				runClaude(executable, ["auth", "status", "--json"], env).catch(() => ""),
				probeSession(executable, env),
			]);
			let auth: AuthStatus = {};
			try { auth = JSON.parse(authText) as AuthStatus; } catch { /* older CLI: rely on the session account */ }
			const sessionAccount = session.account as { email?: string; organization?: string; subscriptionType?: string; tokenSource?: string; apiKeySource?: string };
			const loggedIn = auth.loggedIn ?? Boolean(sessionAccount.email || sessionAccount.subscriptionType || sessionAccount.tokenSource);
			const apiBilling = auth.authMethod ? auth.authMethod !== "claude.ai" && auth.authMethod !== "oauth_token" : Boolean(sessionAccount.apiKeySource && !sessionAccount.subscriptionType);
			const account: ClaudeCodeAccount | null = loggedIn ? {
				email: auth.email ?? sessionAccount.email,
				organization: auth.orgName ?? sessionAccount.organization,
				plan: apiBilling ? "API usage billing" : planName(sessionAccount.subscriptionType ?? auth.subscriptionType),
				apiBilling,
			} : null;
			s.models = session.models.filter((model) => model.value !== "default");
			const version = versionText.trim().split(/\s+/)[0] || null;
			update({
				state: loggedIn ? "connected" : "signed-out", connected: loggedIn, version, executable: executable.path, account,
				models: s.models.map((model) => ({ id: model.value, name: model.displayName, description: model.description })),
				loginPending: loggedIn ? false : s.status.loginPending, error: undefined, checkedAt: Date.now(),
			});
		} catch (error) {
			update({ state: "error", connected: false, executable: executable.path, error: probeError(error), checkedAt: Date.now() });
		}
		return s.status;
	})().finally(() => { s.probing = undefined; });
	return s.probing;
}

function probeError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	if (/ENOENT|not found/i.test(message)) return "Claude Code could not be started. Reinstall it or check its path.";
	return "Claude Code did not respond. Check that it runs in a terminal (claude --version), then retry.";
}

export function setClaudeCodeConsent(enabled: boolean): void {
	writeConsent(enabled);
	const s = state();
	if (!enabled) for (const [controller, meta] of s.controllers) if (meta.background) controller.abort("background");
	update({ allowBackgroundUse: enabled });
}

/** Revoking background consent aborts in-flight background requests. */
export function claudeCodeAbortController(background: boolean): { controller: AbortController; release: () => void } {
	const s = state();
	const controller = new AbortController();
	s.controllers.set(controller, { background });
	return { controller, release: () => { s.controllers.delete(controller); } };
}

export function recordClaudeCodeRateLimit(info: SDKRateLimitInfo): void {
	if (!info.rateLimitType) return;
	const window: ClaudeCodeUsageWindow = {
		kind: info.rateLimitType,
		utilization: typeof info.utilization === "number" ? info.utilization : null,
		resetsAt: typeof info.resetsAt === "number" ? info.resetsAt * 1000 : null,
		status: info.status,
	};
	const usage = [...state().status.usage.filter((entry) => entry.kind !== window.kind), window].sort((a, b) => a.kind.localeCompare(b.kind));
	update({ usage });
}

/** Admission scope for the shared request cycle. */
export function claudeCodeAdmissionScope(selectedModelId: string): AdmissionScope {
	const s = state();
	return { accountId: s.status.account?.email ?? "claude-code", epoch: s.epoch, authorityRevision: s.epoch, selectedModelId };
}
export function claudeCodeScopeCurrent(scope: AdmissionScope): boolean {
	const s = state();
	return s.status.connected && scope.epoch === s.epoch && scope.accountId === (s.status.account?.email ?? "claude-code");
}

/** Opens a terminal running Claude Code's own sign-in, then watches for it to finish. */
export async function startClaudeCodeLogin(): Promise<void> {
	const s = state();
	const executable = s.executable ?? findClaudeExecutable();
	if (!executable) throw new Error("Claude Code is not installed.");
	openLoginTerminal(executable);
	update({ loginPending: true, error: undefined });
	if (s.loginTimer) clearInterval(s.loginTimer);
	const started = Date.now();
	s.loginTimer = setInterval(() => {
		void refreshClaudeCode().then((status) => {
			if (status.connected || Date.now() - started > LOGIN_WINDOW_MS) {
				clearInterval(s.loginTimer); s.loginTimer = undefined;
				if (state().status.loginPending) update({ loginPending: false });
			}
		});
	}, LOGIN_POLL_MS);
}

function openLoginTerminal(executable: ClaudeExecutable): void {
	const command = executable.script ? ["node", executable.path] : [executable.path];
	const options = { detached: true, stdio: "ignore" as const, env: claudeCodeEnv() as NodeJS.ProcessEnv, cwd: claudeCodeDir() };
	mkdirSync(claudeCodeDir(), { recursive: true });
	let child: ChildProcess;
	if (process.platform === "win32") {
		// A detached console process gets its own window; /k keeps it open so
		// the user can read the result.
		child = spawn(process.env.ComSpec || "cmd.exe", ["/d", "/k", ...command, "auth", "login"], { ...options, windowsHide: false });
	} else if (process.platform === "darwin") {
		const line = [...command, "auth", "login"].map((part) => `'${part.replace(/'/g, `'\\''`)}'`).join(" ");
		child = spawn("osascript", ["-e", `tell application "Terminal" to do script "${line.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`, "-e", 'tell application "Terminal" to activate'], options);
	} else {
		child = spawn("x-terminal-emulator", ["-e", ...command, "auth", "login"], options);
	}
	child.on("error", () => update({ loginPending: false, error: "A terminal could not be opened. Run `claude auth login` yourself, then select Check again." }));
	child.unref();
}

/** Tests: install a fixed state instead of probing the CLI; undefined resets. */
export function setClaudeCodeStateForTests(next: { status?: Partial<ClaudeCodeStatus>; models?: ModelInfo[]; executable?: ClaudeExecutable } | undefined): void {
	const global = globalThis as typeof globalThis & { [KEY]?: State };
	delete global[KEY];
	if (!next) return;
	const s = state();
	s.models = next.models ?? [];
	s.executable = next.executable;
	s.status = { ...s.status, checkedAt: Date.now(), ...next.status };
}
