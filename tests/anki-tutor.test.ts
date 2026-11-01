/**
 * Anki cards from mistakes, the tutor's card tool (fork feature,
 * docs/anki.md): the pure helpers (ankiMatchMiss, ankiTutorRepliesAfter,
 * the request tag), the server side (createTutorCard over the real chat
 * store and ledger in an isolated LH_DATA_DIR), the agent tool (its
 * description, schema boundary and result), the GET card route, and the
 * extraTools wiring (teacher and practice get the tool, the prober never).
 *
 * Nothing here talks to Anki or a real model: the agents run on pi-ai's
 * faux provider. The data-dir seam is set before any config-loading
 * import, so every app-module import is dynamic.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, type ToolCall } from "@earendil-works/pi-ai";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-anki-tutor-"));
process.env.LH_DATA_DIR = path.join(scratch, "data");

const { ANKI_CARD_TOOL, ANKI_REASONS, DEFAULT_ANKI_SETTINGS } = await import("../src/core/anki/contract.ts");
type AnkiCardRecord = import("../src/core/anki/contract.ts").AnkiCardRecord;
type AnkiCardToolInput = import("../src/core/anki/contract.ts").AnkiCardToolInput;
type AnkiCardToolResult = import("../src/core/anki/contract.ts").AnkiCardToolResult;
type AnkiMiss = import("../src/core/anki/contract.ts").AnkiMiss;
type AnkiSettings = import("../src/core/anki/contract.ts").AnkiSettings;
type LhMessage = import("../src/core/native-messages.ts").LhMessage;
type PiEngine = import("../src/agent/models.ts").PiEngine;
const { ankiMatchMiss, ankiTutorRepliesAfter } = await import("../src/core/anki/misses.ts");
const { ankiCardId, ankiTags } = await import("../src/core/anki/format.ts");
const { ankiCardToolInputSchema } = await import("../src/core/anki/tool.ts");
const store = await import("../src/server/anki/store.ts");
const { createTutorCard, ANKI_REMINDER_MAX } = await import("../src/server/anki/tutor.ts");
const { ankiTutorTools } = await import("../src/server/anki/tutor-tools.ts");
const { createAnkiHttp } = await import("../src/server/anki/http.ts");
const { ankiCardTools, ankiCardDescription } = await import("../src/agent/tools/anki-card.ts");
const { ANKI_CARD_RULES, ANKI_WRITER_INSTRUCTIONS } = await import("../src/agent/subagents/anki-writer.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { createPracticeAgent, createProberAgent, createTeacherAgent } = await import("../src/agent/teacher-agent.ts");

after(() => {
	fs.rmSync(scratch, { recursive: true, force: true });
});

// ─── record builders ────────────────────────────────────────────────────────

let seq = 0;
const msgId = () => `msg_tutor_${++seq}`;
/** Answers land after `enabledAt` (set when the feature turns on), so the
 *  fold does not filter them out. */
const LATER = () => new Date(Date.now() + 60_000).toISOString();

type Block = { type: "text"; text: string } | { type: "toolCall"; id: string; name: string; arguments: unknown };
const text = (value: string): Block => ({ type: "text", text: value });
const call = (id: string, name: string, args: unknown): Block => ({ type: "toolCall", id, name, arguments: args });

function assistant(blocks: Block[], stopReason = "toolUse"): LhMessage {
	return {
		id: msgId(),
		role: "assistant",
		content: blocks,
		api: "faux",
		provider: "faux",
		model: "faux",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason,
		timestamp: 1_000,
	} as unknown as LhMessage;
}

function result(toolCallId: string, toolName: string, details: unknown, isError = false): LhMessage {
	return { id: msgId(), role: "toolResult", toolCallId, toolName, content: [{ type: "text", text: "{}" }], details, isError, timestamp: 2_000 } as unknown as LhMessage;
}

const user = (value: string): LhMessage => ({ id: msgId(), role: "user", content: value, timestamp: 3_000 }) as unknown as LhMessage;
const reply = (value: string, stopReason = "stop"): LhMessage => assistant([text(value)], stopReason);

const OPTIONS = [
	{ label: "Alpha", value: "a" },
	{ label: "Beta", value: "b" },
];

/** A teach quiz answered wrong: [the call, the answer]. */
function wrongQuiz(callId: string, question: string): LhMessage[] {
	return [
		assistant([text("A check."), call(callId, "quiz", { type: "check", nodeId: "n1", question, options: OPTIONS, explanation: "Because alpha.", correctAnswer: "a" })]),
		result(callId, "quiz", {
			kind: "quiz",
			tool: "quiz",
			questionText: question,
			options: OPTIONS.map((option, i) => ({ index: i + 1, label: option.label })),
			dontKnow: false,
			answers: [{ label: "Beta", value: "b", index: 2 }],
			answeredAt: LATER(),
			correctIndices: [1],
			correct: false,
			confidence: 40,
		}),
	];
}

/** A teach free-text question with an answer (kind freeText). */
function freeText(callId: string, question: string): LhMessage[] {
	return [
		assistant([text("Explain."), call(callId, "explain", { type: "check", nodeId: "n1", question, correctAnswer: "The committed answer." })]),
		result(callId, "explain", {
			kind: "explain",
			tool: "explain",
			questionText: question,
			options: [],
			dontKnow: false,
			answers: [],
			text: "My words.",
			committed: "The committed answer.",
			answeredAt: LATER(),
		}),
	];
}

function newChat(messages: LhMessage[], title = "Calculus"): string {
	const chat = chatStore.createChat(title);
	chatStore.saveMessages(chat.id, messages);
	return chat.id;
}

function settings(patch: Partial<AnkiSettings> = {}): AnkiSettings {
	return store.saveAnkiSettings({ ...DEFAULT_ANKI_SETTINGS, enabled: true, ...patch });
}

const ledger = () => store.readAnkiLedger().cards;
const draft = { front: "Which planet is the largest?", back: "Jupiter.", why: "", pitfall: "" };
const mistake = (question: string, over: Partial<AnkiCardToolInput> = {}): AnkiCardToolInput => ({ reason: "mistake", question, ...draft, ...over });

beforeEach(() => {
	fs.rmSync(store.ankiLedgerFile(), { force: true });
	settings();
});

// ─── the pure helpers ───────────────────────────────────────────────────────

const missOf = (n: number, question: string, over: Partial<AnkiMiss> = {}): AnkiMiss => ({
	key: `c:${n}`,
	chatId: "c",
	toolCallId: `${n}`,
	phase: "teach",
	tool: "quiz",
	kind: "wrong",
	questionType: "check",
	question,
	options: [],
	correctAnswer: "",
	explanation: "",
	learnerAnswer: "",
	learnerThinking: "",
	confidence: null,
	missClass: null,
	rung: null,
	targets: [],
	planNode: null,
	answeredAt: n,
	messageIndex: n,
	...over,
});

describe("ankiMatchMiss", () => {
	const misses = [
		missOf(1, "What is the **derivative** of $x^2$?"),
		missOf(5, "2+2?"),
		missOf(9, "What is the derivative of $x^2$ at zero?"),
	];

	it("matches exactly after normalizing case, spacing, Markdown and math markup, at any length", () => {
		assert.equal(ankiMatchMiss(misses, "  what is the DERIVATIVE of x^2? ")?.key, "c:1");
		assert.equal(ankiMatchMiss(misses, "2+2?")?.key, "c:5", "a short question links on an exact match");
		assert.equal(ankiMatchMiss(misses, "2+2")?.key, undefined, "but not on a short partial one");
	});

	it("accepts a prefix or an inclusion (either way) of at least 12 characters, the most recent first", () => {
		assert.equal(ankiMatchMiss(misses, "What is the derivative")?.key, "c:9", "both start this way: the newer wins");
		assert.equal(ankiMatchMiss(misses, "of $x^2$ at zero")?.key, "c:9", "an inclusion");
		assert.equal(ankiMatchMiss(misses, "Q3. What is the derivative of x^2 at zero? (asked earlier)")?.key, "c:9", "the hint holds the whole question");
		assert.equal(ankiMatchMiss(misses, "derivative")?.key, undefined, "too short to say which");
	});

	it("an empty hint or no match gives null", () => {
		assert.equal(ankiMatchMiss(misses, ""), null);
		assert.equal(ankiMatchMiss(misses, undefined), null);
		assert.equal(ankiMatchMiss(misses, "Something else entirely, long enough"), null);
	});
});

describe("ankiTutorRepliesAfter", () => {
	it("counts the tutor's completed turns after an answer", () => {
		const messages = [...wrongQuiz("q1", "Q one?"), reply("Not quite: alpha."), user("Why?"), reply("Because.")];
		assert.equal(ankiTutorRepliesAfter({ messages }, { messageIndex: 1 }), 2);
		assert.equal(ankiTutorRepliesAfter({ messages: messages.slice(0, 3) }, { messageIndex: 1 }), 1);
		assert.equal(ankiTutorRepliesAfter({ messages: messages.slice(0, 2) }, { messageIndex: 1 }), 0, "no reply yet");
	});

	it("does not count failed replies, or answers saved before any reply", () => {
		const parallel = [
			assistant([call("q1", "quiz", {}), call("q2", "quiz", {})]),
			result("q1", "quiz", { kind: "quiz", answers: [] }),
			result("q2", "quiz", { kind: "quiz", answers: [] }),
		];
		assert.equal(ankiTutorRepliesAfter({ messages: parallel }, { messageIndex: 1 }), 0);
		const failed = [...wrongQuiz("q1", "Q?"), reply("", "error"), user("Retry"), reply("Alpha, because.")];
		assert.equal(ankiTutorRepliesAfter({ messages: failed }, { messageIndex: 1 }), 1);
	});

	it("for a practice conclusion, the rest of that turn is the first reply", () => {
		const messages = [
			assistant([call("c1", "conclude", { outcome: "movedOn" })]),
			result("c1", "conclude", null),
			reply("The trick was the substitution."),
			user("Next"),
			reply("Here is the next one."),
		];
		assert.equal(ankiTutorRepliesAfter({ messages }, { messageIndex: 0 }), 2);
	});
});

describe("anki tags and the card rules", () => {
	it("a requested card is tagged LearnHarness::miss::requested", () => {
		const tags = ankiTags({ chatId: "chat_x_12345678", sessionTitle: "Calculus", phase: "teach", kind: "request", missClass: null, confident: false });
		assert.ok(tags.includes("LearnHarness::miss::requested"));
	});

	it("the writer and the tool share one set of card rules", () => {
		assert.ok(ANKI_WRITER_INSTRUCTIONS.includes(ANKI_CARD_RULES));
		assert.match(ANKI_WRITER_INSTRUCTIONS, /the tutor left without a card/);
		const description = ankiCardDescription({ phase: "teach", triggers: DEFAULT_ANKI_SETTINGS.triggers, lowConfidenceMax: 30 });
		assert.ok(description.includes(ANKI_CARD_RULES));
	});

	it("the store reads a card without writtenBy as the writer's, and drops malformed new fields", () => {
		const base = { key: "c:k", chatId: "c", toolCallId: "k", sessionTitle: "S", phase: "teach", kind: "wrong", missClass: null, confident: false, targets: [], attempts: 0, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" };
		fs.mkdirSync(path.dirname(store.ankiLedgerFile()), { recursive: true });
		fs.writeFileSync(store.ankiLedgerFile(), JSON.stringify({
			version: 1,
			cards: [
				{ ...base, id: "0000000000000001", status: "sent", card: draft },
				{ ...base, id: "0000000000000002", status: "waiting", covers: 7, questionHint: ["x"] },
				{ ...base, id: "0000000000000003", status: "queued", card: draft, writtenBy: "tutor", covers: "c:m", questionHint: "Q?" },
			],
		}));
		const [old, waiting, tutor] = ledger();
		assert.equal(old!.writtenBy, "writer");
		assert.equal(waiting!.writtenBy, undefined);
		assert.equal(waiting!.covers, undefined);
		assert.equal(waiting!.questionHint, undefined);
		assert.equal(tutor!.writtenBy, "tutor");
		assert.equal(tutor!.covers, "c:m");
		assert.equal(tutor!.questionHint, "Q?");
	});
});

// ─── createTutorCard ────────────────────────────────────────────────────────

describe("createTutorCard", () => {
	it("refuses while the feature is off, and for an empty card", async () => {
		const chatId = newChat(wrongQuiz("q1", "Which planet is the largest?"));
		settings({ enabled: false });
		const off = await createTutorCard(chatId, "teach", mistake("Which planet is the largest?"), "tc-1");
		assert.equal(off.details.ok, false);
		assert.equal(ledger().length, 0);
		settings();
		const empty = await createTutorCard(chatId, "teach", mistake("Which planet is the largest?", { back: "  " }), "tc-2");
		assert.equal(empty.details.ok, false);
		assert.equal((await createTutorCard("chat_missing", "teach", mistake("x"), "tc-3")).details.ok, false);
	});

	it("a matched mistake with no record gets the miss's record, queued and written by the tutor", async () => {
		const chatId = newChat([
			...wrongQuiz("q1", "Which planet is the largest?"),
			reply("Jupiter: it is the largest."),
			...wrongQuiz("q2", "What is the boiling point of water at sea level?"),
		]);
		const outcome = await createTutorCard(chatId, "teach", mistake("which planet is the LARGEST"), "tc-1");
		const key = `${chatId}:q1`;
		assert.deepEqual(outcome.details, { ok: true, cardId: ankiCardId(key), linked: true });
		const [rec] = ledger();
		assert.equal(rec!.key, key);
		assert.equal(rec!.status, "queued");
		assert.equal(rec!.writtenBy, "tutor");
		assert.equal(rec!.attempts, 0);
		assert.equal(rec!.kind, "wrong");
		assert.equal(rec!.phase, "teach");
		assert.equal(rec!.sessionTitle, "Calculus");
		assert.equal(rec!.deck, "LearnHarness");
		assert.deepEqual(rec!.card, draft);
		assert.deepEqual(rec!.tags, ankiTags(rec!));
		assert.match(outcome.text, /^Card saved\. It goes to the learner's Anki at the end of this reply\./);
		assert.match(outcome.text, /Mistakes still without a card/);
		assert.match(outcome.text, /- "What is the boiling point of water at sea level\?"/);
		assert.ok(!outcome.text.includes('"Which planet is the largest?"'), "not the one just carded");
	});

	it("the reminder leaves out probe mistakes: the reserve writer makes their cards", async () => {
		const probeQuestion = "What is the derivative of a constant?";
		const chatId = newChat([
			assistant([call("p1", "probe", { question: probeQuestion, options: OPTIONS, explanation: "A constant does not change.", correctAnswer: "a" })]),
			result("p1", "probe", {
				kind: "quiz",
				tool: "probe",
				questionText: probeQuestion,
				options: OPTIONS.map((option, i) => ({ index: i + 1, label: option.label })),
				dontKnow: true,
				answers: [],
				answeredAt: LATER(),
			}),
			...wrongQuiz("q1", "Which planet is the largest?"),
			reply("Jupiter: it is the largest."),
			...wrongQuiz("q2", "What is the boiling point of water at sea level?"),
		]);
		const outcome = await createTutorCard(chatId, "teach", mistake("Which planet is the largest?"), "tc-1");
		assert.equal(outcome.details.ok, true);
		assert.match(outcome.text, /- "What is the boiling point of water at sea level\?"/);
		assert.ok(!outcome.text.includes(probeQuestion), "the probe mistake is not listed");
	});

	it("a matched mistake waiting for the reserve becomes the tutor's queued card", async () => {
		const chatId = newChat(wrongQuiz("q1", "Which planet is the largest?"));
		const key = `${chatId}:q1`;
		await store.updateAnkiLedger((l) => {
			l.cards.push({ id: ankiCardId(key), key, chatId, toolCallId: "q1", sessionTitle: "Calculus", phase: "teach", kind: "wrong", missClass: null, confident: false, targets: [], status: "waiting", reason: "Not explained yet", attempts: 2, checkedAt: 3, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" });
		});
		const outcome = await createTutorCard(chatId, "teach", mistake("Which planet is the largest?"), "tc-1");
		assert.equal(outcome.details.ok, true);
		const [rec] = ledger();
		assert.equal(ledger().length, 1);
		assert.equal(rec!.status, "queued");
		assert.equal(rec!.writtenBy, "tutor");
		assert.equal(rec!.attempts, 0);
		assert.equal(rec!.reason, undefined);
		assert.equal(rec!.checkedAt, undefined);
	});

	it("refuses a mistake that already has a card, or was skipped or removed, saying why", async () => {
		const chatId = newChat([...wrongQuiz("q1", "Which planet is the largest?"), ...wrongQuiz("q2", "What is the boiling point of water?"), ...wrongQuiz("q3", "What is the speed of light in vacuum?")]);
		const recordFor = (callId: string, over: Partial<AnkiCardRecord>): AnkiCardRecord => {
			const key = `${chatId}:${callId}`;
			return { id: ankiCardId(key), key, chatId, toolCallId: callId, sessionTitle: "Calculus", phase: "teach", kind: "wrong", missClass: null, confident: false, targets: [], status: "sent", attempts: 0, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", ...over };
		};
		await store.updateAnkiLedger((l) => {
			l.cards.push(
				recordFor("q1", { status: "sent", noteId: 4, card: { ...draft, front: "Name the largest planet." } }),
				recordFor("q2", { status: "skipped", reason: ANKI_REASONS.sessionLimit }),
				recordFor("q3", { status: "removed", reason: ANKI_REASONS.removedByUser }),
			);
		});
		const has = await createTutorCard(chatId, "teach", mistake("Which planet is the largest?"), "tc-1");
		assert.deepEqual(has.details, { ok: false, error: 'This mistake already has a card: "Name the largest planet.".' });
		assert.equal(has.text, (has.details as { error: string }).error);
		const skipped = await createTutorCard(chatId, "teach", mistake("What is the boiling point of water?"), "tc-2");
		assert.match((skipped.details as { error: string }).error, /skipped \(Session limit reached\)/);
		const removed = await createTutorCard(chatId, "teach", mistake("What is the speed of light in vacuum?"), "tc-3");
		assert.match((removed.details as { error: string }).error, /removed/);
		assert.equal(ledger().length, 3, "nothing new");
	});

	it("a mistake the stored record does not show yet is kept unlinked with its hint", async () => {
		const chatId = newChat([user("Give me a problem")]);
		const outcome = await createTutorCard(chatId, "practice", mistake("Prove that the square root of 2 is irrational."), "tc-9");
		const key = `${chatId}:tc-9`;
		assert.deepEqual(outcome.details, { ok: true, cardId: ankiCardId(key), linked: false });
		const [rec] = ledger();
		assert.equal(rec!.key, key);
		assert.equal(rec!.toolCallId, "tc-9");
		assert.equal(rec!.phase, "practice");
		assert.equal(rec!.questionHint, "Prove that the square root of 2 is irrational.");
		assert.equal(rec!.covers, undefined);
		assert.equal(rec!.status, "queued");
		assert.equal(rec!.writtenBy, "tutor");
		// The same call again (a retry): the saved card, not a second one.
		const again = await createTutorCard(chatId, "practice", mistake("Prove that the square root of 2 is irrational."), "tc-9");
		assert.deepEqual(again.details, outcome.details);
		assert.equal(ledger().length, 1);
	});

	it("a card the learner asked for: kind request, the requested tag, outside the session limit", async () => {
		settings({ perSessionLimit: 1 });
		const chatId = newChat([...wrongQuiz("q1", "Which planet is the largest?"), ...wrongQuiz("q2", "What is the boiling point of water?")]);
		assert.equal((await createTutorCard(chatId, "teach", mistake("Which planet is the largest?"), "tc-1")).details.ok, true);
		const limited = await createTutorCard(chatId, "teach", mistake("What is the boiling point of water?"), "tc-2");
		assert.equal(limited.details.ok, false);
		assert.match(limited.text, /limit/);
		const request = await createTutorCard(chatId, "teach", { reason: "request", question: "ignored", front: "What is a planet?", back: "A body orbiting a star.", why: "", pitfall: "" }, "tc-3");
		assert.equal(request.details.ok, true);
		assert.equal((request.details as { linked: boolean }).linked, false);
		const rec = ledger().find((card) => card.key === `${chatId}:tc-3`)!;
		assert.equal(rec.kind, "request");
		assert.equal(rec.questionHint, undefined);
		assert.ok(rec.tags!.includes("LearnHarness::miss::requested"));
		assert.ok(!/Mistakes still without a card/.test(request.text), "no reminder after a request");
	});

	it("the reminder lists at most five open mistakes, newest first, free-text answers last", async () => {
		const messages: LhMessage[] = [...freeText("f1", "Explain why the sky is blue in your own words.")];
		for (let n = 1; n <= 7; n++) messages.push(...wrongQuiz(`q${n}`, `Question number ${n}: which option is right?`));
		const chatId = newChat(messages);
		const outcome = await createTutorCard(chatId, "teach", mistake("Question number 7: which option is right?"), "tc-1");
		const listed = outcome.text.split("\n").filter((line) => line.startsWith("- "));
		assert.equal(listed.length, ANKI_REMINDER_MAX);
		assert.deepEqual(listed, [6, 5, 4, 3, 2].map((n) => `- "Question number ${n}: which option is right?"`));
	});
});

// ─── the agent tool ─────────────────────────────────────────────────────────

describe("the anki_card tool", () => {
	const triggers = { ...DEFAULT_ANKI_SETTINGS.triggers };

	it("describes when and how, listing only the mistakes the learner turned on", () => {
		const teach = ankiCardDescription({ phase: "teach", triggers: { ...triggers, dontKnow: false }, lowConfidenceMax: 25 });
		assert.match(teach, /right after you have explained the correct idea/);
		assert.match(teach, /reason "request"/);
		assert.match(teach, /careless slip/);
		assert.match(teach, /ask_user_question/);
		assert.match(teach, /confidence 25% or less/);
		const listed = /The mistakes that get a card[^\n]*?\./.exec(teach)?.[0] ?? "";
		assert.match(listed, /a wrong answer/);
		assert.ok(!listed.includes("I don't know"), "a trigger turned off is not listed");
		assert.ok(!teach.includes("practice problem the learner did not solve"), "practice kinds belong to practice");
		assert.match(teach, /Mistakes from the probe get their card automatically right after the answer: make none for them\./);
		assert.ok(!teach.includes("make their card when you teach"), "the teacher no longer cards probe mistakes");
		const practice = ankiCardDescription({ phase: "practice", triggers, lowConfidenceMax: 30 });
		assert.match(practice, /did not solve/);
		assert.match(practice, /R3 or above/);
		const none = ankiCardDescription({ phase: "practice", triggers: { ...triggers, practiceNotSolved: false, practiceHeavyHint: false }, lowConfidenceMax: 30 });
		assert.match(none, /only when the learner asks/);
	});

	it("uses the core schema and returns the server's text and details", async () => {
		const seen: Array<[AnkiCardToolInput, string]> = [];
		const tools = ankiCardTools({
			phase: "teach",
			triggers,
			lowConfidenceMax: 30,
			create: async (input, toolCallId) => {
				seen.push([input, toolCallId]);
				return { text: "Card saved.", details: { ok: true, cardId: "0123456789abcdef", linked: true } };
			},
		});
		const tool = tools[ANKI_CARD_TOOL]!;
		assert.equal(tool.parameters, ankiCardToolInputSchema);
		const outcome = await tool.execute("call-1", mistake("Q?"), undefined);
		assert.deepEqual(outcome.content, [{ type: "text", text: "Card saved." }]);
		assert.deepEqual(outcome.details, { ok: true, cardId: "0123456789abcdef", linked: true });
		assert.deepEqual(seen, [[mistake("Q?"), "call-1"]]);
	});

	it("a failure while saving comes back as a refusal, not a crash", async () => {
		const tool = ankiCardTools({ phase: "teach", triggers, lowConfidenceMax: 30, create: async () => { throw new Error("disk full"); } })[ANKI_CARD_TOOL]!;
		const outcome = await tool.execute("call-1", mistake("Q?"), undefined);
		assert.deepEqual(outcome.details, { ok: false, error: "The card could not be saved: disk full" });
	});

	it("ankiTutorTools: nothing while the feature is off; the real save while on", async () => {
		settings({ enabled: false });
		assert.equal(ankiTutorTools("chat_x", "teach"), undefined);
		settings();
		const chatId = newChat(wrongQuiz("q1", "Which planet is the largest?"));
		const tool = ankiTutorTools(chatId, "teach")![ANKI_CARD_TOOL]!;
		const outcome = await tool.execute("call-7", mistake("Which planet is the largest?"), undefined);
		assert.equal((outcome.details as AnkiCardToolResult).ok, true);
		assert.equal(ledger()[0]!.key, `${chatId}:q1`);
	});
});

// ─── the agents ─────────────────────────────────────────────────────────────

describe("the extraTools wiring", () => {
	function fauxEngine(steps: Parameters<ReturnType<typeof createFauxCore>["setResponses"]>[0]): PiEngine {
		const faux = createFauxCore({});
		faux.setResponses(steps);
		return { model: faux.getModel(), streamFn: faux.streamSimple };
	}
	const stubTools = (calls: string[]) =>
		ankiCardTools({
			phase: "teach",
			triggers: DEFAULT_ANKI_SETTINGS.triggers,
			lowConfidenceMax: 30,
			create: async (input, toolCallId) => {
				calls.push(`${toolCallId}:${input.front}`);
				return { text: "Card saved.", details: { ok: true, cardId: "0123456789abcdef", linked: false } };
			},
		});
	const names = (agent: { state: { tools: Array<{ name: string }> } }) => agent.state.tools.map((tool) => tool.name);

	it("the teacher and the practice agent get the tool; the prober never does", () => {
		const extraTools = stubTools([]);
		const engine = fauxEngine([]);
		assert.ok(names(createTeacherAgent(undefined, { engine, extraTools })).includes(ANKI_CARD_TOOL));
		const practice = names(createPracticeAgent({ chatId: "p", chatStore: { getChat: () => null } } as never, { engine, extraTools }));
		assert.ok(practice.includes(ANKI_CARD_TOOL));
		assert.ok(practice.includes("problem"), "on top of the practice registry");
		const prober = names(createProberAgent({ chatId: "x", chatStore: { getChat: () => null }, jobStore: {}, spawn: () => {}, deliver: () => {} } as never, { engine, extraTools }));
		assert.ok(!prober.includes(ANKI_CARD_TOOL));
		assert.ok(!names(createTeacherAgent(undefined, { engine })).includes(ANKI_CARD_TOOL), "absent without extraTools");
		const explicit = names(createTeacherAgent(undefined, { engine, tools: {}, extraTools }));
		assert.deepEqual(explicit.filter((name) => name === ANKI_CARD_TOOL), [ANKI_CARD_TOOL], "merged into an explicit registry too");
	});

	it("a schema-invalid call is refused at the boundary; a valid one saves", async () => {
		const calls: string[] = [];
		const engine = fauxEngine([
			fauxAssistantMessage([fauxToolCall(ANKI_CARD_TOOL, { reason: "mistake", front: "Q?" } as ToolCall["arguments"], { id: "bad" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall(ANKI_CARD_TOOL, mistake("Q?") as unknown as ToolCall["arguments"], { id: "good" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Done.")]),
		]);
		const agent = createTeacherAgent(undefined, { engine, extraTools: stubTools(calls) });
		await agent.prompt("Make a card.");
		const results = agent.state.messages.filter((m) => m.role === "toolResult") as Array<{ toolCallId: string; isError: boolean; details: unknown }>;
		assert.equal(results.find((r) => r.toolCallId === "bad")!.isError, true);
		const good = results.find((r) => r.toolCallId === "good")!;
		assert.equal(good.isError, false);
		assert.deepEqual(good.details, { ok: true, cardId: "0123456789abcdef", linked: false });
		assert.deepEqual(calls, [`good:${draft.front}`]);
	});
});

// ─── GET /api/anki/cards/<id> ───────────────────────────────────────────────

describe("GET /api/anki/cards/<id>", () => {
	const ORIGIN = "http://127.0.0.1:3123";
	const http = createAnkiHttp({
		runPipeline: async () => {
			throw new Error("the GET must not run the pipeline");
		},
		createClient: () => {
			throw new Error("the GET must not call Anki");
		},
	});
	const get = (id: string, headers: Record<string, string> = {}) => http.ankiCardResponse(new Request(`${ORIGIN}/api/anki/cards/${id}`, { headers }), id);

	it("returns the ledger record, without the write header", async () => {
		const chatId = newChat(wrongQuiz("q1", "Which planet is the largest?"));
		const outcome = await createTutorCard(chatId, "teach", mistake("Which planet is the largest?"), "tc-1");
		const id = (outcome.details as { cardId: string }).cardId;
		const response = await get(id);
		assert.equal(response.status, 200);
		const body = (await response.json()) as { card: AnkiCardRecord | null };
		assert.equal(body.card?.id, id);
		assert.equal(body.card?.writtenBy, "tutor");
		assert.equal((await get(id, { origin: ORIGIN })).status, 200);
	});

	it("an unknown or malformed id is { card: null }, not a 404; a cross-site read is refused", async () => {
		for (const id of ["0123456789abcdef", "not-an-id"]) {
			const response = await get(id);
			assert.equal(response.status, 200);
			assert.deepEqual(await response.json(), { card: null });
		}
		assert.equal((await get("0123456789abcdef", { origin: "http://evil.test" })).status, 403);
	});
});
