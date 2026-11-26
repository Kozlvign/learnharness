/**
 * New courses proposed from a course (fork, docs/rigor.md rule R7).
 *
 * The teacher proposes a separate course with `ask_user_question` and
 * `purpose: "course"` (values create / skip). Only after the learner picked
 * `create` may it call `create_course`, which the server runs: a new chat in
 * the "Suggested courses" folder whose message[0] is a `course-seed` marker
 * — the goal, the origin, what the learner already holds and the books,
 * with the learner's own files where they have them. Pure and browser-safe:
 * the schema, the marker, and the consent fold over a chat record.
 */
import { Type, type Static } from "typebox";
import type { LhMarkerMessage, LhMessage } from "./native-messages.ts";

export const CREATE_COURSE_TOOL = "create_course";

/** The sidebar folder new courses land in (English source text; the
 *  server stores the interface language's catalog entry as the name). */
export const SUGGESTED_COURSES_FOLDER = "Suggested courses";

const courseBook = Type.Object({
	title: Type.String({ description: "The book's title, as verified." }),
	author: Type.String({ description: "Its author or authors, as verified." }),
	edition: Type.Optional(Type.String({ description: "The edition, when it matters." })),
	level: Type.String({ description: "Its level, e.g. introductory, intermediate, advanced." }),
	why: Type.String({ description: "Why this book, for this learner and this goal, in one or two sentences." }),
	path: Type.Optional(
		Type.String({ description: "The learner's own file of this book: only a path the learner gave you and you checked exists." }),
	),
});

export const createCourseInputSchema = Type.Object({
	title: Type.String({ description: "The new course's name: short, in the learner's language." }),
	goal: Type.String({ description: "What the learner sets out to understand: the new course's first goal." }),
	reason: Type.String({ description: "Why it came up in this course, and why it is a separate course rather than a detour." }),
	timing: Type.Union([Type.Literal("now"), Type.Literal("after")], {
		description: "now = it can start right away; after = it is better taken after finishing this course.",
	}),
	background: Type.String({
		description:
			"What the learner already holds from this course that matters for the new one, and the gaps you know of — " +
			"its probe reads this as evidence.",
	}),
	books: Type.Array(courseBook, {
		maxItems: 6,
		description: "The verified books you recommended (2–3 usually), each with the learner's file when they have it.",
	}),
});
export type CreateCourseInput = Static<typeof createCourseInputSchema>;
export type CourseBook = CreateCourseInput["books"][number];

/** The seed marker's UI/audit payload. */
export interface CourseSeedDetails {
	title: string;
	goal: string;
	reason: string;
	timing: "now" | "after";
	background: string;
	books: CourseBook[];
	origin: { chatId: string; title: string };
}

/** The created course, as the tool reports it to the proposing tutor. */
export interface CreateCourseResult {
	ok: true;
	chatId: string;
	title: string;
	folder: string;
	/** Books whose file the learner gave. */
	withFiles: string[];
	/** Books suggested without a file yet. */
	withoutFiles: string[];
}

function bookLine(book: CourseBook): string {
	const facts = [book.edition, book.level].filter((v) => v && v.trim()).join("; ");
	const file = book.path ? ` Learner's file: ${book.path}` : " The learner has no file of it yet.";
	return `- ${book.title} — ${book.author}${facts ? ` (${facts})` : ""}: ${book.why}${file}`;
}

/** The new course's opening context, in the bracket convention of injected
 *  session context (markers reach the model as user-role text). */
export function courseSeedText(details: CourseSeedDetails): string {
	const lines = [
		`[Session context] This course was proposed in another course, “${details.origin.title}”, and created at the learner's request.`,
		`Proposed title: ${details.title}`,
		`Goal: ${details.goal}`,
		`Why: ${details.reason}`,
		`Timing: ${details.timing === "now" ? "it can start now" : "better taken after the origin course"}`,
		`What the learner already holds (from the origin course): ${details.background}`,
	];
	if (details.books.length > 0) lines.push("Books recommended (verified):", ...details.books.map(bookLine));
	lines.push(
		"Begin as usual with the probe: confirm the goal with the learner, read the learner's files (pdf jobs), and treat the background above as evidence.",
	);
	return lines.join("\n");
}

export function newCourseSeedMessage(details: CourseSeedDetails, now: number = Date.now()): LhMarkerMessage {
	return {
		id: `cs_${now.toString(36)}_${crypto.randomUUID().slice(0, 8)}`,
		role: "custom",
		customType: "course-seed",
		content: courseSeedText(details),
		display: true,
		details,
		timestamp: now,
	};
}

/** The learner's latest decision on a course proposal, and whether a
 *  course was already created from it. */
export type CourseConsent =
	| { status: "none" }
	| { status: "pending"; askCallId: string }
	| { status: "declined"; askCallId: string }
	| { status: "granted"; askCallId: string }
	| { status: "used"; askCallId: string };

/** Fold the record: the LAST `purpose: "course"` ask decides. A successful
 *  create_course after its answer consumes it (one course per yes). */
export function courseConsentOf(messages: readonly LhMessage[]): CourseConsent {
	let askCallId: string | null = null;
	let askIndex = -1;
	for (let i = messages.length - 1; i >= 0 && askCallId === null; i--) {
		const m = messages[i]!;
		if (m.role !== "assistant") continue;
		for (let b = m.content.length - 1; b >= 0; b--) {
			const block = m.content[b]!;
			if (block.type === "toolCall" && block.name === "ask_user_question" && (block.arguments as { purpose?: unknown } | undefined)?.purpose === "course") {
				askCallId = block.id;
				askIndex = i;
				break;
			}
		}
	}
	if (askCallId === null) return { status: "none" };
	const resultIndex = messages.findIndex((m, i) => i > askIndex && m.role === "toolResult" && m.toolCallId === askCallId);
	if (resultIndex < 0) return { status: "pending", askCallId };
	const result = messages[resultIndex] as Extract<LhMessage, { role: "toolResult" }>;
	const answers = (result.details as { answers?: Array<{ value?: unknown }>; dismissed?: boolean } | null)?.answers;
	if ((result.details as { dismissed?: boolean } | null)?.dismissed || answers?.[0]?.value !== "create") return { status: "declined", askCallId };
	const used = messages.some((m, i) => i > resultIndex && m.role === "toolResult" && m.toolName === CREATE_COURSE_TOOL && !m.isError);
	return used ? { status: "used", askCallId } : { status: "granted", askCallId };
}
