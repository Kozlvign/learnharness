/**
 * The local dictation API (fork feature, docs/dictation.md):
 *
 *   GET  /api/dictation                    engine choice + model status
 *   PUT  /api/dictation                    { engine }
 *   POST /api/dictation/model              start the download
 *   DELETE /api/dictation/model            cancel the download, or remove the model
 *   POST /api/dictation/sessions           open a session → { id }
 *   POST /api/dictation/sessions/<id>      16 kHz 16-bit PCM → { texts }
 *   DELETE /api/dictation/sessions/<id>    discard the session
 *   POST /api/dictation/sessions/<id>/end  transcribe the rest → { texts }
 *
 * The global proxy still gates desktop requests. Writes also need the
 * same-origin rule and header the other fork controls use.
 */
import { DICTATION_HEADER, isDictationEngine, MAX_DICTATION_AUDIO_BYTES, MODEL_MISSING_CODE, type DictationStatus } from "../core/dictation-local.ts";
import {
	activeDictationSessions,
	appendDictationAudio,
	cancelDictationSession,
	DictationSessionGone,
	endDictationSession,
	openDictationSession,
	shutdownDictationEngine,
} from "./dictation/engine.ts";
import { cancelModelDownload, modelDir, modelReady, modelStatus, removeModel, startModelDownload } from "./dictation/model.ts";
import { dictationSettings, saveDictationSettings } from "./dictation/settings.ts";
import { subscriptionRequestOrigin } from "./web-subscription-http.ts";

const HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const MAX_JSON = 1024;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function sameOrigin(request: Request): boolean {
	const origin = subscriptionRequestOrigin(request);
	if (!origin || request.headers.get("sec-fetch-site") === "cross-site") return false;
	const supplied = request.headers.get("origin");
	return request.method === "GET" ? !supplied || supplied === origin : supplied === origin && request.headers.get(DICTATION_HEADER) === "1";
}

function error(message: string, status: number, code?: string): Response {
	return Response.json(code ? { error: message, code } : { error: message }, { status, headers: HEADERS });
}

function json(body: unknown, status = 200): Response {
	return Response.json(body, { status, headers: HEADERS });
}

export function dictationStatus(): DictationStatus {
	return { settings: dictationSettings(), model: modelStatus() };
}

function forbidden(): Response {
	return error("Dictation controls require a same-origin LearnHarness request.", 403);
}

function failure(cause: unknown): Response {
	if (cause instanceof DictationSessionGone) return error(cause.message, 404);
	return error(cause instanceof Error ? cause.message : "Dictation failed.", 500);
}

/** GET/PUT /api/dictation */
export async function dictationResponse(request: Request): Promise<Response> {
	if (!sameOrigin(request)) return forbidden();
	if (request.method === "GET") return json(dictationStatus());
	if (request.method !== "PUT") return error("Unsupported method.", 405);
	if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") return error("Expected JSON.", 415);
	const text = await request.text();
	if (text.length > MAX_JSON) return error("Request too large.", 413);
	let body: { engine?: unknown };
	try { body = JSON.parse(text) as typeof body; } catch { return error("Expected JSON.", 400); }
	if (!isDictationEngine(body.engine)) return error("Unsupported dictation engine.", 400);
	saveDictationSettings({ ...dictationSettings(), engine: body.engine });
	return json(dictationStatus());
}

/** POST/DELETE /api/dictation/model */
export async function dictationModelResponse(request: Request): Promise<Response> {
	if (!sameOrigin(request)) return forbidden();
	if (request.method === "POST") {
		startModelDownload();
		return json(dictationStatus(), 202);
	}
	if (request.method !== "DELETE") return error("Unsupported method.", 405);
	if (modelStatus().state === "downloading") {
		await cancelModelDownload();
		return json(dictationStatus());
	}
	if (activeDictationSessions() > 0) return error("Stop dictation before removing the model.", 409);
	await shutdownDictationEngine();
	try {
		await removeModel();
	} catch (cause) {
		const code = (cause as { code?: unknown } | null)?.code;
		return error(`Could not remove the model${typeof code === "string" ? ` (${code})` : ""}.`, 500);
	}
	return json(dictationStatus());
}

/** POST /api/dictation/sessions */
export async function dictationSessionsResponse(request: Request): Promise<Response> {
	if (!sameOrigin(request)) return forbidden();
	if (request.method !== "POST") return error("Unsupported method.", 405);
	if (!modelReady()) return error("The dictation model is not downloaded.", 409, MODEL_MISSING_CODE);
	try {
		return json({ id: await openDictationSession(modelDir()) });
	} catch (cause) {
		return failure(cause);
	}
}

/** POST/DELETE /api/dictation/sessions/<id> */
export async function dictationSessionResponse(request: Request, id: string): Promise<Response> {
	if (!sameOrigin(request)) return forbidden();
	if (!SESSION_ID.test(id)) return error("Unknown dictation session.", 404);
	if (request.method === "DELETE") {
		await cancelDictationSession(id);
		return new Response(null, { status: 204, headers: HEADERS });
	}
	if (request.method !== "POST") return error("Unsupported method.", 405);
	if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/octet-stream") return error("Expected audio.", 415);
	const length = Number(request.headers.get("content-length") ?? "0");
	if (length > MAX_DICTATION_AUDIO_BYTES) return error("Request too large.", 413);
	const audio = await request.arrayBuffer();
	if (audio.byteLength > MAX_DICTATION_AUDIO_BYTES) return error("Request too large.", 413);
	if (audio.byteLength % 2 !== 0) return error("Expected 16-bit audio.", 400);
	try {
		return json({ texts: await appendDictationAudio(id, audio) });
	} catch (cause) {
		return failure(cause);
	}
}

/** POST /api/dictation/sessions/<id>/end */
export async function dictationSessionEndResponse(request: Request, id: string): Promise<Response> {
	if (!sameOrigin(request)) return forbidden();
	if (!SESSION_ID.test(id)) return error("Unknown dictation session.", 404);
	if (request.method !== "POST") return error("Unsupported method.", 405);
	try {
		return json({ texts: await endDictationSession(id) });
	} catch (cause) {
		return failure(cause);
	}
}
