/**
 * Attached images on model calls (fork feature, docs/images.md).
 *
 * The chat record keeps each attached image as a file name. Every model
 * call passes through `withAttachedImages`, which puts the bytes back for
 * models that see images and a short note in their place for models that
 * do not. The record itself is never changed.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Api, Context, ImageContent, Message, Model, TextContent } from "@earendil-works/pi-ai";
import { PATHS } from "../../config.ts";
import { isAttachedImage, isAttachmentName } from "../core/attachments.ts";

export function attachmentsDir(): string {
	return path.join(PATHS.data, "attachments");
}

export function attachmentPath(name: string): string {
	if (!isAttachmentName(name)) throw new Error(`Not an attachment name: ${name}`);
	return path.join(attachmentsDir(), name);
}

/** Recently sent images stay encoded in memory: a session resends its
 *  images on every call. Bounded, least recently used first out. */
const CACHE = Symbol.for("lh.attachments.cache");
const CACHE_LIMIT = 64 * 1024 * 1024;
type Cache = { entries: Map<string, string>; size: number };
const globalCache = globalThis as typeof globalThis & { [CACHE]?: Cache };

/** The image's bytes as base64, or null when its file is gone. */
export function attachmentData(name: string): string | null {
	const cache = (globalCache[CACHE] ??= { entries: new Map(), size: 0 });
	const key = attachmentPath(name);
	const hit = cache.entries.get(key);
	if (hit !== undefined) {
		cache.entries.delete(key);
		cache.entries.set(key, hit);
		return hit;
	}
	let data: string;
	try { data = readFileSync(key).toString("base64"); } catch { return null; }
	cache.entries.set(key, data);
	cache.size += data.length;
	for (const [oldest, value] of cache.entries) {
		if (cache.size <= CACHE_LIMIT || oldest === key) break;
		cache.entries.delete(oldest);
		cache.size -= value.length;
	}
	return data;
}

function count(images: number): string {
	return images === 1 ? "an image" : `${images} images`;
}

export function missingImageNote(images: number): string {
	return `(The learner attached ${count(images)} here, but ${images === 1 ? "its file is" : "their files are"} no longer available.)`;
}

export function unseenImageNote(images: number): string {
	return `(The learner attached ${count(images)} here, but the model in use cannot see images. Tell the learner, and suggest describing ${images === 1 ? "it" : "them"} in words or switching to a model that can see images.)`;
}

type Block = TextContent | ImageContent;

function resolved(content: readonly Block[], sees: boolean): Block[] {
	const out: Block[] = [];
	let missing = 0;
	let unseen = 0;
	for (const block of content) {
		if (!isAttachedImage(block)) {
			out.push(block);
			continue;
		}
		if (!sees) {
			unseen++;
			continue;
		}
		const data = attachmentData(block.attachment);
		if (data) out.push({ type: "image", mimeType: block.mimeType, data });
		else missing++;
	}
	const notes = [...(unseen ? [unseenImageNote(unseen)] : []), ...(missing ? [missingImageNote(missing)] : [])];
	return notes.length ? [{ type: "text", text: notes.join("\n") }, ...out] : out;
}

/** The context with the learner's attached images ready for `model`. */
export function withAttachedImages<C extends Context>(context: C, model: Pick<Model<Api>, "input">): C {
	const sees = model.input.includes("image");
	let changed = false;
	const messages = context.messages.map((message): Message => {
		if (message.role !== "user" || !Array.isArray(message.content) || !message.content.some(isAttachedImage)) return message;
		changed = true;
		return { ...message, content: resolved(message.content, sees) };
	});
	return changed ? { ...context, messages } : context;
}
