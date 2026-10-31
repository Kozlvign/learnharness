/**
 * The Anki cards API (fork feature, docs/anki.md):
 *
 *   GET    /api/anki              settings + live connection + the ledger
 *   PUT    /api/anki              a partial AnkiSettings, merged over the stored one
 *   POST   /api/anki/sync         run the pipeline now
 *   GET    /api/anki/cards/<id>   { card }: one ledger record (null when
 *                                 unknown), for the chat's card; no Anki call
 *   POST   /api/anki/cards/<id>   { action: "open" }: open the note in Anki
 *                                 { action: "retry" }: send a failed card again
 *   DELETE /api/anki/cards/<id>   remove the note from Anki, mark it removed
 *
 * Every answer is the full AnkiStatus. The apiKey is write-only: no answer
 * carries it (`apiKeySet` says whether one is stored). The global proxy
 * still gates desktop requests. Writes also need the same-origin rule and
 * header the other fork controls use. Errors carry `{ error, code? }`:
 * 503 Anki unreachable, 401 apiKey refused, 410 note gone from Anki,
 * 502 Anki refused (or did not answer as AnkiConnect).
 */
import {
	ANKI_HEADER,
	ANKI_REASONS,
	type AnkiCardRecord,
	type AnkiConnection,
	type AnkiSettings,
	type AnkiStatus,
} from "../../core/anki/contract.ts";
import { isLoopbackAnkiUrl, parseAnkiSettings } from "../../core/anki/settings.ts";
import { subscriptionRequestOrigin } from "../web-subscription-http.ts";
import {
	AnkiActionError,
	AnkiNoteGoneError,
	AnkiProtocolError,
	AnkiSetupError,
	AnkiUnauthorizedError,
	AnkiUnreachableError,
	createAnkiClient,
	type AnkiClient,
} from "./client.ts";
import { ankiSettings, readAnkiLedger, saveAnkiSettings, updateAnkiLedger } from "./store.ts";

const HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const MAX_SETTINGS_JSON = 4096;
const MAX_ACTION_JSON = 1024;
const MAX_CARDS = 100;
const CARD_ID = /^[0-9a-f]{16}$/;

function sameOrigin(request: Request): boolean {
	const origin = subscriptionRequestOrigin(request);
	if (!origin || request.headers.get("sec-fetch-site") === "cross-site") return false;
	const supplied = request.headers.get("origin");
	return request.method === "GET" ? !supplied || supplied === origin : supplied === origin && request.headers.get(ANKI_HEADER) === "1";
}

function error(message: string, status: number, code?: string): Response {
	return Response.json(code ? { error: message, code } : { error: message }, { status, headers: HEADERS });
}

function json(body: unknown, status = 200): Response {
	return Response.json(body, { status, headers: HEADERS });
}

function forbidden(): Response {
	return error("Anki controls require a same-origin LearnHarness request.", 403);
}

/** Client errors → 503 unreachable, 401 apiKey refused, 410 note gone,
 *  502 not AnkiConnect / setup refused / action refused. */
function failure(cause: unknown, context: string): Response {
	if (cause instanceof AnkiUnreachableError) return error(`${context}: ${cause.message} Open Anki and try again.`, 503, "unreachable");
	if (cause instanceof AnkiUnauthorizedError) return error(`${context}: ${cause.message}`, 401, "unauthorized");
	if (cause instanceof AnkiNoteGoneError) return error(`${context}: ${cause.message}`, 410, "noteGone");
	if (cause instanceof AnkiProtocolError) return error(`${context}: ${cause.message}`, 502, "protocol");
	if (cause instanceof AnkiSetupError) return error(`${context}: ${cause.message}`, 502, "setup");
	if (cause instanceof AnkiActionError) return error(`${context}: ${cause.message}`, 502, "action");
	console.error(`[anki] ${context}:`, cause);
	return error(`${context}.`, 500);
}

/** A JSON body of at most `limit` bytes, or the error response. */
async function readJson(request: Request, limit: number): Promise<unknown> {
	if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") return error("Expected JSON.", 415);
	if (Number(request.headers.get("content-length")) > limit) return error("Request too large.", 413);
	const reader = request.body?.getReader();
	if (!reader) return error("Expected JSON.", 400);
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const next = await reader.read();
			if (next.done) break;
			size += next.value.byteLength;
			if (size > limit) {
				await reader.cancel().catch(() => undefined);
				return error("Request too large.", 413);
			}
			chunks.push(next.value);
		}
	} finally {
		reader.releaseLock();
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
	} catch {
		return error("Expected JSON.", 400);
	}
}

function isObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * The body's fields over the stored settings, or the error response. A
 * field left out keeps its value (`triggers` per trigger). `apiKey`: a
 * non-empty string sets it, null or "" clears it, left out keeps it.
 * `enabledAt` is the server's and is ignored here.
 */
function mergedSettings(stored: AnkiSettings, body: Record<string, unknown>): AnkiSettings | Response {
	if (body.url !== undefined && (typeof body.url !== "string" || !isLoopbackAnkiUrl(body.url))) {
		return error("AnkiConnect's address must be a local http URL (127.0.0.1, localhost or [::1]).", 400);
	}
	if (body.apiKey !== undefined && body.apiKey !== null && typeof body.apiKey !== "string") return error("The apiKey must be text or null.", 400);
	if (body.triggers !== undefined && !isObject(body.triggers)) return error("The triggers must be an object.", 400);
	const { apiKey, triggers, enabledAt: _ignored, ...rest } = body;
	return parseAnkiSettings({
		...stored,
		...rest,
		apiKey: apiKey === undefined ? stored.apiKey : typeof apiKey === "string" && apiKey.trim() ? apiKey.trim() : null,
		triggers: { ...stored.triggers, ...(triggers as Record<string, unknown> | undefined) },
		enabledAt: stored.enabledAt,
	});
}

function newestFirst(a: AnkiCardRecord, b: AnkiCardRecord): number {
	const left = String(a.updatedAt ?? "");
	const right = String(b.updatedAt ?? "");
	return left === right ? 0 : left < right ? 1 : -1;
}

function noteIdOf(record: AnkiCardRecord): number | null {
	return typeof record.noteId === "number" && Number.isSafeInteger(record.noteId) && record.noteId > 0 ? record.noteId : null;
}

export interface AnkiHttpDeps {
	/** Runs the card pipeline once (src/server/anki/pipeline.ts). */
	runPipeline: () => Promise<void>;
	createClient: (settings: AnkiSettings) => AnkiClient;
}

export interface AnkiHttp {
	ankiStatus(): Promise<AnkiStatus>;
	ankiResponse(request: Request): Promise<Response>;
	ankiSyncResponse(request: Request): Promise<Response>;
	ankiCardResponse(request: Request, id: string): Promise<Response>;
}

const DEFAULT_DEPS: AnkiHttpDeps = {
	// Loaded on first use: the pipeline brings in the model stack.
	runPipeline: async () => {
		const { runAnkiPipeline } = await import("./pipeline.ts");
		await runAnkiPipeline();
	},
	createClient: (settings) => createAnkiClient({ url: settings.url, apiKey: settings.apiKey }),
};

/** The handlers over their dependencies; tests pass a stub pipeline. */
export function createAnkiHttp(overrides: Partial<AnkiHttpDeps> = {}): AnkiHttp {
	const deps: AnkiHttpDeps = { ...DEFAULT_DEPS, ...overrides };
	let flushing = false;
	let flushAgain = false;

	/** Runs the pipeline without holding up the answer. One run at a time;
	 *  a request during a run asks for one more run after it. */
	function flushInBackground(): void {
		if (flushing) {
			flushAgain = true;
			return;
		}
		flushing = true;
		void Promise.resolve()
			.then(() => deps.runPipeline())
			.catch((cause: unknown) => console.error("[anki] background flush failed:", cause))
			.finally(() => {
				flushing = false;
				if (flushAgain) {
					flushAgain = false;
					flushInBackground();
				}
			});
	}

	async function status(flush: boolean): Promise<AnkiStatus> {
		const settings = ankiSettings();
		const connection: AnkiConnection = settings.enabled ? await deps.createClient(settings).checkConnection() : { state: "disabled" };
		const { cards } = readAnkiLedger();
		if (flush && connection.state === "connected" && cards.some((card) => card.status === "queued")) flushInBackground();
		return {
			settings: { ...settings, apiKey: null },
			apiKeySet: settings.apiKey !== null,
			connection,
			cards: [...cards].sort(newestFirst).slice(0, MAX_CARDS),
			pending: cards.filter((card) => card.status === "waiting" || card.status === "queued").length,
		};
	}

	/** GET/PUT /api/anki */
	async function ankiResponse(request: Request): Promise<Response> {
		if (!sameOrigin(request)) return forbidden();
		try {
			if (request.method === "GET") return json(await status(true));
			if (request.method !== "PUT") return error("Unsupported method.", 405);
			const body = await readJson(request, MAX_SETTINGS_JSON);
			if (body instanceof Response) return body;
			if (!isObject(body)) return error("Expected the Anki settings.", 400);
			const merged = mergedSettings(ankiSettings(), body);
			if (merged instanceof Response) return merged;
			saveAnkiSettings(merged);
			return json(await status(true));
		} catch (cause) {
			return failure(cause, request.method === "GET" ? "Could not read the Anki status" : "Could not save the Anki settings");
		}
	}

	/** POST /api/anki/sync */
	async function ankiSyncResponse(request: Request): Promise<Response> {
		if (!sameOrigin(request)) return forbidden();
		if (request.method !== "POST") return error("Unsupported method.", 405);
		if (!ankiSettings().enabled) return error("Anki cards are turned off.", 409);
		try {
			await deps.runPipeline();
			return json(await status(false));
		} catch (cause) {
			return failure(cause, "Could not send the cards to Anki");
		}
	}

	async function openCard(id: string): Promise<Response> {
		try {
			const record = readAnkiLedger().cards.find((card) => card.id === id);
			if (!record) return error("Unknown Anki card.", 404);
			const noteId = noteIdOf(record);
			if (record.status !== "sent" || noteId === null) return error("This card has no note of its own in Anki.", 409);
			await deps.createClient(ankiSettings()).openNote(noteId);
			return json(await status(false));
		} catch (cause) {
			return failure(cause, "Could not open the note in Anki");
		}
	}

	async function retryCard(id: string): Promise<Response> {
		try {
			const outcome = await updateAnkiLedger((ledger) => {
				const record = ledger.cards.find((card) => card.id === id);
				if (!record) return "missing";
				if (record.status !== "failed") return "not failed";
				record.status = "queued";
				record.attempts = 0;
				delete record.reason;
				record.updatedAt = new Date().toISOString();
				return "queued";
			});
			if (outcome === "missing") return error("Unknown Anki card.", 404);
			if (outcome === "not failed") return error("Only a failed card can be sent again.", 409);
			flushInBackground();
			return json(await status(false));
		} catch (cause) {
			return failure(cause, "Could not send the card again");
		}
	}

	async function removeCard(id: string): Promise<Response> {
		try {
			const client = deps.createClient(ankiSettings());
			// Anki's delete runs inside the ledger update: a send in flight
			// cannot slip between the delete and the "removed" mark, and an
			// Anki failure leaves the record as it was.
			const found = await updateAnkiLedger(async (ledger) => {
				const record = ledger.cards.find((card) => card.id === id);
				if (!record) return false;
				if (record.status === "removed") return true;
				const noteId = noteIdOf(record);
				// A card folded into another (duplicateOf) has no note of its own.
				if (record.status === "sent" && noteId !== null && !record.duplicateOf) {
					try {
						await client.deleteNote(noteId);
					} catch (cause) {
						// Already deleted in Anki: nothing left to remove.
						if (!(cause instanceof AnkiNoteGoneError)) throw cause;
					}
				}
				record.status = "removed";
				record.reason = ANKI_REASONS.removedByUser;
				record.updatedAt = new Date().toISOString();
				return true;
			});
			if (!found) return error("Unknown Anki card.", 404);
			return json(await status(false));
		} catch (cause) {
			return failure(cause, "Could not remove the note from Anki");
		}
	}

	/** GET /api/anki/cards/<id>: the ledger record only (the tutor's card in
	 *  the chat reads it); an unknown id is `{ card: null }`, not a 404. */
	function cardRecord(id: string): Response {
		try {
			const card = CARD_ID.test(id) ? (readAnkiLedger().cards.find((record) => record.id === id) ?? null) : null;
			return json({ card });
		} catch (cause) {
			return failure(cause, "Could not read the Anki card");
		}
	}

	/** GET/POST/DELETE /api/anki/cards/<id> */
	async function ankiCardResponse(request: Request, id: string): Promise<Response> {
		if (!sameOrigin(request)) return forbidden();
		if (request.method === "GET") return cardRecord(id);
		if (!CARD_ID.test(id)) return error("Unknown Anki card.", 404);
		if (request.method === "DELETE") return removeCard(id);
		if (request.method !== "POST") return error("Unsupported method.", 405);
		const body = await readJson(request, MAX_ACTION_JSON);
		if (body instanceof Response) return body;
		const action = isObject(body) ? body.action : undefined;
		if (action === "open") return openCard(id);
		if (action === "retry") return retryCard(id);
		return error("Unsupported card action.", 400);
	}

	return { ankiStatus: () => status(true), ankiResponse, ankiSyncResponse, ankiCardResponse };
}

const handlers = createAnkiHttp();

/** Settings (without the apiKey), live connection and ledger. When Anki
 *  answers and cards are queued, the pipeline runs in the background to
 *  send them. */
export const ankiStatus = handlers.ankiStatus;
export const ankiResponse = handlers.ankiResponse;
export const ankiSyncResponse = handlers.ankiSyncResponse;
export const ankiCardResponse = handlers.ankiCardResponse;
