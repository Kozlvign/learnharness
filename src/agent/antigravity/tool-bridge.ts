/** LearnHarness's tools for agy, over MCP's Streamable HTTP transport on
 * 127.0.0.1. One HTTP server serves every session; each session has its own
 * endpoint path and bearer token, so an agy process can reach only its own
 * session's tools. A tool call's HTTP request stays open until the agent loop
 * delivers the result, which for a posed question means until the learner
 * answers (agy is configured with no tool timeout). */
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import http from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Tool } from "@earendil-works/pi-ai";
import { TOOL_SERVER } from "./environment.ts";

export interface ToolCallRequest {
	name: string;
	args: Record<string, unknown>;
	/** agy's conversation id, as it reports it in the call's `_meta`. */
	conversationId?: string;
	signal: AbortSignal;
}

export interface EndpointHandlers {
	tools: () => readonly Tool[];
	call: (request: ToolCallRequest) => Promise<CallToolResult>;
}

export interface ToolEndpoint {
	url: string;
	token: string;
	/** Resolves on the first authenticated request: agy connects when it starts. */
	connected: Promise<void>;
	close: () => void;
}

interface Endpoint {
	token: Buffer;
	handlers: EndpointHandlers;
	transports: Map<string, StreamableHTTPServerTransport>;
	markConnected: () => void;
}

interface BridgeState { server?: http.Server; port?: number; starting?: Promise<number>; endpoints: Map<string, Endpoint> }
const KEY = Symbol.for("lh.antigravity.tools");
function bridge(): BridgeState {
	const global = globalThis as typeof globalThis & { [KEY]?: BridgeState };
	return global[KEY] ??= { endpoints: new Map() };
}

/** agy adds its own `toolSummary` to the arguments it shows; a tool that
 * does not declare it must not receive it. */
export function cleanArguments(tool: Tool | undefined, args: unknown): Record<string, unknown> {
	if (!args || typeof args !== "object" || Array.isArray(args)) return {};
	const record = args as Record<string, unknown>;
	const properties = (tool?.parameters as { properties?: Record<string, unknown> } | undefined)?.properties;
	if (!("toolSummary" in record) || (properties && "toolSummary" in properties)) return record;
	const { toolSummary: _summary, ...rest } = record;
	return rest;
}

function makeServer(endpoint: Endpoint): Server {
	const server = new Server({ name: TOOL_SERVER, version: "1.0.0" }, { capabilities: { tools: { listChanged: true } } });
	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: endpoint.handlers.tools().map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters as { type: "object"; [key: string]: unknown } })),
	}));
	server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
		const tool = endpoint.handlers.tools().find((candidate) => candidate.name === request.params.name);
		if (!tool) return { content: [{ type: "text", text: `LearnHarness has no tool named ${request.params.name}.` }], isError: true };
		const meta = request.params._meta as Record<string, unknown> | undefined;
		const conversation = meta?.["antigravity.google/root_conversation_id"] ?? meta?.["antigravity.google/conversation_id"];
		return endpoint.handlers.call({
			name: tool.name, args: cleanArguments(tool, request.params.arguments),
			...(typeof conversation === "string" ? { conversationId: conversation } : {}), signal: extra.signal,
		});
	});
	return server;
}

function authorized(endpoint: Endpoint, header: string | undefined): boolean {
	const supplied = Buffer.from(header?.startsWith("Bearer ") ? header.slice(7) : "");
	return supplied.length === endpoint.token.length && timingSafeEqual(supplied, endpoint.token);
}

async function handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
	const match = /^\/mcp\/([\w-]{16,64})\/?$/.exec(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
	const endpoint = match ? bridge().endpoints.get(match[1]!) : undefined;
	if (!endpoint) { response.writeHead(404).end(); return; }
	if (!authorized(endpoint, request.headers.authorization)) { response.writeHead(401).end(); return; }
	endpoint.markConnected();
	const sessionHeader = request.headers["mcp-session-id"];
	const sessionId = Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader;
	let transport = sessionId ? endpoint.transports.get(sessionId) : undefined;
	if (!transport) {
		if (sessionId) { response.writeHead(404).end(); return; }
		const created: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
			sessionIdGenerator: () => randomUUID(),
			onsessioninitialized: (id) => { endpoint.transports.set(id, created); },
		});
		created.onclose = () => { if (created.sessionId) endpoint.transports.delete(created.sessionId); };
		await makeServer(endpoint).connect(created);
		await created.handleRequest(request, response);
		// A request that did not initialize a session leaves nothing to keep.
		if (!created.sessionId) void created.close().catch(() => {});
		return;
	}
	await transport.handleRequest(request, response);
}

async function port(): Promise<number> {
	const state = bridge();
	if (state.port !== undefined) return state.port;
	return state.starting ??= new Promise<number>((resolve, reject) => {
		const server = http.createServer((request, response) => {
			void handle(request, response).catch(() => { if (!response.headersSent) response.writeHead(500); response.end(); });
		});
		// A tool call stays open while the learner thinks.
		server.requestTimeout = 0;
		server.timeout = 0;
		server.headersTimeout = 60_000;
		server.keepAliveTimeout = 60_000;
		server.once("error", (error) => { state.starting = undefined; reject(error); });
		server.listen(0, "127.0.0.1", () => {
			server.unref();
			state.server = server;
			state.port = (server.address() as { port: number }).port;
			resolve(state.port);
		});
	});
}

/** A new endpoint for one session. */
export async function openToolEndpoint(handlers: EndpointHandlers): Promise<ToolEndpoint> {
	const listening = await port();
	const id = randomUUID();
	const token = randomBytes(32).toString("base64url");
	let markConnected!: () => void;
	const connected = new Promise<void>((resolve) => { markConnected = resolve; });
	const endpoint: Endpoint = { token: Buffer.from(token), handlers, transports: new Map(), markConnected };
	bridge().endpoints.set(id, endpoint);
	return {
		url: `http://127.0.0.1:${listening}/mcp/${id}`,
		token,
		connected,
		close: () => {
			bridge().endpoints.delete(id);
			for (const transport of endpoint.transports.values()) void transport.close().catch(() => {});
			endpoint.transports.clear();
		},
	};
}

/** Tests: stops the shared server. */
export function closeToolBridgeForTests(): void {
	const state = bridge();
	for (const endpoint of state.endpoints.values()) for (const transport of endpoint.transports.values()) void transport.close().catch(() => {});
	state.endpoints.clear();
	state.server?.close();
	state.server = undefined; state.port = undefined; state.starting = undefined;
}
