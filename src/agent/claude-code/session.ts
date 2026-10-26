/** Live Claude Code sessions for the bridge. Each session is one Claude Code
 * process (spawned through the Agent SDK) with LearnHarness's tools exposed
 * by an in-process MCP server. A tool call is held open until the agent loop
 * delivers its result, so a whole lesson runs as one native Claude Code
 * conversation: questions wait for the learner's answer as their result. */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { EffortLevel, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Tool } from "@earendil-works/pi-ai";
import { claudeCodeDir } from "./connection.ts";
import type { ClaudeExecutable } from "./executable.ts";
import type { ContentBlock, McpContent } from "./transcript.ts";

export const TOOL_SERVER = "lh";
export const TOOL_PREFIX = `mcp__${TOOL_SERVER}__`;
const MAX_LIVE = 6;
/** Idle sessions close after this; they resume from disk when needed. */
const IDLE_MS = 10 * 60_000;
/** Sessions waiting on the learner (a posed question) stay open longer. */
const AWAITING_IDLE_MS = 3 * 60 * 60_000;
const MAX_RECORDS = 200;

/** A small async FIFO usable as an AsyncIterable. */
export class AsyncQueue<T> implements AsyncIterable<T> {
	private items: T[] = [];
	private waiters: Array<(result: IteratorResult<T>) => void> = [];
	private done = false;
	push(item: T): void {
		if (this.done) return;
		const waiter = this.waiters.shift();
		if (waiter) waiter({ value: item, done: false });
		else this.items.push(item);
	}
	close(): void {
		this.done = true;
		for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
	}
	next(): Promise<IteratorResult<T>> {
		if (this.items.length) return Promise.resolve({ value: this.items.shift()!, done: false });
		if (this.done) return Promise.resolve({ value: undefined, done: true });
		return new Promise((resolve) => this.waiters.push(resolve));
	}
	[Symbol.asyncIterator](): AsyncIterator<T> { return { next: () => this.next() }; }
}

export interface SessionConfig {
	executable: ClaudeExecutable;
	env: Record<string, string>;
	model: string;
	effort?: EffortLevel;
	thinkingOff: boolean;
	systemPrompt: string;
	systemKey: string;
	tools: Tool[];
	toolsKey: string;
	persist: boolean;
	/** The chat id the agent passed, when it passed one. */
	tag?: string;
	/** Resume this Claude Code session instead of starting one. */
	resume?: string;
}

export type QueryFactory = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Record<string, unknown> }) => Query;

let queryFactory: QueryFactory | undefined;
/** Tests replace the SDK; production loads it lazily. */
export function setClaudeQueryFactory(factory: QueryFactory | undefined): void { queryFactory = factory; }
async function factory(): Promise<QueryFactory> {
	if (queryFactory) return queryFactory;
	const sdk = await import("@anthropic-ai/claude-agent-sdk");
	return sdk.query as unknown as QueryFactory;
}

export function workspaceDir(): string { return path.join(claudeCodeDir(), "workspace"); }

export class LiveSession {
	readonly sessionId: string;
	/** Fingerprints of the conversation messages this Claude session has seen. */
	known: string[] = [];
	/** Tool calls handed to the agent loop and not answered yet. */
	readonly awaiting = new Set<string>();
	/** Calls from a session that was paused while they were pending. */
	paused: string[] = [];
	readonly events = new AsyncQueue<SDKMessage>();
	busy = false;
	closed = false;
	lastUsed = Date.now();
	failure?: string;
	stderrTail = "";
	config: SessionConfig;
	private readonly input = new AsyncQueue<SDKUserMessage>();
	private query?: Query;
	private readonly server: Server;
	private tools = new Map<string, Tool>();
	private readonly waiting = new Map<string, (result: CallToolResult) => void>();
	private readonly early = new Map<string, CallToolResult>();
	/** Calls seen on the stream, for matching when a call carries no id. */
	private readonly emitted: Array<{ id: string; name: string; args: string }> = [];

	constructor(config: SessionConfig) {
		this.config = config;
		this.sessionId = config.resume ?? randomUUID();
		for (const tool of config.tools) this.tools.set(tool.name, tool);
		this.server = new Server({ name: TOOL_SERVER, version: "1.0.0" }, { capabilities: { tools: { listChanged: true } } });
		this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
			tools: [...this.tools.values()].map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters as { type: "object"; [key: string]: unknown } })),
		}));
		this.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
			const meta = request.params._meta as Record<string, unknown> | undefined;
			const id = typeof meta?.["claudecode/toolUseId"] === "string" ? meta["claudecode/toolUseId"] as string : this.match(request.params.name, request.params.arguments);
			if (!id) return { content: [{ type: "text", text: "LearnHarness could not match this tool call." }], isError: true };
			const ready = this.early.get(id);
			if (ready) { this.early.delete(id); return ready; }
			return new Promise<CallToolResult>((resolve) => {
				this.waiting.set(id, resolve);
				extra.signal.addEventListener("abort", () => {
					if (this.waiting.get(id) !== resolve) return;
					this.waiting.delete(id);
					resolve({ content: [{ type: "text", text: "Cancelled." }], isError: true });
				}, { once: true });
			});
		});
	}

	async start(): Promise<void> {
		const config = this.config;
		mkdirSync(workspaceDir(), { recursive: true });
		const create = await factory();
		this.query = create({
			prompt: this.input,
			options: {
				pathToClaudeCodeExecutable: config.executable.path,
				...(config.executable.script ? { executable: "node" } : {}),
				cwd: workspaceDir(),
				env: config.env,
				model: config.model,
				...(config.effort ? { effort: config.effort } : {}),
				...(config.thinkingOff ? { thinking: { type: "disabled" } } : {}),
				systemPrompt: { type: "custom", prompt: config.systemPrompt, snapshot: false },
				// Only LearnHarness's tools: no built-in tools, no user settings,
				// skills, hooks or MCP servers, and prompts sent exactly as written.
				tools: [],
				allowedTools: [`mcp__${TOOL_SERVER}`, ...config.tools.map((tool) => `${TOOL_PREFIX}${tool.name}`)],
				permissionPrompts: "none",
				mcpServers: { [TOOL_SERVER]: { type: "sdk", name: TOOL_SERVER, instance: this.server } },
				strictMcpConfig: true,
				settingSources: [],
				skills: [],
				settings: { disableAllHooks: true },
				verbatimPrompts: true,
				includePartialMessages: true,
				persistSession: config.persist,
				...(config.resume ? { resume: config.resume } : { sessionId: this.sessionId, title: "LearnHarness" }),
				stderr: (chunk: string) => { this.stderrTail = (this.stderrTail + chunk).slice(-4000); },
			},
		});
		void this.pump(this.query);
	}

	private async pump(query: Query): Promise<void> {
		try { for await (const message of query) this.events.push(message); }
		catch (error) { this.failure = error instanceof Error ? error.message : String(error); }
		finally { this.closed = true; this.events.close(); this.cancelWaiting(); }
	}

	private match(name: string, args: unknown): string | undefined {
		const wanted = JSON.stringify(args ?? {});
		const index = this.emitted.findIndex((call) => call.name === name && call.args === wanted && !this.waiting.has(call.id));
		if (index < 0) return undefined;
		return this.emitted.splice(index, 1)[0]!.id;
	}

	/** The stream saw a call to one of our tools. */
	noteCall(id: string, name: string, args: unknown): void {
		this.awaiting.add(id);
		this.emitted.push({ id, name, args: JSON.stringify(args ?? {}) });
		if (this.emitted.length > 64) this.emitted.shift();
	}

	answer(id: string, content: McpContent[], isError: boolean): void {
		const result: CallToolResult = { content, isError };
		this.awaiting.delete(id);
		const resolve = this.waiting.get(id);
		if (resolve) { this.waiting.delete(id); resolve(result); }
		else this.early.set(id, result);
	}

	send(content: ContentBlock[]): void {
		this.input.push({ type: "user", session_id: "", parent_tool_use_id: null, message: { role: "user", content } } as SDKUserMessage);
	}

	setTools(tools: Tool[], toolsKey: string): void {
		this.tools = new Map(tools.map((tool) => [tool.name, tool]));
		this.config = { ...this.config, tools, toolsKey };
		void this.server.sendToolListChanged().catch(() => {});
	}

	async setModel(model: string): Promise<void> {
		if (model === this.config.model) return;
		await this.query?.setModel(model);
		this.config = { ...this.config, model };
	}

	async interrupt(): Promise<void> {
		try { await Promise.race([this.query?.interrupt(), new Promise((resolve) => setTimeout(resolve, 5000))]); } catch { /* already stopped */ }
	}

	/** Stops cleanly: an open tool call is interrupted first, so Claude Code
	 * records it as interrupted instead of retrying it on its own. */
	async shutdown(): Promise<void> {
		if (this.closed) return;
		if (this.awaiting.size || this.waiting.size || this.busy) {
			await this.interrupt();
			const deadline = Date.now() + 3000;
			while (!this.closed && Date.now() < deadline) {
				const next = await Promise.race([this.events.next(), new Promise<null>((resolve) => setTimeout(() => resolve(null), deadline - Date.now()))]);
				if (!next || next.done || next.value.type === "result") break;
			}
		}
		this.close();
	}

	close(): void {
		if (this.closed && !this.query) return;
		this.closed = true;
		this.input.close();
		try { this.query?.close(); } catch { /* already gone */ }
		this.query = undefined;
		this.cancelWaiting();
	}

	private cancelWaiting(): void {
		for (const resolve of this.waiting.values()) resolve({ content: [{ type: "text", text: "Cancelled." }], isError: true });
		this.waiting.clear();
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
const POOL = Symbol.for("lh.claudeCode.pool");
function pool(): PoolState {
	const global = globalThis as typeof globalThis & { [POOL]?: PoolState };
	if (!global[POOL]) {
		global[POOL] = { live: new Set() };
		process.once("exit", () => { for (const session of global[POOL]!.live) session.close(); });
		installShutdown();
	}
	return global[POOL]!;
}

/** Pauses every live session, keeping records so each can resume later. */
export async function pauseAllSessions(): Promise<void> {
	await Promise.all([...pool().live].map((session) => pauseSession(session)));
}

/** The desktop shell asks its server to stop (or goes away). Interrupt open
 * Claude Code turns first: a killed session would otherwise retry its open
 * tool calls on its own before exiting. */
function installShutdown(): void {
	if (typeof process.send !== "function") return;
	let stopping = false;
	const stop = () => {
		if (stopping) return;
		stopping = true;
		const timer = setTimeout(() => process.exit(0), 2500);
		void pauseAllSessions().finally(() => { clearTimeout(timer); process.exit(0); });
	};
	process.on("message", (raw: unknown) => {
		const message = raw as { channel?: unknown; op?: unknown } | null;
		if (message?.channel === "lh:claude-code" && message.op === "shutdown") stop();
	});
	process.once("disconnect", stop);
	// Tell the shell to ask before stopping this server.
	try { process.send({ channel: "lh:claude-code", op: "graceful" }); } catch { /* shell gone */ }
}

function recordsFile(): string { return path.join(claudeCodeDir(), "sessions.json"); }
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
		mkdirSync(claudeCodeDir(), { recursive: true });
		const file = recordsFile(), temp = `${file}.${process.pid}.tmp`;
		writeFileSync(temp, JSON.stringify({ sessions: records().slice(0, MAX_RECORDS) }) + "\n", { mode: 0o600 });
		renameSync(temp, file);
	} catch { /* resume is an optimization; replay still works */ }
}

/** Remembers where a persisted session stands, so it can resume after a restart. */
export function rememberSession(session: LiveSession): void {
	if (!session.config.persist) return;
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
	if (forget) forgetSession(session.sessionId);
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
async function pauseSession(session: LiveSession): Promise<void> {
	pool().live.delete(session);
	rememberSession(session);
	await session.shutdown();
}

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
export function resetClaudeSessions(): void {
	const state = pool();
	for (const session of state.live) session.close();
	state.live.clear();
	state.records = undefined;
	if (state.sweeper) { clearInterval(state.sweeper); state.sweeper = undefined; }
}
