// Fork: images attached to messages (docs/images.md).
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-images-"));
process.env.LH_DATA_DIR = scratch;
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const core = await import("../src/core/index.ts");
const { ChatInputError, inputAppends, parseChatInput, parseUserSteerInput, newUserMessage, newUserSteer, projectView, serializeForSummary, attachmentsOf, MAX_IMAGES_PER_MESSAGE } = core;
const { attachmentData, attachmentPath, withAttachedImages } = await import("../src/agent/attachments.ts");
const { attachmentResponse, sniffImageType, storeAttachment, sweepAttachments, uploadAttachmentResponse, ATTACHMENT_GRACE_MS } = await import("../src/server/attachments-http.ts");
const { userBlocks } = await import("../src/agent/claude/transcript.ts");
const { absorbed } = await import("../components/session-core.ts");
const { initialPromptOwed } = await import("../components/chat.tsx");
const { readOpeningPromptEntry, stashOpeningPrompt } = await import("../components/opening-prompt.ts");
const { startDraftSession } = await import("../components/new-session.tsx");
const { SessionStarter } = await import("../components/start-session.ts");
const { dragTakenAsImages, takeDroppedImages, acceptDroppedImages } = await import("../components/attachments/drop-target.ts");
const { Composer } = await import("../components/composer.tsx");
const { MessageImages } = await import("../components/attachments/composer-images.tsx");
const { fitScale, pastedImages } = await import("../components/attachments/image-files.ts");
type ComposerImages = import("../components/attachments/use-composer-images.ts").ComposerImages;
type Context = import("@earendil-works/pi-ai").Context;
const ready = (context: unknown, input: ("text" | "image")[]) => withAttachedImages(context as Context, { input });

const A = `${"a".repeat(32)}.png`;
const B = `${"b".repeat(32)}.jpg`;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3]);
const ORIGIN = "http://127.0.0.1:3123";

function upload(body: Uint8Array, headers: Record<string, string> = {}): Request {
	return new Request(`${ORIGIN}/api/attachments`, {
		method: "POST",
		headers: { origin: ORIGIN, "content-type": "image/png", "x-learnharness-attachment": "1", ...headers },
		body: new Blob([body as Uint8Array<ArrayBuffer>]),
	});
}

describe("input events", () => {
	it("a text send may carry images, and then its text may be empty", () => {
		assert.deepEqual(parseChatInput({ type: "text", text: "what is this?", images: [A, B] }), { type: "text", text: "what is this?", images: [A, B] });
		assert.deepEqual(parseChatInput({ type: "text", text: "", images: [A] }), { type: "text", text: "", images: [A] });
		assert.deepEqual(parseChatInput({ type: "text", text: "hi" }), { type: "text", text: "hi" }, "text alone is unchanged");
		assert.throws(() => parseChatInput({ type: "text", text: " " }), ChatInputError);
	});

	it("only distinct attachment names within the limit are accepted", () => {
		for (const images of [["../secret.png"], [A, A], "a.png", Array.from({ length: MAX_IMAGES_PER_MESSAGE + 1 }, (_, i) => `${i.toString(16).padStart(32, "0")}.png`)]) {
			assert.throws(() => parseChatInput({ type: "text", text: "x", images }), ChatInputError);
		}
	});

	it("steers carry images too", () => {
		assert.deepEqual(parseUserSteerInput({ type: "steer", id: "steer_1", text: "", images: [A] }), { type: "steer", id: "steer_1", text: "", images: [A] });
		assert.throws(() => parseUserSteerInput({ type: "steer", id: "steer_1", text: "" }), ChatInputError);
		assert.deepEqual(newUserSteer("look", "steer_1", [A]).content, [{ type: "image", mimeType: "image/png", data: "", attachment: A }, { type: "text", text: "look" }]);
	});

	it("the record keeps names, images first, and plain text stays a string", () => {
		const [message] = inputAppends({ messages: [] }, { type: "text", text: "explain", images: [A, B] });
		assert.deepEqual((message as { content: unknown }).content, [
			{ type: "image", mimeType: "image/png", data: "", attachment: A },
			{ type: "image", mimeType: "image/jpeg", data: "", attachment: B },
			{ type: "text", text: "explain" },
		]);
		assert.equal(newUserMessage("plain").content, "plain");
		assert.deepEqual(attachmentsOf(newUserMessage("", [B]).content), [B]);
	});
});

describe("views", () => {
	it("a sent message shows its images before its text", () => {
		const view = projectView([{ ...newUserMessage("see", [A]), id: "u1" }] as never);
		assert.deepEqual(view[0]!.parts.map((part) => part.type), ["image", "text"]);
		assert.equal(view[0]!.parts[0]!.attachment, A);
	});

	it("the compaction summary input names the images", () => {
		const text = serializeForSummary([{ ...newUserMessage("my work", [A, B]), id: "u1" }] as never);
		assert.match(text, /\[LEARNER\] \(attached 2 images\) my work/);
		assert.doesNotMatch(text, /object Object/);
	});

	it("the optimistic copy is absorbed by its server copy", () => {
		const local = { ...newUserMessage("q", [A]), id: "c_1" };
		const server = { ...newUserMessage("q", [A]), id: "msg_1" };
		assert.ok(absorbed(local as never, [server as never]));
		assert.ok(!absorbed(local as never, [{ ...newUserMessage("q", [B]), id: "msg_2" } as never]));
	});

	it("a new session can start from images alone", async () => {
		const data = new Map<string, string>();
		const saved = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
		Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: {
			getItem: (key: string) => data.get(key) ?? null,
			setItem: (key: string, value: string) => { data.set(key, value); },
			removeItem: (key: string) => { data.delete(key); },
		} });
		try {
			const calls: unknown[] = [];
			const fetchLike = (async (_url: string, init?: RequestInit) => {
				calls.push(JSON.parse(String(init?.body)));
				return Response.json({ id: "chat_1" });
			}) as typeof fetch;
			// The title names the images; the opening message stays empty text with the images.
			assert.equal(await startDraftSession("", fetchLike, undefined, undefined, new SessionStarter(), undefined, [A, B]), "/chat/chat_1");
			assert.deepEqual(calls, [{ title: "Images" }]);
			assert.deepEqual(readOpeningPromptEntry("chat_1"), { text: "", images: [A, B], attempted: false });
			// Text openings keep upstream's shape.
			assert.equal(stashOpeningPrompt("chat_2", "hi"), true);
			assert.deepEqual(readOpeningPromptEntry("chat_2"), { text: "hi", attempted: false });
			// Invalid names never reach a send.
			data.set("lh.openingPrompt.chat_3", JSON.stringify({ text: "hi", images: ["../x.png"], attempted: false }));
			assert.deepEqual(readOpeningPromptEntry("chat_3"), { text: "hi", attempted: false });
			// Different images are a different start, not a retry of the same one.
			const starter = new SessionStarter();
			await starter.start({ title: "Image" }, fetchLike, undefined, { text: "", images: [A] });
			await starter.start({ title: "Image" }, fetchLike, undefined, { text: "", images: [B] });
			assert.equal(calls.length, 3);
		} finally {
			if (saved) Object.defineProperty(globalThis, "sessionStorage", saved);
			else Reflect.deleteProperty(globalThis, "sessionStorage");
		}
		assert.equal(initialPromptOwed([], "", [A]), true);
		assert.equal(initialPromptOwed([], "", []), false);
	});
});

describe("dropped files", () => {
	const file = (name: string, type: string) => new File([new Uint8Array([1])], name, { type });
	const drag = (...types: string[]) => ({ items: types.map((type) => ({ kind: "file", type })) as unknown as DataTransferItemList });

	it("images go to the composer that takes them; other files stay path chips", () => {
		const shot = file("shot.png", "image/png"), notes = file("notes.pdf", "application/pdf");
		assert.equal(takeDroppedImages([shot, notes]).size, 0, "with no composer taking images, every file becomes a path chip");
		assert.equal(dragTakenAsImages(drag("image/png")), false);
		const received: File[][] = [];
		const stop = acceptDroppedImages((files) => received.push(files));
		try {
			assert.deepEqual([...takeDroppedImages([shot, notes])], [shot]);
			assert.deepEqual(received, [[shot]]);
			assert.equal(dragTakenAsImages(drag("image/png", "image/jpeg")), true, "a drag of images only shows the composer's hint");
			assert.equal(dragTakenAsImages(drag("image/png", "application/pdf")), false, "mixed drags show the path overlay");
		} finally {
			stop();
		}
		assert.equal(takeDroppedImages([shot]).size, 0, "unregistered composers take nothing");
	});
});

describe("model calls", () => {
	it("models that see images get the bytes; the record is untouched", () => {
		const name = storeAttachment(PNG, "image/png");
		const record = { ...newUserMessage("this", [name]), id: "u1" };
		const context = { messages: [record] };
		const prepared = ready(context, ["text", "image"]);
		const content = prepared.messages[0]!.content as unknown as Array<Record<string, unknown>>;
		assert.deepEqual(content[0], { type: "image", mimeType: "image/png", data: Buffer.from(PNG).toString("base64") });
		assert.equal((record.content as Array<{ data: string }>)[0]!.data, "", "the record keeps only the name");
		// The Claude Code bridge sends it as an Anthropic image block.
		assert.deepEqual(userBlocks(prepared.messages[0] as never)[0], { type: "image", source: { type: "base64", media_type: "image/png", data: Buffer.from(PNG).toString("base64") } });
	});

	it("text-only models and missing files get a note instead", () => {
		const context = { messages: [{ ...newUserMessage("this", [A, B]), id: "u1" }] };
		const blind = ready(context, ["text"]).messages[0]!.content as Array<{ type: string; text?: string }>;
		assert.deepEqual(blind.map((block) => block.type), ["text", "text"]);
		assert.match(blind[0]!.text!, /attached 2 images here, but the model in use cannot see images/);
		const missing = ready(context, ["text", "image"]).messages[0]!.content as Array<{ type: string; text?: string }>;
		assert.match(missing[0]!.text!, /no longer available/);
		assert.equal(attachmentData(A), null);
	});

	it("contexts without attachments pass through as they are", () => {
		const context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };
		assert.equal(ready(context, ["text"]), context);
	});
});

describe("storage and routes", () => {
	it("recognizes images by their bytes", () => {
		assert.equal(sniffImageType(PNG), "image/png");
		assert.equal(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
		assert.equal(sniffImageType(new TextEncoder().encode("GIF89a....")), "image/gif");
		assert.equal(sniffImageType(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 ")), "image/webp");
		assert.equal(sniffImageType(new TextEncoder().encode("<svg></svg>")), null);
	});

	it("uploads are same-origin images within the size limit, stored once", async () => {
		const first = await uploadAttachmentResponse(upload(PNG));
		assert.equal(first.status, 200);
		const { name, mimeType } = (await first.json()) as { name: string; mimeType: string };
		assert.match(name, /^[a-f0-9]{32}\.png$/);
		assert.equal(mimeType, "image/png");
		assert.equal(((await (await uploadAttachmentResponse(upload(PNG))).json()) as { name: string }).name, name, "same bytes, same file");
		assert.equal((await uploadAttachmentResponse(upload(PNG, { "x-learnharness-attachment": "" }))).status, 403);
		assert.equal((await uploadAttachmentResponse(upload(PNG, { origin: "https://evil.example" }))).status, 403);
		assert.equal((await uploadAttachmentResponse(upload(PNG, { "content-type": "image/svg+xml" }))).status, 415);
		assert.equal((await uploadAttachmentResponse(upload(new TextEncoder().encode("<svg/>")))).status, 415);
		assert.equal((await uploadAttachmentResponse(upload(new Uint8Array(3_750_001).fill(0x89)))).status, 413);
	});

	it("serves stored images with a long cache, and nothing else", async () => {
		const name = storeAttachment(PNG, "image/png");
		const response = attachmentResponse(new Request(`${ORIGIN}/api/attachments/${name}`), name);
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("content-type"), "image/png");
		assert.match(response.headers.get("cache-control") ?? "", /immutable/);
		assert.deepEqual(new Uint8Array(await response.arrayBuffer()), PNG);
		assert.equal(attachmentResponse(new Request(`${ORIGIN}/api/attachments/x`), "../chats/x.json").status, 404);
		assert.equal(attachmentResponse(new Request(`${ORIGIN}/api/attachments/${A}`), A).status, 404);
		assert.equal(attachmentResponse(new Request(`${ORIGIN}/api/attachments/${name}`, { headers: { "sec-fetch-site": "cross-site" } }), name).status, 403);
	});

	it("removes images no chat refers to once the grace period is over", () => {
		const chats = path.join(scratch, "sweep-chats");
		fs.mkdirSync(chats, { recursive: true });
		const kept = storeAttachment(new Uint8Array([...PNG, 1]), "image/png");
		const orphan = storeAttachment(new Uint8Array([...PNG, 2]), "image/png");
		const fresh = storeAttachment(new Uint8Array([...PNG, 3]), "image/png");
		fs.writeFileSync(path.join(chats, "chat_x.json"), JSON.stringify({ messages: [newUserMessage("", [kept])] }, null, "\t"));
		const old = new Date(Date.now() - ATTACHMENT_GRACE_MS - 60_000);
		for (const name of [kept, orphan]) fs.utimesSync(attachmentPath(name), old, old);
		sweepAttachments(Date.now(), chats);
		assert.ok(fs.existsSync(attachmentPath(kept)), "referenced");
		assert.ok(!fs.existsSync(attachmentPath(orphan)), "unreferenced and old");
		assert.ok(fs.existsSync(attachmentPath(fresh)), "unreferenced but recent: maybe an unsent draft");
	});
});

describe("composer", () => {
	it("fits images to the size Claude uses", () => {
		assert.equal(fitScale(800, 600), 1);
		assert.equal(fitScale(0, 0), 1);
		const scale = fitScale(4032, 3024);
		assert.ok(4032 * scale <= 1568 && 4032 * scale * 3024 * scale <= 1_150_000 + 1);
		assert.ok(Math.round(3000 * fitScale(3000, 400)) <= 1568);
	});

	it("a paste with plain text stays a text paste", () => {
		const image = new File([PNG], "shot.png", { type: "image/png" });
		const transfer = (types: string[]) => ({ types, files: [image] as unknown as FileList });
		assert.deepEqual(pastedImages(transfer(["Files"])), [image]);
		assert.deepEqual(pastedImages(transfer(["text/plain", "Files"])), []);
		assert.deepEqual(pastedImages({ types: ["Files"], files: [new File(["x"], "a.txt", { type: "text/plain" })] as unknown as FileList }), []);
	});

	const images = (items: ComposerImages["items"] = []): ComposerImages => ({
		items, uploading: items.some((item) => item.name === null), dragging: false, error: null,
		add() {}, remove() {}, clear() {}, restore() {}, names: () => [], isUploading: () => false, onPaste() {}, pick() {},
	});
	const composer = (value: ComposerImages) => renderToStaticMarkup(
		<Composer busy={false} value="" onChange={() => {}} onSend={() => {}} onStop={() => {}} canSend images={value} />,
	);

	it("shows the attach button, and the tray only when there is something in it", () => {
		const empty = composer(images());
		assert.match(empty, /aria-label="Attach images"/);
		assert.doesNotMatch(empty, /composer-images/);
		const full = composer(images([{ key: "1", preview: "blob:1", name: A }, { key: "2", preview: "blob:2", name: null }]));
		assert.equal(full.match(/aria-label="Remove image"/g)?.length, 2);
		assert.equal(full.match(/aria-label="Attaching image"/g)?.length, 1);
	});

	it("the composer without images renders as upstream's", () => {
		const html = renderToStaticMarkup(<Composer busy={false} value="" onChange={() => {}} onSend={() => {}} onStop={() => {}} canSend />);
		assert.doesNotMatch(html, /Attach images/);
	});

	it("sent messages show their images", () => {
		const html = renderToStaticMarkup(<MessageImages parts={[{ type: "image", attachment: A }, { type: "text" }]} />);
		assert.ok(html.includes(`src="/api/attachments/${A}"`));
		assert.equal(renderToStaticMarkup(<MessageImages parts={[{ type: "text" }]} />), "");
	});
});
