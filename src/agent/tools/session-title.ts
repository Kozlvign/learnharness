/**
 * rename_session: the tutor names the session (fork, docs/session-titles.md).
 *
 * Every conversation agent carries it, always on. SERVER-SIDE: it renames
 * through the chat store, which announces chat-renamed so the header, the
 * sidebar and the map update while the turn runs. A title the learner set
 * is refused unless the learner asked for the new one in the chat
 * (requestedByUser: true); a name the learner asked for is theirs from then
 * on. Sequential, so a batch that renames and then calls a milestone tool
 * (probe_done, plan_init, problem) runs the rename first and the milestone
 * sees the new title in the same turn.
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ChatStore } from "../../core/ports.ts";
import {
	effectiveTitleSource,
	RENAME_SESSION_TOOL,
	renameSessionInputSchema,
	validateSessionTitle,
	type RenameSessionInput,
} from "../../core/session-title.ts";
import { serverExecute } from "../tool-execute.ts";

/** What rename_session closes over. */
export interface SessionTitleToolContext {
	chatId: string;
	chatStore: Pick<ChatStore, "getChat" | "renameChat">;
}

export const RENAME_SESSION_DESCRIPTION =
	"Rename this session: the title the learner sees in the sidebar and above the conversation. " +
	"It shows nothing in the conversation itself. " +
	"Refused when the learner named the session, unless the learner asked in the chat for the new name " +
	"(requestedByUser: true, which also makes the new name the learner's). " +
	"probe_done, plan_init and problem are refused while the session still has its automatic title.";

export function renameSessionTool(ctx: SessionTitleToolContext): AgentTool<typeof renameSessionInputSchema> {
	return {
		name: RENAME_SESSION_TOOL,
		label: RENAME_SESSION_TOOL,
		description: RENAME_SESSION_DESCRIPTION,
		parameters: renameSessionInputSchema,
		executionMode: "sequential",
		execute: serverExecute(RENAME_SESSION_TOOL, renameSessionInputSchema, async (input) => {
			const { title: raw, requestedByUser } = input as RenameSessionInput;
			const record = ctx.chatStore.getChat(ctx.chatId);
			if (!record) return { ok: false, error: `Chat not found: ${ctx.chatId}` };
			if (effectiveTitleSource(record) === "user" && requestedByUser !== true) {
				return {
					ok: false,
					error: "The learner named this session; keep their title. Rename it only when the learner asks in the chat, with requestedByUser: true.",
				};
			}
			const checked = validateSessionTitle(raw);
			if (!checked.ok) return { ok: false, error: `Not renamed: ${checked.problem}.` };
			const renamed = ctx.chatStore.renameChat(ctx.chatId, checked.title, requestedByUser === true ? "user" : "agent");
			return {
				text: `Session renamed to ${JSON.stringify(renamed.title)}.`,
				details: { ok: true, title: renamed.title },
			};
		}),
	};
}

/** The registry entry, keyed by the tool's name. */
export function sessionTitleTools(ctx: SessionTitleToolContext): Record<string, AgentTool<any>> {
	return { [RENAME_SESSION_TOOL]: renameSessionTool(ctx) };
}
