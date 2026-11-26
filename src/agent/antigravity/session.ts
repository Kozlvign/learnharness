/** Live Antigravity sessions for the bridge. Each session is one `agy acp`
 * process with one ACP session, running LearnHarness's agent (no built-in
 * tools) with LearnHarness's system prompt appended and LearnHarness's tools
 * on its own MCP endpoint. A tool call is held open until the agent loop
 * delivers its result, so a whole lesson runs as one native Antigravity
 * conversation: questions wait for the learner's answer as their result. */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Tool } from "@earendil-works/pi-ai";
import { onGracefulShutdown } from "../graceful-shutdown.ts";
import { AcpError, authenticate, initialize, isSignInRequired, startAgy, waitForTools, type AcpProcess } from "./acp-client.ts";
import { antigravityDir, TOOL_SERVER, workspaceDir } from "./environment.ts";
import { versionSupported, type AntigravityExecutable } from "./executable.ts";
import { cleanArguments, openToolEndpoint, type ToolCallRequest, type ToolEndpoint } from "./tool-bridge.ts";
import type { AcpContent } from "./transcript.ts";

/** A small async FIFO. `nextWithin` waits a bounded time without consuming on timeout. */
export class AsyncQueue<T> {
	private items: T[] = [];
	private waiters: Array<(result: IteratorResult<T>) => void> = [];
	private done = false;
	push(item: T): void {
		if (this.done) return;
		const waiter = this.waiters.shift();
		if (waiter) waiter({ value: item, done: false });
		else this.items.push(item);
	}
	/** Puts an item back at the front. */
	unshift(item: T): void { if (!this.done) this.items.unshift(item); }
	close(): void {
		this.done = true;
		for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
	}
	next(): Promise<IteratorResult<T>> {
		if (this.items.length) return Promise.resolve({ value: this.items.shift()!, done: false });
		if (this.done) return Promise.resolve({ value: undefined, done: true });
		return new Promise((resolve) => this.waiters.push(resolve));
	}
	nextWithin(ms: number): Promise<IteratorResult<T> | undefined> {
		if (this.items.length || this.done) return this.next();
		return new Promise((resolve) => {
			const waiter = (result: IteratorResult<T>) => { clearTimeout(timer); resolve(result); };
			const timer = setTimeout(() => { this.waiters = this.waiters.filter((entry) => entry !== waiter); resolve(undefined); }, ms);
			this.waiters.push(waiter);
		});
	}
}

export const TOOL_PREFIX = `mcp_${TOOL_SERVER}_`;
const MAX_LIVE = 6;
/** Idle sessions close after this; they resume from disk when needed. */
const IDLE_MS = 10 * 60_000;
/** Sessions waiting on the learner (a posed question) stay open longer. */
const AWAITING_IDLE_MS = 3 * 60 * 60_000;
const MAX_RECORDS = 200;

export interface PromptUsage { inputTokens?: number; outputTokens?: number; cachedReadTokens?: number; cachedWriteTokens?: number; thoughtTokens?: number; totalTokens?: number }

export type AgyEvent =
	| { type: "text"; text: string }
	| { type: "thought"; text: string }
	/** After each model call: the conversation's size, and the model's window. */
	| { type: "usage"; used: number; size?: number }
	| { type: "tool"; id: string; name: string; args: Record<string, unknown> }
	| { type: "end"; stopReason: string; usage?: PromptUsage }
	| { type: "error"; error: Error };

export type SessionErrorKind = "outdated" | "signed-out" | "unavailable" | "failed";
export class SessionError extends Error {
	constructor(readonly kind: SessionErrorKind, message: string) { super(message); }
}

export interface SessionConfig {
	executable: AntigravityExecutable;
	/** agy's model value, e.g. "gemini-4-neon". */
	model: string;
	/** agy's thinking level, e.g. "high"; undefined keeps the model's own. */
	level?: string;
	systemPrompt: string;
	systemKey: string;
	tools: Tool[];
	toolsKey: string;
	persist: boolean;
	/** The chat id the agent passed, when it passed one. */
	tag?: string;
	/** Resume this agy session instead of starting one. */
	resume?: string;
}

interface ConfigOption { id: string; category?: string; currentValue?: unknown; options?: Array<{ value?: string; options?: Array<{ value?: string }> }> }

function optionValues(option: ConfigOption | undefined): string[] {
	return (option?.options ?? []).flatMap((entry) => entry.value !== undefined ? [entry.value] : (entry.options ?? []).flatMap((inner) => inner.value !== undefined ? [inner.value] : []));
}

/** Arguments compared regardless of key order. */
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
	return JSON.stringify(value ?? null);
}

const CANCELLED: CallToolResult = { content: [{ type: "text", text: "Cancelled." }], isError: true };

export class LiveSession {
	/** agy's session id; known once started. */
	sessionId = "";
	/** Fingerprints of the conversation messages this agy session has seen. */
	known: string[] = [];
	/** Tool calls handed to the agent loop and not answered yet. */
	readonly awaiting = new Set<string>();
	/** Calls from a session that was paused while they were pending. */
	paused: string[] = [];
	readonly events = new AsyncQueue<AgyEvent>();
	busy = false;
	closed = false;
	lastUsed = Date.now();
	failure?: string;
	config: SessionConfig;
	/** agy gave up on an open call: continuing live would show its reaction to that. */
	desynced = false;
	/** A `session/prompt` is running (it spans every pi response up to the end of agy's turn). */
	promptOpen = false;
	/** Conversation tokens already reported to pi responses of the running prompt. */
	turnReported = 0;
	private process?: AcpProcess;
	private endpoint?: ToolEndpoint;
	private readonly tools = new Map<string, Tool>();
	private readonly held = new Map<string, (result: CallToolResult) => void>();
	private readonly announced: Array<{ id: string; name: string; args: string }> = [];
	private cancelling = false;
	private modelOption = "model";
	private models: string[] = [];
	private currentModel?: string;
	private levelOption?: { id: string; values: string[]; current?: string };

	constructor(config: SessionConfig) {
		this.config = config;
		for (const tool of config.tools) this.tools.set(tool.name, tool);
	}

	get model(): string | undefined { return this.currentModel; }

	async start(): Promise<void> {
		const config = this.config;
		const endpoint = config.tools.length ? await openToolEndpoint({ tools: () => [...this.tools.values()], call: (request) => this.onCall(request) }) : undefined;
		this.endpoint = endpoint;
		const { process: process_ } = await startAgy({
			executable: config.executable,
			mcp: endpoint ? { url: endpoint.url, token: endpoint.token, tools: config.tools.map((tool) => tool.name) } : null,
			cwd: workspaceDir(),
		}, async (started) => {
			const init = await initialize(started);
			if (!versionSupported(init.agentInfo?.version)) throw new SessionError("outdated", "outdated");
			if (config.systemPrompt && init.agentCapabilities?._meta?.antigravity?.systemPrompt?.append !== true) throw new SessionError("outdated", "This Antigravity version cannot take LearnHarness's instructions.");
			// Signing in is when agy reads its MCP config and connects.
			try { await authenticate(started); }
			catch (error) { throw isSignInRequired(error) ? new SessionError("signed-out", "signed out") : error; }
			if (endpoint) await waitForTools(started, endpoint.connected);
		});
		this.process = process_;
		process_.onNotification = (method, params) => this.onNotification(method, params);
		process_.onRequest = (method, params) => this.onRequest(method, params);
		void process_.exited.then(() => this.onExit());
		if (process_.closed) throw new AcpError(-32603, process_.stderrTail.trim().split("\n").filter(Boolean).at(-1) || "Antigravity stopped while starting.");
		const meta = config.systemPrompt ? { _meta: { antigravity: { systemPrompt: { append: config.systemPrompt } } } } : {};
		let result: { sessionId?: string; configOptions?: ConfigOption[] } | null;
		try {
			result = config.resume
				? await process_.request("session/resume", { sessionId: config.resume, cwd: workspaceDir(), mcpServers: [], ...meta }, 90_000)
				: await process_.request("session/new", { cwd: workspaceDir(), mcpServers: [], ...meta }, 90_000);
		} catch (error) { throw isSignInRequired(error) ? new SessionError("signed-out", "signed out") : error; }
		this.sessionId = config.resume ?? String(result?.sessionId ?? "");
		if (!this.sessionId) throw new AcpError(-32603, "Antigravity did not open a session.");
		this.readOptions(result?.configOptions);
		// A resumed session starts on the account's default model.
		await this.apply(config.model, config.level, true);
	}

	private readOptions(options: ConfigOption[] | undefined): void {
		if (!Array.isArray(options)) return;
		const model = options.find((option) => option.id === "model" || option.category === "model");
		if (model) {
			this.modelOption = model.id;
			this.models = optionValues(model);
			if (typeof model.currentValue === "string") this.currentModel = model.currentValue;
		}
		const level = options.find((option) => option.category === "thought_level");
		this.levelOption = level ? { id: level.id, values: optionValues(level), ...(typeof level.currentValue === "string" ? { current: level.currentValue } : {}) } : undefined;
	}

	private async setOption(configId: string, value: string): Promise<void> {
		const result = await this.process!.request<{ configOptions?: ConfigOption[] } | null>("session/set_config_option", { sessionId: this.sessionId, configId, value }, 30_000);
		this.readOptions(result?.configOptions);
	}

	/** Selects the model and thinking level in place. */
	async apply(model: string, level: string | undefined, force = false): Promise<void> {
		if (this.models.length && !this.models.includes(model)) throw new SessionError("unavailable", model);
		if (force || model !== this.currentModel) await this.setOption(this.modelOption, model);
		this.currentModel = model;
		if (level && this.levelOption?.values.includes(level) && this.levelOption.current !== level) await this.setOption(this.levelOption.id, level);
		this.config = { ...this.config, model, ...(level ? { level } : {}) };
	}

	private onNotification(method: string, params: Record<string, unknown>): void {
		if (method !== "session/update") return;
		if (this.sessionId && typeof params.sessionId === "string" && params.sessionId !== this.sessionId) return;
		const update = (params.update ?? {}) as Record<string, unknown>;
		switch (update.sessionUpdate) {
			case "agent_message_chunk":
			case "agent_thought_chunk": {
				const content = update.content as { type?: string; text?: string } | undefined;
				if (content?.type === "text" && content.text) this.events.push({ type: update.sessionUpdate === "agent_message_chunk" ? "text" : "thought", text: content.text });
				return;
			}
			case "usage_update":
				if (typeof update.used === "number") this.events.push({ type: "usage", used: update.used, ...(typeof update.size === "number" ? { size: update.size } : {}) });
				return;
			case "tool_call":
			case "tool_call_update": {
				const id = typeof update.toolCallId === "string" ? update.toolCallId : undefined;
				const name = typeof update.name === "string" ? update.name : /^Run (\S+?)\??$/.exec(String(update.title ?? ""))?.[1];
				if (!id || !name?.startsWith(TOOL_PREFIX)) return;
				const tool = name.slice(TOOL_PREFIX.length);
				if (!this.announced.some((entry) => entry.id === id) && !this.held.has(id)) {
					this.announced.push({ id, name: tool, args: canonical(cleanArguments(this.tools.get(tool), update.rawInput ?? update.args)) });
					if (this.announced.length > 64) this.announced.shift();
				}
				// agy gave up on a call LearnHarness still holds (it never times out
				// by configuration, so only an agy-side failure does this).
				if (update.status === "failed" && this.held.has(id) && !this.cancelling) {
					this.desynced = true;
					this.cancel();
				}
				return;
			}
			case "config_option_update":
				this.readOptions(update.configOptions as ConfigOption[] | undefined);
				return;
		}
	}

	private async onRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
		if (method === "session/request_permission") {
			const call = (params.toolCall ?? {}) as { name?: unknown; title?: unknown };
			const name = typeof call.name === "string" ? call.name : /^Run (\S+?)\??$/.exec(String(call.title ?? ""))?.[1];
			// Only LearnHarness's own tools run; anything else agy might try is refused.
			const allowed = !!name?.startsWith(TOOL_PREFIX) && this.tools.has(name.slice(TOOL_PREFIX.length));
			const options = Array.isArray(params.options) ? params.options as Array<{ optionId?: string; kind?: string }> : [];
			const choice = options.find((option) => option.kind === (allowed ? "allow_once" : "reject_once") && option.optionId);
			return { outcome: choice ? { outcome: "selected", optionId: choice.optionId } : { outcome: "cancelled" } };
		}
		throw new AcpError(-32601, `${method} is not available in LearnHarness.`);
	}

	private onCall(request: ToolCallRequest): Promise<CallToolResult> {
		if (this.closed) return Promise.resolve(CANCELLED);
		if (request.conversationId && this.sessionId && request.conversationId !== this.sessionId) {
			return Promise.resolve({ content: [{ type: "text", text: "This tool call belongs to another conversation." }], isError: true });
		}
		const args = canonical(request.args);
		const index = this.announced.findIndex((entry) => entry.name === request.name && entry.args === args);
		const id = index >= 0 ? this.announced.splice(index, 1)[0]!.id : `agy_${randomUUID()}`;
		return new Promise<CallToolResult>((resolve) => {
			this.held.set(id, resolve);
			request.signal.addEventListener("abort", () => {
				if (this.held.get(id) !== resolve) return;
				this.held.delete(id);
				resolve(CANCELLED);
			}, { once: true });
			this.events.push({ type: "tool", id, name: request.name, args: request.args });
		});
	}

	/** The stream handed this call to the agent loop. */
	noteCall(id: string): void { this.awaiting.add(id); }

	/** agy still waits on this call, so its result can be delivered live. */
	holds(id: string): boolean { return this.held.has(id); }

	answer(id: string, content: AcpContent[], isError: boolean): void {
		this.awaiting.delete(id);
		const resolve = this.held.get(id);
		if (!resolve) return;
		this.held.delete(id);
		resolve({ content, isError } as CallToolResult);
	}

	/** Starts agy's turn with this prompt; its events arrive on `events`. */
	send(content: AcpContent[]): void {
		this.promptOpen = true;
		this.turnReported = 0;
		this.cancelling = false;
		const prompt = content.length ? content : [{ type: "text", text: "Continue." }];
		void this.process!.request<{ stopReason?: string; usage?: PromptUsage } | null>("session/prompt", { sessionId: this.sessionId, prompt }).then(
			(result) => { this.promptOpen = false; this.events.push({ type: "end", stopReason: String(result?.stopReason ?? "end_turn"), ...(result?.usage ? { usage: result.usage } : {}) }); },
			(error: unknown) => { this.promptOpen = false; this.events.push({ type: "error", error: error instanceof Error ? error : new Error(String(error)) }); },
		);
	}

	/** Stops agy's running turn; open calls fail and the prompt ends "cancelled". */
	cancel(): void {
		if (!this.promptOpen || !this.process) return;
		this.cancelling = true;
		this.process.notify("session/cancel", { sessionId: this.sessionId });
	}

	/** Stops cleanly: a running turn is cancelled first, so agy records the
	 * open calls as interrupted instead of leaving them half-done. */
	async shutdown(): Promise<void> {
		if (this.closed) return;
		if (this.promptOpen) {
			this.cancel();
			const deadline = Date.now() + 3000;
			while (this.promptOpen && !this.closed && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
		}
		this.close();
	}

	close(): void {
		const wasClosed = this.closed;
		this.closed = true;
		this.process?.kill();
		this.endpoint?.close();
		this.endpoint = undefined;
		for (const resolve of this.held.values()) resolve(CANCELLED);
		this.held.clear();
		if (!wasClosed) this.events.close();
	}

	private onExit(): void {
		if (!this.closed) this.failure = this.process?.stderrTail.trim().split("\n").filter(Boolean).at(-1) ?? "Antigravity stopped unexpectedly";
		this.close();
	}
}

// ─── Pool ──────────────────────────────────────────────────────────────────

interface SessionRecord {
	sessionId: string;
	known: string[];
	awaiting: string[];
	systemKey: string;
	toolsKey: string;
	tag?: string;
	updatedAt: number;
}

interface PoolState { live: Set<LiveSession>; records?: SessionRecord[]; sweeper?: ReturnType<typeof setInterval> }
const POOL = Symbol.for("lh.antigravity.pool");
function pool(): PoolState {
	const global = globalThis as typeof globalThis & { [POOL]?: PoolState };
	if (!global[POOL]) {
		global[POOL] = { live: new Set() };
		process.once("exit", () => { for (const session of global[POOL]!.live) session.close(); });
		// The desktop shell asks before stopping this server: open turns are
		// cancelled so agy records them as interrupted.
		onGracefulShutdown("lh:antigravity", pauseAllSessions);
	}
	return global[POOL]!;
}

/** Pauses every live session, keeping records so each can resume later. */
export async function pauseAllSessions(): Promise<void> {
	await Promise.all([...pool().live].map((session) => pauseSession(session)));
}

function recordsFile(): string { return path.join(antigravityDir(), "sessions.json"); }
function records(): SessionRecord[] {
	const state = pool();
	if (!state.records) {
		try { state.records = (JSON.parse(readFileSync(recordsFile(), "utf8")) as { sessions?: SessionRecord[] }).sessions ?? []; }
		catch { state.records = []; }
	}
	return state.records;
}
function saveRecords(): void {
	try {
		mkdirSync(antigravityDir(), { recursive: true });
		const file = recordsFile(), temp = `${file}.${process.pid}.tmp`;
		writeFileSync(temp, JSON.stringify({ sessions: records().slice(0, MAX_RECORDS) }) + "\n", { mode: 0o600 });
		renameSync(temp, file);
	} catch { /* resume is an optimization; replay still works */ }
}

/** Remembers where a persisted session stands, so it can resume after a restart. */
export function rememberSession(session: LiveSession): void {
	if (!session.config.persist || !session.sessionId) return;
	const list = records();
	const index = list.findIndex((record) => record.sessionId === session.sessionId);
	if (index >= 0) list.splice(index, 1);
	list.unshift({
		sessionId: session.sessionId, known: [...session.known], awaiting: [...new Set([...session.awaiting, ...session.paused])],
		systemKey: session.config.systemKey, toolsKey: session.config.toolsKey, tag: session.config.tag, updatedAt: Date.now(),
	});
	saveRecords();
}
export function forgetSession(sessionId: string): void {
	const list = records();
	const index = list.findIndex((record) => record.sessionId === sessionId);
	if (index >= 0) { list.splice(index, 1); saveRecords(); }
}

function isPrefix(prefix: readonly string[], full: readonly string[]): boolean {
	return prefix.length <= full.length && prefix.every((value, index) => value === full[index]);
}

/** The live session that has seen the longest prefix of this conversation. */
export function findLive(fingerprints: readonly string[], tag: string | undefined): LiveSession | undefined {
	let best: LiveSession | undefined;
	for (const session of pool().live) {
		if (session.busy || session.closed) continue;
		if (tag && session.config.tag && session.config.tag !== tag) continue;
		if (!isPrefix(session.known, fingerprints)) continue;
		if (!best || session.known.length > best.known.length) best = session;
	}
	return best;
}

export function findRecord(fingerprints: readonly string[], tag: string | undefined): SessionRecord | undefined {
	const live = new Set([...pool().live].map((session) => session.sessionId));
	let best: SessionRecord | undefined;
	for (const record of records()) {
		if (live.has(record.sessionId) || record.known.length === 0) continue;
		if (tag && record.tag && record.tag !== tag) continue;
		if (!isPrefix(record.known, fingerprints)) continue;
		if (!best || record.known.length > best.known.length) best = record;
	}
	return best;
}

export async function openSession(config: SessionConfig): Promise<LiveSession> {
	const state = pool();
	await makeRoom();
	const session = new LiveSession(config);
	state.live.add(session);
	try { await session.start(); }
	catch (error) { state.live.delete(session); session.close(); throw error; }
	ensureSweeper();
	return session;
}

export async function dropSession(session: LiveSession, forget = false): Promise<void> {
	pool().live.delete(session);
	if (forget && session.sessionId) forgetSession(session.sessionId);
	await session.shutdown();
}

async function makeRoom(): Promise<void> {
	const state = pool();
	for (const session of state.live) if (session.closed) state.live.delete(session);
	while (state.live.size >= MAX_LIVE) {
		const idle = [...state.live].filter((session) => !session.busy).sort((a, b) => (a.awaiting.size - b.awaiting.size) || (a.lastUsed - b.lastUsed));
		const victim = idle[0];
		if (!victim) return;
		await pauseSession(victim);
	}
}

/** Closes a session but keeps its record, so it can resume later. */
export async function pauseSession(session: LiveSession): Promise<void> {
	pool().live.delete(session);
	rememberSession(session);
	await session.shutdown();
}

/** One-shot callers (plugin inference) release what they opened. */
export async function releaseTaggedSessions(tag: string): Promise<void> {
	await Promise.all([...pool().live].filter((session) => session.config.tag === tag && !session.busy).map((session) => dropSession(session, true)));
}

/** Sign-out, an account change or a removed runtime: every session ends and
 * no record is kept, so nothing resumes into the wrong account. */
export async function closeAllSessions(): Promise<void> {
	const state = pool();
	await Promise.all([...state.live].map((session) => { state.live.delete(session); return session.shutdown(); }));
	state.records = [];
	saveRecords();
}

export function liveSessionCount(): number { return [...pool().live].filter((session) => !session.closed).length; }

function ensureSweeper(): void {
	const state = pool();
	if (state.sweeper) return;
	state.sweeper = setInterval(() => {
		const now = Date.now();
		for (const session of state.live) {
			if (session.closed) { state.live.delete(session); continue; }
			if (session.busy) continue;
			const limit = session.awaiting.size ? AWAITING_IDLE_MS : IDLE_MS;
			if (now - session.lastUsed > limit) void pauseSession(session);
		}
		if (state.live.size === 0 && state.sweeper) { clearInterval(state.sweeper); state.sweeper = undefined; }
	}, 60_000);
	state.sweeper.unref?.();
}

/** Test hook: closes every session and forgets cached records. */
export function resetAntigravitySessions(): void {
	const state = pool();
	for (const session of state.live) session.close();
	state.live.clear();
	state.records = undefined;
	if (state.sweeper) { clearInterval(state.sweeper); state.sweeper = undefined; }
}
