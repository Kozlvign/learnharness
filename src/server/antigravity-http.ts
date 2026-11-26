/** GET/POST /api/antigravity: the Antigravity connection's status and controls.
 * Works in desktop and web/dev mode alike: the server itself drives agy, so no
 * main-process owner is involved. The global proxy still gates desktop
 * requests; these checks add the same-origin rule the subscription controls use. */
import {
	antigravityStatus, antigravityStatusForDisplay, cancelAntigravityInstall, cancelAntigravityLogin, installAntigravity,
	logoutAntigravity, refreshAntigravity, removeAntigravityRuntime, setAntigravityConsent, startAntigravityLogin, submitAntigravityLoginCode,
} from "../agent/antigravity/connection.ts";
import { subscriptionRequestOrigin } from "./web-subscription-http.ts";

const HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" };
const MAX_BODY = 8192;
/** Messages the controls may show as they are; anything else gets the generic one. */
const SHOWN = /^(Antigravity is not installed\.|Start sign-in first, then paste the code\.|Paste the code from Google's page, or that page's full address\.|This Antigravity version cannot sign out\. Update it\.|Wait for the installation to finish\.)$/;

function authorized(request: Request): boolean {
	const origin = subscriptionRequestOrigin(request);
	if (!origin || request.headers.get("x-learnharness-antigravity") !== "1") return false;
	if (request.headers.get("sec-fetch-site") === "cross-site") return false;
	const supplied = request.headers.get("origin");
	return request.method === "GET" ? !supplied || supplied === origin : supplied === origin;
}
function error(message: string, status: number): Response { return Response.json({ error: message }, { status, headers: HEADERS }); }
const ok = () => Response.json(antigravityStatus(), { headers: HEADERS });

export async function antigravityResponse(request: Request): Promise<Response> {
	if (!authorized(request)) return error("Antigravity controls require a same-origin LearnHarness request.", 403);
	try {
		if (request.method === "GET") {
			const refresh = new URL(request.url).searchParams.get("refresh") === "1";
			return Response.json(refresh ? await refreshAntigravity() : antigravityStatusForDisplay(), { headers: HEADERS });
		}
		if (request.method !== "POST") return error("Unsupported method.", 405);
		if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") return error("Expected JSON.", 415);
		const text = await request.text();
		if (text.length > MAX_BODY) return error("Request too large.", 413);
		const command = JSON.parse(text) as { op?: unknown; enabled?: unknown; code?: unknown };
		switch (command.op) {
			case "refresh": return Response.json(await refreshAntigravity(), { headers: HEADERS });
			case "install": installAntigravity(); return ok();
			case "cancel-install": cancelAntigravityInstall(); return ok();
			case "remove-runtime": await removeAntigravityRuntime(); return ok();
			case "login-start": await startAntigravityLogin(); return ok();
			case "login-submit":
				if (typeof command.code !== "string") return error("Unsupported control.", 400);
				submitAntigravityLoginCode(command.code); return ok();
			case "login-cancel": cancelAntigravityLogin(); return ok();
			case "logout": await logoutAntigravity(); return ok();
			case "consent":
				if (typeof command.enabled !== "boolean") return error("Unsupported control.", 400);
				setAntigravityConsent(command.enabled); return ok();
			default: return error("Unsupported control.", 400);
		}
	} catch (cause) {
		const message = cause instanceof Error && SHOWN.test(cause.message) ? cause.message : "The Antigravity connection could not be changed. Try again.";
		return error(message, 400);
	}
}
