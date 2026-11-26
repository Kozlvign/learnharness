/** Where Antigravity's files live and what its processes see.
 *
 * agy runs with a profile only LearnHarness uses (`GEMINI_HOME` and
 * `--gemini-dir`), so its sign-in, settings, MCP servers and conversations never
 * touch the user's own `~/.gemini`. The profile's "global" config holds the one
 * agent LearnHarness runs (no built-in tools) and, for each process at start,
 * the MCP server that process talks to. */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PATHS } from "../../../config.ts";
import { AUTH_PROVIDER_ENV_VARS } from "../../core/auth-keys.ts";

export const AGENT_NAME = "learnharness";
/** The server name agy gives LearnHarness's tools: they appear as `mcp_lh_<tool>`. */
export const TOOL_SERVER = "lh";

export function antigravityDir(): string { return path.join(PATHS.data, "antigravity"); }
export function profileDir(): string { return path.join(antigravityDir(), "profile"); }
export function workspaceDir(): string { return path.join(antigravityDir(), "workspace"); }
export function runtimeDir(): string { return path.join(antigravityDir(), "runtime"); }
function tempRoot(): string { return path.join(antigravityDir(), "tmp"); }
/** agy keeps its sign-in, logs and conversations here, beneath the profile. */
export const APP_DATA_DIR = "antigravity-acp";

/** Removed so agy uses its own Google sign-in, never a key or project
 * LearnHarness or the shell put into its environment. */
const REMOVED = new Set([
	"GEMINI_API_KEY",
	"GOOGLE_API_KEY",
	"GOOGLE_APPLICATION_CREDENTIALS",
	"GOOGLE_CLOUD_PROJECT",
	"GOOGLE_CLOUD_LOCATION",
	"GOOGLE_CLOUD_QUOTA_PROJECT",
	"GOOGLE_GENAI_USE_VERTEXAI",
	"GCLOUD_PROJECT",
	"CLOUDSDK_CORE_PROJECT",
	"GEMINI_HOME",
	"BROWSER",
	"PYTHONUNBUFFERED",
	"ELECTRON_RUN_AS_NODE",
	"NODE_OPTIONS",
	// An inherited pipe whose owner exited makes child processes print Crashpad errors.
	"CHROME_CRASHPAD_PIPE_NAME",
]);
const PROVIDER_KEYS = new Set([...AUTH_PROVIDER_ENV_VARS].map((name) => name.toUpperCase()));

/** The environment of one agy process. `temp` is that process's own temporary folder. */
export function antigravityEnv(temp: string, source: Record<string, string | undefined> = process.env, platform: NodeJS.Platform = process.platform): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [name, value] of Object.entries(source)) {
		if (value === undefined) continue;
		const upper = name.toUpperCase();
		// LH_* includes the desktop API secret; provider keys are LearnHarness's.
		if (upper.startsWith("LH_") || upper.startsWith("AGY_") || REMOVED.has(upper) || PROVIDER_KEYS.has(upper)) continue;
		env[name] = value;
	}
	env.GEMINI_HOME = profileDir();
	env.AGY_ACP_FORCE_FILE_STORAGE = "1";
	// LearnHarness installs updates itself; agy's troubleshooting docs specify "true".
	env.AGY_CLI_DISABLE_AUTO_UPDATE = "true";
	// agy 1.5 keeps Google sign-ins in one OS keyring entry shared by every
	// profile unless it believes it runs over SSH. Then it stores this profile's
	// sign-in in the profile and signs in with `--login` (a pasted code).
	env.SSH_CONNECTION = source.SSH_CONNECTION || "127.0.0.1 0 127.0.0.1 0";
	if (platform === "win32") { env.TEMP = temp; env.TMP = temp; }
	else env.TMPDIR = temp;
	return env;
}

let swept = false;
/** A temporary folder for one agy process, removed when it exits. Leftovers
 * from processes that were killed are removed the first time one is made. */
export function processTempDir(): { dir: string; remove: () => void } {
	const root = tempRoot();
	mkdirSync(root, { recursive: true, mode: 0o700 });
	if (!swept) {
		swept = true;
		for (const name of safeList(root)) if (name.startsWith("run-")) rmSync(path.join(root, name), { recursive: true, force: true, maxRetries: 2 });
	}
	const dir = mkdtempSync(path.join(root, "run-"));
	return { dir, remove: () => { try { rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* swept next time */ } } };
}

function safeList(dir: string): string[] { try { return readdirSync(dir); } catch { return []; } }

function writeIfChanged(file: string, content: string): void {
	try { if (readFileSync(file, "utf8") === content) return; } catch { /* absent */ }
	mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const temp = `${file}.${process.pid}.tmp`;
	writeFileSync(temp, content, { mode: 0o600 });
	renameSync(temp, file);
}

/** The one agent LearnHarness runs: no built-in tools (`tools: []`). Each
 * session appends LearnHarness's own system prompt to it. */
const AGENT_FILE = `---
name: ${AGENT_NAME}
description: LearnHarness's agent. Its instructions and tools come from LearnHarness.
mainAgent: true
subagent: false
tools: []
---
You are running inside LearnHarness, a learning app. The instructions that follow are your system prompt for this conversation: follow them exactly, and use only the tools they give you.
`;

/** Creates the profile, workspace and agent definition. Idempotent. */
export function prepareProfile(): void {
	for (const dir of [profileDir(), path.join(profileDir(), "config"), workspaceDir()]) mkdirSync(dir, { recursive: true, mode: 0o700 });
	writeIfChanged(path.join(profileDir(), "config", "agents", AGENT_NAME, "agent.md"), AGENT_FILE);
}

export interface McpEntry { url: string; token: string; tools: string[] }

/** The MCP server the next agy process connects to. agy reads this file once,
 * when it starts, and honors `timeoutSeconds` only here: servers passed over
 * ACP are cut off after 3 minutes, and a question can wait longer than that
 * for the learner. `null` writes no server (probes and sign-in). */
export function writeMcpConfig(entry: McpEntry | null): void {
	const servers = entry ? {
		[TOOL_SERVER]: {
			serverUrl: entry.url,
			headers: { Authorization: `Bearer ${entry.token}` },
			timeoutSeconds: -1,
			// Eager tools are declared to the model directly. Lazy ones would need
			// built-in file tools this agent does not have.
			tools: Object.fromEntries(entry.tools.map((name) => [name, { eager: true }])),
		},
	} : {};
	writeIfChanged(path.join(profileDir(), "config", "mcp_config.json"), `${JSON.stringify({ mcpServers: servers }, null, "\t")}\n`);
}

/** Removes the files agy keeps for a conversation (probe sessions). */
export function removeConversationFiles(sessionId: string): void {
	if (!/^[\w-]{8,80}$/.test(sessionId)) return;
	const base = path.join(profileDir(), APP_DATA_DIR);
	for (const target of [path.join(base, "conversations", `${sessionId}.db`), path.join(base, "brain", sessionId), path.join(base, "annotations", `${sessionId}.pbtxt`)]) {
		try { rmSync(target, { recursive: true, force: true }); } catch { /* best effort */ }
	}
}
