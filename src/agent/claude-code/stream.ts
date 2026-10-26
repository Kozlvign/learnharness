/** The stream function for Claude models served through Claude Code.
 *
 * pi's agent loop asks for one assistant response per call and runs tools
 * itself; Claude Code runs a whole conversation and calls tools over MCP.
 * The bridge keeps one live Claude Code session per conversation: each call
 * delivers what is new since the last one (the learner's message, or the
 * results of the calls Claude is waiting on) and streams Claude's next
 * response back as pi events, ending at the first tool call. */
import type { Api, AssistantMessage, AssistantMessageEvent, Model, SimpleStreamOptions, StreamFunction, TextContent, ThinkingContent, ToolCall, ToolResultMessage, TranscriptContext, UserMessage } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { EffortLevel, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { CLAUDE_CODE_LABEL } from "../../core/contracts/claude-code.ts";
import { markUnadmittedUsage, type NoDispatchKind, type SubscriptionDispatchLifecycle } from "../subscription-request-cycle.ts";
import { claudeCodeModelValue } from "./catalog.ts";
import {
	claudeCodeAbortController, claudeCodeAdmissionScope, claudeCodeBackgroundAllowed, claudeCodeExecutable,
	claudeCodeStatus, ensureClaudeCodeStatus, recordClaudeCodeRateLimit, rememberClaudeCodeContextWindow,
} from "./connection.ts";
import { claudeCodeEnv } from "./environment.ts";
import { dropSession, findLive, findRecord, openSession, rememberSession, TOOL_PREFIX, type LiveSession, type SessionConfig } from "./session.ts";
import { attachedUserContent, conversation, fingerprint, pausedResultsBlocks, replayBlocks, requestShape, toolResultContent, userBlocks, type ContentBlock, type ConversationMessage } from "./transcript.ts";

type ErrorKind = "missing" | "signed-out" | "background" | "limit" | "auth" | "cancelled" | "failed";
class BridgeError extends Error {
	constructor(readonly kind: ErrorKind, message: string) { super(message); }
}

const NO_FALLBACK = " No API-key fallback was used.";
export function claudeCodeError(kind: ErrorKind | string, detail = ""): string {
	switch (kind) {
		case "missing": return `Claude Code is not installed on this computer. Install it, sign in, then select Check again in Providers → ${CLAUDE_CODE_LABEL}.${NO_FALLBACK}`;
		case "signed-out": return `Claude Code is not signed in. Open Providers → ${CLAUDE_CODE_LABEL} and select Sign in.${NO_FALLBACK}`;
		case "background": return `${CLAUDE_CODE_LABEL} background use is off in this app. Enable it in Providers to run this work.${NO_FALLBACK}`;
		case "limit": return `${CLAUDE_CODE_LABEL} plan usage limit reached${detail}. Try again after it resets, or choose another model.${NO_FALLBACK}`;
		case "auth": return `Claude Code's sign-in is no longer valid. Open Providers → ${CLAUDE_CODE_LABEL} and sign in again.${NO_FALLBACK}`;
		case "cancelled": return `${CLAUDE_CODE_LABEL} request cancelled.${NO_FALLBACK}`;
		default: return `${CLAUDE_CODE_LABEL} request failed${detail ? `: ${detail}` : ""}. Retry, or check Claude Code in Providers.${NO_FALLBACK}`;
	}
}

function emptyMessage(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [], stopReason: "stop", timestamp: Date.now(),
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
}

export function claudeCodeStream(background: () => boolean, lifecycle?: SubscriptionDispatchLifecycle): StreamFunction<Api, SimpleStreamOptions> {
	return (model, context, options) => {
		const output = new AssistantMessageEventStream();
		void runTurn(model, context, options, background(), lifecycle, output);
		return output;
	};
}

function effortFor(model: Model<Api>, reasoning: string | undefined): { effort?: EffortLevel; thinkingOff: boolean } {
	if (!reasoning) return { thinkingOff: model.thinkingLevelMap?.off === "off" };
	const mapped = model.thinkingLevelMap?.[reasoning as keyof NonNullable<Model<Api>["thinkingLevelMap"]>];
	// "default": thinking on, for models without effort levels.
	return { effort: (typeof mapped === "string" && mapped !== "off" && mapped !== "default" ? mapped : undefined) as EffortLevel | undefined, thinkingOff: false };
}

async function runTurn(model: Model<Api>, context: TranscriptContext, options: SimpleStreamOptions | undefined, purpose: boolean, lifecycle: SubscriptionDispatchLifecycle | undefined, output: AssistantMessageEventStream): Promise<void> {
	const { controller, release } = claudeCodeAbortController(purpose);
	const signal = options?.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
	const message = emptyMessage(model);
	const progress = { started: false };
	let dispatched = false;
	let session: LiveSession | undefined;
	try {
		const status = await ensureClaudeCodeStatus();
		if (status.state === "missing") throw new BridgeError("missing", "missing");
		if (!status.connected) throw new BridgeError("signed-out", "signed out");
		if (purpose && !claudeCodeBackgroundAllowed()) throw new BridgeError("background", "background");
		const executable = claudeCodeExecutable();
		if (!executable) throw new BridgeError("missing", "missing");
		const scope = claudeCodeAdmissionScope(model.id);
		lifecycle?.captured(scope);
		if (signal.aborted) throw new BridgeError("cancelled", "cancelled");

		const shape = requestShape(context.messages);
		const messages = conversation(context.messages);
		const fingerprints = messages.map(fingerprint);
		const config: SessionConfig = {
			executable, env: claudeCodeEnv(), model: claudeCodeModelValue(model.id), ...effortFor(model, options?.reasoning),
			systemPrompt: shape.systemPrompt, systemKey: shape.systemKey, tools: shape.tools, toolsKey: shape.toolsKey,
			persist: shape.tools.length > 0, tag: options?.sessionId,
		};
		const plan = await prepare(messages, fingerprints, config);
		session = plan.session;
		lifecycle?.beforeDispatch(scope);
		dispatched = true;
		plan.deliver();
		session.known = fingerprints;
		session.lastUsed = Date.now();
		await consume(session, message, output, signal, config.model, progress);
		// The agent loop appends this response to the transcript as-is.
		session.known = [...fingerprints, fingerprint(message)];
		session.busy = false;
		session.lastUsed = Date.now();
		rememberSession(session);
	} catch (error) {
		const kind: ErrorKind = signal.aborted ? (controller.signal.reason === "background" ? "background" : "cancelled") : error instanceof BridgeError ? error.kind : "failed";
		// The Claude transcript may now hold a partial turn: never resume it.
		if (session) void dropSession(session, true);
		if (!dispatched) {
			markUnadmittedUsage(message.usage);
			const denial: NoDispatchKind = kind === "cancelled" ? "all" : kind === "background" ? "background" : "other";
			try { lifecycle?.noDispatch(denial); } catch { /* the cycle already settled */ }
		}
		const detail = error instanceof BridgeError ? (error.kind === "failed" || error.kind === "limit" ? error.message : "") : error instanceof Error ? error.message : "";
		const failed: AssistantMessage = { ...message, stopReason: signal.aborted ? "aborted" : "error", errorMessage: claudeCodeError(kind, kind === "failed" || kind === "limit" ? detail : "") };
		if (!progress.started) output.push({ type: "start", partial: failed });
		output.push({ type: "error", reason: failed.stopReason as "error" | "aborted", error: failed });
	} finally {
		release();
		output.end();
	}
}

interface Plan { session: LiveSession; deliver: () => void }

/** Splits the new messages into the leading tool results and what follows. */
function splitDelta(delta: readonly ConversationMessage[]): { results: ToolResultMessage[]; users: UserMessage[]; clean: boolean } {
	const results: ToolResultMessage[] = [], users: UserMessage[] = [];
	let clean = true;
	for (const message of delta) {
		if (message.role === "toolResult" && users.length === 0) results.push(message);
		else if (message.role === "user") users.push(message);
		else clean = false;
	}
	return { results, users, clean };
}

/** Finds or opens the session for this conversation and prepares what to send. */
async function prepare(messages: ConversationMessage[], fingerprints: string[], config: SessionConfig): Promise<Plan> {
	const live = findLive(fingerprints, config.tag);
	if (live) {
		const plan = await continueLive(live, messages.slice(live.known.length), config);
		if (plan) return plan;
		await dropSession(live, true);
	}
	const record = findRecord(fingerprints, config.tag);
	if (record) {
		const delta = messages.slice(record.known.length);
		const { results, users, clean } = splitDelta(delta);
		const covered = record.awaiting.every((id) => results.some((result) => result.toolCallId === id)) && results.every((result) => record.awaiting.includes(result.toolCallId));
		if (clean && covered && (results.length > 0 || users.length > 0)) {
			const session = await openSession({ ...config, resume: record.sessionId });
			session.busy = true;
			const content: ContentBlock[] = results.length ? pausedResultsBlocks(results, users) : users.flatMap(userBlocks);
			return { session, deliver: () => session.send(content) };
		}
	}
	const session = await openSession({ ...config, resume: undefined });
	session.busy = true;
	let lastAssistant = -1;
	messages.forEach((message, index) => { if (message.role === "assistant") lastAssistant = index; });
	const content = replayBlocks(messages.slice(0, lastAssistant + 1), messages.slice(lastAssistant + 1));
	return { session, deliver: () => session.send(content) };
}

/** Continues a live session, or returns undefined when the new messages do
 * not fit what it is waiting for. */
async function continueLive(session: LiveSession, delta: ConversationMessage[], config: SessionConfig): Promise<Plan | undefined> {
	const { results, users, clean } = splitDelta(delta);
	if (!clean) return undefined;
	const awaiting = [...session.awaiting];
	if (awaiting.length) {
		const ids = new Set(results.map((result) => result.toolCallId));
		if (awaiting.some((id) => !ids.has(id)) || results.some((result) => !session.awaiting.has(result.toolCallId))) return undefined;
	} else if (results.length || !users.length) return undefined;

	const optionsChanged = config.systemKey !== session.config.systemKey || config.effort !== session.config.effort || config.thinkingOff !== session.config.thinkingOff;
	if (optionsChanged) {
		// The prompt is fixed for a running process: resume the same Claude
		// session with the new options. Open calls become paused results.
		const known = session.known;
		session.busy = true; // nobody else may pick it while it restarts
		await dropSession(session);
		const next = await openSession({ ...config, resume: session.sessionId });
		next.known = known;
		next.busy = true;
		const content: ContentBlock[] = results.length ? pausedResultsBlocks(results, users) : users.flatMap(userBlocks);
		return { session: next, deliver: () => next.send(content) };
	}
	session.busy = true;
	if (config.toolsKey !== session.config.toolsKey) session.setTools(config.tools, config.toolsKey);
	try { await session.setModel(config.model); } catch { session.busy = false; return undefined; }
	return {
		session,
		deliver: () => {
			if (!results.length) { session.send(users.flatMap(userBlocks)); return; }
			results.forEach((result, index) => {
				const extra = index === results.length - 1 ? attachedUserContent(users) : [];
				session.answer(result.toolCallId, [...toolResultContent(result), ...extra], result.isError);
			});
		},
	};
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(new BridgeError("cancelled", "cancelled"));
	return new Promise((resolve, reject) => {
		const onAbort = () => reject(new BridgeError("cancelled", "cancelled"));
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then((value) => { signal.removeEventListener("abort", onAbort); resolve(value); }, (error) => { signal.removeEventListener("abort", onAbort); reject(error); });
	});
}

type StreamEvent = Extract<SDKMessage, { type: "stream_event" }>["event"];

/** Streams Claude's next response into pi events, up to its first tool call
 * or the end of its turn. */
async function consume(session: LiveSession, message: AssistantMessage, output: AssistantMessageEventStream, signal: AbortSignal, modelValue: string, progress: { started: boolean }): Promise<void> {
	const push = (event: AssistantMessageEvent) => output.push(event);
	const start = () => { if (!progress.started) { progress.started = true; push({ type: "start", partial: message }); } };
	/** Anthropic block index → pi content index, per API message. */
	let blocks = new Map<number, number>();
	const json = new Map<number, string>();
	let stopReason: string | null = null;
	let lastError: string | undefined;
	const usage = message.usage;
	const usageBase = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0 };
	const settleUsage = () => { usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite; };

	const handle = (event: StreamEvent): "toolUse" | undefined => {
		switch (event.type) {
			case "message_start": {
				start();
				blocks = new Map();
				message.responseId = event.message.id;
				message.responseModel = event.message.model;
				const u = event.message.usage as unknown as Record<string, number | Record<string, number> | undefined>;
				usageBase.input = usage.input; usageBase.cacheRead = usage.cacheRead; usageBase.cacheWrite = usage.cacheWrite; usageBase.output = usage.output;
				usage.input = usageBase.input + Number(u.input_tokens ?? 0);
				usage.cacheRead = usageBase.cacheRead + Number(u.cache_read_input_tokens ?? 0);
				usage.cacheWrite = usageBase.cacheWrite + Number(u.cache_creation_input_tokens ?? 0);
				const creation = u.cache_creation as Record<string, number> | undefined;
				if (creation && typeof creation.ephemeral_1h_input_tokens === "number") usage.cacheWrite1h = (usage.cacheWrite1h ?? 0) + creation.ephemeral_1h_input_tokens;
				settleUsage();
				return;
			}
			case "content_block_start": {
				start();
				const block = event.content_block as { type: string; id?: string; name?: string; data?: string };
				if (block.type === "text") {
					blocks.set(event.index, message.content.push({ type: "text", text: "" }) - 1);
					push({ type: "text_start", contentIndex: blocks.get(event.index)!, partial: message });
				} else if (block.type === "thinking") {
					blocks.set(event.index, message.content.push({ type: "thinking", thinking: "" }) - 1);
					push({ type: "thinking_start", contentIndex: blocks.get(event.index)!, partial: message });
				} else if (block.type === "redacted_thinking") {
					const index = message.content.push({ type: "thinking", thinking: "", redacted: true, thinkingSignature: block.data }) - 1;
					push({ type: "thinking_start", contentIndex: index, partial: message });
					push({ type: "thinking_end", contentIndex: index, content: "", partial: message });
				} else if (block.type === "tool_use" && block.name?.startsWith(TOOL_PREFIX) && block.id) {
					blocks.set(event.index, message.content.push({ type: "toolCall", id: block.id, name: block.name.slice(TOOL_PREFIX.length), arguments: {} }) - 1);
					json.set(event.index, "");
					push({ type: "toolcall_start", contentIndex: blocks.get(event.index)!, partial: message });
				}
				return;
			}
			case "content_block_delta": {
				const index = blocks.get(event.index);
				if (index === undefined) return;
				const delta = event.delta as { type: string; text?: string; thinking?: string; signature?: string; partial_json?: string };
				const target = message.content[index]!;
				if (delta.type === "text_delta" && target.type === "text") { target.text += delta.text ?? ""; push({ type: "text_delta", contentIndex: index, delta: delta.text ?? "", partial: message }); }
				else if (delta.type === "thinking_delta" && target.type === "thinking") { target.thinking += delta.thinking ?? ""; push({ type: "thinking_delta", contentIndex: index, delta: delta.thinking ?? "", partial: message }); }
				else if (delta.type === "signature_delta" && target.type === "thinking") target.thinkingSignature = delta.signature;
				else if (delta.type === "input_json_delta" && target.type === "toolCall") { json.set(event.index, (json.get(event.index) ?? "") + (delta.partial_json ?? "")); push({ type: "toolcall_delta", contentIndex: index, delta: delta.partial_json ?? "", partial: message }); }
				return;
			}
			case "content_block_stop": {
				const index = blocks.get(event.index);
				if (index === undefined) return;
				const target = message.content[index]!;
				if (target.type === "text") push({ type: "text_end", contentIndex: index, content: (target as TextContent).text, partial: message });
				else if (target.type === "thinking") push({ type: "thinking_end", contentIndex: index, content: (target as ThinkingContent).thinking, partial: message });
				else if (target.type === "toolCall") {
					const call = target as ToolCall;
					const text = json.get(event.index) ?? "";
					try {
						const parsed: unknown = text.trim() ? JSON.parse(text) : {};
						if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) call.arguments = parsed as ToolCall["arguments"];
						else call.argumentsError = `Arguments were not a JSON object: ${text}`;
					} catch { call.argumentsError = `Arguments were not valid JSON: ${text}`; }
					session.noteCall(call.id, call.name, call.arguments);
					push({ type: "toolcall_end", contentIndex: index, toolCall: call, partial: message });
				}
				return;
			}
			case "message_delta": {
				stopReason = (event.delta as { stop_reason?: string | null }).stop_reason ?? stopReason;
				const u = event.usage as unknown as Record<string, number | Record<string, number> | undefined>;
				if (typeof u.output_tokens === "number") usage.output = usageBase.output + u.output_tokens;
				const details = u.output_tokens_details as Record<string, number> | undefined;
				if (typeof details?.thinking_tokens === "number") usage.reasoning = (usage.reasoning ?? 0) + details.thinking_tokens;
				settleUsage();
				return;
			}
			case "message_stop": {
				if (stopReason === "tool_use" && message.content.some((block) => block.type === "toolCall")) return "toolUse";
				return;
			}
		}
		return undefined;
	};

	for (;;) {
		const next = await abortable(session.events.next(), signal);
		if (next.done) {
			const tail = session.stderrTail.trim().split("\n").filter(Boolean).at(-1);
			throw new BridgeError("failed", session.failure ?? tail ?? "Claude Code stopped unexpectedly");
		}
		const event = next.value;
		if (event.type === "stream_event") {
			if (event.parent_tool_use_id) continue;
			if (handle(event.event) === "toolUse") {
				message.stopReason = "toolUse";
				push({ type: "done", reason: "toolUse", message });
				return;
			}
		} else if (event.type === "assistant") {
			if (event.error) lastError = event.error;
		} else if (event.type === "rate_limit_event") {
			recordClaudeCodeRateLimit(event.rate_limit_info);
		} else if (event.type === "result") {
			for (const usageEntry of Object.values(event.modelUsage ?? {})) rememberClaudeCodeContextWindow(modelValue, usageEntry.contextWindow);
			if (event.subtype === "success" && !event.is_error) {
				start();
				message.stopReason = stopReason === "max_tokens" ? "length" : "stop";
				push({ type: "done", reason: message.stopReason as "stop" | "length", message });
				return;
			}
			throw resultError(lastError, event);
		}
	}
}

function resultError(assistantError: string | undefined, result: Extract<SDKMessage, { type: "result" }>): BridgeError {
	const text = "errors" in result && Array.isArray(result.errors) ? result.errors.join("; ") : "result" in result ? String(result.result ?? "") : "";
	if (assistantError === "rate_limit" || /usage limit|rate.?limit/i.test(text)) {
		const reset = claudeCodeStatus().usage.find((window) => window.status === "rejected")?.resetsAt;
		return new BridgeError("limit", reset ? ` (resets ${new Date(reset).toLocaleString()})` : "");
	}
	if (assistantError === "authentication_failed" || assistantError === "oauth_org_not_allowed" || /not logged in|authenticat|\/login/i.test(text)) return new BridgeError("auth", "auth");
	return new BridgeError("failed", (text || assistantError || "unknown error").slice(0, 300));
}
