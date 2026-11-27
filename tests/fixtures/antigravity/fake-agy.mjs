// A scripted stand-in for Google's `agy acp`, for tests/antigravity-bridge.test.ts.
// It behaves like agy 1.5 where the bridge depends on it: ACP over stdio, the
// profile's global MCP config read when `authenticate` signs it in, permission
// requests before each tool call, MCP calls held until answered, `--login`
// reading a pasted code, and session files on disk for `session/resume`.
//
// Each model call takes the next step from <GEMINI_HOME>/fake-script.json:
//   { text?, thought?, calls?: [{ name, args }], native?: "run_command" }
// With `cancel: "ignore"` in the script, `session/cancel` is logged but the
// turn keeps running. Everything it sees is appended to <GEMINI_HOME>/fake-log.jsonl.
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const home = process.env.GEMINI_HOME;
const args = process.argv.slice(2);
const log = (entry) => appendFileSync(path.join(home, "fake-log.jsonl"), `${JSON.stringify(entry)}\n`);
const marker = path.join(home, "antigravity-acp", "fake-signed-in");
const scriptFile = path.join(home, "fake-script.json");
const readScript = () => { try { return JSON.parse(readFileSync(scriptFile, "utf8")); } catch { return {}; } };
const nextStep = () => { const script = readScript(); const step = (script.steps ?? []).shift(); writeFileSync(scriptFile, JSON.stringify(script)); return step ?? { text: "(unscripted)" }; };

log({ kind: "launch", args, env: { GEMINI_HOME: home, SSH_CONNECTION: process.env.SSH_CONNECTION, AGY_ACP_FORCE_FILE_STORAGE: process.env.AGY_ACP_FORCE_FILE_STORAGE, AGY_CLI_DISABLE_AUTO_UPDATE: process.env.AGY_CLI_DISABLE_AUTO_UPDATE, secret: !!process.env.LH_DESKTOP_API_SECRET, geminiKey: !!process.env.GEMINI_API_KEY, temp: process.env.TEMP ?? process.env.TMPDIR } });

if (args.includes("--login")) {
	process.stdout.write("Open this link in a browser to log in with Google:\n\n  https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=test&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&response_type=code&scope=openid&state=fake-state\n\nThen paste the authorization code, or the full URL of the page you land on, and press Enter:\n");
	let input = "";
	process.stdin.setEncoding("utf8");
	process.stdin.on("data", (chunk) => {
		input += chunk;
		if (!input.includes("\n")) return;
		const code = input.trim();
		log({ kind: "login-code", code });
		if (code === "good-code") {
			mkdirSync(path.dirname(marker), { recursive: true });
			writeFileSync(marker, "");
			process.stdout.write("Logged in as learner@example.invalid.\n");
			process.exit(0);
		}
		process.stdout.write("login failed\n");
		process.exit(1);
	});
	process.stdin.on("end", () => { process.stdout.write("login cancelled: no authorization code was entered\n"); process.exit(1); });
} else {
	runAcp();
}

function runAcp() {
	const MODELS = readScript().models ?? [
		{ value: "gemini-test-pro", name: "Gemini Test Pro", levels: ["low", "medium", "high", "xhigh"], size: 1048576 },
		{ value: "gemini-pro-orchestrator", name: "Orchestrator (Carbon)", levels: [], size: 1048576 },
		{ value: "claude-test", name: "Claude Test", levels: ["low", "medium", "high"], size: 1000000 },
		{ value: "fixed-test", name: "Fixed Test", levels: [], size: 131072 },
	];
	let id = 0, buffer = "";
	const pending = new Map();
	const sessions = new Map();
	let mcp;
	const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
	const notify = (sessionId, update) => send({ method: "session/update", params: { sessionId, update } });
	const ask = (method, params) => new Promise((resolve) => { const requestId = `agent-${++id}`; pending.set(requestId, resolve); send({ id: requestId, method, params }); });
	const options = (session) => {
		const model = MODELS.find((entry) => entry.value === session.model) ?? MODELS[0];
		return [
			{ id: "model", name: "Model", category: "model", type: "select", currentValue: session.model, options: MODELS.map((entry) => ({ value: entry.value, name: entry.name })) },
			...(model.levels.length ? [{ id: "thought_level", name: "Thinking Level", category: "thought_level", type: "select", currentValue: session.level ?? model.levels.at(-1), options: model.levels.map((value) => ({ value, name: value })) }] : []),
		];
	};
	const sessionFile = (sessionId) => path.join(home, "fake-sessions", `${sessionId}.json`);
	const save = (session) => { mkdirSync(path.dirname(sessionFile(session.id)), { recursive: true }); writeFileSync(sessionFile(session.id), JSON.stringify({ id: session.id, history: session.history })); };

	async function connectMcp() {
		let config;
		try { config = JSON.parse(readFileSync(path.join(home, "config", "mcp_config.json"), "utf8")); } catch { return; }
		const server = config.mcpServers?.lh;
		log({ kind: "mcp-config", server: server ? { url: server.serverUrl, timeoutSeconds: server.timeoutSeconds, eager: Object.keys(server.tools ?? {}) } : null });
		if (!server) return;
		const transport = new StreamableHTTPClientTransport(new URL(server.serverUrl), { requestInit: { headers: server.headers } });
		const client = new Client({ name: "fake-agy", version: "1.0.0" });
		await client.connect(transport);
		const listed = await client.listTools();
		log({ kind: "mcp-tools", tools: listed.tools.map((tool) => tool.name) });
		mcp = client;
	}

	async function prompt(session, content) {
		session.history.push({ role: "user", content });
		save(session);
		log({ kind: "prompt", sessionId: session.id, systemPrompt: session.systemPrompt, model: session.model, level: session.level, prompt: content });
		let used = 0, calls = 0;
		for (;;) {
			if (session.cancelled) return { stopReason: "cancelled" };
			const step = nextStep();
			used += 1000;
			if (step.thought) notify(session.id, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: step.thought } });
			if (step.text) for (const part of step.text.match(/.{1,6}/gs) ?? []) notify(session.id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: part } });
			notify(session.id, { sessionUpdate: "usage_update", used: 1000, size: MODELS.find((entry) => entry.value === session.model)?.size ?? 1048576 });
			if (step.native) {
				const toolCallId = `call_native_${++id}`;
				const answer = await ask("session/request_permission", { sessionId: session.id, toolCall: { sessionUpdate: "tool_call", toolCallId, name: step.native, title: `Run ${step.native}`, status: "pending", kind: "execute", rawInput: { CommandLine: "echo hi" } }, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }] });
				log({ kind: "permission", tool: step.native, outcome: answer.result?.outcome });
			}
			if (!step.calls?.length) {
				session.history.push({ role: "assistant", text: step.text ?? "" });
				save(session);
				return { stopReason: "end_turn", usage: { inputTokens: used + 200, outputTokens: 10 + calls, cachedReadTokens: 500, cachedWriteTokens: 0, thoughtTokens: 4, totalTokens: used + 714 + calls } };
			}
			const results = await Promise.all(step.calls.map(async (call) => {
				calls++;
				const toolCallId = `call_${randomUUID().slice(0, 8)}`;
				const rawInput = { toolSummary: "Doing it", ...call.args };
				const update = { toolCallId, name: `mcp_lh_${call.name}`, args: rawInput, kind: "other", title: `Run mcp_lh_${call.name}`, rawInput };
				notify(session.id, { sessionUpdate: "tool_call", ...update, status: "in_progress" });
				const answer = await ask("session/request_permission", { sessionId: session.id, toolCall: { sessionUpdate: "tool_call", ...update, status: "pending" }, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }] });
				log({ kind: "permission", tool: call.name, outcome: answer.result?.outcome });
				if (answer.result?.outcome?.optionId !== "allow") return { toolCallId, denied: true };
				const controller = new AbortController();
				session.controllers.add(controller);
				try {
					const result = await mcp.callTool({ name: call.name, arguments: call.args, _meta: { "antigravity.google/conversation_id": session.id, progressToken: toolCallId } }, undefined, { timeout: 3_600_000, signal: controller.signal });
					log({ kind: "result", sessionId: session.id, name: call.name, content: result.content, isError: result.isError ?? false });
					notify(session.id, { sessionUpdate: "tool_call_update", ...update, status: "completed" });
					return { toolCallId, result };
				} catch (error) {
					notify(session.id, { sessionUpdate: "tool_call_update", ...update, status: "failed" });
					log({ kind: "call-failed", name: call.name, error: String(error) });
					return { toolCallId, failed: true };
				} finally { session.controllers.delete(controller); }
			}));
			if (results.some((result) => result.failed) && session.cancelled) return { stopReason: "cancelled" };
		}
	}

	const handlers = {
		initialize: () => ({ protocolVersion: 1, agentInfo: { name: "Antigravity ACP Server", version: readScript().version ?? "1.5.18" }, agentCapabilities: { loadSession: true, promptCapabilities: { image: true, audio: false, embeddedContext: true }, sessionCapabilities: { resume: {} }, auth: { logout: {} }, _meta: { antigravity: { systemPrompt: { append: true } } } } }),
		authenticate: async () => {
			if (!existsSync(marker)) throw { code: -32603, message: "No browser is available here (this is a remote (SSH) session). Run `agy acp --login` in a terminal on this machine, then retry." };
			await connectMcp();
			return { _meta: { antigravity: { tier: { name: "Google AI Pro" } } } };
		},
		logout: () => { rmSync(marker, { force: true }); log({ kind: "logout" }); return {}; },
		"session/new": (params) => {
			const session = { id: randomUUID(), model: MODELS[0].value, systemPrompt: params._meta?.antigravity?.systemPrompt?.append, history: [], controllers: new Set() };
			sessions.set(session.id, session);
			save(session);
			log({ kind: "session/new", sessionId: session.id, systemPrompt: session.systemPrompt });
			setTimeout(() => notify(session.id, { sessionUpdate: "usage_update", used: 0, size: MODELS[0].size }), 5);
			return { sessionId: session.id, configOptions: options(session) };
		},
		"session/resume": (params) => {
			const file = sessionFile(params.sessionId);
			if (!existsSync(file)) throw { code: -32602, message: "Unknown session." };
			const stored = JSON.parse(readFileSync(file, "utf8"));
			const session = { id: stored.id, model: MODELS[0].value, systemPrompt: params._meta?.antigravity?.systemPrompt?.append, history: stored.history, controllers: new Set() };
			sessions.set(session.id, session);
			log({ kind: "session/resume", sessionId: session.id, systemPrompt: session.systemPrompt, history: session.history.length });
			return { configOptions: options(session) };
		},
		"session/set_config_option": (params) => {
			const session = sessions.get(params.sessionId);
			if (params.configId === "model") {
				if (!MODELS.some((entry) => entry.value === params.value)) throw { code: -32602, message: "Unknown model." };
				session.model = params.value; session.level = undefined;
				const size = MODELS.find((entry) => entry.value === params.value)?.size;
				setTimeout(() => notify(session.id, { sessionUpdate: "usage_update", used: 0, size }), 5);
			} else session.level = params.value;
			log({ kind: "set", configId: params.configId, value: params.value });
			return { configOptions: options(session) };
		},
		"session/prompt": (params) => { const session = sessions.get(params.sessionId); session.cancelled = false; return prompt(session, params.prompt); },
	};

	process.stdin.setEncoding("utf8");
	process.stdin.on("data", (chunk) => {
		buffer += chunk;
		let index;
		while ((index = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
			if (!line.trim()) continue;
			const message = JSON.parse(line);
			if (message.method === undefined && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); continue; }
			if (message.method === "session/cancel") {
				const session = sessions.get(message.params.sessionId);
				log({ kind: "cancel", sessionId: message.params.sessionId });
				if (readScript().cancel === "ignore") continue;
				if (session) { session.cancelled = true; for (const controller of session.controllers) controller.abort(); }
				continue;
			}
			const handler = handlers[message.method];
			if (!handler) { if (message.id !== undefined) send({ id: message.id, error: { code: -32601, message: "Method not found" } }); continue; }
			Promise.resolve().then(() => handler(message.params ?? {})).then(
				(result) => send({ id: message.id, result }),
				(error) => send({ id: message.id, error: { code: error?.code ?? -32603, message: error?.message ?? String(error) } }),
			);
		}
	});
	process.stdin.on("end", () => process.exit(0));
}
