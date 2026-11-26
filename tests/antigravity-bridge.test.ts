/** The Antigravity bridge, offline: a scripted stand-in for `agy acp`
 * (tests/fixtures/antigravity/fake-agy.mjs) runs as a real child process,
 * reads the profile's MCP config and calls the bridge's real MCP endpoint, so
 * tool calls, held results, resume, replay, sign-in and the controls run end
 * to end without Google's CLI or a network. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { after, afterEach, beforeEach, test } from "node:test";
import { Type } from "typebox";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-antigravity-"));
process.env.LH_DATA_DIR = scratch;
const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "antigravity", "fake-agy.mjs");
const { Agent } = await import("@earendil-works/pi-agent-core");
const { normalizeContext } = await import("@earendil-works/pi-ai");
const connection = await import("../src/agent/antigravity/connection.ts");
const sessions = await import("../src/agent/antigravity/session.ts");
const { antigravityModel, antigravityLevel } = await import("../src/agent/antigravity/catalog.ts");
const { antigravityStream } = await import("../src/agent/antigravity/stream.ts");
const { antigravityEnv, profileDir, runtimeDir } = await import("../src/agent/antigravity/environment.ts");
const { findAntigravityExecutable, versionSupported } = await import("../src/agent/antigravity/executable.ts");
const { cleanArguments, closeToolBridgeForTests } = await import("../src/agent/antigravity/tool-bridge.ts");
const release = await import("../src/agent/antigravity/release.ts");
const { antigravityResponse } = await import("../src/server/antigravity-http.ts");
const { piEngineForSpec } = await import("../src/agent/models.ts");
after(() => { sessions.resetAntigravitySessions(); closeToolBridgeForTests(); fs.rmSync(scratch, { recursive: true, force: true }); });

const profile = profileDir();
const marker = path.join(profile, "antigravity-acp", "fake-signed-in");
const executable = { path: FAKE, source: "override" as const, script: true };
const models = [
	{ id: "gemini-test-pro", name: "Gemini Test Pro", levels: ["low", "medium", "high", "xhigh"], contextWindow: 1_048_576 },
	{ id: "claude-test", name: "Claude Test", levels: ["low", "medium", "high"], contextWindow: 1_000_000 },
	{ id: "fixed-test", name: "Fixed Test", levels: [], contextWindow: 131_072 },
];
type Step = { text?: string; thought?: string; calls?: Array<{ name: string; args: Record<string, unknown> }>; native?: string };
function script(steps: Step[]): void { fs.mkdirSync(profile, { recursive: true }); fs.writeFileSync(path.join(profile, "fake-script.json"), JSON.stringify({ steps })); }
function events(kind?: string): any[] {
	let text = "";
	try { text = fs.readFileSync(path.join(profile, "fake-log.jsonl"), "utf8"); } catch { return []; }
	return text.split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((entry) => !kind || entry.kind === kind);
}
const launches = () => events("launch").filter((entry) => !entry.args.includes("--login"));
function connect(overrides: Record<string, unknown> = {}) {
	connection.setAntigravityStateForTests({
		status: { state: "connected", connected: true, version: "1.5.18", executable: FAKE, source: "override", account: { email: "learner@example.invalid", plan: "Google AI Pro" }, allowBackgroundUse: true, ...overrides },
		models, executable,
	});
}
beforeEach(() => {
	sessions.resetAntigravitySessions();
	fs.mkdirSync(path.dirname(marker), { recursive: true });
	fs.writeFileSync(marker, "");
	fs.rmSync(path.join(profile, "fake-log.jsonl"), { force: true });
	fs.rmSync(path.join(scratch, "antigravity", "sessions.json"), { force: true });
	script([]);
	connection.setAntigravityReleaseForTests({ latest: async () => null });
	connect();
});
afterEach(async () => {
	await sessions.pauseAllSessions();
	sessions.resetAntigravitySessions();
	connection.setAntigravityStateForTests(undefined);
	connection.setAntigravityReleaseForTests(undefined);
	delete process.env.LH_ANTIGRAVITY_PROBE; delete process.env.LH_ANTIGRAVITY_PATH;
});

const quizTool = {
	name: "quiz", label: "Quiz", description: "Pose a question.", parameters: Type.Object({ question: Type.String() }), executionMode: "sequential" as const,
	execute: async () => ({ content: [{ type: "text" as const, text: "Question posed — the turn ends here." }], details: null, terminate: true }),
};
const lookupTool = {
	name: "lookup", label: "Lookup", description: "Look something up.", parameters: Type.Object({ topic: Type.String() }),
	execute: async (_id: string, params: { topic: string }) => ({ content: [{ type: "text" as const, text: `About ${params.topic}: 7 × 8 = 56.` }], details: null }),
};
const pictureTool = {
	name: "picture", label: "Picture", description: "Draw a picture.", parameters: Type.Object({}),
	execute: async () => ({ content: [{ type: "text" as const, text: "Here it is." }, { type: "image" as const, data: "iVBORw0KGgo=", mimeType: "image/png" }], details: null }),
};
function agent(messages: any[], tools: any[] = [lookupTool, quizTool], prompt = "You are a tutor.", sessionId = "chat-1") {
	const model = antigravityModel("gemini-test-pro")!;
	return new Agent({ initialState: { systemPrompt: prompt, model, thinkingLevel: "low", tools, messages }, streamFn: antigravityStream(() => false) as any, sessionId });
}
const transcript = (a: InstanceType<typeof Agent>) => a.state.messages.filter((m: any) => m.role !== "system");
const assistants = (a: InstanceType<typeof Agent>) => transcript(a).filter((m: any) => m.role === "assistant") as any[];
const text = (a: InstanceType<typeof Agent>) => assistants(a).flatMap((m) => m.content).filter((c: any) => c.type === "text").map((c: any) => c.text);

test("catalog: the account's models with agy's thinking levels, real windows and zero cost", () => {
	const pro = antigravityModel("gemini-test-pro")!;
	assert.equal(pro.provider, "antigravity");
	assert.equal(pro.api, "antigravity");
	assert.deepEqual(pro.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	assert.equal(pro.contextWindow, 1_048_576);
	assert.equal(pro.thinkingLevelMap?.xhigh, "xhigh");
	assert.equal(pro.thinkingLevelMap?.max, null);
	assert.equal(pro.thinkingLevelMap?.off, null);
	assert.equal(antigravityLevel(pro, "high"), "high");
	const fixed = antigravityModel("fixed-test")!;
	assert.equal(fixed.thinkingLevelMap?.medium, "default");
	assert.equal(antigravityLevel(fixed, "medium"), undefined);
	assert.equal(piEngineForSpec({ provider: "antigravity", id: "claude-test" }).model.id, "claude-test");
	connect({ state: "signed-out", connected: false });
	assert.equal(antigravityModel("gemini-test-pro"), undefined);
});

test("the probe reads models, levels and windows without a model request, and leaves Orchestrator out", async () => {
	connection.setAntigravityStateForTests(undefined);
	process.env.LH_ANTIGRAVITY_PROBE = "1"; process.env.LH_ANTIGRAVITY_PATH = FAKE;
	const status = await connection.refreshAntigravity();
	assert.equal(status.state, "connected");
	assert.equal(status.version, "1.5.18");
	assert.equal(status.source, "override");
	assert.equal(status.account?.plan, "Google AI Pro");
	assert.deepEqual(status.models.map((model) => model.id), ["gemini-test-pro", "claude-test", "fixed-test"]);
	assert.deepEqual(status.models.find((model) => model.id === "claude-test")?.levels, ["low", "medium", "high"]);
	assert.deepEqual(connection.antigravityModelInfos().map((model) => model.contextWindow), [1_048_576, 1_000_000, 131_072]);
	assert.equal(events("prompt").length, 0, "no model request");
	assert(fs.existsSync(path.join(scratch, "antigravity", "state.json")), "the probe is cached for the next start");
	fs.rmSync(marker);
	assert.equal((await connection.refreshAntigravity()).state, "signed-out");
});

test("a run with a tool call stays in one agy process, gated to LearnHarness's tools, and streams text", async () => {
	script([{ calls: [{ name: "lookup", args: { topic: "7x8" } }] }, { thought: "Easy.", text: "7 × 8 is 56." }]);
	const a = agent([]);
	await a.prompt("Teach me 7 × 8.");
	assert.equal(launches().length, 1);
	const launch = launches()[0];
	assert.deepEqual(launch.args.slice(0, 7), ["acp", "--gemini-dir", profile, "--app-data-dir", "antigravity-acp", "--agent", "learnharness"]);
	assert.equal(launch.env.SSH_CONNECTION, "127.0.0.1 0 127.0.0.1 0");
	assert.equal(launch.env.AGY_ACP_FORCE_FILE_STORAGE, "1");
	assert.equal(launch.env.secret, false);
	const config = events("mcp-config")[0].server;
	assert.equal(config.timeoutSeconds, -1, "a held call never times out");
	assert.deepEqual(config.eager, ["lookup", "quiz"]);
	assert.deepEqual(events("mcp-tools")[0].tools, ["lookup", "quiz"]);
	assert.equal(events("session/new")[0].systemPrompt, "You are a tutor.");
	assert.deepEqual(events("set").map((entry) => [entry.configId, entry.value]), [["model", "gemini-test-pro"], ["thought_level", "low"]]);
	assert.deepEqual(events("permission")[0].outcome, { outcome: "selected", optionId: "allow" });
	assert.equal(events("result")[0].content[0].text, "About 7x8: 7 × 8 = 56.", "agy's toolSummary never reaches the tool");
	assert.deepEqual(text(a), ["7 × 8 is 56."]);
	const [call, final] = assistants(a);
	assert.equal(call.stopReason, "toolUse");
	assert.equal(call.content[0].name, "lookup");
	assert.match(call.content[0].id, /^call_/);
	assert.equal(call.usage.input, 1000);
	assert.equal(final.content[0].type, "thinking");
	// The turn's totals, less what the tool response already reported.
	assert.deepEqual([final.usage.input, final.usage.cacheRead, final.usage.output, final.usage.cost.total], [1200, 500, 11, 0]);
	assert.equal(call.usage.totalTokens + final.usage.totalTokens, 2711);
});

test("a posed question waits in the live session; the graded answer arrives as its result", async () => {
	script([{ calls: [{ name: "quiz", args: { question: "7 × 8?" } }] }, { text: "Correct!" }]);
	let a = agent([]);
	await a.prompt("Quiz me.");
	const answered = transcript(a).map((m: any) => m.role === "toolResult" ? { ...m, content: [{ type: "text", text: "Learner answered 56: correct." }] } : m);
	a = agent(answered);
	await a.continue();
	assert.equal(launches().length, 1, "no new agy process for the answer");
	assert.equal(events("result")[0].content[0].text, "Learner answered 56: correct.");
	assert.deepEqual(text(a), ["Correct!"]);
});

test("calls the model makes together come back as one response", async () => {
	script([{ calls: [{ name: "lookup", args: { topic: "a" } }, { name: "lookup", args: { topic: "b" } }] }, { text: "Both." }]);
	const a = agent([]);
	await a.prompt("Look up a and b.");
	assert.deepEqual(assistants(a)[0].content.map((c: any) => c.arguments.topic).sort(), ["a", "b"]);
	assert.deepEqual(events("result").map((entry) => entry.content[0].text).sort(), ["About a: 7 × 8 = 56.", "About b: 7 × 8 = 56."]);
	assert.deepEqual(text(a), ["Both."]);
});

test("agy's own tools are refused", async () => {
	script([{ native: "run_command", text: "Done." }]);
	const a = agent([]);
	await a.prompt("Run a command.");
	assert.deepEqual(events("permission")[0], { kind: "permission", tool: "run_command", outcome: { outcome: "selected", optionId: "deny" } });
});

test("images travel natively, in the prompt and in tool results", async () => {
	script([{ calls: [{ name: "picture", args: {} }] }, { text: "Nice." }]);
	const a = agent([], [pictureTool]);
	await a.prompt({ role: "user", content: [{ type: "text", text: "Look:" }, { type: "image", data: "AAAA", mimeType: "image/png" }], timestamp: Date.now() } as any);
	assert.deepEqual(events("prompt")[0].prompt, [{ type: "text", text: "Look:" }, { type: "image", data: "AAAA", mimeType: "image/png" }]);
	assert.deepEqual(events("result")[0].content[1], { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" });
});

test("after a restart the session resumes from agy's files instead of replaying", async () => {
	script([{ text: "Hello." }, { text: "Again." }]);
	let a = agent([]);
	await a.prompt("Hi.");
	const first = events("session/new")[0].sessionId;
	sessions.resetAntigravitySessions();
	a = agent(transcript(a));
	await a.prompt("Once more.");
	assert.equal(launches().length, 2);
	assert.equal(events("session/resume")[0].sessionId, first);
	assert.deepEqual(events("prompt")[1].prompt, [{ type: "text", text: "Once more." }]);
	assert.equal(events("set").filter((entry) => entry.configId === "model").length, 2, "the model is chosen again after resume");
});

test("a paused question resumes and delivers the real result as text", async () => {
	script([{ calls: [{ name: "quiz", args: { question: "2 + 2?" } }] }, { text: "Right, 4." }]);
	let a = agent([]);
	await a.prompt("Quiz me.");
	await sessions.pauseAllSessions();
	assert.equal(events("cancel").length, 1, "the open turn is cancelled before closing");
	const answered = transcript(a).map((m: any) => m.role === "toolResult" ? { ...m, content: [{ type: "text", text: "Learner answered 4." }] } : m);
	a = agent(answered);
	await a.continue();
	assert.equal(launches().length, 2);
	assert(events("session/resume").length === 1);
	const delivered = JSON.stringify(events("prompt")[1].prompt);
	assert(delivered.includes("Learner answered 4.") && delivered.includes("paused"));
	assert.deepEqual(text(a), ["Right, 4."]);
});

test("a changed history starts a fresh session with a text replay", async () => {
	script([{ text: "First." }, { text: "Summary noted." }]);
	let a = agent([]);
	await a.prompt("Hi.");
	const edited = [{ role: "user", content: [{ type: "text", text: "[Summary: we covered greetings.]" }], timestamp: 1 }, ...transcript(a).slice(1)];
	a = agent(edited);
	await a.prompt("What did we cover?");
	assert.equal(events("session/new").length, 2);
	assert.equal(events("session/resume").length, 0);
	const replay = JSON.stringify(events("prompt")[1].prompt);
	assert(replay.includes("<earlier_conversation>") && replay.includes("we covered greetings") && replay.includes("What did we cover?"));
});

test("a new system prompt or tool set resumes the same session in a new process", async () => {
	script([{ text: "Probing done." }, { text: "Teaching now." }]);
	let a = agent([], [lookupTool], "You are the prober.");
	await a.prompt("Start.");
	a = agent(transcript(a), [lookupTool, quizTool], "You are the teacher.");
	await a.prompt("Go on.");
	assert.equal(launches().length, 2);
	assert.equal(events("session/resume")[0].sessionId, events("session/new")[0].sessionId);
	assert.equal(events("session/resume")[0].systemPrompt, "You are the teacher.");
	assert.deepEqual(events("mcp-config")[1].server.eager, ["lookup", "quiz"]);
});

test("a model switch applies in place", async () => {
	script([{ text: "One." }, { text: "Two." }]);
	let a = agent([]);
	await a.prompt("Hi.");
	const claude = antigravityModel("claude-test")!;
	a = new Agent({ initialState: { systemPrompt: "You are a tutor.", model: claude, thinkingLevel: "medium", tools: [lookupTool, quizTool], messages: transcript(a) }, streamFn: antigravityStream(() => false) as any, sessionId: "chat-1" });
	await a.prompt("Again.");
	assert.equal(launches().length, 1);
	assert.deepEqual(events("set").slice(-2).map((entry) => [entry.configId, entry.value]), [["model", "claude-test"], ["thought_level", "medium"]]);
	assert.equal(events("prompt")[1].model, "claude-test");
});

test("signed out: the request fails before dispatch with sign-in guidance", async () => {
	connect({ state: "signed-out", connected: false, account: null });
	const stream = antigravityStream(() => false)({ id: "gemini-test-pro", provider: "antigravity", api: "antigravity" } as any, normalizeContext({ messages: [{ role: "user", content: "Hi", timestamp: 1 }] }));
	const result = await stream.result();
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage ?? "", /not signed in/);
	assert.match(result.errorMessage ?? "", /No API-key fallback/);
	assert.equal(launches().length, 0);
});

test("a sign-in that is gone fails the request and shows the connection signed out", async () => {
	fs.rmSync(marker);
	const result = await antigravityStream(() => false)(antigravityModel("gemini-test-pro")!, normalizeContext({ messages: [{ role: "user", content: "Hi", timestamp: 1 }] })).result();
	assert.match(result.errorMessage ?? "", /sign-in is no longer valid/);
	assert.equal(connection.antigravityStatus().state, "signed-out");
});

test("background work is refused when background use is off", async () => {
	connect({ allowBackgroundUse: false });
	const denials: string[] = [];
	const stream = antigravityStream(() => true, { captured() {}, beforeDispatch() {}, noDispatch: (kind) => { denials.push(kind); } })(antigravityModel("gemini-test-pro")!, normalizeContext({ messages: [{ role: "user", content: "Hi", timestamp: 1 }] }));
	const result = await stream.result();
	assert.match(result.errorMessage ?? "", /background use is off/);
	assert.deepEqual(denials, ["background"]);
	assert.equal(launches().length, 0);
});

test("one-shot callers release the agy process they used", async () => {
	script([{ text: "Done." }]);
	const a = agent([], [lookupTool], "You are a helper.", "one-shot-1");
	await a.prompt("Summarize.");
	assert.equal(sessions.liveSessionCount(), 1);
	await sessions.releaseTaggedSessions("one-shot-1");
	assert.equal(sessions.liveSessionCount(), 0);
});

test("agy's environment drops app secrets and keys, and isolates its profile", () => {
	const env = antigravityEnv("/tmp/run-x", { PATH: "/bin", HOME: "/home/x", LH_DESKTOP_API_SECRET: "s".repeat(64), GEMINI_API_KEY: "g", GOOGLE_API_KEY: "k", OPENAI_API_KEY: "o", AGY_ACP_CCPA_PROJECT: "p", BROWSER: "x", NODE_OPTIONS: "--inspect" }, "linux");
	assert.equal(env.PATH, "/bin");
	for (const name of ["LH_DESKTOP_API_SECRET", "GEMINI_API_KEY", "GOOGLE_API_KEY", "OPENAI_API_KEY", "AGY_ACP_CCPA_PROJECT", "BROWSER", "NODE_OPTIONS"]) assert.equal(env[name], undefined, name);
	assert.equal(env.GEMINI_HOME, profile);
	assert.equal(env.AGY_ACP_FORCE_FILE_STORAGE, "1");
	assert.equal(env.AGY_CLI_DISABLE_AUTO_UPDATE, "true");
	assert.equal(env.SSH_CONNECTION, "127.0.0.1 0 127.0.0.1 0");
	assert.equal(env.TMPDIR, "/tmp/run-x");
	assert.equal(antigravityEnv("C:\\t", { SSH_CONNECTION: "10.0.0.1 1 10.0.0.2 22" }, "win32").TEMP, "C:\\t");
	assert.equal(antigravityEnv("C:\\t", { SSH_CONNECTION: "10.0.0.1 1 10.0.0.2 22" }, "win32").SSH_CONNECTION, "10.0.0.1 1 10.0.0.2 22");
});

test("the executable: an override, the managed runtime, the installer's folder, then PATH", () => {
	const home = fs.mkdtempSync(path.join(scratch, "home-"));
	const root = fs.mkdtempSync(path.join(scratch, "runtime-"));
	assert.equal(findAntigravityExecutable({}, "win32", home, root), undefined);
	const onPath = fs.mkdtempSync(path.join(scratch, "path-"));
	fs.writeFileSync(path.join(onPath, "agy.exe"), "");
	assert.equal(findAntigravityExecutable({ PATH: onPath }, "win32", home, root)?.source, "path");
	fs.mkdirSync(path.join(home, "AppData", "Local", "agy", "bin"), { recursive: true });
	fs.writeFileSync(path.join(home, "AppData", "Local", "agy", "bin", "agy.exe"), "");
	assert.equal(findAntigravityExecutable({ PATH: onPath }, "win32", home, root)?.source, "installer");
	fs.mkdirSync(path.join(root, "versions", "1.5.18-a"), { recursive: true });
	fs.writeFileSync(path.join(root, "versions", "1.5.18-a", "agy.exe"), "");
	fs.writeFileSync(path.join(root, "current.json"), JSON.stringify({ version: "1.5.18", executable: path.join("versions", "1.5.18-a", "agy.exe") }));
	const managed = findAntigravityExecutable({ PATH: onPath }, "win32", home, root);
	assert.deepEqual([managed?.source, managed?.version], ["managed", "1.5.18"]);
	assert.equal(findAntigravityExecutable({ LH_ANTIGRAVITY_PATH: FAKE }, "win32", home, root)?.script, true);
	assert.equal(findAntigravityExecutable({ LH_ANTIGRAVITY_PATH: path.join(scratch, "missing.exe") }, "win32", home, root), undefined);
	assert(versionSupported("1.5.1") && versionSupported("agy_acp_server_1.6.0") && !versionSupported("1.4.9") && !versionSupported("agy_acp_server_1.1.1"));
});

test("agy's own toolSummary is stripped unless the tool declares it", () => {
	assert.deepEqual(cleanArguments(lookupTool as any, { toolSummary: "x", topic: "y" }), { topic: "y" });
	assert.deepEqual(cleanArguments({ ...lookupTool, parameters: Type.Object({ toolSummary: Type.String() }) } as any, { toolSummary: "x" }), { toolSummary: "x" });
});

test("a release must be Google's file for this platform", () => {
	const sha512 = "a".repeat(128);
	const windows = { version: "1.5.18", url: "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.18-6386224290725888/windows-x64/cli_windows_x64.exe", sha512 };
	assert.deepEqual(release.parseRelease(windows, "win32", "x64"), { ...windows, format: "executable", executableName: "agy.exe" });
	assert.equal(release.parseRelease({ ...windows, url: windows.url.replace("storage.googleapis.com", "example.com") }, "win32", "x64"), null);
	assert.equal(release.parseRelease(windows, "linux", "x64"), null);
	assert.equal(release.parseRelease({ ...windows, sha512: "not-a-hash" }, "win32", "x64"), null);
	const linux = { version: "1.5.18", url: "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.18-1/linux-arm-musl/cli_linux_arm64_musl.tar.gz", sha512 };
	assert.equal(release.parseRelease(linux, "linux", "arm64", true)?.executableName, "antigravity");
	assert.equal(release.releaseTarget("darwin", "arm64"), "darwin_arm64");
	assert.equal(release.releaseTarget("win32", "ia32"), null);
});

/** A one-file tar archive, the shape of Google's macOS and Linux releases. */
function tarGz(name: string, content: Buffer): Buffer {
	const header = Buffer.alloc(512);
	header.write(name, 0);
	header.write("0000755\0", 100);
	header.write("0000000\0", 108);
	header.write("0000000\0", 116);
	header.write(`${content.length.toString(8).padStart(11, "0")}\0`, 124);
	header.write("00000000000\0", 136);
	header.write("0", 156);
	header.write("ustar\u000000", 257);
	header.fill(" ", 148, 156);
	let sum = 0; for (const byte of header) sum += byte;
	header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
	const padding = Buffer.alloc((512 - (content.length % 512)) % 512);
	return gzipSync(Buffer.concat([header, content, padding, Buffer.alloc(1024)]));
}

test("installing a release verifies Google's checksum and activates it whole", async () => {
	const executableBytes = Buffer.from("fake executable");
	const archive = tarGz("cli/antigravity", Buffer.from("#!/bin/sh\n"));
	const server = http.createServer((request, response) => {
		const body = request.url === "/agy.exe" ? executableBytes : archive;
		response.writeHead(200, { "content-length": body.length }).end(body);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
	const root = fs.mkdtempSync(path.join(scratch, "install-"));
	try {
		const sha = (bytes: Buffer) => createHash("sha512").update(bytes).digest("hex");
		const progress: string[] = [];
		await assert.rejects(release.installRelease({ version: "1.5.17", url: `${base}/agy.exe`, sha512: "0".repeat(128), format: "executable", executableName: "agy.exe" }, { root }), /checksum/);
		assert.equal(release.managedRuntime(root), undefined, "a bad download activates nothing");
		const installed = await release.installRelease({ version: "1.5.18", url: `${base}/agy.exe`, sha512: sha(executableBytes), format: "executable", executableName: "agy.exe" }, { root, onProgress: (p) => progress.push(p.phase) });
		assert.deepEqual(release.managedRuntime(root), installed);
		assert.equal(fs.readFileSync(installed.path, "utf8"), "fake executable");
		assert.deepEqual([...new Set(progress)], ["downloading", "verifying", "installing"]);
		const unix = await release.installRelease({ version: "1.5.19", url: `${base}/cli.tar.gz`, sha512: sha(archive), format: "tar.gz", executableName: "antigravity" }, { root });
		assert.equal(path.basename(unix.path), "antigravity");
		assert.equal(fs.readFileSync(unix.path, "utf8"), "#!/bin/sh\n");
		assert.equal(release.managedRuntime(root)?.version, "1.5.19");
		assert.equal(fs.readdirSync(path.join(root, "versions")).length, 1, "older versions are removed");
		release.removeManagedRuntime(root);
		assert.equal(release.managedRuntime(root), undefined);
	} finally { server.close(); }
	assert.equal(runtimeDir(), path.join(scratch, "antigravity", "runtime"));
});

function control(body?: Record<string, unknown>, headers: Record<string, string> = {}): Request {
	return new Request("http://localhost:3000/api/antigravity", body
		? { method: "POST", headers: { "x-learnharness-antigravity": "1", origin: "http://localhost:3000", "content-type": "application/json", ...headers }, body: JSON.stringify(body) }
		: { headers: { "x-learnharness-antigravity": "1", ...headers } });
}
async function until(check: () => boolean, ms = 10_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!check()) { if (Date.now() > deadline) throw new Error("timed out"); await new Promise((resolve) => setTimeout(resolve, 25)); }
}

test("the controls: same-origin only, consent, and Google sign-in with a pasted code", async () => {
	assert.equal((await antigravityResponse(new Request("http://localhost:3000/api/antigravity"))).status, 403);
	assert.equal((await antigravityResponse(control({ op: "consent", enabled: false }, { origin: "https://evil.example" }))).status, 403);
	assert.equal((await (await antigravityResponse(control())).json()).state, "connected");
	assert.equal((await (await antigravityResponse(control({ op: "consent", enabled: false }))).json()).allowBackgroundUse, false);
	assert.equal(connection.antigravityBackgroundAllowed(), false);

	fs.rmSync(marker);
	process.env.LH_ANTIGRAVITY_PROBE = "1"; process.env.LH_ANTIGRAVITY_PATH = FAKE;
	connect({ state: "signed-out", connected: false, account: null });
	assert.equal((await antigravityResponse(control({ op: "login-start" }))).status, 200);
	await until(() => connection.antigravityStatus().login?.phase === "waiting");
	assert.match(connection.antigravityStatus().login?.url ?? "", /^https:\/\/accounts\.google\.com\/o\/oauth2\/auth\?/);
	const refused = await antigravityResponse(control({ op: "login-submit", code: "not a code" }));
	assert.equal(refused.status, 400);
	assert.match((await refused.json()).error, /Paste the code/);
	assert.equal((await antigravityResponse(control({ op: "login-submit", code: "good-code" }))).status, 200);
	await until(() => connection.antigravityStatus().connected && connection.antigravityStatus().login === null);
	assert.equal(connection.antigravityStatus().account?.email, "learner@example.invalid");
	assert.deepEqual(events("login-code").map((entry) => entry.code), ["good-code"]);

	assert.equal((await antigravityResponse(control({ op: "logout" }))).status, 200);
	assert.equal(connection.antigravityStatus().state, "signed-out");
	assert.equal(events("logout").length, 1);
	assert(!fs.existsSync(marker), "agy's own sign-out removed the sign-in");
});
