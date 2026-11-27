/**
 * Session titles chosen by the tutor (fork, docs/session-titles.md).
 *
 * A new session is named from the learner's first message (titleFromPrompt),
 * which reads as a truncated sentence. The tutor renames it with
 * `rename_session` once the subject is clear, and the milestone tools
 * (probe_done, plan_init, problem) refuse until it has. A title the learner
 * set is theirs: the tool refuses to change it unless the learner asked in
 * the chat. Pure and browser-safe: the schema, the source fold over a chat
 * record, the title check and the system-prompt note.
 */
import { Type, type Static } from "typebox";
import { imagesLabel } from "./attachments.ts";
import type { ChatRecord, TitleSource } from "./contracts/chat.ts";
import { TITLE_MAX_CHARS, titleFromPrompt } from "./contracts/graph.ts";
import type { LhMessage } from "./native-messages.ts";

export const RENAME_SESSION_TOOL = "rename_session";

export const renameSessionInputSchema = Type.Object({
	title: Type.String({
		description: `The session's new name, one line of at most ${TITLE_MAX_CHARS} characters.`,
	}),
	requestedByUser: Type.Optional(
		Type.Boolean({ description: "true only when the learner asked in the chat for this name or for a new one." }),
	),
});

export type RenameSessionInput = Static<typeof renameSessionInputSchema>;

/** What the title fold reads from a record. */
export type TitledRecord = Pick<ChatRecord, "title" | "titleSource" | "messages">;

/** The text and image count of a user message's content. */
function userMessageParts(content: unknown): { text: string; images: number } {
	if (typeof content === "string") return { text: content, images: 0 };
	if (!Array.isArray(content)) return { text: "", images: 0 };
	let text = "";
	let images = 0;
	for (const block of content as Array<{ type?: unknown; text?: unknown }>) {
		if (block?.type === "text" && typeof block.text === "string") text += block.text;
		else if (block?.type === "image") images++;
	}
	return { text, images };
}

/** The title POST /api/chats gives a session opened with this message:
 *  the composer sends the trimmed text, or the images label when there is
 *  only an image, and the route runs titleFromPrompt over it. */
function birthTitle(message: LhMessage): string {
	const { text, images } = userMessageParts((message as { content?: unknown }).content);
	const trimmed = text.trim();
	return titleFromPrompt(trimmed || (images > 0 ? imagesLabel(images) : "Untitled session"));
}

/**
 * Who set the record's title. A record written with the field answers
 * directly. A record from before it is read conservatively, so a title the
 * learner may have chosen is never replaced:
 * - a course created by `create_course` (message[0] is its course-seed
 *   marker) was named when it was created: user;
 * - a record with no learner message has nothing the title came from: user;
 * - otherwise the title is the automatic one when it equals the title the
 *   first learner message gives at creation, and the learner's otherwise.
 */
export function effectiveTitleSource(record: TitledRecord): TitleSource {
	if (record.titleSource) return record.titleSource;
	const first = record.messages[0];
	if (first?.role === "custom" && first.customType === "course-seed") return "user";
	const opening = record.messages.find((message) => message.role === "user");
	if (!opening) return "user";
	return record.title === birthTitle(opening) ? "auto" : "user";
}

/** True while the session still carries its automatic title: the tutor
 *  owes it a name before probe_done, plan_init or a practice problem. */
export function needsSessionTitle(record: TitledRecord): boolean {
	return effectiveTitleSource(record) === "auto";
}

/** Check a proposed title: one line (whitespace runs collapse to a single
 *  space), not empty, and at most TITLE_MAX_CHARS characters, so it is
 *  never cut with an ellipsis in the sidebar or the header. */
export function validateSessionTitle(raw: string): { ok: true; title: string } | { ok: false; problem: string } {
	const title = raw.replace(/\s+/g, " ").trim();
	if (!title) return { ok: false, problem: "the title is empty" };
	if (title.length > TITLE_MAX_CHARS) {
		return { ok: false, problem: `the title has ${title.length} characters; the limit is ${TITLE_MAX_CHARS}` };
	}
	return { ok: true, title };
}

/** The refusal the milestone tools return while the title is automatic. */
export const SESSION_TITLE_REQUIRED =
	`Name the session first: call ${RENAME_SESSION_TOOL} with a title for what this session is about, then call this tool again.`;

/**
 * The one-line note at the end of a conversation agent's system prompt:
 * the current title and what the tutor may do with it. It changes only
 * when the title does, so it costs one cache miss per rename.
 */
export function sessionTitleContextNote(record: TitledRecord): string {
	const title = JSON.stringify(record.title);
	const source = effectiveTitleSource(record);
	const rule = source === "auto"
		? `set automatically from the learner's first message. Name the session with ${RENAME_SESSION_TOOL} as soon as its subject is clear.`
		: source === "agent"
			? `named by you. Refine it with ${RENAME_SESSION_TOOL} only when the plan is set or the course's scope changes.`
			: `named by the learner. Change it only when the learner asks, with ${RENAME_SESSION_TOOL} and requestedByUser: true.`;
	return `<session_title>Current title: ${title}, ${rule}</session_title>`;
}
