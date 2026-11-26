/** The Agent Client Protocol over stdio: newline-delimited JSON-RPC 2.0 with
 * one `agy acp` process. LearnHarness is the client; agy is the agent.
 *
 * Every agy process starts through `startAgy`, one at a time: agy reads the
 * profile's MCP config once, when `authenticate` signs it in, so the file is
 * written for this process, and the next process waits until this one has
 * signed in (and, with tools, connected to its endpoint). */
import { spawn } from "node:child_process";
import packageJson from "../../../package.json";
import { AGENT_NAME, antigravityEnv, APP_DATA_DIR, prepareProfile, processTempDir, profileDir, writeMcpConfig, type McpEntry } from "./environment.ts";
import type { AntigravityExecutable } from "./executable.ts";

export class AcpError extends Error {
	constructor(readonly code: number, message: string, readonly data?: unknown) { super(message); }
}
/** The process ended while a request was open. */
export const PROCESS_EXITED = -32099;

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer?: ReturnType<typeof setTimeout> };
type RequestHandler = (method: string, params: Record<string, unknown>) => Promise<unknown>;
type NotificationHandler = (method: string, params: Record<string, unknown>) => void;

const MAX_LINE = 64 * 1024 * 1024;

export class AcpProcess {
	onNotification: NotificationHandler = () => {};
	onRequest: RequestHandler = async (method) => { throw new AcpError(-32601, `${method} is not supported by LearnHarness.`); };
	readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
	stderrTail = "";
	/** Lines on stdout that were not JSON-RPC (sign-in prints its link this way). */
	readonly textLines: string[] = [];
	closed = false;
	private nextId = 0;
	private readonly pending = new Map<number, Pending>();
	private buffer = "";

	constructor(private readonly child: ReturnType<typeof spawn>, cleanup?: () => void) {
		child.stdout!.setEncoding("utf8");
		child.stdout!.on("data", (chunk: string) => this.receive(chunk));
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => { this.stderrTail = (this.stderrTail + chunk).slice(-4000); });
		child.stdin!.on("error", () => { /* the process went away; exit handling reports it */ });
		this.exited = new Promise((resolve) => {
			let done = false;
			const finish = (code: number | null, signal: NodeJS.Signals | null, reason?: string) => {
				if (done) return;
				done = true;
				this.closed = true;
				const message = reason ?? (this.stderrTail.trim().split("\n").filter(Boolean).at(-1) || `Antigravity stopped${code !== null ? ` (exit code ${code})` : signal ? ` (${signal})` : ""}.`);
				for (const [id, pending] of this.pending) { if (pending.timer) clearTimeout(pending.timer); pending.reject(new AcpError(PROCESS_EXITED, message)); this.pending.delete(id); }
				try { cleanup?.(); } catch { /* best effort */ }
				resolve({ code, signal });
			};
			child.once("exit", (code, signal) => finish(code, signal));
			child.once("error", (error) => finish(null, null, /ENOENT|EACCES/i.test(error.message) ? "Antigravity could not be started. Reinstall it or check its path." : error.message));
		});
	}

	get pid(): number | undefined { return this.child.pid; }

	private receive(chunk: string): void {
		this.buffer += chunk;
		if (this.buffer.length > MAX_LINE) { this.buffer = ""; this.kill(); return; }
		let index: number;
		while ((index = this.buffer.indexOf("\n")) >= 0) {
			const line = this.buffer.slice(0, index).trim();
			this.buffer = this.buffer.slice(index + 1);
			if (!line) continue;
			let message: Record<string, unknown>;
			try { message = JSON.parse(line) as Record<string, unknown>; }
			catch { this.textLines.push(line); if (this.textLines.length > 50) this.textLines.shift(); continue; }
			this.dispatch(message);
		}
	}

	private dispatch(message: Record<string, unknown>): void {
		const id = message.id as number | string | undefined;
		const method = typeof message.method === "string" ? message.method : undefined;
		if (!method && id !== undefined) {
			const pending = this.pending.get(id as number);
			if (!pending) return;
			this.pending.delete(id as number);
			if (pending.timer) clearTimeout(pending.timer);
			const error = message.error as { code?: number; message?: string; data?: unknown } | undefined;
			if (error) pending.reject(new AcpError(typeof error.code === "number" ? error.code : -32603, String(error.message ?? "Antigravity reported an error."), error.data));
			else pending.resolve(message.result);
			return;
		}
		if (!method) return;
		const params = (message.params && typeof message.params === "object" ? message.params : {}) as Record<string, unknown>;
		if (id === undefined) {
			try { this.onNotification(method, params); } catch { /* a handler must not break the stream */ }
			return;
		}
		void this.onRequest(method, params).then(
			(result) => this.write({ jsonrpc: "2.0", id, result: result ?? null }),
			(error: unknown) => this.write({ jsonrpc: "2.0", id, error: { code: error instanceof AcpError ? error.code : -32603, message: error instanceof Error ? error.message : "Request failed." } }),
		);
	}

	private write(message: unknown): void {
		if (this.closed) return;
		try { this.child.stdin!.write(`${JSON.stringify(message)}\n`); } catch { /* exit handling reports it */ }
	}

	request<T = unknown>(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<T> {
		if (this.closed) return Promise.reject(new AcpError(PROCESS_EXITED, "Antigravity is not running."));
		const id = ++this.nextId;
		return new Promise<T>((resolve, reject) => {
			const pending: Pending = { resolve: resolve as (value: unknown) => void, reject };
			if (timeoutMs) pending.timer = setTimeout(() => { this.pending.delete(id); reject(new AcpError(-32001, `Antigravity did not answer ${method} in time.`)); }, timeoutMs);
			this.pending.set(id, pending);
			this.write({ jsonrpc: "2.0", id, method, params });
		});
	}

	notify(method: string, params: Record<string, unknown>): void { this.write({ jsonrpc: "2.0", method, params }); }

	/** Writes a line to stdin as typed text (the sign-in code). */
	type(text: string): void { if (!this.closed) try { this.child.stdin!.write(`${text}\n`); } catch { /* gone */ } }

	kill(): void {
		if (this.closed) return;
		try { this.child.kill(); } catch { /* already gone */ }
	}
}

export interface StartOptions {
	executable: AntigravityExecutable;
	/** The MCP server this process uses, or null for none. */
	mcp: McpEntry | null;
	cwd: string;
	/** `--login` instead of an agent session. */
	login?: boolean;
}

/** Tests replace the process start (executable + args + env). */
export type Spawner = (file: string, args: string[], options: { cwd: string; env: Record<string, string> }) => ReturnType<typeof spawn>;
let spawner: Spawner | undefined;
export function setAntigravitySpawnerForTests(next: Spawner | undefined): void { spawner = next; }

let chain: Promise<unknown> = Promise.resolve();
const CONNECT_WAIT_MS = 20_000;

export function agyArgs(login = false): string[] {
	return ["acp", "--gemini-dir", profileDir(), "--app-data-dir", APP_DATA_DIR, ...(login ? ["--login"] : ["--agent", AGENT_NAME])];
}

/** Starts one agy process and runs `ready` on it (the handshake), one process
 * at a time (see the module comment). A failed `ready` stops the process. */
export function startAgy<T = undefined>(options: StartOptions, ready?: (process: AcpProcess) => Promise<T>): Promise<{ process: AcpProcess; value: T }> {
	const run = async (): Promise<{ process: AcpProcess; value: T }> => {
		prepareProfile();
		writeMcpConfig(options.mcp);
		const temp = processTempDir();
		const env = antigravityEnv(temp.dir);
		if (options.login) {
			// Without a display it prints the link instead of opening a browser here.
			delete env.DISPLAY; delete env.WAYLAND_DISPLAY;
		}
		const args = agyArgs(options.login);
		const [file, argv] = options.executable.script ? [process.execPath, [options.executable.path, ...args]] : [options.executable.path, args];
		const child = spawner ? spawner(file, argv, { cwd: options.cwd, env }) : spawn(file, argv, { cwd: options.cwd, env: env as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
		const process_ = new AcpProcess(child, temp.remove);
		try {
			const value = ready ? await ready(process_) : undefined as T;
			return { process: process_, value };
		} catch (error) {
			process_.kill();
			throw error;
		}
	};
	const result = chain.then(run, run);
	chain = result.catch(() => {});
	return result;
}

/** Waits until a signed-in process has connected to its tool endpoint. */
export async function waitForTools(process_: AcpProcess, connected: Promise<void>): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const outcome = await Promise.race([
		connected.then(() => "connected" as const),
		process_.exited.then(() => "exited" as const),
		new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), CONNECT_WAIT_MS); }),
	]);
	clearTimeout(timer);
	if (outcome === "connected") return;
	throw new AcpError(PROCESS_EXITED, outcome === "exited" ? (process_.stderrTail.trim().split("\n").filter(Boolean).at(-1) || "Antigravity stopped while starting.") : "Antigravity did not connect to LearnHarness's tools.");
}

export interface InitializeResult {
	protocolVersion?: number;
	agentInfo?: { name?: string; version?: string };
	agentCapabilities?: { auth?: { logout?: unknown }; _meta?: { antigravity?: { systemPrompt?: { append?: boolean } } }; promptCapabilities?: { image?: boolean } };
	authMethods?: Array<{ id: string }>;
}

export function initialize(process_: AcpProcess): Promise<InitializeResult> {
	return process_.request<InitializeResult>("initialize", {
		protocolVersion: 1,
		clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
		clientInfo: { name: "learnharness", title: "LearnHarness", version: packageJson.version },
	}, 90_000);
}

/** The plan name Google reports (e.g. "Google AI Pro"), when signed in. */
export async function authenticate(process_: AcpProcess): Promise<{ plan?: string }> {
	const result = await process_.request<{ _meta?: { antigravity?: { tier?: { name?: string } } } } | null>("authenticate", { methodId: "oauth-personal" }, 60_000);
	const plan = result?._meta?.antigravity?.tier?.name;
	return typeof plan === "string" && plan.trim() ? { plan: plan.trim() } : {};
}

/** No stored sign-in: agy asks for `--login` (it believes it runs over SSH) or
 * reports that authentication is required. */
export function isSignInRequired(error: unknown): boolean {
	return error instanceof AcpError && (error.code === -32000 || (error.code === -32603 && /No browser is available|agy acp --login|not logged in|Authentication required/i.test(error.message)));
}
