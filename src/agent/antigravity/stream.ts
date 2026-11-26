/** The stream function for models served through Antigravity.
 *
 * pi's agent loop asks for one assistant response per call and runs tools
 * itself; agy runs a whole conversation and calls tools over MCP. The bridge
 * keeps one live agy session per conversation: each call delivers what is new
 * since the last one (the learner's message, or the results of the calls agy
 * is waiting on) and streams agy's next response back as pi events, ending at
 * the first tool call that reaches LearnHarness's MCP endpoint.
 *
 * Usage: agy reports the conversation's size after each model call and the
 * turn's totals when the turn ends. A response that ends at a tool call
 * carries the sizes of its calls; the turn's last response carries the rest
 * of the totals, so the totals add up and the last response's size is the
 * conversation's size. */
import type { Api, AssistantMessage, AssistantMessageEvent, Model, SimpleStreamOptions, StreamFunction, TextContent, ThinkingContent, ToolCall, ToolResultMessage, TranscriptContext, UserMessage } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { ANTIGRAVITY_LABEL } from "../../core/contracts/antigravity.ts";
import { markUnadmittedUsage, type NoDispatchKind, type SubscriptionDispatchLifecycle } from "../subscription-request-cycle.ts";
import { AcpError, isSignInRequired } from "./acp-client.ts";
import { antigravityLevel } from "./catalog.ts";
import {
	antigravityAbortController, antigravityAdmissionScope, antigravityBackgroundAllowed, antigravityExecutable,
	ensureAntigravityStatus, markAntigravitySignedOut, rememberAntigravityContextWindow,
} from "./connection.ts";
import { dropSession, findLive, findRecord, openSession, pauseSession, rememberSession, SessionError, type LiveSession, type SessionConfig } from "./session.ts";
import { attachedUserContent, conversation, fingerprint, pausedResultsBlocks, replayBlocks, requestShape, toolResultContent, userBlocks, type AcpContent, type ConversationMessage } from "./transcript.ts";

type ErrorKind = "missing" | "outdated" | "signed-out" | "background" | "limit" | "auth" | "unavailable" | "cancelled" | "failed";
class BridgeError extends Error {
	constructor(readonly kind: ErrorKind, message: string) { super(message); }
}

const NO_FALLBACK = " No API-key fallback was used.";
export function antigravityError(kind: ErrorKind | string, detail = ""): string {
	switch (kind) {
		case "missing": return `Antigravity is not installed on this computer. Install it in Providers → ${ANTIGRAVITY_LABEL}, sign in, then try again.${NO_FALLBACK}`;
		case "outdated": return `This Antigravity version is too old for LearnHarness. Update it in Providers → ${ANTIGRAVITY_LABEL}.${NO_FALLBACK}`;
		case "signed-out": return `Antigravity is not signed in. Open Providers → ${ANTIGRAVITY_LABEL} and sign in with Google.${NO_FALLBACK}`;
		case "background": return `${ANTIGRAVITY_LABEL} background use is off in this app. Enable it in Providers to run this work.${NO_FALLBACK}`;
		case "limit": return `${ANTIGRAVITY_LABEL} plan usage limit reached. Try again later, or choose another model.${NO_FALLBACK}`;
		case "auth": return `Antigravity's Google sign-in is no longer valid. Open Providers → ${ANTIGRAVITY_LABEL} and sign in again.${NO_FALLBACK}`;
		case "unavailable": return `This model is not available on your Google account. Choose another ${ANTIGRAVITY_LABEL} model.${NO_FALLBACK}`;
		case "cancelled": return `${ANTIGRAVITY_LABEL} request cancelled.${NO_FALLBACK}`;
		default: return `${ANTIGRAVITY_LABEL} request failed${detail ? `: ${detail}` : ""}. Retry, or check Antigravity in Providers.${NO_FALLBACK}`;
	}
}

function emptyMessage(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [], stopReason: "stop", timestamp: Date.now(),
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
}

export function antigravityStream(background: () => boolean, lifecycle?: SubscriptionDispatchLifecycle): StreamFunction<Api, SimpleStreamOptions> {
	return (model, context, options) => {
		const output = new AssistantMessageEventStream();
		void runTurn(model, context, options, background(), lifecycle, output);
		return output;
	};
}

/** An agy error, sorted into what the learner is told. */
function classify(error: unknown): BridgeError {
	if (error instanceof BridgeError) return error;
	// The status said signed in, so agy refusing the sign-in means it expired or was revoked.
	if (error instanceof SessionError) return new BridgeError(error.kind === "signed-out" ? "auth" : error.kind, error.message);
	const message = error instanceof Error ? error.message : String(error);
	if (isSignInRequired(error)) return new BridgeError("auth", message);
	if (/RESOURCE_EXHAUSTED|quota|rate.?limit|\b429\b|usage limit|SUBSCRIPTION_REQUIRED/i.test(message)) return new BridgeError("limit", message);
	return new BridgeError("failed", (error instanceof AcpError ? message : message || "unknown error").slice(0, 300));
}

async function runTurn(model: Model<Api>, context: TranscriptContext, options: SimpleStreamOptions | undefined, purpose: boolean, lifecycle: SubscriptionDispatchLifecycle | undefined, output: AssistantMessageEventStream): Promise<void> {
	const { controller, release } = antigravityAbortController(purpose);
	const signal = options?.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
	const message = emptyMessage(model);
	const progress = { started: false };
	let dispatched = false;
	let session: LiveSession | undefined;
	try {
		const status = await ensureAntigravityStatus();
		if (status.state === "missing") throw new BridgeError("missing", "missing");
		if (status.state === "outdated") throw new BridgeError("outdated", "outdated");
		if (!status.connected) throw new BridgeError("signed-out", "signed out");
		if (purpose && !antigravityBackgroundAllowed()) throw new BridgeError("background", "background");
		const executable = antigravityExecutable();
		if (!executable) throw new BridgeError("missing", "missing");
		const scope = antigravityAdmissionScope(model.id);
		lifecycle?.captured(scope);
		if (signal.aborted) throw new BridgeError("cancelled", "cancelled");

		const shape = requestShape(context.messages);
		const messages = conversation(context.messages);
		const fingerprints = messages.map(fingerprint);
		const config: SessionConfig = {
			executable, model: model.id, level: antigravityLevel(model, options?.reasoning),
			systemPrompt: shape.systemPrompt, systemKey: shape.systemKey, tools: shape.tools, toolsKey: shape.toolsKey,
			persist: shape.tools.length > 0, ...(options?.sessionId ? { tag: options.sessionId } : {}),
		};
		const plan = await prepare(messages, fingerprints, config);
		session = plan.session;
		lifecycle?.beforeDispatch(scope);
		dispatched = true;
		plan.deliver();
		session.known = fingerprints;
		session.lastUsed = Date.now();
		await consume(session, message, output, signal, progress);
		// The agent loop appends this response to the transcript as-is.
		session.known = [...fingerprints, fingerprint(message)];
		session.busy = false;
		session.lastUsed = Date.now();
		rememberSession(session);
	} catch (error) {
		const failure = signal.aborted ? new BridgeError(controller.signal.reason === "background" ? "background" : "cancelled", "cancelled") : classify(error);
		if (failure.kind === "auth" || failure.kind === "signed-out") markAntigravitySignedOut();
		// The agy conversation may now hold a partial turn: never resume it.
		if (session) void dropSession(session, true);
		if (!dispatched) {
			markUnadmittedUsage(message.usage);
			const denial: NoDispatchKind = failure.kind === "cancelled" ? "all" : failure.kind === "background" ? "background" : "other";
			try { lifecycle?.noDispatch(denial); } catch { /* the cycle already settled */ }
		}
		const failed: AssistantMessage = { ...message, stopReason: signal.aborted ? "aborted" : "error", errorMessage: antigravityError(failure.kind, failure.kind === "failed" ? failure.message : "") };
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
		const plan = live.desynced ? undefined : await continueLive(live, messages.slice(live.known.length), config);
		if (plan) return plan;
		// agy dropped an open call: resume the session and deliver the results as text.
		if (live.desynced) await pauseSession(live);
		else await dropSession(live, true);
	}
	const record = findRecord(fingerprints, config.tag);
	if (record) {
		const delta = messages.slice(record.known.length);
		const { results, users, clean } = splitDelta(delta);
		const covered = record.awaiting.every((id) => results.some((result) => result.toolCallId === id)) && results.every((result) => record.awaiting.includes(result.toolCallId));
		if (clean && covered && (results.length > 0 || users.length > 0)) {
			const session = await openSession({ ...config, resume: record.sessionId });
			session.known = record.known;
			session.busy = true;
			const content: AcpContent[] = results.length ? pausedResultsBlocks(results, users) : users.flatMap(userBlocks);
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
		if (awaiting.some((id) => !session.holds(id))) { session.desynced = true; return undefined; }
	} else if (results.length || !users.length || session.promptOpen) return undefined;

	// The prompt and the tools are fixed when agy starts: resume the same agy
	// session in a new process with the new ones. Open calls become paused results.
	if (config.systemKey !== session.config.systemKey || config.toolsKey !== session.config.toolsKey) {
		const known = session.known;
		session.busy = true; // nobody else may pick it while it restarts
		await dropSession(session);
		const next = await openSession({ ...config, resume: session.sessionId });
		next.known = known;
		next.busy = true;
		const content: AcpContent[] = results.length ? pausedResultsBlocks(results, users) : users.flatMap(userBlocks);
		return { session: next, deliver: () => next.send(content) };
	}
	session.busy = true;
	try { await session.apply(config.model, config.level); } catch { session.busy = false; return undefined; }
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

/** How long calls the model made together may take to reach the endpoint. */
const GROUP_MS = 150;

/** Streams agy's next response into pi events, up to its first tool call
 * or the end of its turn. */
async function consume(session: LiveSession, message: AssistantMessage, output: AssistantMessageEventStream, signal: AbortSignal, progress: { started: boolean }): Promise<void> {
	const push = (event: AssistantMessageEvent) => output.push(event);
	const start = () => { if (!progress.started) { progress.started = true; push({ type: "start", partial: message }); } };
	let open: { kind: "text" | "thinking"; index: number } | undefined;
	const close = () => {
		if (!open) return;
		const block = message.content[open.index]!;
		if (open.kind === "text") push({ type: "text_end", contentIndex: open.index, content: (block as TextContent).text, partial: message });
		else push({ type: "thinking_end", contentIndex: open.index, content: (block as ThinkingContent).thinking, partial: message });
		open = undefined;
	};
	const append = (kind: "text" | "thinking", text: string) => {
		start();
		if (open?.kind !== kind) {
			close();
			const index = message.content.push(kind === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" }) - 1;
			open = { kind, index };
			push({ type: kind === "text" ? "text_start" : "thinking_start", contentIndex: index, partial: message });
		}
		const block = message.content[open.index]!;
		if (kind === "text") (block as TextContent).text += text;
		else (block as ThinkingContent).thinking += text;
		push({ type: kind === "text" ? "text_delta" : "thinking_delta", contentIndex: open.index, delta: text, partial: message });
	};
	const usage = message.usage;
	const settle = () => { usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite; };
	let spanUsed = 0;
	const sized = (event: { used: number; size?: number }) => {
		spanUsed += event.used;
		if (event.size && session.model) rememberAntigravityContextWindow(session.model, event.size);
	};

	for (;;) {
		const next = await abortable(session.events.next(), signal);
		if (next.done) throw new BridgeError("failed", session.failure ?? "Antigravity stopped unexpectedly");
		const event = next.value;
		switch (event.type) {
			case "text": append("text", event.text); break;
			case "thought": append("thinking", event.text); break;
			case "usage": sized(event); break;
			case "tool": {
				start();
				close();
				const calls = [event];
				// Calls the model made together reach the endpoint moments apart.
				for (;;) {
					const more = await session.events.nextWithin(GROUP_MS);
					if (!more || more.done) break;
					if (more.value.type === "tool") calls.push(more.value);
					else if (more.value.type === "usage") sized(more.value);
					else { session.events.unshift(more.value); break; }
				}
				for (const call of calls) {
					const index = message.content.push({ type: "toolCall", id: call.id, name: call.name, arguments: call.args as ToolCall["arguments"] }) - 1;
					push({ type: "toolcall_start", contentIndex: index, partial: message });
					push({ type: "toolcall_delta", contentIndex: index, delta: JSON.stringify(call.args), partial: message });
					push({ type: "toolcall_end", contentIndex: index, toolCall: message.content[index] as ToolCall, partial: message });
					session.noteCall(call.id);
				}
				usage.input = spanUsed;
				settle();
				session.turnReported += spanUsed;
				message.stopReason = "toolUse";
				push({ type: "done", reason: "toolUse", message });
				return;
			}
			case "end": {
				start();
				close();
				const totals = event.usage;
				if (totals) {
					usage.input = Math.max(0, (totals.inputTokens ?? 0) - session.turnReported);
					usage.cacheRead = totals.cachedReadTokens ?? 0;
					usage.cacheWrite = totals.cachedWriteTokens ?? 0;
					usage.output = totals.outputTokens ?? 0;
					if (totals.thoughtTokens) usage.reasoning = totals.thoughtTokens;
				} else usage.input = spanUsed;
				settle();
				if (event.stopReason === "cancelled") throw new BridgeError(signal.aborted ? "cancelled" : "failed", "Antigravity stopped the turn");
				if (event.stopReason === "refusal") throw new BridgeError("failed", "the model declined to answer");
				message.stopReason = event.stopReason === "max_tokens" ? "length" : "stop";
				push({ type: "done", reason: message.stopReason as "stop" | "length", message });
				return;
			}
			case "error": throw event.error;
		}
	}
}
