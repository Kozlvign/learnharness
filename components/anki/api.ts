/**
 * Settings → Anki's requests (fork feature, docs/anki.md). Every route
 * answers with the whole AnkiStatus; a refused request throws the route's
 * `{ error }` text. Writes carry ANKI_HEADER, which a cross-site form
 * cannot send.
 */
import { ANKI_API, ANKI_HEADER, type AnkiCardRecord, type AnkiSettings, type AnkiStatus } from "@/src/core";

/** Shown when a request failed without a message of its own. */
export const ANKI_REQUEST_FAILED = "Anki request failed";

/** A settings write: only the fields that change (the server merges it over
 *  the stored record). `apiKey` goes only when the user sets or clears it;
 *  `enabledAt` is the server's. */
export type AnkiSettingsPatch = Partial<Omit<AnkiSettings, "enabledAt">>;

type Method = "GET" | "PUT" | "POST" | "DELETE";

function isStatus(body: unknown): body is AnkiStatus {
	if (!body || typeof body !== "object") return false;
	const value = body as Partial<AnkiStatus>;
	return (
		!!value.settings &&
		!!value.connection &&
		Array.isArray(value.cards) &&
		typeof value.pending === "number" &&
		typeof value.apiKeySet === "boolean"
	);
}

async function request(path: string, method: Method = "GET", json?: unknown): Promise<AnkiStatus> {
	const headers: Record<string, string> = {};
	if (method !== "GET") headers[ANKI_HEADER] = "1";
	if (json !== undefined) headers["content-type"] = "application/json";
	const response = await fetch(`${ANKI_API}${path}`, {
		method,
		cache: "no-store",
		headers,
		...(json === undefined ? {} : { body: JSON.stringify(json) }),
	});
	const body: unknown = await response.json().catch(() => null);
	if (response.ok && isStatus(body)) return body;
	const error = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
	throw new Error(typeof error === "string" && error.trim() ? error : `Anki request failed (${response.status})`);
}

/** Reads the settings, the cards and the live connection. */
export function loadAnkiStatus(): Promise<AnkiStatus> {
	return request("");
}

/** One card's record, from the ledger only (the chat's card status); null
 *  when the ledger has no such card. Throws like the other requests. */
export async function loadAnkiCard(id: string): Promise<AnkiCardRecord | null> {
	const response = await fetch(`${ANKI_API}/cards/${encodeURIComponent(id)}`, { cache: "no-store" });
	const body: unknown = await response.json().catch(() => null);
	const card = body && typeof body === "object" ? (body as { card?: unknown }).card : undefined;
	if (response.ok && card === null) return null;
	if (response.ok && isRecord(card)) return card;
	const error = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
	throw new Error(typeof error === "string" && error.trim() ? error : `Anki request failed (${response.status})`);
}

function isRecord(value: unknown): value is AnkiCardRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<AnkiCardRecord>;
	return typeof record.id === "string" && typeof record.status === "string";
}

/** Saves the changed settings fields. */
export function saveAnkiSettings(patch: AnkiSettingsPatch): Promise<AnkiStatus> {
	return request("", "PUT", patch);
}

/** Writes the cards that are ready and sends the queued ones now. */
export function syncAnki(): Promise<AnkiStatus> {
	return request("/sync", "POST");
}

/** Opens the card's note in Anki's browser. */
export function openAnkiCard(id: string): Promise<AnkiStatus> {
	return request(`/cards/${encodeURIComponent(id)}`, "POST", { action: "open" });
}

/** Sends a failed card again. */
export function retryAnkiCard(id: string): Promise<AnkiStatus> {
	return request(`/cards/${encodeURIComponent(id)}`, "POST", { action: "retry" });
}

/** Removes the card from Anki (when sent); it is never created again. */
export function removeAnkiCard(id: string): Promise<AnkiStatus> {
	return request(`/cards/${encodeURIComponent(id)}`, "DELETE");
}
