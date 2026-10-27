/**
 * The tutor's language (fork feature, docs/language.md).
 *
 * Every model call (teacher, prober, helper agents, compaction) gets this
 * note at the end of its system prompt. The prompts themselves stay in
 * English, the language they were written and tuned in; the note decides
 * the language of what the learner reads.
 */
import { DEFAULT_LOCALE, isDefaultLanguage, tutorLocale, type LanguageSettings, type Locale } from "./locales.ts";

const NAMES: Record<Locale, string> = {
	en: "English",
	"pt-BR": "Brazilian Portuguese (pt-BR)",
};

const TERMS: Partial<Record<Locale, string>> = {
	"pt-BR": "Use the terminology Brazilian teachers and textbooks use. Where Brazilians normally keep an English term (for example \"machine learning\" or \"deploy\"), keep it and explain it in Portuguese the first time.",
};

/** The system-prompt note for the learner's language, or null for upstream's behavior. */
export function tutorLanguageNote(settings: LanguageSettings): string | null {
	if (isDefaultLanguage(settings)) return null;
	const locale = tutorLocale(settings);
	const name = NAMES[locale];
	const lines = [
		"<learner_language>",
		`The learner reads ${name}. Write everything the learner will read in ${name}: teaching prose, questions, answer options, hints, feedback, plans and plan node titles, summaries, research and PDF briefs, figure and demo text, and concept names for the knowledge graph.`,
		`This holds when the learner's sources, earlier messages, tool results or the examples in these instructions are in another language.`,
		"Keep unchanged: tool names, JSON keys, ids, enum values and other machine-read fields; code, commands and identifiers; math notation; titles of cited works. When exact wording from a source matters, quote it in the original language and add a translation.",
	];
	const terms = TERMS[locale];
	if (terms) lines.push(terms);
	if (locale !== DEFAULT_LOCALE) lines.push("When the subject being learned is itself a language, keep the material being studied in that language and explain it in the learner's language.");
	lines.push(`If the learner explicitly asks for another language, follow the learner.`, "</learner_language>");
	return lines.join("\n");
}
