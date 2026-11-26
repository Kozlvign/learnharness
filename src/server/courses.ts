/**
 * New courses from a course (fork, docs/rigor.md rule R7): the server half
 * of the teacher's create_course tool. It checks the learner's consent and
 * the learner's files, creates the chat, files it in the "Suggested
 * courses" folder and writes its context note (the course-seed marker).
 */
import * as fs from "node:fs";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { emit } from "../core/events.ts";
import {
	courseConsentOf,
	newCourseSeedMessage,
	SUGGESTED_COURSES_FOLDER,
	type CourseBook,
	type CreateCourseInput,
	type CreateCourseResult,
} from "../core/course.ts";
import { parseFilePaths } from "../core/file-paths.ts";
import { CATALOGS } from "../core/i18n/catalog.ts";
import { createCourseTools } from "../agent/tools/create-course.ts";
import { resolveSourcePath } from "../agent/tools/fs-shared.ts";
import { languageSettings } from "../agent/language.ts";
import { stores } from "./stores.ts";
import { sourceDirectory } from "./source-organization.ts";
import { readSettings as readSettingsRecord } from "../store/settings.ts";
import { titleFromPrompt } from "../core/contracts.ts";

// Global registry so separate Next.js route/module instances share one
// intra-turn consent ledger (same Symbol.for pattern as compaction.ts).
const CONSUMED_CONSENTS_KEY = Symbol.for("lh.courses.consumedConsents");

function consumedConsents(): Set<string> {
	const g = globalThis as Record<symbol, Set<string> | undefined>;
	return (g[CONSUMED_CONSENTS_KEY] ??= new Set());
}

/** Strip surrounding quotes the learner's drag-and-drop (CommonMark
 *  backticks via quoteFilePath) or OS "Copy as path" ("..." / '...') puts
 *  around a file path, before resolveSourcePath checks it. */
function unwrapBookPath(raw: string): string {
	const trimmed = raw.trim();
	if (!trimmed) return "";
	const parts = parseFilePaths(trimmed);
	if (parts.length === 1 && parts[0]!.kind === "path") return parts[0]!.path.trim();
	if (
		trimmed.length >= 2 &&
		((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
			(trimmed.startsWith("'") && trimmed.endsWith("'")))
	) {
		return trimmed.slice(1, -1).trim();
	}
	return trimmed;
}

/** The folder's name in the interface language (a folder name is data:
 *  stored as the learner reads it). */
export function suggestedCoursesFolderName(): string {
	const locale = languageSettings().ui;
	const translated = CATALOGS[locale]?.[SUGGESTED_COURSES_FOLDER];
	return typeof translated === "string" && translated.trim() ? translated : SUGGESTED_COURSES_FOLDER;
}

/** Each book's file, checked like the tutor's own file reads (allowed
 *  folders, sensitive locations) and readable as a file. All or nothing:
 *  a bad path refuses the whole call so the tutor can fix it with the
 *  learner. */
function checkedBooks(books: readonly CourseBook[]): CourseBook[] {
	const problems: string[] = [];
	const out = books.map((book) => {
		const raw = unwrapBookPath(book.path ?? "");
		if (!raw) return { ...book, path: undefined };
		try {
			const resolved = resolveSourcePath(raw);
			if (!fs.statSync(resolved).isFile()) throw new Error("not a file");
			fs.accessSync(resolved, fs.constants.R_OK);
			return { ...book, path: resolved };
		} catch (error) {
			problems.push(`${raw}: ${error instanceof Error ? error.message : String(error)}`);
			return book;
		}
	});
	if (problems.length > 0) {
		throw new Error(`These files cannot be read, so no course was created: ${problems.join("; ")}. Check the paths with the learner, or leave those books without a path.`);
	}
	return out;
}

/** All localized names for the suggested-courses root folder across catalogs,
 *  so switching interface language reuses the existing folder instead of
 *  creating a duplicate root folder. */
function knownSuggestedCoursesFolderNames(): Set<string> {
	const names = new Set<string>([SUGGESTED_COURSES_FOLDER]);
	for (const catalog of Object.values(CATALOGS)) {
		const translated = catalog?.[SUGGESTED_COURSES_FOLDER];
		if (typeof translated === "string" && translated.trim()) names.add(translated.trim());
	}
	return names;
}

/** Find the root-level suggested-courses folder (preferring the current
 *  interface language, then any known localized alias), or create it. */
function ensureSuggestedCoursesFolder(preferredName: string): { id: string; name: string } {
	const roots = sourceDirectory.read().organization.folders.filter((folder) => folder.parentId === null);
	const exact = roots.find((folder) => folder.name === preferredName);
	if (exact) return { id: exact.id, name: exact.name };
	const aliases = knownSuggestedCoursesFolderNames();
	const existing = roots.find((folder) => aliases.has(folder.name));
	if (existing) return { id: existing.id, name: existing.name };
	const created = sourceDirectory.change({ action: "create-folder", name: preferredName, parentId: null });
	if (!created.createdFolderId) throw new Error("The suggested-courses folder could not be created.");
	return { id: created.createdFolderId, name: preferredName };
}

/** Create the course the learner agreed to in `originChatId`. */
export async function createProposedCourse(originChatId: string, input: CreateCourseInput): Promise<CreateCourseResult> {
	const origin = stores.chatStore.getChat(originChatId);
	if (!origin) throw new Error("This course's record could not be read.");
	const consent = courseConsentOf(origin.messages);
	if (consent.status !== "granted") {
		const why = consent.status === "declined" && consent.answeredOther
			? 'the learner answered via "Other" instead of choosing create; confirm with a new course proposal (ask_user_question with purpose "course") before creating the course'
			: {
				none: 'no course proposal was made: ask with ask_user_question and purpose "course" first',
				pending: "the learner has not answered the course proposal yet",
				declined: "the learner did not choose create on the latest course proposal",
				used: "a course was already created from the learner's latest yes; propose again for another one",
			}[consent.status];
		throw new Error(`create_course refused: ${why}.`);
	}
	const consentKey = `${originChatId}:${consent.askCallId}`;
	const consumed = consumedConsents();
	if (consumed.has(consentKey)) {
		throw new Error("create_course refused: a course was already created from the learner's latest yes; propose again for another one.");
	}
	const title = input.title.trim();
	if (!title) throw new Error("create_course needs a title.");
	const books = checkedBooks(input.books);

	// Reserve the consent synchronously before side effects so a second
	// create_course call in the same turn (before onFinish persists the first
	// toolResult to chatStore) cannot create a duplicate course.
	consumed.add(consentKey);
	let chat: ReturnType<typeof stores.chatStore.createChat>;
	try {
		chat = stores.chatStore.createChat(titleFromPrompt(title));
	} catch (error) {
		consumed.delete(consentKey);
		throw error;
	}
	// The new course owns its model from birth, as POST /api/chats stamps it.
	const strong = readSettingsRecord()?.models?.strong;
	if (strong?.model) {
		stores.chatStore.saveSettings(chat.id, {
			model: { provider: strong.model.provider, id: strong.model.id },
			thinkingLevel: strong.thinkingLevel,
		});
	}
	stores.chatStore.saveMessages(chat.id, [
		newCourseSeedMessage({
			title,
			goal: input.goal.trim(),
			reason: input.reason.trim(),
			timing: input.timing,
			background: input.background.trim(),
			books,
			origin: { chatId: originChatId, title: origin.title },
		}),
	]);
	const folder = ensureSuggestedCoursesFolder(suggestedCoursesFolderName());
	sourceDirectory.change({ action: "move", kind: "source", id: chat.id, parentId: folder.id });
	// The sidebar re-reads its folders on this event; the chat's own creation
	// event fired before the placement existed.
	emit("chats-changed", {});
	return {
		ok: true,
		chatId: chat.id,
		title: chat.title,
		folder: folder.name,
		withFiles: books.filter((book) => book.path).map((book) => book.title),
		withoutFiles: books.filter((book) => !book.path).map((book) => book.title),
	};
}

/** The teacher's create_course tool, bound to its chat. */
export function courseTutorTools(chatId: string): Record<string, AgentTool<any>> {
	return createCourseTools({ create: (input) => createProposedCourse(chatId, input) });
}
