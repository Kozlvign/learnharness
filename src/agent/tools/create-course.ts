/**
 * create_course: the teacher creates a separate course the learner agreed
 * to (fork, docs/rigor.md rule R7). Teacher only, through the chat
 * handler's extraTools. SERVER-SIDE: the execute hands the input to an
 * injected closure (src/server/courses.ts), so this layer never imports
 * the server; the closure refuses unless the learner's latest answer to a
 * `purpose: "course"` ask was `create` (courseConsentOf).
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { CREATE_COURSE_TOOL, createCourseInputSchema, type CreateCourseInput, type CreateCourseResult } from "../../core/course.ts";
import { serverExecute } from "../tool-execute.ts";

export interface CreateCourseToolContext {
	/** Create the course (the chat handler binds createProposedCourse). */
	create(input: CreateCourseInput): Promise<CreateCourseResult>;
}

export const CREATE_COURSE_DESCRIPTION =
	"Create a separate new course the learner agreed to: a new chat in the learner's \"Suggested courses\" folder, " +
	"opened with a context note for its tutor (goal, origin, what the learner already holds, the books and the " +
	"learner's files). Call it only after the learner chose `create` on your `ask_user_question` with " +
	"`purpose: \"course\"`, and after asking which of the books they have as files; give a book's `path` only when " +
	"the learner gave it and you checked it exists. Refused without that choice, once a course was already created " +
	"from it, or when a path cannot be read. The new course appears in the learner's sidebar; continue the current " +
	"lesson after it.";

export function createCourseTools(ctx: CreateCourseToolContext): Record<string, AgentTool<any>> {
	return {
		[CREATE_COURSE_TOOL]: {
			name: CREATE_COURSE_TOOL,
			label: CREATE_COURSE_TOOL,
			description: CREATE_COURSE_DESCRIPTION,
			parameters: createCourseInputSchema,
			execute: serverExecute(CREATE_COURSE_TOOL, createCourseInputSchema, async (input) => {
				const created = await ctx.create(input as CreateCourseInput);
				const files = created.withFiles.length > 0 ? ` Books with the learner's file: ${created.withFiles.join("; ")}.` : "";
				const missing = created.withoutFiles.length > 0 ? ` Suggested without a file yet: ${created.withoutFiles.join("; ")}.` : "";
				return {
					text: `Course created: “${created.title}” (${created.chatId}), in the folder “${created.folder}”.${files}${missing} Tell the learner in one sentence and continue this lesson.`,
					details: created,
				};
			}),
		},
	};
}
