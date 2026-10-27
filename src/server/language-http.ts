/** GET/PUT /api/language: the interface and tutor language (fork feature,
 * docs/language.md). The global proxy still gates desktop requests; writes
 * also need the same-origin rule the other fork controls use. */
import { languageSettings, saveLanguageSettings } from "../agent/language.ts";
import { DEFAULT_LOCALE, isLocale, isTutorLanguage, LOCALE_COOKIE, type LanguageSettings } from "../core/i18n/locales.ts";
import { subscriptionRequestOrigin } from "./web-subscription-http.ts";

const HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const MAX_BODY = 1024;

function sameOrigin(request: Request): boolean {
	const origin = subscriptionRequestOrigin(request);
	if (!origin || request.headers.get("sec-fetch-site") === "cross-site") return false;
	const supplied = request.headers.get("origin");
	return request.method === "GET" ? !supplied || supplied === origin : supplied === origin && request.headers.get("x-learnharness-language") === "1";
}
function error(message: string, status: number): Response { return Response.json({ error: message }, { status, headers: HEADERS }); }
/** The answer, with the cookie the boot script reads before first paint. */
function answer(settings: LanguageSettings): Response {
	const cookie = settings.ui === DEFAULT_LOCALE
		? `${LOCALE_COOKIE}=; Path=/; Max-Age=0; SameSite=Strict`
		: `${LOCALE_COOKIE}=${settings.ui}; Path=/; Max-Age=31536000; SameSite=Strict`;
	return Response.json({ settings }, { headers: { ...HEADERS, "Set-Cookie": cookie } });
}

export async function languageResponse(request: Request): Promise<Response> {
	if (!sameOrigin(request)) return error("Language settings require a same-origin LearnHarness request.", 403);
	if (request.method === "GET") return answer(languageSettings());
	if (request.method !== "PUT") return error("Unsupported method.", 405);
	if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") return error("Expected JSON.", 415);
	const text = await request.text();
	if (text.length > MAX_BODY) return error("Request too large.", 413);
	let body: { ui?: unknown; tutor?: unknown };
	try { body = JSON.parse(text) as typeof body; } catch { return error("Expected JSON.", 400); }
	const current = languageSettings();
	if (body.ui !== undefined && !isLocale(body.ui)) return error("Unsupported language.", 400);
	if (body.tutor !== undefined && !isTutorLanguage(body.tutor)) return error("Unsupported language.", 400);
	return answer(saveLanguageSettings({ ui: body.ui ?? current.ui, tutor: body.tutor ?? current.tutor }));
}
