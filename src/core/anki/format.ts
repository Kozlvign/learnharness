/**
 * Anki cards from mistakes (fork feature, docs/anki.md): what a card looks
 * like inside Anki — its ledger id, deck, tags and note fields. Card text
 * is written as Markdown with `$…$` math; Anki fields are HTML, and Anki's
 * MathJax reads `\(…\)` and `\[…\]`. Pure and browser-safe.
 */

import { readContentSpans } from "../content-reader.ts";
import { repairMathForDisplay } from "../math-delims.ts";
import {
	ANKI_ROOT_TAG,
	type AnkiCardDraft,
	type AnkiCardKind,
	type AnkiCardRecord,
	type AnkiNoteField,
} from "./contract.ts";

/** The app's name: the source line, and the deck when nothing else is left. */
const APP_NAME = "LearnHarness";

// ─── the ledger id ──────────────────────────────────────────────────────────

// In its own module, so the browser can compute it without this one's
// Markdown and KaTeX stack (a probe question's card in the chat).
export { ankiCardId } from "./id.ts";

// ─── text helpers ───────────────────────────────────────────────────────────

const HTML_ESCAPES: Readonly<Record<string, string>> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };

function escapeHtml(text: string): string {
	return text.replace(/[&<>"]/g, (char) => HTML_ESCAPES[char]!);
}

/** At most `max` UTF-16 units, never splitting a surrogate pair. */
function clip(text: string, max: number): string {
	if (text.length <= max) return text;
	let cut = text.slice(0, max);
	const last = cut.charCodeAt(cut.length - 1);
	if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
	return cut;
}

// ─── deck ───────────────────────────────────────────────────────────────────

const MAX_DECK_SEGMENT = 60;

/** One inserted value (a folder name or the session title) as deck text:
 *  no `::` (it would nest a subdeck), no quotes or control characters, one
 *  space between words, at most 60 characters. */
function deckValue(value: string): string {
	const clean = value
		.replace(/::/g, " ")
		.replace(/["\u0000-\u001f\u007f-\u009f]/g, " ")
		.replace(/\s+/g, " ")
		.replace(/^[\s:]+|[\s:]+$/g, "");
	return clip(clean, MAX_DECK_SEGMENT).replace(/[\s:]+$/, "");
}

const DECK_PLACEHOLDER = /\{(folder|pasta|session|sessao|sessão)\}/giu;

/**
 * The deck a card goes to. `{folder}` (alias `{pasta}`) becomes the
 * session's folder path in the sources list, nested with `::`; `{session}`
 * (alias `{sessao}`) becomes the session title. Placeholders match in any
 * letter case. Empty segments and stray `::` are dropped, so an empty
 * placeholder drops its segment; an empty result falls back to
 * "LearnHarness".
 */
export function ankiDeckName(template: string, ctx: { folderPath: string[]; sessionTitle: string }): string {
	const folder = ctx.folderPath.map(deckValue).filter((segment) => segment !== "").join("::");
	const session = deckValue(ctx.sessionTitle);
	const filled = template.replace(DECK_PLACEHOLDER, (_match, name: string) =>
		/^(folder|pasta)$/i.test(name) ? folder : session,
	);
	const segments = filled
		.split("::")
		.map((segment) => segment.replace(/\s+/g, " ").trim())
		.filter((segment) => segment !== "");
	return segments.length > 0 ? segments.join("::") : APP_NAME;
}

// ─── tags ───────────────────────────────────────────────────────────────────

const MISS_TAG: Readonly<Record<AnkiCardKind, string>> = {
	wrong: "wrong",
	dontKnow: "dont-know",
	lowConfidence: "guess",
	freeText: "wrong",
	practiceNotSolved: "not-solved",
	practiceHeavyHint: "heavy-hint",
	// A card the learner asked the tutor for: no miss behind it.
	request: "requested",
};

/** Latin letters that Unicode does not decompose into a base + accent. */
const LETTER_FOLDS: Readonly<Record<string, string>> = {
	ß: "ss",
	æ: "ae",
	œ: "oe",
	ø: "o",
	ł: "l",
	đ: "d",
	ð: "d",
	þ: "th",
	ı: "i",
};

const MAX_SLUG = 40;

/** The session title as a tag word: lowercase ASCII, accents folded,
 *  every other run of characters a single "-", at most 40 characters. */
function slugOf(title: string): string {
	const folded = title
		.toLowerCase()
		.normalize("NFKD")
		.replace(/\p{M}+/gu, "")
		.replace(/[ßæœøłđðþı]/g, (char) => LETTER_FOLDS[char]!);
	const slug = folded.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
	return slug.slice(0, MAX_SLUG).replace(/-+$/, "");
}

/** `LearnHarness::session::<title slug>_<last 8 chars of the chat id>`:
 *  Anki tags cannot hold spaces, and the id suffix keeps two sessions
 *  with the same title apart. */
function sessionTag(sessionTitle: string, chatId: string): string {
	const slug = slugOf(sessionTitle);
	const suffix = chatId.slice(-8).replace(/[^A-Za-z0-9_-]/g, "");
	const word = slug !== "" && suffix !== "" ? `${slug}_${suffix}` : slug || suffix || "session";
	return `${ANKI_ROOT_TAG}::session::${word}`;
}

export function ankiTags(
	rec: Pick<AnkiCardRecord, "chatId" | "sessionTitle" | "phase" | "kind" | "missClass" | "confident">,
): string[] {
	const tags = [ANKI_ROOT_TAG, `${ANKI_ROOT_TAG}::phase::${rec.phase}`, `${ANKI_ROOT_TAG}::miss::${MISS_TAG[rec.kind]}`];
	if (rec.missClass) tags.push(`${ANKI_ROOT_TAG}::type::${rec.missClass}`);
	if (rec.confident) tags.push(`${ANKI_ROOT_TAG}::confident-error`);
	tags.push(sessionTag(rec.sessionTitle, rec.chatId));
	return tags;
}

// ─── Markdown → Anki HTML ───────────────────────────────────────────────────

// Private-use marks around a held piece's index: math, code and escaped
// characters are rendered once, held out of the prose while the prose
// rules run, and put back at the end, so no prose rule ever touches them.
const HOLD_OPEN = "";
const HOLD_CLOSE = "";
const HELD = /(\d+)/g;
const ONLY_HELD = /^\s*(\d+)\s*$/;

/** "$5 and $10" is money, not math: a single-dollar span that opens on a
 *  digit and closes after a space, or right before a digit. */
function isCurrency(body: string, after: string): boolean {
	return /^\d/.test(body) && (/\s$/.test(body) || /^\d/.test(after));
}

/** A code span from the Markdown reader: a fenced block, an indented
 *  block, or inline code. */
function renderCode(raw: string): { html: string; block: boolean } {
	const fence = /^[ \t]*(`{3,}|~{3,})[^\n]*\n/.exec(raw);
	if (fence) {
		const lines = raw.slice(fence[0].length).split("\n");
		const marker = fence[1]!;
		const last = lines[lines.length - 1]!.trim();
		if (last === "" || (last.startsWith(marker) && /^(`+|~+)$/.test(last))) lines.pop();
		const closing = lines[lines.length - 1]?.trim() ?? "";
		if (closing.startsWith(marker) && /^(`+|~+)$/.test(closing)) lines.pop();
		return { html: `<pre><code>${escapeHtml(lines.join("\n"))}</code></pre>`, block: true };
	}
	const ticks = /^`+/.exec(raw)?.[0].length ?? 0;
	if (ticks > 0 && raw.endsWith("`".repeat(ticks)) && raw.length >= ticks * 2) {
		let body = raw.slice(ticks, raw.length - ticks).replace(/\n/g, " ");
		if (body.length > 2 && body.startsWith(" ") && body.endsWith(" ") && body.trim() !== "") body = body.slice(1, -1);
		return { html: `<code>${escapeHtml(body)}</code>`, block: false };
	}
	const body = raw
		.split("\n")
		.map((line) => line.replace(/^(?: {1,4}|\t)/, ""))
		.join("\n")
		.replace(/\n+$/, "");
	return { html: `<pre><code>${escapeHtml(body)}</code></pre>`, block: true };
}

/** Bold, italic. Runs on escaped prose whose math and code are held out. */
function inline(text: string): string {
	return text
		.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<b>$1</b>")
		.replace(/(^|[^\p{L}\p{N}_])__(?=\S)([\s\S]*?\S)__(?![\p{L}\p{N}_])/gu, "$1<b>$2</b>")
		.replace(/\*(?=[^\s*])([^*]*?[^\s*])\*/g, "<i>$1</i>")
		.replace(/(^|[^\p{L}\p{N}_])_(?=[^\s_])([^_]*?[^\s_])_(?![\p{L}\p{N}_])/gu, "$1<i>$2</i>");
}

type Line =
	| { type: "text"; html: string }
	| { type: "blank" }
	| { type: "block"; html: string }
	| { type: "list"; ordered: boolean; items: string[] };

/**
 * Card Markdown → Anki field HTML. Kept deliberately small: HTML in the
 * text is escaped; `$…$` and `\(…\)` become inline math `\(…\)`, `$$…$$`
 * and `\[…\]` display math `\[…\]` (math is found the way the app's
 * renderer finds it, src/core/content-reader.ts, and JSON-escape damage
 * inside it is repaired first, src/core/math-delims.ts); `**bold**`,
 * `*italic*`/`_italic_`, `` `code` ``, fenced code blocks, `- ` and `1. `
 * lists, `#` headings (as bold lines) and line breaks. Math and code are
 * never touched by the prose rules.
 */
export function markdownToAnkiHtml(markdown: string): string {
	if (markdown.trim() === "") return "";
	const source = repairMathForDisplay(markdown.replace(/[]/g, "")).replace(/\r\n?/g, "\n");
	const held: string[] = [];
	const blocks = new Set<number>();
	const hold = (html: string, block = false): string => {
		held.push(html);
		if (block) blocks.add(held.length - 1);
		return `${HOLD_OPEN}${held.length - 1}${HOLD_CLOSE}`;
	};

	// 1. Math and code out of the prose.
	const spans = readContentSpans(source);
	let prose = "";
	spans.forEach((span, index) => {
		if (span.kind !== "math") {
			if (span.kind === "prose") prose += span.raw;
			else {
				const code = renderCode(span.raw);
				prose += hold(code.html, code.block);
			}
			return;
		}
		const after = spans[index + 1]?.raw.charAt(0) ?? "";
		const body = span.body.trim();
		if (body === "" || (span.open === "$" && isCurrency(span.body, after))) {
			prose += span.raw;
			return;
		}
		const display = span.open.startsWith("$") ? span.open.length >= 2 : span.open === "\\[";
		prose += hold(display ? `\\[${escapeHtml(body)}\\]` : `\\(${escapeHtml(body)}\\)`, display);
	});

	// 2. Backslash escapes stay literal; then the prose is escaped.
	prose = escapeHtml(prose.replace(/\\([\\`*_{}[\]()#+\-.!$|~<>])/g, (_match, char: string) => hold(escapeHtml(char))));

	// 3. Lines: lists, headings, blocks, text.
	const lines: Line[] = [];
	for (const raw of prose.split("\n")) {
		const onlyHeld = ONLY_HELD.exec(raw);
		if (onlyHeld && blocks.has(Number(onlyHeld[1]))) {
			lines.push({ type: "block", html: raw.trim() });
			continue;
		}
		if (raw.trim() === "") {
			lines.push({ type: "blank" });
			continue;
		}
		const bullet = /^\s*[-*+]\s+(.*)$/.exec(raw);
		const numbered = bullet ? null : /^\s*(\d{1,9})([.)])\s+(.*)$/.exec(raw);
		// "1) this 2) that" on one line is an inline enumeration, not a one-item list.
		const enumeration = numbered !== null && new RegExp(`(?:^|\\s)${Number(numbered[1]) + 1}\\${numbered[2]}\\s`).test(numbered[3]!);
		const itemText = bullet ? bullet[1] : numbered && !enumeration ? numbered[3] : undefined;
		if (itemText !== undefined) {
			const ordered = numbered !== null;
			const previous = lines[lines.length - 1];
			if (previous?.type === "list" && previous.ordered === ordered) previous.items.push(inline(itemText.trim()));
			else lines.push({ type: "list", ordered, items: [inline(itemText.trim())] });
			continue;
		}
		const heading = /^\s{0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$/.exec(raw);
		lines.push({ type: "text", html: heading ? `<b>${inline(heading[1]!)}</b>` : inline(raw.trim()) });
	}

	// 4. Joined: <br> between text lines, a blank line as two.
	let html = "";
	let previous: Line["type"] | null = null;
	let blankBefore = false;
	for (const line of lines) {
		if (line.type === "blank") {
			blankBefore = true;
			continue;
		}
		if (line.type === "text") {
			if (previous === "text") html += blankBefore ? "<br><br>" : "<br>";
			html += line.html;
		} else if (line.type === "block") {
			html += line.html;
		} else {
			const tag = line.ordered ? "ol" : "ul";
			html += `<${tag}>${line.items.map((item) => `<li>${item}</li>`).join("")}</${tag}>`;
		}
		previous = line.type;
		blankBefore = false;
	}

	return html.replace(HELD, (_match, index: string) => held[Number(index)] ?? "");
}

// ─── note fields ────────────────────────────────────────────────────────────

function formatDate(date: Date, locale: string): string {
	if (Number.isNaN(date.getTime())) return "";
	try {
		return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(date);
	} catch {
		return new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(date);
	}
}

/** The note's fields: the ledger id, the card's four texts as HTML, and
 *  the source line `LearnHarness · <session title> · <date>`. */
export function ankiNoteFields(
	rec: AnkiCardRecord & { card: AnkiCardDraft },
	opts: { date: Date; locale: string },
): Record<AnkiNoteField, string> {
	const source = [APP_NAME, rec.sessionTitle.trim(), formatDate(opts.date, opts.locale)]
		.filter((part) => part !== "")
		.join(" · ");
	return {
		"LH ID": rec.id,
		Front: markdownToAnkiHtml(rec.card.front),
		Back: markdownToAnkiHtml(rec.card.back),
		Why: markdownToAnkiHtml(rec.card.why),
		Pitfall: markdownToAnkiHtml(rec.card.pitfall),
		Source: escapeHtml(source),
	};
}
