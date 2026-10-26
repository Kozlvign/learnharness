/** Transcript helpers for the Claude Code bridge: message identity,
 * conversions to Claude Code (Anthropic content blocks) and MCP tool results,
 * and the text replay used when a conversation cannot continue live. */
import { createHash } from "node:crypto";
import { getCurrentSystemPrompt, getCurrentTools, toToolDeclaration, type ImageContent, type Message, type TextContent, type Tool, type ToolResultMessage, type UserMessage } from "@earendil-works/pi-ai";

export type ConversationMessage = Exclude<Message, { role: "system" }>;
export type ContentBlock =
	| { type: "text"; text: string }
	| { type: "image"; source: { type: "base64"; media_type: string; data: string } };
export type McpContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

function hash(value: string): string { return createHash("sha256").update(value).digest("base64url").slice(0, 16); }

/** The prompt and tools in effect after replaying every system message. */
export function requestShape(messages: readonly Message[]): { systemPrompt: string; tools: Tool[]; systemKey: string; toolsKey: string } {
	const systemPrompt = getCurrentSystemPrompt(messages);
	const tools = getCurrentTools(messages).map(toToolDeclaration);
	return { systemPrompt, tools, systemKey: hash(systemPrompt), toolsKey: hash(JSON.stringify(tools)) };
}

/** System messages are request chrome: the agent re-seeds the leading one on
 * every run, so they are compared through requestShape, not here. */
export function conversation(messages: readonly Message[]): ConversationMessage[] {
	return messages.filter((message): message is ConversationMessage => message.role !== "system");
}

/** Identity of a message across agent runs. Timestamps come from the chat
 * record, so they are stable. A tool result is identified by its call alone:
 * a question's placeholder result is later replaced by the learner's answer. */
export function fingerprint(message: ConversationMessage): string {
	switch (message.role) {
		case "user": return `u:${message.timestamp}:${hash(JSON.stringify(message.content))}`;
		case "assistant": return `a:${message.timestamp}:${message.content.filter((block) => block.type === "toolCall").map((block) => block.id).join(",")}`;
		case "toolResult": return `t:${message.toolCallId}`;
	}
}

function blocks(content: string | readonly (TextContent | ImageContent)[]): ContentBlock[] {
	if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
	return content.flatMap((part): ContentBlock[] => part.type === "text"
		? (part.text ? [{ type: "text", text: part.text }] : [])
		: [{ type: "image", source: { type: "base64", media_type: part.mimeType, data: part.data } }]);
}

export function userBlocks(message: UserMessage): ContentBlock[] { return blocks(message.content); }

export function toMcp(block: ContentBlock): McpContent {
	return block.type === "text" ? block : { type: "image", data: block.source.data, mimeType: block.source.media_type };
}

export function toolResultContent(message: ToolResultMessage): McpContent[] {
	const content = blocks(message.content).map(toMcp);
	return content.length ? content : [{ type: "text", text: message.isError ? "The tool failed without a message." : "(no output)" }];
}

/** Text shown with the user messages that arrive together with tool results
 * (steering notes, rendered images), inside the last result. */
export function attachedUserContent(messages: readonly UserMessage[]): McpContent[] {
	return messages.flatMap((message) => [{ type: "text" as const, text: "<user_message>" }, ...blocks(message.content).map(toMcp), { type: "text" as const, text: "</user_message>" }]);
}

const REPLAY_HEADER = "This session continues an earlier conversation that could not be restored as live turns. It is reproduced below, oldest first; you were the assistant. The tool calls shown already ran and their results follow them. Do not repeat them, and never write tool calls as text: call tools normally.";

/** The whole history as one user turn, ending with the messages that need a reply. */
export function replayBlocks(history: readonly ConversationMessage[], latest: readonly ConversationMessage[]): ContentBlock[] {
	const out: ContentBlock[] = [];
	const text = (value: string) => {
		const last = out.at(-1);
		if (last?.type === "text") last.text += value;
		else out.push({ type: "text", text: value });
	};
	const render = (message: ConversationMessage) => {
		if (message.role === "user") {
			text("<user>\n");
			for (const block of blocks(message.content)) block.type === "text" ? text(block.text) : out.push(block);
			text("\n</user>\n");
		} else if (message.role === "assistant") {
			text("<assistant>\n");
			for (const block of message.content) {
				if (block.type === "text") text(block.text + "\n");
				else if (block.type === "toolCall") text(`<tool_call id="${block.id}" name="${block.name}">${JSON.stringify(block.arguments)}</tool_call>\n`);
			}
			text("</assistant>\n");
		} else {
			text(`<tool_result id="${message.toolCallId}" name="${message.toolName}"${message.isError ? ' error="true"' : ""}>\n`);
			for (const block of blocks(message.content)) block.type === "text" ? text(block.text) : out.push(block);
			text("\n</tool_result>\n");
		}
	};
	if (history.length) {
		text(`<earlier_conversation>\n${REPLAY_HEADER}\n\n`);
		for (const message of history) render(message);
		text("</earlier_conversation>\n\n");
	}
	const users = latest.filter((message): message is UserMessage => message.role === "user");
	if (users.length === latest.length) {
		for (const message of users) for (const block of blocks(message.content)) block.type === "text" ? text(block.text) : out.push(block);
	} else {
		for (const message of latest) render(message);
		text("\nContinue from the end of the conversation above.");
	}
	return out.length ? out : [{ type: "text", text: "Continue." }];
}

/** Results for calls that were pending when a session was paused, delivered
 * as text after resuming it. */
export function pausedResultsBlocks(results: readonly ToolResultMessage[], users: readonly UserMessage[]): ContentBlock[] {
	const out: ContentBlock[] = [{ type: "text", text: "Your earlier tool calls were paused before their results arrived, so they show as interrupted above. These are their real results; continue from here.\n" }];
	for (const result of results) {
		out.push({ type: "text", text: `<tool_result id="${result.toolCallId}" name="${result.toolName}"${result.isError ? ' error="true"' : ""}>\n` });
		out.push(...blocks(result.content));
		out.push({ type: "text", text: "\n</tool_result>" });
	}
	for (const message of users) out.push(...blocks(message.content));
	return out;
}
