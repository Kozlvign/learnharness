/**
 * POST /api/attachments and GET /api/attachments/<name>: images the learner
 * attaches to messages (fork feature, docs/images.md).
 *
 * Files are stored once under a name derived from their content, so the
 * same screenshot attached twice is one file. Files no chat refers to are
 * removed after a grace period that covers drafts not yet sent.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PATHS } from "../../config.ts";
import { attachmentPath, attachmentsDir } from "../agent/attachments.ts";
import { attachmentType, IMAGE_TYPES, isAttachmentName, MAX_IMAGE_BYTES, type ImageType } from "../core/attachments.ts";
import { subscriptionRequestOrigin } from "./web-subscription-http.ts";

const HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
/** Unsent drafts keep their images this long. */
export const ATTACHMENT_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const SWEEP_EVERY_MS = 12 * 60 * 60 * 1000;

function error(message: string, status: number): Response {
	return Response.json({ error: message }, { status, headers: HEADERS });
}

function sameOrigin(request: Request): boolean {
	const origin = subscriptionRequestOrigin(request);
	if (!origin || request.headers.get("sec-fetch-site") === "cross-site") return false;
	const supplied = request.headers.get("origin");
	return request.method === "GET" ? !supplied || supplied === origin : supplied === origin && request.headers.get("x-learnharness-attachment") === "1";
}

function startsWith(bytes: Uint8Array, signature: readonly number[], at = 0): boolean {
	return signature.every((byte, index) => bytes[at + index] === byte);
}

const ascii = (text: string) => Array.from(text, (char) => char.charCodeAt(0));

/** What the bytes are, read from their signature, or null for anything else. */
export function sniffImageType(bytes: Uint8Array): ImageType | null {
	if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
	if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
	if (startsWith(bytes, ascii("GIF87a")) || startsWith(bytes, ascii("GIF89a"))) return "image/gif";
	if (startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8)) return "image/webp";
	return null;
}

/** Store the image and return its attachment name. */
export function storeAttachment(bytes: Uint8Array, type: ImageType): string {
	const name = `${createHash("sha256").update(bytes).digest("hex").slice(0, 32)}.${IMAGE_TYPES[type]}`;
	const file = attachmentPath(name);
	if (existsSync(file)) {
		// Attached again: the grace period starts over.
		const now = new Date();
		utimesSync(file, now, now);
		return name;
	}
	mkdirSync(attachmentsDir(), { recursive: true });
	const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(temporary, bytes);
	renameSync(temporary, file);
	return name;
}

const REFERENCE = /"attachment"\s*:\s*"([a-f0-9]{32}\.(?:png|jpg|webp|gif))"/g;

/** Every attachment name the chat records refer to. */
export function referencedAttachments(chatsDir: string = PATHS.chats): Set<string> {
	const names = new Set<string>();
	let files: string[] = [];
	try { files = readdirSync(chatsDir).filter((file) => file.endsWith(".json")); } catch { return names; }
	for (const file of files) {
		let text: string;
		try { text = readFileSync(path.join(chatsDir, file), "utf8"); } catch { continue; }
		for (const match of text.matchAll(REFERENCE)) names.add(match[1]!);
	}
	return names;
}

/** Remove stored images no chat refers to, once they are older than the
 *  grace period. Returns how many were removed. */
export function sweepAttachments(now = Date.now(), chatsDir: string = PATHS.chats): number {
	let files: string[];
	try { files = readdirSync(attachmentsDir()); } catch { return 0; }
	const referenced = referencedAttachments(chatsDir);
	let removed = 0;
	for (const file of files) {
		const temporary = file.endsWith(".tmp");
		const stored = isAttachmentName(file);
		if (!stored && !temporary) continue;
		if (stored && referenced.has(file)) continue;
		const full = path.join(attachmentsDir(), file);
		try {
			if (now - statSync(full).mtimeMs < (stored ? ATTACHMENT_GRACE_MS : SWEEP_EVERY_MS)) continue;
			unlinkSync(full);
			removed++;
		} catch { /* already gone or busy: next sweep */ }
	}
	return removed;
}

const SWEPT = Symbol.for("lh.attachments.swept");
const sweepState = globalThis as typeof globalThis & { [SWEPT]?: number };

function sweepNowAndThen(): void {
	const now = Date.now();
	if (now - (sweepState[SWEPT] ?? 0) < SWEEP_EVERY_MS) return;
	sweepState[SWEPT] = now;
	try { sweepAttachments(now); } catch (err) { console.error("[attachments] sweep failed:", err); }
}

export async function uploadAttachmentResponse(request: Request): Promise<Response> {
	if (!sameOrigin(request)) return error("Attaching images requires a same-origin LearnHarness request.", 403);
	const declared = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
	if (!(declared in IMAGE_TYPES)) return error("Attach a PNG, JPEG, WebP or GIF image.", 415);
	if (Number(request.headers.get("content-length")) > MAX_IMAGE_BYTES) return error("The image is too large.", 413);
	const bytes = new Uint8Array(await request.arrayBuffer());
	if (bytes.byteLength === 0) return error("The image is empty.", 400);
	if (bytes.byteLength > MAX_IMAGE_BYTES) return error("The image is too large.", 413);
	const type = sniffImageType(bytes);
	if (!type) return error("Attach a PNG, JPEG, WebP or GIF image.", 415);
	const name = storeAttachment(bytes, type);
	sweepNowAndThen();
	return Response.json({ name, mimeType: type }, { headers: HEADERS });
}

export function attachmentResponse(request: Request, name: string): Response {
	if (!sameOrigin(request)) return error("Images require a same-origin LearnHarness request.", 403);
	if (!isAttachmentName(name)) return error("No such image.", 404);
	let bytes: Buffer;
	try { bytes = readFileSync(attachmentPath(name)); } catch { return error("No such image.", 404); }
	return new Response(new Uint8Array(bytes), {
		headers: {
			"Content-Type": attachmentType(name),
			"Content-Length": String(bytes.byteLength),
			// The name is the content's hash: it never changes.
			"Cache-Control": "private, max-age=31536000, immutable",
			"X-Content-Type-Options": "nosniff",
			"Content-Security-Policy": "default-src 'none'; sandbox",
		},
	});
}
