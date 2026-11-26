/** Transcript helpers for the Antigravity bridge. Message identity, the
 * request shape and the replay text are the Claude bridge's: both bridges
 * match a pi transcript to a live native session the same way. ACP prompt
 * blocks and MCP tool results share one shape ({ type: "text" } or
 * { type: "image", data, mimeType }). */
import type { ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import {
	attachedUserContent as claudeAttached, conversation, fingerprint, pausedResultsBlocks as claudePaused,
	replayBlocks as claudeReplay, requestShape, toMcp, toolResultContent, userBlocks as claudeUserBlocks,
	type ConversationMessage, type McpContent,
} from "../claude/transcript.ts";

export { conversation, fingerprint, requestShape, toolResultContent, type ConversationMessage };
/** An ACP content block, which is also an MCP tool-result block. */
export type AcpContent = McpContent;

export function userBlocks(message: UserMessage): AcpContent[] { return claudeUserBlocks(message).map(toMcp); }
export function attachedUserContent(messages: readonly UserMessage[]): AcpContent[] { return claudeAttached(messages); }

/** The whole history as one prompt, ending with the messages that need a reply. */
export function replayBlocks(history: readonly ConversationMessage[], latest: readonly ConversationMessage[]): AcpContent[] {
	return merge(claudeReplay(history, latest).map(toMcp));
}

/** Results of calls that were open when a session stopped, as text. */
export function pausedResultsBlocks(results: readonly ToolResultMessage[], users: readonly UserMessage[]): AcpContent[] {
	return merge(claudePaused(results, users).map(toMcp));
}

/** Adjacent text blocks joined, so agy receives one text part per run of text. */
function merge(blocks: AcpContent[]): AcpContent[] {
	const out: AcpContent[] = [];
	for (const block of blocks) {
		const last = out.at(-1);
		if (block.type === "text" && last?.type === "text") last.text += block.text;
		else out.push(block.type === "text" ? { type: "text", text: block.text } : block);
	}
	return out.length ? out : [{ type: "text", text: "Continue." }];
}
