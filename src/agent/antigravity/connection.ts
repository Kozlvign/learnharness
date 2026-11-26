/** Antigravity connection state: whether agy is installed and its LearnHarness
 * profile signed in, which models the account offers, the managed runtime's
 * download, Google sign-in, and the background-use consent.
 *
 * agy keeps its own credentials in the profile; nothing here reads them.
 * Sign-in runs agy's own `agy acp --login`: it prints Google's sign-in link,
 * and the learner pastes back the code Google's page shows.
 *
 * Starting agy is never part of a fast path. The last probe is cached on disk
 * (`state.json`), so the model catalog is ready at startup; a probe runs on
 * the first use without a cache, on Check again, and after sign-in or install. */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { emit } from "../../core/events.ts";
import type { AntigravityAccount, AntigravityInstall, AntigravityLogin, AntigravityManaged, AntigravityModelSummary, AntigravityStatus } from "../../core/contracts/antigravity.ts";
import type { AdmissionScope } from "../subscription-request-cycle.ts";
import { AcpError, authenticate, initialize, isSignInRequired, startAgy, type AcpProcess } from "./acp-client.ts";
import { antigravityDir, removeConversationFiles, runtimeDir, workspaceDir } from "./environment.ts";
import { compareVersions, displayVersion, findAntigravityExecutable, versionSupported, type AntigravityExecutable } from "./executable.ts";
import { fetchLatestRelease, installRelease, isMusl, managedRuntime, releaseTarget, removeManagedRuntime, type FetchLike, type ReleaseAsset } from "./release.ts";
import { closeAllSessions, pauseAllSessions } from "./session.ts";

const LOGIN_WINDOW_MS = 10 * 60_000;
const LATEST_TTL_MS = 6 * 60 * 60_000;
const PROGRESS_EMIT_MS = 300;
/** agy calls it Orchestrator: a planner paired with an executor for coding work. */
const ORCHESTRATOR = /(^|[-_])orchestrator($|[-_])/i;

/** A model as the probe found it; the catalog builds pi models from these. */
export interface AntigravityModelInfo extends AntigravityModelSummary { contextWindow?: number }

interface Cache {
	executable: string;
	version: string | null;
	connected: boolean;
	account: AntigravityAccount | null;
	models: AntigravityModelInfo[];
	checkedAt: number;
}

interface LoginFlow { process: AcpProcess; redirectUri?: string; state?: string; email?: string; cancelled: boolean; timer: ReturnType<typeof setTimeout> }

interface State {
	status: AntigravityStatus;
	models: AntigravityModelInfo[];
	executable?: AntigravityExecutable;
	probing?: Promise<AntigravityStatus>;
	listeners: Set<() => void>;
	controllers: Map<AbortController, { background: boolean }>;
	/** Changes when the account or availability changes; admission scopes pin it. */
	epoch: number;
	contextWindows: Map<string, number>;
	install?: AbortController;
	login?: LoginFlow;
	latest?: { asset: ReleaseAsset | null; at: number };
	lastEmit: number;
}

const KEY = Symbol.for("lh.antigravity");
const probingEnabled = () => process.env.NODE_ENV !== "test" || process.env.LH_ANTIGRAVITY_PROBE === "1";

function state(): State {
	const global = globalThis as typeof globalThis & { [KEY]?: State };
	if (global[KEY]) return global[KEY]!;
	const s: State = { status: initialStatus(), models: [], listeners: new Set(), controllers: new Map(), epoch: 1, contextWindows: new Map(), lastEmit: 0 };
	const cache = probingEnabled() ? readCache() : undefined;
	if (cache && s.status.state === "connected") {
		s.models = cache.models;
		for (const model of cache.models) if (model.contextWindow) s.contextWindows.set(model.id, model.contextWindow);
	}
	return global[KEY] = s;
}

function emptyManaged(): AntigravityManaged {
	const supported = releaseTarget(process.platform, process.arch, isMusl()) !== null;
	return { supported, installed: managedRuntime(runtimeDir())?.version ?? null, latest: null };
}

/** From the disk cache when it still describes the executable found now. */
function initialStatus(): AntigravityStatus {
	const base: AntigravityStatus = {
		state: "checking", connected: false, version: null, executable: null, source: null, account: null, models: [],
		allowBackgroundUse: readConsent(), managed: { supported: true, installed: null, latest: null }, install: null, login: null, checkedAt: null, revision: 0,
	};
	if (!probingEnabled()) return base;
	const executable = findAntigravityExecutable();
	const managed = emptyManaged();
	if (!executable) return { ...base, managed, state: "missing", checkedAt: Date.now() };
	const cache = readCache();
	if (!cache || cache.executable !== executable.path) return { ...base, managed, executable: executable.path, source: executable.source };
	return {
		...base, managed, executable: executable.path, source: executable.source, version: cache.version, account: cache.account,
		state: cache.connected ? "connected" : "signed-out", connected: cache.connected,
		models: cache.connected ? cache.models.map(summary) : [], checkedAt: cache.checkedAt,
	};
}

function summary(model: AntigravityModelInfo): AntigravityModelSummary { return { id: model.id, name: model.name, levels: model.levels }; }

function settingsFile(): string { return path.join(antigravityDir(), "settings.json"); }
function cacheFile(): string { return path.join(antigravityDir(), "state.json"); }

function writeJson(file: string, value: unknown): void {
	mkdirSync(path.dirname(file), { recursive: true });
	const temp = `${file}.${process.pid}.tmp`;
	writeFileSync(temp, `${JSON.stringify(value, null, "\t")}\n`, { mode: 0o600 });
	renameSync(temp, file);
}

function readConsent(): boolean {
	try { return (JSON.parse(readFileSync(settingsFile(), "utf8")) as { allowBackgroundUse?: unknown }).allowBackgroundUse !== false; }
	catch { return true; }
}

function readCache(): Cache | undefined {
	try {
		const value = JSON.parse(readFileSync(cacheFile(), "utf8")) as Cache;
		return typeof value.executable === "string" && Array.isArray(value.models) ? value : undefined;
	} catch { return undefined; }
}

function saveCache(): void {
	const s = state();
	if (!probingEnabled() || !s.status.executable) return;
	try {
		writeJson(cacheFile(), {
			executable: s.status.executable, version: s.status.version, connected: s.status.connected, account: s.status.account,
			models: s.models.map((model) => ({ ...model, ...(s.contextWindows.get(model.id) ? { contextWindow: s.contextWindows.get(model.id) } : {}) })),
			checkedAt: s.status.checkedAt ?? Date.now(),
		} satisfies Cache);
	} catch { /* the cache only speeds up startup */ }
}

function update(patch: Partial<AntigravityStatus>, quiet = false): void {
	const s = state();
	const before = s.status;
	s.status = { ...before, ...patch, revision: before.revision + 1 };
	if (before.connected !== s.status.connected || before.account?.email !== s.status.account?.email) s.epoch++;
	for (const listener of s.listeners) {
		try { listener(); } catch { /* a listener must not break the others */ }
	}
	const now = Date.now();
	if (quiet && now - s.lastEmit < PROGRESS_EMIT_MS) return;
	s.lastEmit = now;
	emit("subscriptions-changed", {});
}

export function onAntigravityChange(listener: () => void): () => void {
	const s = state();
	s.listeners.add(listener);
	return () => { s.listeners.delete(listener); };
}

/** The current snapshot, without side effects. */
export function antigravityStatus(): AntigravityStatus { return state().status; }
/** The snapshot for the settings UI. Probes only when nothing was ever checked. */
export function antigravityStatusForDisplay(): AntigravityStatus {
	const s = state();
	if (s.status.checkedAt === null && !s.probing) void refreshAntigravity();
	return s.status;
}
export function antigravityConnected(): boolean { return antigravityStatus().connected; }
export function antigravityModelInfos(): AntigravityModelInfo[] { return state().models; }
export function antigravityExecutable(): AntigravityExecutable | undefined {
	const s = state();
	return s.executable ??= probingEnabled() ? findAntigravityExecutable() : undefined;
}
export function antigravityBackgroundAllowed(): boolean { return state().status.allowBackgroundUse; }
export function antigravityContextWindow(model: string): number | undefined { return state().contextWindows.get(model); }
export function rememberAntigravityContextWindow(model: string, size: number): void {
	if (size > 0 && state().contextWindows.get(model) !== size) { state().contextWindows.set(model, size); saveCache(); }
}

/** Waits for an in-flight or first probe. Never probes again on its own. */
export async function ensureAntigravityStatus(): Promise<AntigravityStatus> {
	const s = state();
	if (s.probing) return s.probing;
	if (s.status.checkedAt === null) return refreshAntigravity();
	return s.status;
}

interface ConfigOption { id: string; category?: string; currentValue?: unknown; options?: Array<{ value?: string; name?: string; options?: Array<{ value?: string; name?: string }> }> }
function choices(option: ConfigOption | undefined): Array<{ value: string; name: string }> {
	return (option?.options ?? []).flatMap((entry) => entry.value !== undefined ? [{ value: entry.value, name: entry.name ?? entry.value }]
		: (entry.options ?? []).flatMap((inner) => inner.value !== undefined ? [{ value: inner.value, name: inner.name ?? inner.value }] : []));
}

/** Each model's thinking levels and window, read from a session without a
 * model request: agy reports them for the selected model only. */
async function probeModels(process_: AcpProcess): Promise<AntigravityModelInfo[]> {
	let size: number | undefined;
	process_.onNotification = (method, params) => {
		const update = params.update as { sessionUpdate?: string; size?: unknown } | undefined;
		if (method === "session/update" && update?.sessionUpdate === "usage_update" && typeof update.size === "number") size = update.size;
	};
	const created = await process_.request<{ sessionId?: string; configOptions?: ConfigOption[] }>("session/new", { cwd: workspaceDir(), mcpServers: [] }, 90_000);
	const sessionId = String(created?.sessionId ?? "");
	try {
		// The window of the default model arrives just after the session opens.
		await new Promise((resolve) => setTimeout(resolve, 200));
		const modelOption = created?.configOptions?.find((option) => option.id === "model" || option.category === "model");
		if (!modelOption) return [];
		const levelsOf = (options: ConfigOption[] | undefined) => choices(options?.find((option) => option.category === "thought_level")).map((choice) => choice.value);
		const models: AntigravityModelInfo[] = [];
		let levels = levelsOf(created.configOptions);
		let current = typeof modelOption.currentValue === "string" ? modelOption.currentValue : undefined;
		for (const choice of choices(modelOption)) {
			if (ORCHESTRATOR.test(choice.value) || /^orchestrator\b/i.test(choice.name)) continue;
			if (choice.value !== current) {
				const result = await process_.request<{ configOptions?: ConfigOption[] } | null>("session/set_config_option", { sessionId, configId: modelOption.id, value: choice.value }, 30_000);
				levels = levelsOf(result?.configOptions);
				current = choice.value;
				// agy reports a changed window right after the switch.
				await new Promise((resolve) => setTimeout(resolve, 200));
			}
			models.push({ id: choice.value, name: choice.name, levels, ...(size ? { contextWindow: size } : {}) });
		}
		return models;
	} finally {
		if (sessionId) void process_.exited.then(() => removeConversationFiles(sessionId));
	}
}

export function refreshAntigravity(): Promise<AntigravityStatus> {
	const s = state();
	if (s.probing) return s.probing;
	s.probing = (async () => {
		// Tests never start the real CLI unless they opt in.
		if (!probingEnabled()) {
			update({ state: "missing", connected: false, version: null, executable: null, source: null, account: null, models: [], error: undefined, checkedAt: Date.now() });
			return s.status;
		}
		// Google's manifest answers on its own time; the newest version shows when it arrives.
		void refreshLatest();
		const executable = findAntigravityExecutable();
		s.executable = executable;
		const managed = { ...emptyManaged(), latest: s.status.managed.latest };
		if (!executable) {
			s.models = [];
			update({ state: "missing", connected: false, version: null, executable: null, source: null, account: null, models: [], managed, error: undefined, checkedAt: Date.now() });
			return s.status;
		}
		const base = { executable: executable.path, source: executable.source, managed };
		let process_: AcpProcess | undefined;
		try {
			const started = await startAgy({ executable, mcp: null, cwd: workspaceDir() }, async (agy) => {
				const init = await initialize(agy);
				if (!versionSupported(init.agentInfo?.version)) return { init, outcome: "outdated" as const };
				try { return { init, outcome: "connected" as const, plan: (await authenticate(agy)).plan }; }
				catch (error) { if (isSignInRequired(error)) return { init, outcome: "signed-out" as const }; throw error; }
			});
			process_ = started.process;
			const { init, outcome } = started.value;
			const version = displayVersion(init.agentInfo?.version) ?? executable.version ?? null;
			if (outcome === "outdated") {
				s.models = [];
				update({ ...base, state: "outdated", connected: false, version, models: [], error: undefined, checkedAt: Date.now() });
				return s.status;
			}
			if (outcome === "signed-out") {
				s.models = [];
				update({ ...base, state: "signed-out", connected: false, version, account: null, models: [], error: undefined, checkedAt: Date.now() });
				saveCache();
				return s.status;
			}
			const plan = started.value.plan;
			const models = await probeModels(process_);
			s.models = models;
			for (const model of models) if (model.contextWindow) s.contextWindows.set(model.id, model.contextWindow);
			const email = s.status.account?.email;
			update({
				...base, state: "connected", connected: true, version, account: { ...(email ? { email } : {}), ...(plan ? { plan } : {}) },
				models: models.map(summary), login: null, error: undefined, checkedAt: Date.now(),
			});
			saveCache();
		} catch (error) {
			if (isSignInRequired(error)) {
				s.models = [];
				update({ ...base, state: "signed-out", connected: false, account: null, models: [], error: undefined, checkedAt: Date.now() });
			} else update({ ...base, state: "error", connected: false, error: probeError(error), checkedAt: Date.now() });
		} finally {
			process_?.kill();
		}
		return s.status;
	})().finally(() => { s.probing = undefined; });
	return s.probing;
}

function probeError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	if (/could not be started|ENOENT|EACCES/i.test(message)) return "Antigravity could not be started. Reinstall it or check its path.";
	if (error instanceof AcpError && /in time/.test(message)) return "Antigravity did not respond in time. Check this computer's network connection, then try again.";
	return "Antigravity did not respond. Check that it runs in a terminal (agy --version), then try again.";
}

// ─── Managed runtime ───────────────────────────────────────────────────────

type ReleaseSource = { latest: () => Promise<ReleaseAsset | null>; fetch?: FetchLike };
let releaseSource: ReleaseSource | undefined;
/** Tests: a local release instead of Google's manifest. */
export function setAntigravityReleaseForTests(next: ReleaseSource | undefined): void { releaseSource = next; }
function latestRelease(): Promise<ReleaseAsset | null> { return releaseSource ? releaseSource.latest() : fetchLatestRelease(); }

/** Checks Google's manifest at most every few hours; explicit checks refresh it. */
async function refreshLatest(force = true): Promise<ReleaseAsset | null> {
	const s = state();
	if (!force && s.latest && Date.now() - s.latest.at < LATEST_TTL_MS) return s.latest.asset;
	const asset = await latestRelease().catch(() => null);
	if (asset || !s.latest) s.latest = { asset, at: Date.now() };
	const latestVersion = s.latest.asset?.version ?? null;
	if (latestVersion !== s.status.managed.latest) update({ managed: { ...s.status.managed, latest: latestVersion } });
	return s.latest.asset;
}

function setInstall(install: AntigravityInstall | null, quiet = false): void { update({ install }, quiet); }

/** Downloads (or updates) Google's runtime into LearnHarness's folder. */
export function installAntigravity(): void {
	const s = state();
	if (s.install) return;
	const controller = new AbortController();
	s.install = controller;
	setInstall({ phase: "downloading", version: null, downloadedBytes: 0, totalBytes: null, message: null });
	void (async () => {
		try {
			const asset = await refreshLatest(true);
			if (!asset) throw new Error(releaseTarget(process.platform, process.arch, isMusl()) ? "Could not find Google's Antigravity release. Check the network connection and try again." : "Google does not publish an Antigravity runtime for this computer.");
			if (controller.signal.aborted) throw new DOMException("cancelled", "AbortError");
			const installed = await installRelease(asset, {
				root: runtimeDir(), signal: controller.signal, ...(releaseSource?.fetch ? { fetch: releaseSource.fetch } : {}),
				onProgress: (progress) => setInstall({ phase: progress.phase, version: asset.version, downloadedBytes: progress.downloadedBytes, totalBytes: progress.totalBytes, message: null }, progress.phase === "downloading"),
			});
			s.install = undefined;
			update({ install: { phase: "succeeded", version: installed.version, downloadedBytes: 0, totalBytes: null, message: null }, managed: { ...s.status.managed, installed: installed.version } });
			await refreshAntigravity();
		} catch (error) {
			const cancelled = controller.signal.aborted;
			s.install = undefined;
			setInstall({
				phase: cancelled ? "cancelled" : "failed", version: null, downloadedBytes: 0, totalBytes: null,
				message: cancelled ? "Installation cancelled. Nothing was changed." : error instanceof Error && error.message && !/fetch failed|network/i.test(error.message) ? error.message : "The download failed. Check the network connection and try again.",
			});
		} finally {
			if (s.install === controller) s.install = undefined;
		}
	})();
}

export function cancelAntigravityInstall(): void { state().install?.abort(); }

/** Deletes the downloaded runtime. Sessions on it pause first; their
 * conversations stay in the profile and resume with another runtime. */
export async function removeAntigravityRuntime(): Promise<void> {
	if (state().install) throw new Error("Wait for the installation to finish.");
	if (state().executable?.source === "managed") await pauseAllSessions();
	removeManagedRuntime(runtimeDir());
	update({ install: null, managed: { ...state().status.managed, installed: null } });
	await refreshAntigravity();
}

/** A managed runtime older than Google's latest. */
export function antigravityUpdateAvailable(status: AntigravityStatus = antigravityStatus()): boolean {
	return status.source === "managed" && !!status.managed.latest && !!status.managed.installed && compareVersions(status.managed.latest, status.managed.installed) > 0;
}

// ─── Consent and admission ─────────────────────────────────────────────────

export function setAntigravityConsent(enabled: boolean): void {
	writeJson(settingsFile(), { allowBackgroundUse: enabled });
	const s = state();
	if (!enabled) for (const [controller, meta] of s.controllers) if (meta.background) controller.abort("background");
	update({ allowBackgroundUse: enabled });
}

/** Revoking background consent aborts in-flight background requests. */
export function antigravityAbortController(background: boolean): { controller: AbortController; release: () => void } {
	const s = state();
	const controller = new AbortController();
	s.controllers.set(controller, { background });
	return { controller, release: () => { s.controllers.delete(controller); } };
}

/** Admission scope for the shared request cycle. */
export function antigravityAdmissionScope(selectedModelId: string): AdmissionScope {
	const s = state();
	return { accountId: s.status.account?.email ?? ANTIGRAVITY_ACCOUNT, epoch: s.epoch, authorityRevision: s.epoch, selectedModelId };
}
const ANTIGRAVITY_ACCOUNT = "antigravity";
export function antigravityScopeCurrent(scope: AdmissionScope): boolean {
	const s = state();
	return s.status.connected && scope.epoch === s.epoch && scope.accountId === (s.status.account?.email ?? ANTIGRAVITY_ACCOUNT);
}

/** A request found the sign-in gone (expired or revoked). */
export function markAntigravitySignedOut(): void {
	const s = state();
	if (!s.status.connected) return;
	s.models = [];
	update({ state: "signed-out", connected: false, models: [], checkedAt: Date.now() });
	saveCache();
}

// ─── Sign-in ───────────────────────────────────────────────────────────────

const CODE_REDIRECT = "https://antigravity.google/oauth-callback";

/** The Google link `agy acp --login` printed, when it is the expected kind. */
export function parseSignInUrl(line: string): { url: string; redirectUri: string; state: string } | undefined {
	if (line.length > 16_384 || /\s/.test(line)) return undefined;
	let url: URL;
	try { url = new URL(line); } catch { return undefined; }
	const state_ = url.searchParams.get("state"), redirect = url.searchParams.get("redirect_uri");
	if (url.origin !== "https://accounts.google.com" || url.pathname !== "/o/oauth2/auth" || url.username || url.password || url.hash) return undefined;
	if (url.searchParams.get("response_type") !== "code" || !state_ || state_.length > 512 || redirect !== CODE_REDIRECT) return undefined;
	return { url: line, redirectUri: redirect, state: state_ };
}

/** What may be typed into `--login`: the code Google's page shows, or that
 * page's full URL answering this sign-in. Undefined for anything else. */
export function signInResponse(flow: { redirectUri?: string; state?: string }, response: string): string | undefined {
	const value = response.trim();
	if (/^[\w./~-]{1,2048}$/.test(value)) return value;
	if (value.length > 16_384 || /\s/.test(value) || !flow.redirectUri) return undefined;
	let url: URL;
	try { url = new URL(value); } catch { return undefined; }
	if (`${url.origin}${url.pathname}` !== flow.redirectUri || url.username || url.password) return undefined;
	if (url.searchParams.get("state") !== flow.state || !url.searchParams.get("code")) return undefined;
	return value;
}

function setLogin(login: AntigravityLogin | null): void { update({ login }); }

/** Starts Google sign-in in this computer's profile. */
export async function startAntigravityLogin(): Promise<void> {
	const s = state();
	if (s.login && !s.login.cancelled) return;
	const executable = s.executable ?? findAntigravityExecutable();
	if (!executable) throw new Error("Antigravity is not installed.");
	setLogin({ phase: "starting", url: null, message: null });
	let process_: AcpProcess;
	try { process_ = (await startAgy({ executable, mcp: null, cwd: workspaceDir(), login: true })).process; }
	catch (error) { setLogin({ phase: "failed", url: null, message: "Antigravity sign-in could not start. Try again." }); throw error; }
	const flow: LoginFlow = {
		process: process_, cancelled: false,
		timer: setTimeout(() => { flow.cancelled = true; process_.kill(); setLogin({ phase: "failed", url: null, message: "Google sign-in expired. Start sign-in again." }); }, LOGIN_WINDOW_MS),
	};
	s.login = flow;
	const watch = setInterval(() => {
		for (const line of process_.textLines.splice(0)) {
			const link = line.startsWith("https://accounts.google.com/") ? parseSignInUrl(line) : undefined;
			if (link && !flow.state) { flow.redirectUri = link.redirectUri; flow.state = link.state; setLogin({ phase: "waiting", url: link.url, message: null }); }
			const signedIn = /^Logged in as (\S+@\S+?)\.?$/.exec(line);
			if (signedIn) flow.email = signedIn[1];
		}
	}, 100);
	void process_.exited.then(async ({ code }) => {
		clearInterval(watch);
		for (const line of process_.textLines.splice(0)) { const signedIn = /^Logged in as (\S+@\S+?)\.?$/.exec(line); if (signedIn) flow.email = signedIn[1]; }
		clearTimeout(flow.timer);
		if (s.login === flow) s.login = undefined;
		if (flow.cancelled) return;
		if (code !== 0) { setLogin({ phase: "failed", url: null, message: "Google sign-in did not finish. Start sign-in again." }); return; }
		const previous = s.status.account?.email;
		// Another account's sessions must not continue in this one.
		if (!previous || previous !== flow.email) await closeAllSessions();
		update({ account: flow.email ? { email: flow.email } : null, login: { phase: "verifying", url: null, message: null } });
		await refreshAntigravity();
		if (!s.status.connected) setLogin({ phase: "failed", url: null, message: "Antigravity is still not signed in. Start sign-in again." });
		else setLogin(null);
	});
}

/** Sends the pasted code (or page URL) to the waiting sign-in. */
export function submitAntigravityLoginCode(code: string): void {
	const flow = state().login;
	if (!flow || !flow.state) throw new Error("Start sign-in first, then paste the code.");
	const response = signInResponse(flow, code);
	if (!response) throw new Error("Paste the code from Google's page, or that page's full address.");
	flow.process.type(response);
	setLogin({ phase: "verifying", url: null, message: null });
}

export function cancelAntigravityLogin(): void {
	const flow = state().login;
	if (!flow) { if (state().status.login) setLogin(null); return; }
	flow.cancelled = true;
	clearTimeout(flow.timer);
	flow.process.kill();
	state().login = undefined;
	setLogin(null);
}

/** Signs this profile out of Google with agy's own sign-out. */
export async function logoutAntigravity(): Promise<void> {
	const s = state();
	cancelAntigravityLogin();
	const executable = s.executable ?? findAntigravityExecutable();
	if (!executable) throw new Error("Antigravity is not installed.");
	await closeAllSessions();
	const { process: process_, value: init } = await startAgy({ executable, mcp: null, cwd: workspaceDir() }, initialize);
	try {
		if (!init.agentCapabilities?.auth?.logout) throw new Error("This Antigravity version cannot sign out. Update it.");
		await process_.request("logout", {}, 60_000);
	} finally { process_.kill(); }
	s.models = [];
	update({ state: "signed-out", connected: false, account: null, models: [], login: null, checkedAt: Date.now() });
	saveCache();
}

/** Tests: install a fixed state instead of probing the CLI; undefined resets. */
export function setAntigravityStateForTests(next: { status?: Partial<AntigravityStatus>; models?: AntigravityModelInfo[]; executable?: AntigravityExecutable } | undefined): void {
	const global = globalThis as typeof globalThis & { [KEY]?: State };
	const previous = global[KEY];
	previous?.login?.process.kill();
	previous?.install?.abort();
	delete global[KEY];
	if (!next) return;
	const s = state();
	s.models = next.models ?? [];
	for (const model of s.models) if (model.contextWindow) s.contextWindows.set(model.id, model.contextWindow);
	s.executable = next.executable;
	s.status = { ...s.status, checkedAt: Date.now(), models: s.models.map(summary), ...next.status };
}
