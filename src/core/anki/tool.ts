/**
 * The tutor's `anki_card` tool input (fork feature, docs/anki.md): ONE
 * schema for the model-facing boundary (src/agent/tools/anki-card.ts) and
 * the chat's display parse, so boundary-valid ⇔ display-parseable (the
 * tool-parts.ts rule). Mechanical field descriptions only; when to make a
 * card and how to write it live in the tool's description.
 */

import { Type, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { ANKI_CARD_REASONS, type AnkiCardToolInput } from "./contract.ts";

export const ankiCardToolInputSchema = Type.Object({
	reason: Type.Union(
		ANKI_CARD_REASONS.map((reason) => Type.Literal(reason)),
		{ description: '"mistake": a learner mistake you have just explained. "request": the learner asked for a card.' },
	),
	question: Type.Optional(
		Type.String({
			description:
				'reason "mistake": the missed question\'s text, or the practice problem\'s statement, copied as it was posed (its first words are enough). Leave it out for "request".',
		}),
	),
	front: Type.String({ description: "The card's front: a recall question. Markdown, math in $…$." }),
	back: Type.String({ description: "The answer, short. Markdown, math in $…$." }),
	why: Type.String({ description: 'Why it is so, in one or two sentences; "" when the back says it all.' }),
	pitfall: Type.String({ description: 'The wrong belief behind the learner\'s answer and why it fails; "" when there is none.' }),
});

/** The model-authored input, for display: null when it does not parse (a
 *  partial stream, or an input the boundary rejected). */
export function parseAnkiCardToolInput(input: unknown): AnkiCardToolInput | null {
	if (typeof input !== "object" || input === null) return null;
	const schema: TSchema = ankiCardToolInputSchema;
	const converted = structuredClone(input);
	Value.Convert(schema, converted);
	if (!Value.Check(schema, converted)) return null;
	const parsed = Value.Clean(schema, converted) as AnkiCardToolInput;
	return parsed.front.trim() ? parsed : null;
}
