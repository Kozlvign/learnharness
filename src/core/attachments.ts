/**
 * Images the learner attaches to a message (fork feature, docs/images.md).
 *
 * A message with images keeps pi's native shape, a list of image and text
 * blocks, so every provider and the Claude Code bridge read it as usual.
 * The bytes live in `<data>/attachments` under a name derived from their
 * content. The chat record keeps only that name (`attachment`) with an
 * empty `data`, which src/agent/attachments.ts fills in for each model
 * call. Chat files stay small, and so does everything that reads them
 * (the sidebar reads every chat on each refresh).
 */
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

/** The image types every supported provider accepts, with their file extension. */
export const IMAGE_TYPES = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" } as const;
export type ImageType = keyof typeof IMAGE_TYPES;
const TYPE_OF_EXTENSION: Record<string, ImageType> = { png: "image/png", jpg: "image/jpeg", webp: "image/webp", gif: "image/gif" };

export const MAX_IMAGES_PER_MESSAGE = 8;
/** The largest image kept: about 5 MB once base64-encoded, the strictest
 *  provider limit (Anthropic's). */
export const MAX_IMAGE_BYTES = 3_750_000;
/** Images are scaled down to fit these before upload. Claude scales larger
 *  images down to about this size anyway, so bigger ones only cost upload
 *  time and tokens. */
export const IMAGE_MAX_EDGE = 1568;
export const IMAGE_MAX_PIXELS = 1_150_000;

/** An attached image as the record keeps it. */
export interface AttachedImage extends ImageContent {
	/** The stored file's name: 32 hex characters of its SHA-256 and the extension. */
	attachment: string;
}

const NAME = /^[a-f0-9]{32}\.(png|jpg|webp|gif)$/;

export function isAttachmentName(value: unknown): value is string {
	return typeof value === "string" && NAME.test(value);
}

export function attachmentType(name: string): ImageType {
	const type = TYPE_OF_EXTENSION[name.slice(name.lastIndexOf(".") + 1)];
	if (!type || !isAttachmentName(name)) throw new Error(`Not an attachment name: ${name}`);
	return type;
}

export function attachedImage(name: string): AttachedImage {
	return { type: "image", mimeType: attachmentType(name), data: "", attachment: name };
}

export function isAttachedImage(block: unknown): block is AttachedImage {
	if (!block || typeof block !== "object") return false;
	const candidate = block as { type?: unknown; attachment?: unknown };
	return candidate.type === "image" && isAttachmentName(candidate.attachment);
}

/** The attachment names in a message's content, in order. */
export function attachmentsOf(content: unknown): string[] {
	return Array.isArray(content) ? content.filter(isAttachedImage).map((block) => block.attachment) : [];
}

/** A user message's content: plain text as before, or the images followed by the text. */
export function userContent(text: string, images: readonly string[] = []): string | (TextContent | ImageContent)[] {
	if (images.length === 0) return text;
	return [...images.map(attachedImage), ...(text.trim() ? [{ type: "text" as const, text }] : [])];
}

/** The `images` field of an input event: absent means none. Null when it is
 *  not a list of distinct attachment names within the per-message limit. */
export function parseImageList(value: unknown): string[] | null {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > MAX_IMAGES_PER_MESSAGE || !value.every(isAttachmentName)) return null;
	return new Set(value).size === value.length ? [...value] : null;
}

/** How a message with images but no text is named where only text fits
 *  (a new session's title, a queued steer). A fixed word, so the
 *  interface translation also covers it in session titles. */
export function imagesLabel(count: number): string {
	return count === 1 ? "Image" : "Images";
}
