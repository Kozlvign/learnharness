/** GET/POST /api/claude: the Claude connection's status and controls.
 * Works in desktop and web/dev mode alike: the server itself drives Claude
 * Code, so no main-process owner is involved. The global proxy still gates
 * desktop requests; these checks add the same-origin rule the subscription
 * controls use. */
import { claudeStatus, claudeStatusForDisplay, refreshClaude, setClaudeConsent, startClaudeLogin } from "../agent/claude/connection.ts";
import { subscriptionRequestOrigin } from "./web-subscription-http.ts";

const HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" };
const MAX_BODY = 4096;

function authorized(request: Request): boolean {
	const origin = subscriptionRequestOrigin(request);
	if (!origin || request.headers.get("x-learnharness-claude") !== "1") return false;
	if (request.headers.get("sec-fetch-site") === "cross-site") return false;
	const supplied = request.headers.get("origin");
	return request.method === "GET" ? !supplied || supplied === origin : supplied === origin;
}
function error(message: string, status: number): Response { return Response.json({ error: message }, { status, headers: HEADERS }); }

export async function claudeResponse(request: Request): Promise<Response> {
	if (!authorized(request)) return error("Claude controls require a same-origin LearnHarness request.", 403);
	try {
		if (request.method === "GET") {
			const refresh = new URL(request.url).searchParams.get("refresh") === "1";
			return Response.json(refresh ? await refreshClaude() : claudeStatusForDisplay(), { headers: HEADERS });
		}
		if (request.method !== "POST") return error("Unsupported method.", 405);
		if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") return error("Expected JSON.", 415);
		const text = await request.text();
		if (text.length > MAX_BODY) return error("Request too large.", 413);
		const command = JSON.parse(text) as { op?: unknown; enabled?: unknown };
		if (command.op === "refresh") return Response.json(await refreshClaude(), { headers: HEADERS });
		if (command.op === "login") { await startClaudeLogin(); return Response.json(claudeStatus(), { headers: HEADERS }); }
		if (command.op === "consent" && typeof command.enabled === "boolean") { setClaudeConsent(command.enabled); return Response.json(claudeStatus(), { headers: HEADERS }); }
		return error("Unsupported control.", 400);
	} catch (cause) {
		const message = cause instanceof Error && /not installed/i.test(cause.message) ? "Claude Code is not installed." : "The Claude connection could not be changed. Try again.";
		return error(message, 400);
	}
}
