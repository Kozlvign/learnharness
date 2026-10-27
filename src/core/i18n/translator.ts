/**
 * Catalog lookup for displayed text (fork feature, docs/language.md).
 *
 * A catalog maps English text, exactly as the interface shows it, to its
 * translation. Keys with numbered placeholders ("{0} steps") are patterns:
 * a placeholder matches any value, and a value that is itself a catalog
 * entry is translated too ("Delete {0} selected {1}" with "nodes").
 * `null` marks text that is deliberately left as is.
 */

export type Messages = Readonly<Record<string, string | null>>;

/** Translated text, or null when the catalog has nothing for it.
 * `exactOnly` skips patterns: for places that may hold the learner's own
 * words, where "{0} thinking" must not rewrite "Critical thinking". */
export type Translator = (text: string, exactOnly?: boolean) => string | null;

interface Pattern {
	regex: RegExp;
	/** Placeholder number for each capture group, in source order. */
	order: number[];
	template: string;
	/** The longest literal piece: a cheap pre-check before the regex. */
	probe: string;
	literal: number;
}

const PLACEHOLDER = /\{(\d+)\}/g;

function escape(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compile(source: string, template: string): Pattern {
	const pieces = source.split(PLACEHOLDER);
	const order: number[] = [];
	let regex = "^";
	let probe = "";
	let literal = 0;
	pieces.forEach((piece, index) => {
		if (index % 2 === 1) {
			order.push(Number(piece));
			regex += "(.+?)";
			return;
		}
		regex += escape(piece);
		literal += piece.trim().length;
		if (piece.length > probe.length) probe = piece;
	});
	return { regex: new RegExp(`${regex}$`, "s"), order, template, probe, literal };
}

/** Whitespace runs collapse the way JSX and HTML collapse them. */
export function normalizeText(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

export function createTranslator(messages: Messages): Translator {
	const exact = new Map<string, string>();
	const patterns: Pattern[] = [];
	for (const [source, target] of Object.entries(messages)) {
		if (!target || target === source) continue;
		if (/\{\d+\}/.test(source)) patterns.push(compile(source, target));
		else exact.set(source, target);
	}
	// Most literal text first: "Delete {0} nodes?" wins over "Delete {0}".
	patterns.sort((a, b) => b.literal - a.literal);

	const lookup = (core: string, exactOnly: boolean): string | null => {
		const hit = exact.get(core);
		if (hit !== undefined || exactOnly) return hit ?? null;
		for (const pattern of patterns) {
			if (!core.includes(pattern.probe)) continue;
			const match = pattern.regex.exec(core);
			if (!match) continue;
			return pattern.template.replace(PLACEHOLDER, (_, n: string) => {
				const group = pattern.order.indexOf(Number(n));
				const value = group >= 0 ? match[group + 1] ?? "" : "";
				const [, before = "", inner = "", after = ""] = /^(\s*)([\s\S]*?)(\s*)$/.exec(value) ?? [];
				const known = exact.get(inner);
				return known === undefined ? value : `${before}${known}${after}`;
			});
		}
		return null;
	};

	return (text, exactOnly = false) => {
		const parts = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
		if (!parts) return null;
		const core = normalizeText(parts[2]!);
		if (!/[A-Za-z]/.test(core)) return null;
		const translated = lookup(core, exactOnly);
		return translated === null ? null : `${parts[1]}${translated}${parts[3]}`;
	};
}
