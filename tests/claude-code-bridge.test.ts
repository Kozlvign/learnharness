/** The Claude Code bridge, offline: a scripted stand-in for Claude Code talks
 * to the bridge's real in-process MCP server, so tool calls, held results,
 * resume and replay run end to end without the CLI or a network. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, beforeEach, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-claude-code-"));
process.env.LH_DATA_DIR = scratch;
const { Agent } = await import("@earendil-works/pi-agent-core");
const { Type, normalizeContext } = await import("@earendil-works/pi-ai");
const connection = await import("../src/agent/claude-code/connection.ts");
const sessions = await import("../src/agent/claude-code/session.ts");
const { claudeCodeModel, claudeCodeModelValue } = await import("../src/agent/claude-code/catalog.ts");
const { claudeCodeStream } = await import("../src/agent/claude-code/stream.ts");
const { claudeCodeEnv } = await import("../src/agent/claude-code/environment.ts");
const { findClaudeExecutable } = await import("../src/agent/claude-code/executable.ts");
const { piEngineForSpec } = await import("../src/agent/models.ts");
after(() => { sessions.resetClaudeSessions(); fs.rmSync(scratch, { recursive: true, force: true }); });

type Step = { text?: string; calls?: Array<{ name: string; args: Record<string, unknown> }> };

/** A scripted Claude Code: each step is one model response. */
class FakeClaude {
	launches: Array<Record<string, any>> = [];
	inputs: unknown[][] = [];
	results: unknown[] = [];
	script: Step[] = [];
	interrupts = 0;
	factory = ({ prompt, options }: { prompt: AsyncIterable<any>; options: Record<string, any> }) => {
		this.launches.push(options);
		const events = new sessions.AsyncQueue<any>();
		const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "fake-claude", version: "1.0.0" });
		const ready = Promise.all([options.mcpServers.lh.instance.connect(serverSide), client.connect(clientSide)]);
		let closed = false, counter = 0;
		const stream = (event: unknown) => events.push({ type: "stream_event", event, parent_tool_use_id: null });
		void (async () => {
			await ready;
			for await (const message of prompt) {
				this.inputs.push(message.message.content);
				for (;;) {
					const step = this.script.shift() ?? { text: "(unscripted)" };
					stream({ type: "message_start", message: { id: `msg_${this.inputs.length}_${counter}`, model: "claude-fake", usage: { input_tokens: 3, cache_read_input_tokens: 100, cache_creation_input_tokens: 10 } } });
					let index = 0;
					if (step.text) {
						stream({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
						stream({ type: "content_block_delta", index, delta: { type: "text_delta", text: step.text } });
						stream({ type: "content_block_stop", index }); index++;
					}
					const calls = (step.calls ?? []).map((call) => ({ ...call, id: `toolu_${++counter}` }));
					for (const call of calls) {
						stream({ type: "content_block_start", index, content_block: { type: "tool_use", id: call.id, name: `mcp__lh__${call.name}`, input: {} } });
						stream({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(call.args) } });
						stream({ type: "content_block_stop", index }); index++;
					}
					stream({ type: "message_delta", delta: { stop_reason: calls.length ? "tool_use" : "end_turn" }, usage: { output_tokens: 7 } });
					stream({ type: "message_stop" });
					if (!calls.length) {
						events.push({ type: "result", subtype: "success", is_error: false, result: step.text, modelUsage: { "claude-fake": { contextWindow: 1_000_000 } } });
						break;
					}
					let results: unknown[];
					try { results = await Promise.all(calls.map((call) => client.callTool({ name: call.name, arguments: call.args, _meta: { "claudecode/toolUseId": call.id } }, undefined, { timeout: 600_000 }))); }
					catch { return; } // closed while a call was open
					if (closed) return;
					this.results.push(...results);
				}
			}
		})();
		return {
			next: () => events.next(),
			[Symbol.asyncIterator]() { return { next: () => events.next() }; },
			interrupt: async () => { this.interrupts++; events.push({ type: "result", subtype: "error_during_execution", is_error: true, errors: [] }); },
			close: () => { closed = true; events.close(); void client.close(); },
			setModel: async () => {},
		} as any;
	};
}

let fake: FakeClaude;
const models = [
	{ value: "haiku", resolvedModel: "claude-haiku-5-5", displayName: "Haiku 5.5", description: "", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high"] },
	{ value: "claude-opus-4-8", resolvedModel: "claude-opus-4-8", displayName: "Opus 4.8", description: "", supportsEffort: true, supportedEffortLevels: ["low", "high"] },
	{ value: "claude-haiku-4-5", resolvedModel: "claude-haiku-4-5", displayName: "Haiku 4.5", description: "", supportsThinkingOff: true },
] as any[];
function connect(overrides: Record<string, unknown> = {}) {
	connection.setClaudeCodeStateForTests({
		status: { state: "connected", connected: true, account: { email: "learner@example.invalid", plan: "Claude Max" }, allowBackgroundUse: true, ...overrides },
		models, executable: { path: "claude-fixture.exe", script: false },
	});
}
beforeEach(() => { fake = new FakeClaude(); sessions.setClaudeQueryFactory(fake.factory as any); sessions.resetClaudeSessions(); connect(); });
afterEach(() => { sessions.resetClaudeSessions(); sessions.setClaudeQueryFactory(undefined); connection.setClaudeCodeStateForTests(undefined); });

const quizTool = {
	name: "quiz", label: "Quiz", description: "Pose a question.", parameters: Type.Object({ question: Type.String() }), executionMode: "sequential" as const,
	execute: async () => ({ content: [{ type: "text" as const, text: "Question posed — the turn ends here." }], details: null, terminate: true }),
};
const lookupTool = {
	name: "lookup", label: "Lookup", description: "Look something up.", parameters: Type.Object({ topic: Type.String() }),
	execute: async (_id: string, params: { topic: string }) => ({ content: [{ type: "text" as const, text: `About ${params.topic}: 7 × 8 = 56.` }], details: null }),
};
function agent(messages: any[], tools: any[] = [lookupTool, quizTool], prompt = "You are a tutor.") {
	const model = claudeCodeModel("claude-haiku")!;
	return new Agent({ initialState: { systemPrompt: prompt, model, thinkingLevel: "low", tools, messages }, streamFn: claudeCodeStream(() => false) as any, sessionId: "chat-1" });
}
const transcript = (a: InstanceType<typeof Agent>) => a.state.messages.filter((m: any) => m.role !== "system");
const text = (a: InstanceType<typeof Agent>) => transcript(a).filter((m: any) => m.role === "assistant").flatMap((m: any) => m.content).filter((c: any) => c.type === "text").map((c: any) => c.text);

test("catalog: aliases become claude-* ids with mapped effort levels and zero cost", () => {
	const haiku = claudeCodeModel("claude-haiku")!;
	assert.equal(haiku.provider, "claude-code");
	assert.equal(haiku.name, "Claude Haiku 5.5");
	assert.deepEqual(haiku.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	assert.equal(haiku.thinkingLevelMap?.medium, "medium");
	assert.equal(haiku.thinkingLevelMap?.xhigh, null);
	assert.equal(claudeCodeModelValue("claude-haiku"), "haiku");
	assert.equal(claudeCodeModelValue("claude-opus-4-8"), "claude-opus-4-8");
	assert(claudeCodeModel("claude-opus-4-8"));
	const legacy = claudeCodeModel("claude-haiku-4-5")!;
	assert.equal(legacy.thinkingLevelMap?.off, "off");
	assert.equal(legacy.thinkingLevelMap?.medium, "default");
	assert.equal(legacy.thinkingLevelMap?.high, null);
	assert.equal(piEngineForSpec({ provider: "claude-code", id: "claude-haiku" }).model.id, "claude-haiku");
});

test("a run with a tool call stays in one Claude Code session and streams text", async () => {
	fake.script = [{ calls: [{ name: "lookup", args: { topic: "7x8" } }] }, { text: "7 × 8 is 56." }];
	const a = agent([]);
	await a.prompt("Teach me 7 × 8.");
	assert.equal(fake.launches.length, 1);
	assert.deepEqual(text(a), ["7 × 8 is 56."]);
	const options = fake.launches[0]!;
	assert.deepEqual(options.tools, []);
	assert.deepEqual(options.settingSources, []);
	assert.equal(options.verbatimPrompts, true);
	assert.equal(options.model, "haiku");
	assert.equal(options.effort, "low");
	assert.deepEqual(options.systemPrompt, { type: "custom", prompt: "You are a tutor.", snapshot: false });
	assert.equal((fake.results[0] as any).content[0].text, "About 7x8: 7 × 8 = 56.");
	const last = transcript(a).at(-1) as any;
	assert.equal(last.usage.cacheRead, 100);
	assert.equal(last.usage.cost.total, 0);
});

test("a posed question waits in the live session; the graded answer arrives as its result", async () => {
	fake.script = [{ calls: [{ name: "quiz", args: { question: "7 × 8?" } }] }, { text: "Correct!" }];
	let a = agent([]);
	await a.prompt("Quiz me.");
	const messages = transcript(a);
	const call = messages.flatMap((m: any) => m.role === "assistant" ? m.content : []).find((c: any) => c.type === "toolCall");
	const answered = messages.map((m: any) => m.role === "toolResult" ? { ...m, content: [{ type: "text", text: "Learner answered 56: correct." }] } : m);
	a = agent(answered);
	await a.continue();
	assert.equal(fake.launches.length, 1, "no new Claude Code process for the answer");
	assert.equal((fake.results[0] as any).content[0].text, "Learner answered 56: correct.");
	assert.equal(call.name, "quiz");
	assert.deepEqual(text(a), ["Correct!"]);
});

test("after a restart the session resumes from disk instead of replaying", async () => {
	fake.script = [{ text: "Hello." }, { text: "Again." }];
	let a = agent([]);
	await a.prompt("Hi.");
	const first = fake.launches[0]!;
	sessions.resetClaudeSessions();
	a = agent(transcript(a));
	await a.prompt("Once more.");
	assert.equal(fake.launches.length, 2);
	assert.equal(fake.launches[1]!.resume, first.sessionId);
	assert.deepEqual(fake.inputs[1], [{ type: "text", text: "Once more." }]);
});

test("a paused question resumes and delivers the real result as text", async () => {
	fake.script = [{ calls: [{ name: "quiz", args: { question: "2 + 2?" } }] }, { text: "Right, 4." }];
	let a = agent([]);
	await a.prompt("Quiz me.");
	await sessions.pauseAllSessions();
	assert.equal(fake.interrupts, 1, "the open call is interrupted before closing");
	const answered = transcript(a).map((m: any) => m.role === "toolResult" ? { ...m, content: [{ type: "text", text: "Learner answered 4." }] } : m);
	a = agent(answered);
	await a.continue();
	assert.equal(fake.launches.length, 2);
	assert(fake.launches[1]!.resume);
	const delivered = JSON.stringify(fake.inputs[1]);
	assert(delivered.includes("Learner answered 4.") && delivered.includes("paused"));
});

test("a changed history starts a fresh session with a text replay", async () => {
	fake.script = [{ text: "First." }, { text: "Summary noted." }];
	let a = agent([]);
	await a.prompt("Hi.");
	const edited = [{ role: "user", content: [{ type: "text", text: "[Summary: we covered greetings.]" }], timestamp: 1 }, ...transcript(a).slice(1)];
	a = agent(edited);
	await a.prompt("What did we cover?");
	assert.equal(fake.launches.length, 2);
	assert.equal(fake.launches[1]!.resume, undefined);
	const replay = JSON.stringify(fake.inputs[1]);
	assert(replay.includes("<earlier_conversation>") && replay.includes("we covered greetings") && replay.includes("What did we cover?"));
});

test("a new system prompt resumes the same session with the new prompt", async () => {
	fake.script = [{ text: "Probing done." }, { text: "Teaching now." }];
	let a = agent([], [lookupTool], "You are the prober.");
	await a.prompt("Start.");
	a = agent(transcript(a), [lookupTool, quizTool], "You are the teacher.");
	await a.prompt("Go on.");
	assert.equal(fake.launches.length, 2);
	assert.equal(fake.launches[1]!.resume, fake.launches[0]!.sessionId);
	assert.equal(fake.launches[1]!.systemPrompt.prompt, "You are the teacher.");
});

test("signed out: the request fails before dispatch with sign-in guidance", async () => {
	connect({ state: "signed-out", connected: false, account: null });
	const stream = claudeCodeStream(() => false)(claudeCodeModel("claude-haiku") ?? { id: "claude-haiku", provider: "claude-code", api: "claude-code" } as any, normalizeContext({ messages: [{ role: "user", content: "Hi", timestamp: 1 }] }));
	const result = await stream.result();
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage ?? "", /not signed in/);
	assert.equal(fake.launches.length, 0);
});

test("background work is refused when background use is off", async () => {
	connect({ allowBackgroundUse: false });
	const denials: string[] = [];
	const stream = claudeCodeStream(() => true, { captured() {}, beforeDispatch() {}, noDispatch: (kind) => { denials.push(kind); } })(claudeCodeModel("claude-haiku")!, normalizeContext({ messages: [{ role: "user", content: "Hi", timestamp: 1 }] }));
	const result = await stream.result();
	assert.match(result.errorMessage ?? "", /background use is off/);
	assert.deepEqual(denials, ["background"]);
	assert.equal(fake.launches.length, 0);
});

test("the Claude Code environment drops app secrets and API keys", () => {
	const env = claudeCodeEnv({ PATH: "/bin", ANTHROPIC_API_KEY: "sk-ant-x", OPENAI_API_KEY: "sk-x", LH_DESKTOP_API_SECRET: "s".repeat(64), CLAUDECODE: "1", HOME: "/home/x" });
	assert.equal(env.PATH, "/bin");
	assert.equal(env.HOME, "/home/x");
	for (const name of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "LH_DESKTOP_API_SECRET", "CLAUDECODE"]) assert.equal(env[name], undefined, name);
	assert.equal(env.ENABLE_CLAUDEAI_MCP_SERVERS, "false");
});

test("the executable is found at the installer location, an override, or on PATH", () => {
	const home = fs.mkdtempSync(path.join(scratch, "home-"));
	fs.mkdirSync(path.join(home, ".local", "bin"), { recursive: true });
	fs.writeFileSync(path.join(home, ".local", "bin", "claude.exe"), "");
	assert.equal(findClaudeExecutable({}, "win32", home)?.path, path.join(home, ".local", "bin", "claude.exe"));
	const other = path.join(scratch, "custom-claude.exe");
	fs.writeFileSync(other, "");
	assert.equal(findClaudeExecutable({ LH_CLAUDE_CODE_PATH: other }, "win32", home)?.path, other);
	assert.equal(findClaudeExecutable({ LH_CLAUDE_CODE_PATH: path.join(scratch, "missing.exe") }, "win32", home), undefined);
	const empty = fs.mkdtempSync(path.join(scratch, "empty-"));
	const npmDir = fs.mkdtempSync(path.join(scratch, "npm-"));
	fs.writeFileSync(path.join(npmDir, "claude.cmd"), "");
	fs.mkdirSync(path.join(npmDir, "node_modules", "@anthropic-ai", "claude-code", "bin"), { recursive: true });
	fs.writeFileSync(path.join(npmDir, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"), "");
	assert.equal(findClaudeExecutable({ PATH: npmDir }, "win32", empty)?.path, path.join(npmDir, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"));
});
