/**
 * Anki cards from mistakes (fork feature, docs/anki.md): the settings
 * parse. Lenient per field: a missing or invalid value falls back to its
 * default and the rest of the record still counts, so a hand-edited
 * `<data>/anki.json` or an older client never loses the whole choice.
 * Pure and browser-safe.
 */

import { ANKI_TRIGGERS, DEFAULT_ANKI_SETTINGS, type AnkiSettings, type AnkiTrigger } from "./contract.ts";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const MAX_DECK_TEMPLATE = 200;

/** AnkiConnect runs on the user's machine. Only a plain http URL to the
 *  loopback address is accepted (no credentials in it), so a pasted
 *  address can never send cards, or the apiKey, anywhere else. */
export function isLoopbackAnkiUrl(url: string): boolean {
	let parsed: URL;
	try {
		parsed = new URL(url.trim());
	} catch {
		return false;
	}
	return (
		parsed.protocol === "http:" &&
		LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase()) &&
		parsed.username === "" &&
		parsed.password === ""
	);
}

function integerIn(value: unknown, min: number, max: number, fallback: number): number {
	return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

export function parseAnkiSettings(value: unknown): AnkiSettings {
	const record = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
	const defaults = DEFAULT_ANKI_SETTINGS;

	const url = typeof record.url === "string" && isLoopbackAnkiUrl(record.url) ? record.url.trim() : defaults.url;
	const apiKey = typeof record.apiKey === "string" && record.apiKey.trim() !== "" ? record.apiKey.trim() : null;
	const template = typeof record.deckTemplate === "string" ? record.deckTemplate.trim() : "";
	const deckTemplate = template !== "" && template.length <= MAX_DECK_TEMPLATE ? template : defaults.deckTemplate;

	const rawTriggers =
		record.triggers && typeof record.triggers === "object" && !Array.isArray(record.triggers)
			? (record.triggers as Record<string, unknown>)
			: {};
	const triggers = {} as Record<AnkiTrigger, boolean>;
	for (const trigger of ANKI_TRIGGERS) {
		const raw = rawTriggers[trigger];
		triggers[trigger] = typeof raw === "boolean" ? raw : defaults.triggers[trigger];
	}

	return {
		enabled: typeof record.enabled === "boolean" ? record.enabled : defaults.enabled,
		url,
		apiKey,
		deckTemplate,
		triggers,
		lowConfidenceMax: integerIn(record.lowConfidenceMax, 0, 100, defaults.lowConfidenceMax),
		perSessionLimit: integerIn(record.perSessionLimit, 0, 100, defaults.perSessionLimit),
		enabledAt:
			typeof record.enabledAt === "string" && Number.isFinite(Date.parse(record.enabledAt)) ? record.enabledAt : null,
	};
}
