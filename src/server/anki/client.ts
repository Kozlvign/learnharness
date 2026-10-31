/**
 * The AnkiConnect client (fork feature, docs/anki.md). Speaks the add-on's
 * legacy protocol (POST / with `{ action, version: 6, params, key }`) to the
 * user's local Anki; Anki's own version comes best-effort from the add-on's
 * v1 JSON-RPC endpoint (POST /api/v1, `api.describe`).
 *
 * Server side only. Node's fetch sends no Origin header, and AnkiConnect
 * admits every request without one; never add an Origin header here.
 *
 * Errors: nothing answering (Anki closed, timeout) or Anki busy with its
 * collection closed → AnkiUnreachableError; a missing or wrong apiKey →
 * AnkiUnauthorizedError; the address answering but not as AnkiConnect →
 * AnkiProtocolError; the note type or a deck refused → AnkiSetupError; the
 * note deleted in Anki → AnkiNoteGoneError; anything else Anki refuses →
 * AnkiActionError.
 */
import { statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	ANKI_NOTE_FIELDS,
	ANKI_NOTE_TEMPLATE,
	ANKI_NOTE_TYPE_NAME,
	ANKICONNECT_ADDON_CODE,
	ANKICONNECT_API_VERSION,
	type AnkiConnection,
	type AnkiNoteField,
} from "../../core/anki/contract.ts";

export class AnkiError extends Error {}

/** Nothing answered (Anki closed, AnkiConnect missing, timeout), or Anki has
 *  no collection open right now. A later run may succeed. */
export class AnkiUnreachableError extends AnkiError {
	override name = "AnkiUnreachableError";
}

/** AnkiConnect wants an apiKey and the one sent is missing or wrong. */
export class AnkiUnauthorizedError extends AnkiError {
	override name = "AnkiUnauthorizedError";
}

/** Anki answered and refused the action (the add-on's error text). */
export class AnkiActionError extends AnkiError {
	override name = "AnkiActionError";
}

/** The address answered, but not as AnkiConnect: an HTTP error, a
 *  redirect, not JSON, an unexpected shape, an oversized answer. */
export class AnkiProtocolError extends AnkiError {
	override name = "AnkiProtocolError";
}

/** Preparing Anki for the cards (the note type, a deck) failed. The message
 *  is AnkiConnect's own, or why the note type cannot be completed. */
export class AnkiSetupError extends AnkiError {
	override name = "AnkiSetupError";
}

/** The note is no longer in Anki (deleted there). */
export class AnkiNoteGoneError extends AnkiError {
	override name = "AnkiNoteGoneError";
}

export interface AnkiClientOptions {
	/** AnkiConnect's address (a loopback URL from the settings). */
	url: string;
	apiKey: string | null;
	fetchImpl?: typeof fetch;
	/** Per call; default 5000 ms. The connection check uses at most 2500 ms. */
	timeoutMs?: number;
}

export interface AnkiCardNote {
	deck: string;
	fields: Record<AnkiNoteField, string>;
	tags: string[];
}

export interface AnkiClient {
	readonly url: string;
	invoke<T>(action: string, params?: Record<string, unknown>): Promise<T>;
	checkConnection(): Promise<AnkiConnection>;
	/** Creates the LearnHarness note type, or adds fields it lacks.
	 *  AnkiConnect refusing → AnkiSetupError. */
	ensureNoteType(): Promise<void>;
	/** AnkiConnect refusing → AnkiSetupError. */
	ensureDeck(name: string): Promise<void>;
	/** The new note's id. A duplicate "LH ID" fails (see isAnkiDuplicateError). */
	addCardNote(note: AnkiCardNote): Promise<number>;
	findNoteByLhId(id: string): Promise<number | null>;
	/** Brings the note's review cards forward: due today → true. No card in
	 *  review yet → false (new and learning cards come up anyway, and a due
	 *  date would skip their learning steps). The note gone → AnkiNoteGoneError. */
	resurface(noteId: number): Promise<boolean>;
	/** Deleting a note Anki no longer has succeeds. */
	deleteNote(noteId: number): Promise<void>;
	/** Opens Anki's card browser on the note. The note gone → AnkiNoteGoneError. */
	openNote(noteId: number): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 5000;
const CHECK_TIMEOUT_MS = 2500;
/** `api.describe` carries the whole v1 schema (about 230 KB). */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
/** How long a client trusts that the note type is in place. */
const NOTE_TYPE_TTL_MS = 60_000;

// The add-on's own texts (AnkiConnect __init__.py, legacy.py, runtime.py).
const KEY_ERROR = /valid api key must be provided/i;
const DUPLICATE_ERROR = /cannot create note because it is a duplicate/i;
const MODEL_EXISTS_ERROR = /model name already exists/i;
const UNSUPPORTED_ACTION = /unsupported action/i;
/** Anki is open but cannot take collection work right now (profile manager,
 *  sync, import, another long operation). */
const BUSY_ERROR = /collection is not available|collection operation is active|lifecycle operation is active|active collection operation|too many active operations/i;

const LH_ID = /^[0-9a-f]{16}$/;

export function isAnkiDuplicateError(err: unknown): boolean {
	return err instanceof AnkiActionError && DUPLICATE_ERROR.test(err.message);
}

function errorText(value: unknown): string {
	if (typeof value === "string") return value;
	try { return JSON.stringify(value); } catch { return String(value); }
}

function causeCode(cause: unknown): string | null {
	for (let current = cause, depth = 0; current && typeof current === "object" && depth < 4; current = (current as { cause?: unknown }).cause, depth += 1) {
		const code = (current as { code?: unknown }).code;
		if (typeof code === "string") return code;
	}
	return null;
}

function noteIdOf(value: unknown): number | null {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function requireNoteId(noteId: number): number {
	if (noteIdOf(noteId) === null) throw new AnkiActionError(`Not an Anki note id: ${String(noteId)}`);
	return noteId;
}

/** An AnkiConnect refusal while preparing the note type or a deck. */
function asSetupError(cause: unknown): unknown {
	return cause instanceof AnkiActionError ? new AnkiSetupError(cause.message, { cause }) : cause;
}

async function readBounded(response: Response, limit: number): Promise<string> {
	if (Number(response.headers.get("content-length")) > limit) {
		await response.body?.cancel().catch(() => undefined);
		throw new AnkiProtocolError("AnkiConnect's answer is too large.");
	}
	if (!response.body) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const next = await reader.read();
		if (next.done) break;
		size += next.value.byteLength;
		if (size > limit) {
			await reader.cancel().catch(() => undefined);
			throw new AnkiProtocolError("AnkiConnect's answer is too large.");
		}
		chunks.push(next.value);
	}
	return Buffer.concat(chunks).toString("utf8");
}

export function createAnkiClient(options: AnkiClientOptions): AnkiClient {
	const url = options.url;
	const apiKey = options.apiKey ? options.apiKey : null;
	const fetchImpl: typeof fetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const checkTimeoutMs = Math.min(CHECK_TIMEOUT_MS, timeoutMs);
	const legacyEndpoint = new URL("/", url).href;
	const rpcEndpoint = new URL("/api/v1", url).href;

	/** One POST; transport failures become AnkiUnreachableError. */
	async function post(endpoint: string, body: unknown, ms: number, headers: Record<string, string> = {}): Promise<{ status: number; text: string }> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), ms);
		const unreachable = (cause: unknown) => {
			if (controller.signal.aborted) return new AnkiUnreachableError(`Anki did not answer at ${url} within ${ms / 1000} s.`);
			const code = causeCode(cause);
			return new AnkiUnreachableError(`Nothing answered at ${url}${code ? ` (${code})` : ""}.`);
		};
		try {
			let response: Response;
			try {
				response = await fetchImpl(endpoint, {
					method: "POST",
					headers: { "content-type": "application/json", ...headers },
					body: JSON.stringify(body),
					redirect: "manual",
					signal: controller.signal,
				});
			} catch (cause) {
				throw unreachable(cause);
			}
			if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
				await response.body?.cancel().catch(() => undefined);
				throw new AnkiProtocolError(`${url} answered with a redirect, not as AnkiConnect.`);
			}
			try {
				return { status: response.status, text: await readBounded(response, MAX_RESPONSE_BYTES) };
			} catch (cause) {
				if (cause instanceof AnkiError) throw cause;
				throw unreachable(cause);
			}
		} finally {
			clearTimeout(timer);
		}
	}

	async function call<T>(action: string, params: Record<string, unknown>, ms: number): Promise<T> {
		const body = { action, version: ANKICONNECT_API_VERSION, params, ...(apiKey ? { key: apiKey } : {}) };
		const { status, text } = await post(legacyEndpoint, body, ms);
		if (status < 200 || status >= 300) throw new AnkiProtocolError(`${url} answered HTTP ${status} to "${action}".`);
		let reply: unknown;
		try { reply = JSON.parse(text); } catch { throw new AnkiProtocolError(`${url} did not answer "${action}" as AnkiConnect (not JSON).`); }
		if (!reply || typeof reply !== "object" || Array.isArray(reply) || !("result" in reply) || !("error" in reply)) {
			throw new AnkiProtocolError(`${url} did not answer "${action}" as AnkiConnect.`);
		}
		const { result, error } = reply as { result: unknown; error: unknown };
		if (error !== null && error !== undefined) {
			const message = errorText(error);
			if (KEY_ERROR.test(message)) throw new AnkiUnauthorizedError(`AnkiConnect wants a valid apiKey (${message}).`);
			if (BUSY_ERROR.test(message)) throw new AnkiUnreachableError(`Anki cannot take cards right now (${message}).`);
			throw new AnkiActionError(message);
		}
		return result as T;
	}

	/** Anki's version from the v1 API; null when anything goes wrong. */
	async function ankiVersion(): Promise<string | null> {
		try {
			const { status, text } = await post(rpcEndpoint, { jsonrpc: "2.0", id: 1, method: "api.describe" }, checkTimeoutMs, apiKey ? { authorization: `Bearer ${apiKey}` } : {});
			if (status !== 200) return null;
			const version = (JSON.parse(text) as { result?: { ankiVersion?: unknown } } | null)?.result?.ankiVersion;
			return typeof version === "string" && version ? version : null;
		} catch {
			return null;
		}
	}

	/** An action whose result must be a list. */
	async function list(action: string, params: Record<string, unknown>): Promise<unknown[]> {
		const result = await call<unknown>(action, params, timeoutMs);
		if (!Array.isArray(result)) throw new AnkiProtocolError(`${url} did not answer "${action}" as AnkiConnect.`);
		return result;
	}

	/** notesInfo answers `{}` for a note it does not have. */
	async function requireNote(noteId: number): Promise<void> {
		const [info] = await list("notesInfo", { notes: [noteId] });
		if (noteIdOf((info as { noteId?: unknown } | null | undefined)?.noteId) === null) throw new AnkiNoteGoneError(`Note ${noteId} is no longer in Anki.`);
	}

	let noteTypeEnsuredAt = Number.NEGATIVE_INFINITY;
	let ensuringNoteType: Promise<void> | null = null;

	async function ensureNoteTypeNow(): Promise<void> {
		const names = await list("modelNames", {});
		if (!names.includes(ANKI_NOTE_TYPE_NAME)) {
			try {
				await call("createModel", {
					modelName: ANKI_NOTE_TYPE_NAME,
					inOrderFields: [...ANKI_NOTE_FIELDS],
					css: ANKI_NOTE_TEMPLATE.css,
					isCloze: false,
					cardTemplates: [{ Name: ANKI_NOTE_TEMPLATE.name, Front: ANKI_NOTE_TEMPLATE.front, Back: ANKI_NOTE_TEMPLATE.back }],
				}, timeoutMs);
			} catch (cause) {
				// Created a moment ago by another client.
				if (!(cause instanceof AnkiActionError && MODEL_EXISTS_ERROR.test(cause.message))) throw cause;
			}
			return;
		}
		const present = await list("modelFieldNames", { modelName: ANKI_NOTE_TYPE_NAME });
		// Anki matches field names without regard to case.
		const lower = new Set(present.filter((name): name is string => typeof name === "string").map((name) => name.toLowerCase()));
		const missing = ANKI_NOTE_FIELDS.filter((field) => !lower.has(field.toLowerCase()));
		let count = lower.size;
		for (const field of missing) {
			try {
				// At its place in the canonical order: "LH ID" must stay first,
				// since Anki's duplicate check reads the first field.
				await call("modelFieldAdd", { modelName: ANKI_NOTE_TYPE_NAME, fieldName: field, index: Math.min(ANKI_NOTE_FIELDS.indexOf(field), count) }, timeoutMs);
				count += 1;
			} catch (cause) {
				if (cause instanceof AnkiActionError && UNSUPPORTED_ACTION.test(cause.message)) {
					// Field names in quotes: the page translator leaves them alone.
					throw new AnkiSetupError(
						`The "${ANKI_NOTE_TYPE_NAME}" note type in Anki lacks the field(s) ${missing.map((name) => `"${name}"`).join(", ")} and this AnkiConnect cannot add fields. ` +
						`Add them in Anki (Tools > Manage Note Types > ${ANKI_NOTE_TYPE_NAME} > Fields), or rename that note type so LearnHarness creates a fresh one.`,
						{ cause },
					);
				}
				throw cause;
			}
		}
	}

	return {
		url,

		invoke<T>(action: string, params: Record<string, unknown> = {}): Promise<T> {
			return call<T>(action, params, timeoutMs);
		},

		async checkConnection(): Promise<AnkiConnection> {
			try {
				const apiVersion = await call<unknown>("version", {}, checkTimeoutMs);
				if (typeof apiVersion !== "number" || !Number.isInteger(apiVersion)) return { state: "error", error: `${url} did not answer as AnkiConnect.` };
				if (apiVersion < ANKICONNECT_API_VERSION) {
					return { state: "error", error: `AnkiConnect is too old (API version ${apiVersion}; LearnHarness needs ${ANKICONNECT_API_VERSION}). Update the add-on in Anki.` };
				}
				const [profile, version] = await Promise.all([
					call<unknown>("getActiveProfile", {}, checkTimeoutMs).then((value) => (typeof value === "string" && value ? value : null), () => null),
					ankiVersion(),
				]);
				return { state: "connected", apiVersion, ankiVersion: version, profile };
			} catch (cause) {
				if (cause instanceof AnkiUnreachableError) return { state: "unreachable", addonInstalled: ankiAddonInstalled(), error: cause.message };
				if (cause instanceof AnkiUnauthorizedError) return { state: "unauthorized", error: cause.message };
				return { state: "error", error: cause instanceof Error ? cause.message : String(cause) };
			}
		},

		async ensureNoteType(): Promise<void> {
			if (Date.now() - noteTypeEnsuredAt < NOTE_TYPE_TTL_MS) return;
			ensuringNoteType ??= ensureNoteTypeNow()
				.then(() => { noteTypeEnsuredAt = Date.now(); }, (cause: unknown) => { throw asSetupError(cause); })
				.finally(() => { ensuringNoteType = null; });
			return ensuringNoteType;
		},

		async ensureDeck(name: string): Promise<void> {
			try {
				await call("createDeck", { deck: name }, timeoutMs);
			} catch (cause) {
				throw asSetupError(cause);
			}
		},

		async addCardNote(note: AnkiCardNote): Promise<number> {
			const id = noteIdOf(await call<unknown>("addNote", {
				note: {
					deckName: note.deck,
					modelName: ANKI_NOTE_TYPE_NAME,
					fields: note.fields,
					tags: note.tags,
					options: { allowDuplicate: false, duplicateScope: "collection" },
				},
			}, timeoutMs));
			if (id === null) throw new AnkiProtocolError(`${url} did not answer "addNote" with a note id.`);
			return id;
		},

		async findNoteByLhId(id: string): Promise<number | null> {
			if (!LH_ID.test(id)) throw new AnkiActionError(`Not a LearnHarness card id: ${id}`);
			const ids = await list("findNotes", { query: `"LH ID:${id}" note:${ANKI_NOTE_TYPE_NAME}` });
			for (const value of ids) {
				const noteId = noteIdOf(value);
				if (noteId !== null) return noteId;
			}
			return null;
		},

		async resurface(noteId: number): Promise<boolean> {
			// Review cards only: a due date turns a new or learning card into
			// a review card and skips its learning steps.
			const cards = await list("findCards", { query: `nid:${requireNoteId(noteId)} is:review` });
			if (cards.length > 0) {
				await call("setDueDate", { cards, days: "0" }, timeoutMs);
				return true;
			}
			await requireNote(noteId);
			return false;
		},

		async deleteNote(noteId: number): Promise<void> {
			await call("deleteNotes", { notes: [requireNoteId(noteId)] }, timeoutMs);
		},

		async openNote(noteId: number): Promise<void> {
			await requireNote(requireNoteId(noteId));
			await call("guiBrowse", { query: `nid:${noteId}` }, timeoutMs);
		},
	};
}

// ─── is the add-on installed? ───────────────────────────────────────────────

function isDirectory(dir: string): boolean {
	try { return statSync(dir).isDirectory(); } catch { return false; }
}

type Env = Readonly<Record<string, string | undefined>>;

function ankiBaseDir(env: Env, platform: NodeJS.Platform): string {
	if (env.ANKI_BASE) return env.ANKI_BASE;
	const home = (platform === "win32" ? env.USERPROFILE : env.HOME) || os.homedir();
	if (platform === "win32") return path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), "Anki2");
	if (platform === "darwin") return path.join(home, "Library", "Application Support", "Anki2");
	return path.join(env.XDG_DATA_HOME || path.join(home, ".local", "share"), "Anki2");
}

/** Whether AnkiConnect is in Anki's add-on folder: true/false, or null when
 *  Anki's data folder itself is not there (another location, or no Anki). */
export function ankiAddonInstalled(env: Env = process.env, platform: NodeJS.Platform = process.platform): boolean | null {
	const base = ankiBaseDir(env, platform);
	if (!isDirectory(base)) return null;
	return isDirectory(path.join(base, "addons21", ANKICONNECT_ADDON_CODE));
}
