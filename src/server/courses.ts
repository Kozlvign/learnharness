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
import { CATALOGS } from "../core/i18n/catalog.ts";
import { createCourseTools } from "../agent/tools/create-course.ts";
import { resolveSourcePath } from "../agent/tools/fs-shared.ts";
import { languageSettings } from "../agent/language.ts";
import { stores } from "./stores.ts";
import { sourceDirectory } from "./source-organization.ts";
import { readSettings as readSettingsRecord } from "../store/settings.ts";
import { titleFromPrompt } from "../core/contracts.ts";

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
		const raw = book.path?.trim();
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

/** Find the root-level folder by name, or create it; returns its id. */
function suggestedCoursesFolderId(name: string): string {
	const existing = sourceDirectory.read().organization.folders.find((folder) => folder.parentId === null && folder.name === name);
	if (existing) return existing.id;
	const created = sourceDirectory.change({ action: "create-folder", name, parentId: null });
	if (!created.createdFolderId) throw new Error("The suggested-courses folder could not be created.");
	return created.createdFolderId;
}

/** Create the course the learner agreed to in `originChatId`. */
export async function createProposedCourse(originChatId: string, input: CreateCourseInput): Promise<CreateCourseResult> {
	const origin = stores.chatStore.getChat(originChatId);
	if (!origin) throw new Error("This course's record could not be read.");
	const consent = courseConsentOf(origin.messages);
	if (consent.status !== "granted") {
		const why = {
			none: "no course proposal was made: ask with ask_user_question and purpose \"course\" first",
			pending: "the learner has not answered the course proposal yet",
			declined: "the learner did not choose create on the latest course proposal",
			used: "a course was already created from the learner's latest yes; propose again for another one",
		}[consent.status];
		throw new Error(`create_course refused: ${why}.`);
	}
	const title = input.title.trim();
	if (!title) throw new Error("create_course needs a title.");
	const books = checkedBooks(input.books);

	const chat = stores.chatStore.createChat(titleFromPrompt(title));
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
	const folder = suggestedCoursesFolderName();
	const folderId = suggestedCoursesFolderId(folder);
	sourceDirectory.change({ action: "move", kind: "source", id: chat.id, parentId: folderId });
	// The sidebar re-reads its folders on this event; the chat's own creation
	// event fired before the placement existed.
	emit("chats-changed", {});
	return {
		ok: true,
		chatId: chat.id,
		title: chat.title,
		folder,
		withFiles: books.filter((book) => book.path).map((book) => book.title),
		withoutFiles: books.filter((book) => !book.path).map((book) => book.title),
	};
}

/** The teacher's create_course tool, bound to its chat. */
export function courseTutorTools(chatId: string): Record<string, AgentTool<any>> {
	return createCourseTools({ create: (input) => createProposedCourse(chatId, input) });
}
