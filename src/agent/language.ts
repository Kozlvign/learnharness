/**
 * The stored language choice and the tutor-language note on model calls
 * (fork feature, docs/language.md).
 *
 * The choice lives in its own file, `<data>/language.json`, beside the
 * upstream settings record, so upstream's settings schema stays untouched.
 */
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { normalizeContext, type Context, type Message } from "@earendil-works/pi-ai";
import { PATHS } from "../../config.ts";
import { DEFAULT_LANGUAGE, parseLanguageSettings, type LanguageSettings } from "../core/i18n/locales.ts";
import { tutorLanguageNote } from "../core/i18n/tutor.ts";

const STATE = Symbol.for("lh.language");
type State = { file: string; mtimeMs: number; settings: LanguageSettings };
const globalState = globalThis as typeof globalThis & { [STATE]?: State };

export function languageFile(): string {
	return path.join(PATHS.data, "language.json");
}

/** The current choice. The file is re-read only when it changes on disk. */
export function languageSettings(): LanguageSettings {
	const file = languageFile();
	let mtimeMs = -1;
	try { mtimeMs = statSync(file).mtimeMs; } catch { /* no file yet: defaults */ }
	const cached = globalState[STATE];
	if (cached && cached.file === file && cached.mtimeMs === mtimeMs) return cached.settings;
	let settings: LanguageSettings = DEFAULT_LANGUAGE;
	if (mtimeMs >= 0) {
		try { settings = parseLanguageSettings(JSON.parse(readFileSync(file, "utf8"))); } catch { /* unreadable: defaults */ }
	}
	globalState[STATE] = { file, mtimeMs, settings };
	return settings;
}

export function saveLanguageSettings(next: LanguageSettings): LanguageSettings {
	const settings = parseLanguageSettings(next);
	const file = languageFile();
	mkdirSync(path.dirname(file), { recursive: true });
	const temporary = `${file}.${process.pid}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(settings, null, "\t")}\n`);
	renameSync(temporary, file);
	globalState[STATE] = { file, mtimeMs: statSync(file).mtimeMs, settings };
	return settings;
}

/** Add text to the end of a request's system prompt, in either context form:
 * a `systemPrompt` field, or a leading system message (pi-agent-core's
 * normalized transcripts). Everything else in the request is unchanged. */
export function appendSystemText<C extends Context>(context: C, text: string): C {
	if (typeof context.systemPrompt === "string" && context.systemPrompt.length > 0) {
		return { ...context, systemPrompt: `${context.systemPrompt}\n\n${text}` };
	}
	const [first, ...rest] = context.messages;
	if (first?.role === "system") {
		const content = typeof first.content === "string"
			? (first.content ? `${first.content}\n\n${text}` : text)
			: [...first.content, { type: "text" as const, text: `\n\n${text}` }];
		return { ...context, messages: [{ ...first, content }, ...rest] };
	}
	const leading: Message = { role: "system", content: text, timestamp: 0 };
	return { ...context, messages: [leading, ...context.messages] };
}

/** The request with the learner's language note, or unchanged in English.
 * The note goes into a normalized transcript (prompt as the leading system
 * message), the form every stream function accepts. */
export function withTutorLanguage<C extends Context>(context: C, settings: LanguageSettings = languageSettings()): C {
	const note = tutorLanguageNote(settings);
	// The transcript brand is type-only; the normalized messages are what it marks.
	return note ? (appendSystemText({ messages: normalizeContext(context).messages }, note) as C) : context;
}
