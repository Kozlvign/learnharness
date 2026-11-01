/**
 * anki_card: the tutor's card tool (fork feature, docs/anki.md).
 *
 * The teacher and the practice agent write a flashcard for the learner's
 * Anki right after explaining a mistake, or when the learner asks for one.
 * In their registries only while the feature is on (the chat handler passes
 * it through AgentBuildOptions.extraTools); never the prober's: a probe
 * mistake gets its card from the reserve writer right after the answer,
 * which shows the correct answer and its explanation.
 *
 * SERVER-SIDE. The execute hands the card to an injected closure (the chat
 * handler binds src/server/anki/tutor.ts createTutorCard to the chat and
 * phase): this layer never imports the server. The result is a short text
 * for the tutor and `details: AnkiCardToolResult` for the chat's card.
 *
 * The description is static per settings (the learner's triggers), so the
 * prompt cache holds across turns. The card craft is single-sourced with
 * the reserve writer (ANKI_CARD_RULES).
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	ANKI_CARD_TOOL,
	type AnkiCardToolInput,
	type AnkiCardToolResult,
	type AnkiSettings,
	type AnkiTrigger,
} from "../../core/anki/contract.ts";
import { ankiCardToolInputSchema } from "../../core/anki/tool.ts";
import { ANKI_CARD_RULES } from "../subagents/anki-writer.ts";
import { serverExecute } from "../tool-execute.ts";

export interface AnkiCardToolContext {
	/** Which agent carries the tool: the description names its mistakes. */
	phase: "teach" | "practice";
	/** The learner's choice of mistakes that get a card (AnkiSettings). */
	triggers: AnkiSettings["triggers"];
	/** A right answer at or below this confidence counts as a guess. */
	lowConfidenceMax: number;
	/** Save the card (the chat handler binds createTutorCard). */
	create(input: AnkiCardToolInput, toolCallId: string): Promise<{ text: string; details: AnkiCardToolResult }>;
}

/** The mistakes each trigger covers, as the tutor sees them. */
function triggerText(trigger: AnkiTrigger, lowConfidenceMax: number): string {
	switch (trigger) {
		case "wrong":
			return "a wrong answer (a wrong choice, or a free-text answer that was wrong or partly wrong)";
		case "dontKnow":
			return '"I don\'t know"';
		case "lowConfidence":
			return `a right answer given as a guess (confidence ${lowConfidenceMax}% or less)`;
		case "practiceNotSolved":
			return "a practice problem the learner did not solve (moved on or gave up)";
		case "practiceHeavyHint":
			return "a practice problem solved only with a heavy hint (R3 or above)";
	}
}

const PHASE_TRIGGERS: Record<AnkiCardToolContext["phase"], readonly AnkiTrigger[]> = {
	teach: ["wrong", "dontKnow", "lowConfidence"],
	practice: ["practiceNotSolved", "practiceHeavyHint"],
};

export function ankiCardDescription(ctx: Pick<AnkiCardToolContext, "phase" | "triggers" | "lowConfidenceMax">): string {
	const kinds = PHASE_TRIGGERS[ctx.phase].filter((trigger) => ctx.triggers[trigger]).map((trigger) => triggerText(trigger, ctx.lowConfidenceMax));
	const mistakes = kinds.length > 0
		? `The mistakes that get a card (the learner's choice): ${kinds.join("; ")}.`
		: "The learner turned off cards for mistakes here: use the tool only when the learner asks for a card.";
	const probe = ctx.phase === "teach"
		? " Mistakes from the probe get their card automatically right after the answer: make none for them."
		: "";
	return [
		"Save a flashcard to the learner's Anki collection. The card shows in the chat and goes to Anki at the end of your reply.",
		"",
		"WHEN:",
		`- reason "mistake": right after you have explained the correct idea behind a learner mistake, in that same reply; one card per idea. ${mistakes}${probe} Put the missed question (or the practice problem's statement) in question, copied as it was posed (its first words are enough): it ties the card to the mistake.`,
		'- reason "request": when the learner asks you for a card of something.',
		"Never before you have explained the idea, never for a careless slip, a skipped question or an answer to ask_user_question. Do not announce the card at length: the chat shows it. A refusal (the mistake already has a card, the session's card limit, cards turned off) comes back as the result: accept it.",
		"",
		"HOW:",
		ANKI_CARD_RULES,
	].join("\n");
}

export function ankiCardTools(ctx: AnkiCardToolContext): Record<string, AgentTool<any>> {
	return {
		[ANKI_CARD_TOOL]: {
			name: ANKI_CARD_TOOL,
			label: ANKI_CARD_TOOL,
			description: ankiCardDescription(ctx),
			// The core-owned schema (src/core/anki/tool.ts): the chat's card
			// parses the same one, so boundary-valid ⇔ display-parseable.
			parameters: ankiCardToolInputSchema,
			execute: serverExecute(ANKI_CARD_TOOL, ankiCardToolInputSchema, async (input, { toolCallId }) => {
				try {
					return await ctx.create(input as AnkiCardToolInput, toolCallId);
				} catch (err) {
					const error = `The card could not be saved: ${err instanceof Error ? err.message : String(err)}`;
					console.error(`[anki] ${ANKI_CARD_TOOL} failed:`, err);
					const details: AnkiCardToolResult = { ok: false, error };
					return { text: error, details };
				}
			}),
		},
	};
}
