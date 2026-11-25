// Fork: images attached to question answers, the reading field and practice
// thinking (docs/images.md, "In questions and practice").
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-answer-images-"));
process.env.LH_DATA_DIR = scratch;
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const core = await import("../src/core/index.ts");
const { ChatInputError, parseChatInput, parseDismissInput, newAnswerResult, newThinkingMessage, toLlmMessages, serializeForSummary, sideChatLessonDocument, answerAttachments, validatePluginBuiltinSubmissionAnswer } = core;
const { withAttachedImages, attachmentPath } = await import("../src/agent/attachments.ts");
const { storeAttachment, sweepAttachments, referencedAttachments, ATTACHMENT_GRACE_MS } = await import("../src/server/attachments-http.ts");
const { AnsweredCard } = await import("../components/answered-card.tsx");
const { ThinkingCard } = await import("../components/practice-cards.tsx");
const { ReadingThinkingField } = await import("../components/reading-thinking.tsx");
const { PracticeDock } = await import("../components/practice-dock.tsx");
const { dragTakenAsImages } = await import("../components/attachments/drop-target.ts");
type QuestionAnswerData = import("../src/core/question-core.ts").QuestionAnswerData;
type ComposerImages = import("../components/attachments/use-composer-images.ts").ComposerImages;
type Context = import("@earendil-works/pi-ai").Context;

const A = `${"a".repeat(32)}.png`;
const B = `${"b".repeat(32)}.jpg`;
const C = `${"c".repeat(32)}.webp`;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3]);
const attached = (name: string) => ({ type: "image", mimeType: name.endsWith(".png") ? "image/png" : name.endsWith(".jpg") ? "image/jpeg" : "image/webp", data: "", attachment: name });

const quizAnswer = (extra: Partial<QuestionAnswerData> = {}): QuestionAnswerData => ({
	kind: "quiz", tool: "quiz", questionText: "Slope at P?", options: [{ index: 1, label: "4" }, { index: 2, label: "2" }],
	dontKnow: false, answers: [{ index: 1, label: "4", value: "4" }], thinking: "derivative", correct: true, correctIndices: [1],
	answeredAt: "2026-11-25T00:00:00.000Z", ...extra,
} as QuestionAnswerData);

describe("input events", () => {
	it("an answer keeps its attached images per channel and drops empty channels", () => {
		const input = parseChatInput({ type: "answer", toolCallId: "q1", answer: quizAnswer({ attachments: { thinking: [A, B], readingThinking: [C], answer: [] } }) });
		assert.equal(input.type, "answer");
		if (input.type === "answer") assert.deepEqual(input.answer.attachments, { thinking: [A, B], readingThinking: [C] });
		const none = parseChatInput({ type: "answer", toolCallId: "q1", answer: quizAnswer({ attachments: { thinking: [] } }) });
		if (none.type === "answer") assert.equal("attachments" in none.answer, false);
	});

	it("only known channels of distinct attachment names are accepted", () => {
		for (const attachments of [{ thinking: ["../secret.png"] }, { thinking: [A, A] }, { notes: [A] }, [A], "x"]) {
			assert.throws(() => parseChatInput({ type: "answer", toolCallId: "q1", answer: { ...quizAnswer(), attachments } }), ChatInputError);
		}
	});

	it("practice thinking may be images alone", () => {
		assert.deepEqual(parseChatInput({ type: "thinking", problemCallId: "p1", text: "", attachments: [A] }), { type: "thinking", problemCallId: "p1", text: "", attachments: [A] });
		assert.throws(() => parseChatInput({ type: "thinking", problemCallId: "p1", text: " " }), ChatInputError);
		assert.throws(() => parseChatInput({ type: "thinking", problemCallId: "p1", text: "x", attachments: ["nope.png"] }), ChatInputError);
	});

	it("a dismissal keeps the reading field's images", () => {
		const input = parseDismissInput({ type: "dismiss", toolCallId: "q1", answer: { ...quizAnswer({ dismissed: true }), attachments: { readingThinking: [A] } } });
		assert.equal(input.type, "dismiss");
		if (input.type === "dismiss") assert.deepEqual(input.answer.attachments, { readingThinking: [A] });
	});

	it("images alone are a text-mode answer", () => {
		const question = { id: "e1", kind: "explain", question: "Prove it", mode: "text", options: [], createdAt: "" } as never;
		assert.throws(() => validatePluginBuiltinSubmissionAnswer(question, { text: "", images: [] }), /required/);
		assert.deepEqual(validatePluginBuiltinSubmissionAnswer(question, { text: "", images: [] }, true), { text: "" });
	});

	it("answerAttachments keeps only channels that hold images", () => {
		assert.deepEqual(answerAttachments({ answer: [], thinking: [A], readingThinking: undefined }), { thinking: [A] });
		assert.equal(answerAttachments({}), undefined);
	});
});

describe("record and model", () => {
	it("an answer's images follow its text, labeled by channel, attached before inline", () => {
		const inline = { type: "image" as const, mimeType: "image/png", data: Buffer.from(PNG).toString("base64") };
		const result = newAnswerResult("q1", "quiz", quizAnswer({ attachments: { thinking: [A], readingThinking: [B] }, images: { thinking: [inline] } }));
		const content = result.content as Array<{ type: string; text?: string }>;
		assert.deepEqual(content.slice(1), [
			{ type: "text", text: "Question thinking images:" }, attached(A), inline,
			{ type: "text", text: "Reading thinking images:" }, attached(B),
		]);
		assert.doesNotMatch(content[0]!.text!, /attachment/, "the answer's JSON never repeats the names");
		assert.deepEqual((result.details as unknown as QuestionAnswerData).attachments, { thinking: [A], readingThinking: [B] });
	});

	it("a dismissal's images stay in the record only, like its text", () => {
		const result = newAnswerResult("q1", "quiz", quizAnswer({ dismissed: true, readingThinking: "notes", attachments: { readingThinking: [A] } }));
		assert.equal((result.content as unknown[]).length, 1);
		assert.deepEqual((result.details as unknown as QuestionAnswerData).attachments, { readingThinking: [A] });
	});

	it("practice thinking keeps the names and sends the images after its text", () => {
		const marker = { ...newThinkingMessage("p1", "my work", undefined, [A]), id: "t1" };
		assert.deepEqual((marker.details as { attachments?: string[] }).attachments, [A]);
		const [message] = toLlmMessages([marker]);
		assert.equal(message!.role, "user");
		assert.deepEqual(message!.content, [{ type: "text", text: "Your thinking:\nmy work" }, attached(A)]);
		assert.equal("attachments" in (newThinkingMessage("p1", "plain").details as object), false, "no images, upstream's shape");
	});

	it("models get the bytes of an answer's images; text-only models get a note", () => {
		const name = storeAttachment(PNG, "image/png");
		const result = { ...newAnswerResult("q1", "quiz", quizAnswer({ attachments: { answer: [name] } })), id: "r1" };
		const context = { messages: [result] } as unknown as Context;
		const sees = withAttachedImages(context, { input: ["text", "image"] }).messages[0]!.content as unknown as Array<Record<string, unknown>>;
		assert.deepEqual(sees.at(-1), { type: "image", mimeType: "image/png", data: Buffer.from(PNG).toString("base64") });
		assert.equal((result.content as Array<{ data?: string }>).at(-1)!.data, "", "the record keeps only the name");
		const blind = withAttachedImages(context, { input: ["text"] }).messages[0]!.content as Array<{ type: string; text?: string }>;
		assert.equal(blind.some((block) => block.type === "image"), false);
		assert.match(blind[0]!.text!, /cannot see images/);
	});

	it("the compaction summary names the images instead of dumping their blocks", () => {
		const text = serializeForSummary([
			{ ...newAnswerResult("q1", "quiz", quizAnswer({ attachments: { thinking: [A] } })), id: "r1" },
			{ ...newThinkingMessage("p1", "work", undefined, [A, B]), id: "t1" },
		] as never);
		assert.match(text, /Question thinking images:\n\(attached an image\)/);
		assert.match(text, /\(attached 2 images\) Your thinking:/);
		assert.doesNotMatch(text, /"attachment"/);
	});

	it("the side helper is told where images were attached", () => {
		const call = { id: "m1", role: "assistant", content: [{ type: "toolCall", id: "q1", name: "quiz", arguments: { question: "Slope at P?", options: [{ label: "4" }, { label: "2" }], correctAnswer: "4" } }], stopReason: "toolUse", timestamp: 1 };
		const doc = sideChatLessonDocument([call, { ...newAnswerResult("q1", "quiz", quizAnswer({ attachments: { thinking: [A, B] } })), id: "r1" }] as never);
		assert.match(doc, /The learner attached images, not shown to you: 2 images with their thinking\./);
	});

	it("the cleanup keeps images that answers and practice thinking refer to", () => {
		const chats = path.join(scratch, "sweep-chats");
		fs.mkdirSync(chats, { recursive: true });
		const answered = storeAttachment(new Uint8Array([...PNG, 1]), "image/png");
		const skipped = storeAttachment(new Uint8Array([...PNG, 2]), "image/png");
		const practiced = storeAttachment(new Uint8Array([...PNG, 3]), "image/png");
		const orphan = storeAttachment(new Uint8Array([...PNG, 4]), "image/png");
		fs.writeFileSync(path.join(chats, "chat_x.json"), JSON.stringify({ messages: [
			newAnswerResult("q1", "quiz", quizAnswer({ attachments: { thinking: [answered] } })),
			newAnswerResult("q2", "quiz", quizAnswer({ dismissed: true, attachments: { readingThinking: [skipped] } })),
			newThinkingMessage("p1", "", undefined, [practiced]),
		] }, null, "\t"));
		assert.deepEqual([...referencedAttachments(chats)].sort(), [answered, skipped, practiced].sort());
		const old = new Date(Date.now() - ATTACHMENT_GRACE_MS - 60_000);
		for (const name of [answered, skipped, practiced, orphan]) fs.utimesSync(attachmentPath(name), old, old);
		sweepAttachments(Date.now(), chats);
		for (const name of [answered, skipped, practiced]) assert.ok(fs.existsSync(attachmentPath(name)), name);
		assert.ok(!fs.existsSync(attachmentPath(orphan)));
	});
});

describe("transcript", () => {
	it("the answered card shows each channel's images from their files", () => {
		const html = renderToStaticMarkup(<AnsweredCard answer={quizAnswer({ readingThinking: "", thinking: "", attachments: { thinking: [A], readingThinking: [B] } })} />);
		assert.ok(html.includes(`src="/api/attachments/${B}"`), "the reading block arrives open with its images");
		assert.match(html, /data-testid="reading-thinking-block"/, "images alone make the reading block");
		assert.match(html, /data-testid="your-thinking"/, "images alone make the thinking block (collapsed in the card)");
		const text = renderToStaticMarkup(<AnsweredCard answer={{ kind: "explain", tool: "explain", questionText: "Prove it", dontKnow: false, answers: [], answeredAt: "", attachments: { answer: [C] } } as QuestionAnswerData} />);
		assert.ok(text.includes(`src="/api/attachments/${C}"`), "an answer of images alone shows them");
	});

	it("practice thinking shows its images", () => {
		const html = renderToStaticMarkup(<ThinkingCard data={{ problemCallId: "p1", text: "", attachments: [A] }} />);
		assert.ok(html.includes(`src="/api/attachments/${A}"`));
	});
});

describe("fields", () => {
	const images = (items: ComposerImages["items"] = []): ComposerImages => ({
		items, uploading: items.some((item) => item.name === null), dragging: false, error: null,
		add() {}, remove() {}, clear() {}, restore() {}, names: () => [], isUploading: () => false, onPaste() {}, pick() {},
	});

	it("the reading field has the image button only when it takes images", () => {
		const field = (value?: ComposerImages) => renderToStaticMarkup(<ReadingThinkingField value="" revision={0} onChange={() => {}} claim images={value} />);
		assert.match(field(images()), /data-testid="attach-field-images"/);
		assert.doesNotMatch(field(), /attach-field-images/, "a plugin check's reading field takes none");
		const full = field(images([{ key: "1", preview: "/api/attachments/x", name: A }]));
		assert.match(full, /data-testid="field-images"/);
		assert.match(full, /aria-label="Remove image"/);
	});

	it("native practice has the image button; a plugin problem's field does not", () => {
		const dock = (custom: boolean) => renderToStaticMarkup(<PracticeDock problemCallId="p1" input={{ statement: "Find m" }} expanded onExpand={() => {}} onSubmit={() => {}}
			{...(custom ? { customInput: { editor: null, thinking: "", onThinkingChange() {}, ready: true, prepare() {} } } : {})} />);
		assert.match(dock(false), /data-testid="attach-field-images"/);
		assert.doesNotMatch(dock(true), /attach-field-images/);
	});
});

describe("question dock", async () => {
	const { parseHTML } = await import("linkedom");
	const { createRoot } = await import("react-dom/client");
	const { QuestionDock } = await import("../components/question-dock.tsx");
	type QuestionDockProps = import("../components/question-dock.tsx").QuestionDockProps;

	async function mount(props: Partial<QuestionDockProps>) {
		const dom = parseHTML("<html><body></body></html>");
		const previous = new Map<string, PropertyDescriptor | undefined>();
		for (const [key, value] of Object.entries({ window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} disconnect() {} } })) {
			previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
			Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
		}
		const host = document.createElement("div"); document.body.append(host);
		const root = createRoot(host);
		const render = (next: Partial<QuestionDockProps>) => act(async () => root.render(<QuestionDock toolName="quiz" toolCallId="q1"
			input={{ question: "Slope?", options: [{ label: "4" }, { label: "2" }], correctAnswer: "4", explanation: "The derivative is 4." } as never}
			expanded onExpand={() => {}} onSubmit={() => {}} {...props} {...next} />));
		await render({});
		return {
			host, render,
			async unmount() {
				await act(async () => root.unmount());
				for (const [key, descriptor] of previous) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as Record<string, unknown>)[key];
			},
		};
	}
	const drag = { items: [{ kind: "file", type: "image/png" }] as unknown as DataTransferItemList };

	it("takes dropped images while it holds dictation's claim", async () => {
		const dock = await mount({ dictationClaim: true });
		try {
			assert.ok(dock.host.querySelector('[data-testid="thinking-field"] [data-testid="attach-field-images"]'), "the button sits in the thinking field");
			assert.equal(dragTakenAsImages(drag), true);
			await dock.render({ dictationClaim: false });
			assert.equal(dragTakenAsImages(drag), false, "a closed check leaves them to the reading field");
		} finally { await dock.unmount(); }
	});

	it("a text answer of images alone submits, carrying them under the answer channel", async () => {
		let sent: QuestionAnswerData | undefined;
		const dock = await mount({ toolName: "ask_user_question", input: { question: "Show your work" } as never, dictationClaim: false,
			initialDraft: { selection: { selected: new Set(), otherSelected: false, dontKnow: false }, thinking: "", other: "", text: "", confidenceIndex: 2, attachments: [A] },
			onSubmit: (answer) => { sent = answer; } });
		try {
			const tray = dock.host.querySelector('[data-testid="answer-field"] [data-testid="field-images"]');
			assert.ok(tray?.innerHTML.includes(`/api/attachments/${A}`), "a failed submission's images come back with its draft");
			const submit = dock.host.querySelector<HTMLButtonElement>('button[type="submit"]')!;
			assert.equal(submit.hasAttribute("disabled"), false, "images stand in for the text");
			// linkedom has no implicit form submission: send the form's submit event.
			await act(async () => { submit.closest("form")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); });
			assert.deepEqual(sent?.attachments, { answer: [A] });
			assert.equal(sent?.text, undefined);
		} finally { await dock.unmount(); }
	});
});
