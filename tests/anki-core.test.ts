/**
 * Anki cards from mistakes (fork feature, docs/anki.md): the pure core —
 * the settings parse, the miss fold over chat records (synthetic and the
 * golden recordings), the transcript excerpt, and what a card looks like
 * in Anki (id, deck, tags, Markdown → HTML, note fields).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
	ANKI_NOTE_FIELDS,
	ANKI_TRIGGERS,
	DEFAULT_ANKI_SETTINGS,
	type AnkiCardDraft,
	type AnkiCardRecord,
	type AnkiMiss,
	type AnkiSettings,
	ankiMissExplainedOnAnswer,
	missNeedsTeaching,
} from "../src/core/anki/contract.ts";
import { ankiCardId, ankiDeckName, ankiNoteFields, ankiTags, markdownToAnkiHtml } from "../src/core/anki/format.ts";
import { ankiMissesOf, ankiTranscriptExcerpt, ankiTutorRepliedAfter } from "../src/core/anki/misses.ts";
import { isLoopbackAnkiUrl, parseAnkiSettings } from "../src/core/anki/settings.ts";
import type { ChatRecord } from "../src/core/contracts/chat.ts";
import type { LhMessage } from "../src/core/native-messages.ts";

// ── record builders ──────────────────────────────────────────────────────────

let seq = 0;
const msgId = () => `msg_${++seq}`;

type Block =
	| { type: "text"; text: string }
	| { type: "thinking"; thinking: string }
	| { type: "toolCall"; id: string; name: string; arguments: unknown };

const text = (value: string): Block => ({ type: "text", text: value });
const thinking = (value: string): Block => ({ type: "thinking", thinking: value });
const call = (id: string, name: string, args: unknown): Block => ({ type: "toolCall", id, name, arguments: args });

function assistant(blocks: Block[], timestamp = 1_000): LhMessage {
	return {
		id: msgId(),
		role: "assistant",
		content: blocks,
		api: "faux",
		provider: "faux",
		model: "faux",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "toolUse",
		timestamp,
	} as unknown as LhMessage;
}

function result(toolCallId: string, toolName: string, details: unknown, timestamp = 2_000, isError = false): LhMessage {
	return {
		id: msgId(),
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: "{}" }],
		details,
		isError,
		timestamp,
	} as unknown as LhMessage;
}

function marker(customType: string, details: unknown, timestamp = 1_000): LhMessage {
	return { id: msgId(), role: "custom", customType, content: "", display: true, details, timestamp } as unknown as LhMessage;
}

const OPTIONS = [
	{ label: "Alpha", value: "a" },
	{ label: "Beta", value: "b" },
	{ label: "Gamma", value: "c" },
];
const LABEL: Record<string, string> = { a: "Alpha", b: "Beta", c: "Gamma" };

const teachQuiz = (extra: Record<string, unknown> = {}) => ({
	type: "check",
	nodeId: "n1",
	question: "Which one?",
	options: OPTIONS,
	explanation: "Because alpha.",
	correctAnswer: "a",
	...extra,
});
const probeQuiz = (extra: Record<string, unknown> = {}) => ({
	question: "Which one?",
	options: OPTIONS,
	explanation: "Because alpha.",
	correctAnswer: "a",
	...extra,
});

/** The stored answer of a multiple-choice question (QuestionAnswerData). */
function mcAnswer(tool: string, values: string[], extra: Record<string, unknown> = {}) {
	return {
		kind: "quiz",
		tool,
		questionText: "Which one?",
		options: OPTIONS.map((option, i) => ({ index: i + 1, label: option.label })),
		dontKnow: false,
		answers: values.map((value) => ({ label: LABEL[value] ?? value, value, index: OPTIONS.findIndex((o) => o.value === value) + 1 })),
		answeredAt: "2026-10-10T10:00:00.000Z",
		correctIndices: [1],
		correct: values.length === 1 && values[0] === "a",
		confidence: 50,
		...extra,
	};
}

function textAnswer(tool: string, answer: string, extra: Record<string, unknown> = {}) {
	return {
		kind: "explain",
		tool,
		questionText: "Explain it.",
		options: [],
		dontKnow: false,
		answers: [],
		text: answer,
		committed: "The committed answer.",
		answeredAt: "2026-10-10T10:00:00.000Z",
		...extra,
	};
}

const TREE = { nodes: [{ id: "n1", title: "Node one" }], edges: [], version: 1 };

function teachChat(messages: LhMessage[], id = "chat_test_0000abcd"): Pick<ChatRecord, "id" | "kind" | "messages" | "tree"> {
	return { id, kind: "teach", messages, tree: TREE };
}

/** One posed question and its answer: [assistant call, tool result]. */
function asked(callId: string, tool: string, args: unknown, details: unknown, isError = false): LhMessage[] {
	return [assistant([text("Here is a question."), call(callId, tool, args)]), result(callId, tool, details, 2_000, isError)];
}

const settingsWith = (patch: Partial<Omit<AnkiSettings, "triggers">> & { triggers?: Partial<AnkiSettings["triggers"]> } = {}): AnkiSettings =>
	parseAnkiSettings({ ...DEFAULT_ANKI_SETTINGS, ...patch, triggers: { ...DEFAULT_ANKI_SETTINGS.triggers, ...patch.triggers } });

const DEFAULTS = settingsWith();
const only = (misses: AnkiMiss[]): AnkiMiss => {
	assert.equal(misses.length, 1, `expected one miss, got ${misses.map((m) => m.kind).join(", ") || "none"}`);
	return misses[0]!;
};

// ── settings ─────────────────────────────────────────────────────────────────

describe("parseAnkiSettings", () => {
	it("gives the defaults for anything that is not a record, as a fresh copy", () => {
		for (const value of [undefined, null, 3, "x", [], [1]]) {
			assert.deepEqual(parseAnkiSettings(value), DEFAULT_ANKI_SETTINGS);
		}
		const parsed = parseAnkiSettings({});
		assert.notEqual(parsed.triggers, DEFAULT_ANKI_SETTINGS.triggers);
		parsed.triggers.wrong = false; // not frozen
		assert.equal(DEFAULT_ANKI_SETTINGS.triggers.wrong, true);
	});

	it("keeps valid values", () => {
		const value: AnkiSettings = {
			enabled: true,
			url: "http://localhost:9999",
			apiKey: "secret",
			deckTemplate: "Study::{session}",
			triggers: { wrong: false, dontKnow: true, lowConfidence: false, practiceNotSolved: true, practiceHeavyHint: false },
			lowConfidenceMax: 0,
			perSessionLimit: 0,
			enabledAt: "2026-10-31T12:00:00.000Z",
		};
		assert.deepEqual(parseAnkiSettings(value), value);
		assert.equal(parseAnkiSettings({ lowConfidenceMax: 100, perSessionLimit: 100 }).lowConfidenceMax, 100);
		assert.equal(parseAnkiSettings({ lowConfidenceMax: 100, perSessionLimit: 100 }).perSessionLimit, 100);
	});

	it("falls back per field on invalid values", () => {
		const parsed = parseAnkiSettings({
			enabled: "yes",
			url: "https://127.0.0.1:8765",
			apiKey: 42,
			deckTemplate: "   ",
			triggers: { wrong: false, dontKnow: "no", lowConfidence: null },
			lowConfidenceMax: 30.5,
			perSessionLimit: 101,
		});
		assert.equal(parsed.enabled, false);
		assert.equal(parsed.url, DEFAULT_ANKI_SETTINGS.url);
		assert.equal(parsed.apiKey, null);
		assert.equal(parsed.deckTemplate, DEFAULT_ANKI_SETTINGS.deckTemplate);
		assert.deepEqual(parsed.triggers, { ...DEFAULT_ANKI_SETTINGS.triggers, wrong: false });
		assert.equal(parsed.lowConfidenceMax, DEFAULT_ANKI_SETTINGS.lowConfidenceMax);
		assert.equal(parsed.perSessionLimit, DEFAULT_ANKI_SETTINGS.perSessionLimit);

		for (const bad of [-1, 101, "30", Number.NaN, Infinity]) {
			assert.equal(parseAnkiSettings({ lowConfidenceMax: bad }).lowConfidenceMax, 30);
			assert.equal(parseAnkiSettings({ perSessionLimit: bad }).perSessionLimit, 10);
		}
		assert.deepEqual(parseAnkiSettings({ triggers: "all" }).triggers, DEFAULT_ANKI_SETTINGS.triggers);
	});

	it("keeps enabledAt only when it is a date", () => {
		assert.equal(parseAnkiSettings({}).enabledAt, null);
		assert.equal(parseAnkiSettings({ enabledAt: "2026-10-31T12:00:00.000Z" }).enabledAt, "2026-10-31T12:00:00.000Z");
		for (const bad of ["garbage", "", 1_790_000_000_000, null, {}]) {
			assert.equal(parseAnkiSettings({ enabledAt: bad }).enabledAt, null, String(bad));
		}
	});

	it("trims the apiKey and the deck template, and bounds the template", () => {
		assert.equal(parseAnkiSettings({ apiKey: "  key  " }).apiKey, "key");
		assert.equal(parseAnkiSettings({ apiKey: "   " }).apiKey, null);
		assert.equal(parseAnkiSettings({ deckTemplate: "  Deck::{session}  " }).deckTemplate, "Deck::{session}");
		assert.equal(parseAnkiSettings({ deckTemplate: "x".repeat(200) }).deckTemplate, "x".repeat(200));
		assert.equal(parseAnkiSettings({ deckTemplate: "x".repeat(201) }).deckTemplate, DEFAULT_ANKI_SETTINGS.deckTemplate);
	});

	it("accepts only a loopback http URL", () => {
		for (const url of ["http://127.0.0.1:8765", "http://localhost:8765/", "http://LOCALHOST:8765", "http://[::1]:8765", "http://127.0.0.1"]) {
			assert.equal(isLoopbackAnkiUrl(url), true, url);
		}
		for (const url of [
			"https://127.0.0.1:8765",
			"http://127.0.0.2:8765",
			"http://0.0.0.0:8765",
			"http://localhost.example.com:8765",
			"http://example.com",
			"http://user:pass@127.0.0.1:8765",
			"file:///etc/passwd",
			"127.0.0.1:8765",
			"not a url",
			"",
		]) {
			assert.equal(isLoopbackAnkiUrl(url), false, url);
		}
		assert.equal(parseAnkiSettings({ url: " http://127.0.0.1:9000 " }).url, "http://127.0.0.1:9000");
		assert.equal(parseAnkiSettings({ url: "http://example.com:8765" }).url, DEFAULT_ANKI_SETTINGS.url);
		assert.equal(parseAnkiSettings({ url: 8765 }).url, DEFAULT_ANKI_SETTINGS.url);
	});
});

// ── misses: multiple choice ──────────────────────────────────────────────────

describe("ankiMissesOf: multiple choice", () => {
	it("a wrong teach answer is a miss with the question's full context", () => {
		const record = teachChat([
			assistant([text("Intro.")]),
			...asked("q1", "quiz", teachQuiz(), mcAnswer("quiz", ["b"], { confidence: 80, thinking: "I think beta.", readingThinking: "While reading." })),
		]);
		const miss = only(ankiMissesOf(record, DEFAULTS));
		assert.deepEqual(miss, {
			key: "chat_test_0000abcd:q1",
			chatId: "chat_test_0000abcd",
			toolCallId: "q1",
			phase: "teach",
			tool: "quiz",
			kind: "wrong",
			questionType: "check",
			question: "Which one?",
			options: ["Alpha", "Beta", "Gamma"],
			correctAnswer: "Alpha",
			explanation: "Because alpha.",
			learnerAnswer: "Beta",
			learnerThinking: "I think beta.\n\nWhile reading.",
			confidence: 80,
			missClass: null,
			rung: null,
			targets: [],
			planNode: "Node one",
			answeredAt: Date.parse("2026-10-10T10:00:00.000Z"),
			messageIndex: 2,
		} satisfies AnkiMiss);
	});

	it("grades again from the call and ignores a tampered stored verdict", () => {
		// Stored as correct, but the selection is wrong.
		const tamperedRight = teachChat(asked("q1", "quiz", teachQuiz(), mcAnswer("quiz", ["b"], { correct: true, confidence: 90 })));
		assert.equal(only(ankiMissesOf(tamperedRight, DEFAULTS)).kind, "wrong");
		// Stored as wrong, but the selection is right (and confident).
		const tamperedWrong = teachChat(asked("q1", "quiz", teachQuiz(), mcAnswer("quiz", ["a"], { correct: false, confidence: 90 })));
		assert.deepEqual(ankiMissesOf(tamperedWrong, DEFAULTS), []);
	});

	it("falls back to the stored verdict only when the call cannot be parsed", () => {
		// correctAnswer names no option: the quiz parse refuses the call.
		const broken = teachQuiz({ correctAnswer: "zzz" });
		const wrong = teachChat(asked("q1", "quiz", broken, mcAnswer("quiz", ["a"], { correct: false, correctIndices: [2] })));
		const miss = only(ankiMissesOf(wrong, DEFAULTS));
		assert.equal(miss.kind, "wrong");
		assert.equal(miss.correctAnswer, "Beta");
		assert.deepEqual(miss.options, ["Alpha", "Beta", "Gamma"]);
		const right = teachChat(asked("q1", "quiz", broken, mcAnswer("quiz", ["b"], { correct: true, confidence: 90 })));
		assert.deepEqual(ankiMissesOf(right, DEFAULTS), []);
		// No call arguments and no stored verdict: nothing to grade, no miss.
		const unknown = teachChat(asked("q1", "quiz", broken, mcAnswer("quiz", ["b"], { correct: undefined })));
		assert.deepEqual(ankiMissesOf(unknown, DEFAULTS), []);
	});

	it("multi-select needs the exact set, and lists every correct label", () => {
		const args = teachQuiz({ multiSelect: true, correctAnswer: ["a", "c"] });
		const partial = only(ankiMissesOf(teachChat(asked("q1", "quiz", args, mcAnswer("quiz", ["a"]))), DEFAULTS));
		assert.equal(partial.kind, "wrong");
		assert.equal(partial.correctAnswer, "Alpha; Gamma");
		assert.equal(partial.learnerAnswer, "Alpha");
		assert.deepEqual(ankiMissesOf(teachChat(asked("q1", "quiz", args, mcAnswer("quiz", ["a", "c"], { confidence: 90 }))), DEFAULTS), []);
		const extra = only(ankiMissesOf(teachChat(asked("q1", "quiz", args, mcAnswer("quiz", ["a", "b", "c"]))), DEFAULTS));
		assert.equal(extra.learnerAnswer, "Alpha; Beta; Gamma");
		// A stringified correctAnswer array (weak-model wobble) grades the same.
		const encoded = teachQuiz({ multiSelect: true, correctAnswer: '["a","c"]' });
		assert.deepEqual(ankiMissesOf(teachChat(asked("q1", "quiz", encoded, mcAnswer("quiz", ["a", "c"], { confidence: 90 }))), DEFAULTS), []);
	});

	it("heals stringified options and a quoted type", () => {
		const args = teachQuiz({ options: JSON.stringify(OPTIONS), type: '"predict"' });
		const miss = only(ankiMissesOf(teachChat(asked("q1", "quiz", args, mcAnswer("quiz", ["c"]))), DEFAULTS));
		assert.equal(miss.kind, "wrong");
		assert.equal(miss.questionType, "predict");
		assert.deepEqual(miss.options, ["Alpha", "Beta", "Gamma"]);
		assert.equal(miss.learnerAnswer, "Gamma");
	});

	it('"I don\'t know" is its own kind, with no answer and no confidence', () => {
		const record = teachChat(asked("q1", "quiz", teachQuiz(), mcAnswer("quiz", [], { dontKnow: true, correct: false, confidence: 70 })));
		const miss = only(ankiMissesOf(record, DEFAULTS));
		assert.equal(miss.kind, "dontKnow");
		assert.equal(miss.learnerAnswer, "");
		assert.equal(miss.confidence, null);
	});

	it("a correct answer at or below the confidence threshold is a guess", () => {
		const at = (confidence: number | undefined, settings = DEFAULTS) =>
			ankiMissesOf(teachChat(asked("q1", "quiz", teachQuiz(), mcAnswer("quiz", ["a"], { confidence }))), settings);
		assert.equal(only(at(30)).kind, "lowConfidence");
		assert.equal(only(at(0)).kind, "lowConfidence");
		assert.equal(only(at(30)).confidence, 30);
		assert.deepEqual(at(31), []);
		assert.deepEqual(at(undefined), []);
		assert.equal(only(at(50, settingsWith({ lowConfidenceMax: 50 }))).kind, "lowConfidence");
		assert.deepEqual(at(30, settingsWith({ lowConfidenceMax: 0 })), []);
	});

	it("probe questions are the probe phase, with no type or plan node", () => {
		const record = teachChat(asked("p1", "probe", probeQuiz(), mcAnswer("probe", ["b"])));
		const miss = only(ankiMissesOf(record, DEFAULTS));
		assert.equal(miss.phase, "probe");
		assert.equal(miss.tool, "probe");
		assert.equal(miss.questionType, null);
		assert.equal(miss.planNode, null);
	});

	it("a quiz without a nodeId (the prober before the rename) is the probe phase", () => {
		const record = teachChat(asked("p1", "quiz", probeQuiz(), mcAnswer("quiz", ["b"])));
		const miss = only(ankiMissesOf(record, DEFAULTS));
		assert.equal(miss.phase, "probe");
		assert.equal(miss.questionType, null);
	});

	it("reads the tool name from the result when the call is missing", () => {
		const record = teachChat([result("orphan", "probe", mcAnswer("probe", ["b"], { correct: false }))]);
		const miss = only(ankiMissesOf(record, DEFAULTS));
		assert.equal(miss.tool, "probe");
		assert.equal(miss.kind, "wrong");
		assert.equal(miss.messageIndex, 0);
	});

	it("dates the miss by the message when the answer has no valid stamp", () => {
		const record = teachChat(asked("q1", "quiz", teachQuiz(), mcAnswer("quiz", ["b"], { answeredAt: "garbage" })));
		assert.equal(only(ankiMissesOf(record, DEFAULTS)).answeredAt, 2_000);
	});

	it("reads the pre-rename thinking key", () => {
		const record = teachChat(asked("q1", "quiz", teachQuiz(), mcAnswer("quiz", ["b"], { note: "old note" })));
		assert.equal(only(ankiMissesOf(record, DEFAULTS)).learnerThinking, "old note");
	});
});

// ── misses: free text, exclusions, triggers ──────────────────────────────────

describe("ankiMissesOf: free text and exclusions", () => {
	it("an explain or recall answer is a free-text candidate with the committed answer", () => {
		const record = teachChat([
			...asked(
				"e1",
				"explain",
				{ type: "predict", nodeId: "n1", question: "Explain it.", correctAnswer: "The committed answer." },
				textAnswer("explain", "My words.", { readingThinking: "Reading." }),
			),
			...asked("r1", "recall", { question: "Recall it.", correctAnswer: "Recalled." }, textAnswer("recall", "Something.", { committed: "Recalled." })),
		]);
		const [explain, recall] = ankiMissesOf(record, DEFAULTS);
		assert.equal(explain?.kind, "freeText");
		assert.equal(explain?.phase, "teach");
		assert.equal(explain?.questionType, "predict");
		assert.equal(explain?.planNode, "Node one");
		assert.equal(explain?.question, "Explain it.");
		assert.equal(explain?.correctAnswer, "The committed answer.");
		assert.equal(explain?.learnerAnswer, "My words.");
		assert.equal(explain?.learnerThinking, "Reading.");
		assert.deepEqual(explain?.options, []);
		assert.equal(explain?.explanation, "");
		assert.equal(explain?.confidence, null);
		assert.equal(recall?.kind, "freeText");
		assert.equal(recall?.phase, "probe");
		assert.equal(recall?.correctAnswer, "Recalled.");
	});

	it("free text rides the wrong trigger, and an empty answer is nothing", () => {
		const record = teachChat(asked("r1", "recall", { question: "Q", correctAnswer: "A" }, textAnswer("recall", "words")));
		assert.equal(ankiMissesOf(record, DEFAULTS).length, 1);
		assert.deepEqual(ankiMissesOf(record, settingsWith({ triggers: { wrong: false } })), []);
		const empty = teachChat(asked("r1", "recall", { question: "Q", correctAnswer: "A" }, textAnswer("recall", "   ")));
		assert.deepEqual(ankiMissesOf(empty, DEFAULTS), []);
	});

	it("never counts ask_user_question, skipped questions or errored calls", () => {
		const record = teachChat([
			...asked(
				"ask",
				"ask_user_question",
				{ question: "Which topic?", options: OPTIONS },
				{ kind: "ask", tool: "ask_user_question", questionText: "Which topic?", dontKnow: false, answers: [{ label: "Beta", value: "b", index: 2 }], answeredAt: "2026-10-10T10:00:00.000Z" },
			),
			...asked("skip", "quiz", teachQuiz(), { kind: "quiz", questionText: "Which one?", dontKnow: false, answers: [], dismissed: true, answeredAt: "2026-10-10T10:00:00.000Z" }),
			...asked("err", "quiz", teachQuiz(), { tool: "quiz", problems: ["bad nodeId"] }, true),
			...asked("nodetails", "quiz", teachQuiz(), null),
		]);
		assert.deepEqual(ankiMissesOf(record, DEFAULTS), []);
	});

	it("filters every kind by its trigger", () => {
		const record = teachChat([
			...asked("w", "quiz", teachQuiz(), mcAnswer("quiz", ["b"])),
			...asked("d", "quiz", teachQuiz(), mcAnswer("quiz", [], { dontKnow: true })),
			...asked("g", "quiz", teachQuiz(), mcAnswer("quiz", ["a"], { confidence: 10 })),
			...asked("f", "explain", { type: "check", nodeId: "n1", question: "Q", correctAnswer: "A" }, textAnswer("explain", "words")),
		]);
		const kinds = (settings: AnkiSettings) => ankiMissesOf(record, settings).map((miss) => miss.kind);
		assert.deepEqual(kinds(DEFAULTS), ["wrong", "dontKnow", "lowConfidence", "freeText"]);
		assert.deepEqual(kinds(settingsWith({ triggers: { wrong: false } })), ["dontKnow", "lowConfidence"]);
		assert.deepEqual(kinds(settingsWith({ triggers: { dontKnow: false } })), ["wrong", "lowConfidence", "freeText"]);
		assert.deepEqual(kinds(settingsWith({ triggers: { lowConfidence: false } })), ["wrong", "dontKnow", "freeText"]);
		const none = Object.fromEntries(ANKI_TRIGGERS.map((trigger) => [trigger, false]));
		assert.deepEqual(kinds(settingsWith({ triggers: none })), []);
	});

	it("keeps keys unique when a provider reuses a call id", () => {
		const record = teachChat([
			...asked("call_0", "quiz", teachQuiz(), mcAnswer("quiz", ["b"])),
			...asked("call_0", "quiz", teachQuiz(), mcAnswer("quiz", ["c"])),
		]);
		const misses = ankiMissesOf(record, DEFAULTS);
		assert.deepEqual(
			misses.map((miss) => miss.key),
			["chat_test_0000abcd:call_0", "chat_test_0000abcd:call_0#2"],
		);
		assert.deepEqual(misses.map((miss) => miss.learnerAnswer), ["Beta", "Gamma"]);
	});

	it("never moves a reused call id's key to another miss when settings change", () => {
		const keysOf = (record: ReturnType<typeof teachChat>, settings: AnkiSettings) =>
			ankiMissesOf(record, settings).map((miss) => [miss.key, miss.kind]);
		// A sure correct answer, then a wrong one: the wrong one is #2 whether
		// or not the first counts as a guess.
		const guessThenWrong = teachChat([
			...asked("call_0", "quiz", teachQuiz(), mcAnswer("quiz", ["a"], { confidence: 50 })),
			...asked("call_0", "quiz", teachQuiz(), mcAnswer("quiz", ["b"])),
		]);
		assert.deepEqual(keysOf(guessThenWrong, DEFAULTS), [["chat_test_0000abcd:call_0#2", "wrong"]]);
		assert.deepEqual(keysOf(guessThenWrong, settingsWith({ lowConfidenceMax: 60 })), [
			["chat_test_0000abcd:call_0", "lowConfidence"],
			["chat_test_0000abcd:call_0#2", "wrong"],
		]);
		// A wrong answer, then "I don't know": turning wrong off keeps #2.
		const wrongThenDontKnow = teachChat([
			...asked("call_0", "quiz", teachQuiz(), mcAnswer("quiz", ["b"])),
			...asked("call_0", "quiz", teachQuiz(), mcAnswer("quiz", [], { dontKnow: true })),
		]);
		assert.deepEqual(keysOf(wrongThenDontKnow, DEFAULTS), [
			["chat_test_0000abcd:call_0", "wrong"],
			["chat_test_0000abcd:call_0#2", "dontKnow"],
		]);
		assert.deepEqual(keysOf(wrongThenDontKnow, settingsWith({ triggers: { wrong: false } })), [["chat_test_0000abcd:call_0#2", "dontKnow"]]);
		// …and so does an answer before the feature was turned on.
		const later = teachChat([
			...asked("call_0", "quiz", teachQuiz(), mcAnswer("quiz", ["b"], { answeredAt: "2026-10-01T00:00:00.000Z" })),
			...asked("call_0", "quiz", teachQuiz(), mcAnswer("quiz", ["c"], { answeredAt: "2026-10-20T00:00:00.000Z" })),
		]);
		assert.deepEqual(keysOf(later, settingsWith({ enabledAt: "2026-10-10T00:00:00.000Z" })), [["chat_test_0000abcd:call_0#2", "wrong"]]);
	});

	it("ignores misses answered before the feature was turned on", () => {
		const at = (answeredAt: string, id: string) => asked(id, "quiz", teachQuiz(), mcAnswer("quiz", ["b"], { answeredAt }));
		const record = teachChat([
			...at("2026-10-10T09:59:59.999Z", "before"),
			...at("2026-10-10T10:00:00.000Z", "equal"),
			...at("2026-10-10T11:00:00.000Z", "after"),
		]);
		const ids = (settings: AnkiSettings) => ankiMissesOf(record, settings).map((miss) => miss.toolCallId);
		assert.deepEqual(ids(settingsWith({ enabledAt: "2026-10-10T10:00:00.000Z" })), ["equal", "after"]);
		assert.deepEqual(ids(settingsWith({ enabledAt: "2026-10-10T07:00:00-03:00" })), ["equal", "after"]);
		assert.deepEqual(ids(DEFAULTS), ["before", "equal", "after"]);
		assert.deepEqual(ids({ ...DEFAULTS, enabledAt: "garbage" }), ["before", "equal", "after"]);
	});
});

// ── misses: practice ─────────────────────────────────────────────────────────

describe("ankiMissesOf: practice", () => {
	const picks = marker("graph-context", { propositions: [{ id: "p1", name: "Chain rule", statement: "S" }], chains: [] });
	const problem = (id: string, args: Record<string, unknown> = {}): LhMessage[] => [
		assistant([text("A problem."), call(id, "problem", { statement: "Differentiate.", mode: "recall", target: ["Chain rule"], modelSolution: "Use the chain rule.", ...args })], 1_000),
		result(id, "problem", null, 1_001),
	];
	const conclude = (id: string, args: Record<string, unknown>, timestamp = 5_000, isError = false): LhMessage[] => [
		assistant([call(id, "conclude", { verdict: "You stopped at the inner function.", retest: true, ...args })], timestamp),
		result(id, "conclude", null, timestamp + 1, isError),
	];
	const attempt = (problemCallId: string, value: string) => marker("practice-thinking", { problemCallId, text: value }, 3_000);
	const practice = (messages: LhMessage[]) => ({ id: "chat_practice_1234", kind: "practice" as const, messages });

	it("a problem not solved is a miss with the problem, solution, verdict and attempts", () => {
		const messages = [
			picks,
			...problem("pr1"),
			attempt("pr1", "First try."),
			attempt("other", "Not this one."),
			attempt("pr1", "Second try."),
			...conclude("co1", { outcome: "movedOn", rung: "R2", missClass: "structural" }),
		];
		const miss = only(ankiMissesOf(practice(messages), DEFAULTS));
		assert.deepEqual(miss, {
			key: "chat_practice_1234:pr1",
			chatId: "chat_practice_1234",
			toolCallId: "pr1",
			phase: "practice",
			tool: "problem",
			kind: "practiceNotSolved",
			questionType: null,
			question: "Differentiate.",
			options: [],
			correctAnswer: "Use the chain rule.",
			explanation: "You stopped at the inner function.",
			learnerAnswer: "First try.\n\nSecond try.",
			learnerThinking: "",
			confidence: null,
			missClass: "structural",
			rung: "R2",
			targets: ["p1"],
			planNode: null,
			answeredAt: 5_000,
			messageIndex: 6,
		} satisfies AnkiMiss);
	});

	it("maps each outcome, and never counts careless slips or dismissals", () => {
		const kindOf = (args: Record<string, unknown>) =>
			ankiMissesOf(practice([picks, ...problem("pr1"), ...conclude("co1", args)]), DEFAULTS).map((miss) => miss.kind);
		assert.deepEqual(kindOf({ outcome: "surrendered", rung: "R5", missClass: "cue" }), ["practiceNotSolved"]);
		assert.deepEqual(kindOf({ outcome: "solvedWithHints", rung: "R3", missClass: "execution" }), ["practiceHeavyHint"]);
		assert.deepEqual(kindOf({ outcome: "solvedWithHints", rung: "R5", missClass: null }), ["practiceHeavyHint"]);
		assert.deepEqual(kindOf({ outcome: "solvedWithHints", rung: "R2", missClass: "execution" }), []);
		assert.deepEqual(kindOf({ outcome: "solved", rung: null, missClass: null }), []);
		assert.deepEqual(kindOf({ outcome: "movedOn", rung: "R1", missClass: "careless" }), []);
		assert.deepEqual(kindOf({ outcome: "solvedWithHints", rung: "R4", missClass: "careless" }), []);
		// Weak-model wobble: string-encoded enums heal.
		assert.deepEqual(kindOf({ outcome: '"solvedWithHints"', rung: '"R4"', missClass: '"discrimination"' }), ["practiceHeavyHint"]);

		const dismissed = practice([
			picks,
			...problem("pr1"),
			marker("problem-dismissed", { problemCallId: "pr1" }, 4_000),
			...conclude("call_conc_pr1", { outcome: "dismissed" }),
		]);
		assert.deepEqual(ankiMissesOf(dismissed, DEFAULTS), []);
	});

	it("ignores an errored conclude, and respects the practice triggers", () => {
		const errored = practice([picks, ...problem("pr1"), ...conclude("co1", { outcome: "movedOn" }, 5_000, true)]);
		assert.deepEqual(ankiMissesOf(errored, DEFAULTS), []);
		const notSolved = practice([picks, ...problem("pr1"), ...conclude("co1", { outcome: "movedOn" })]);
		assert.deepEqual(ankiMissesOf(notSolved, settingsWith({ triggers: { practiceNotSolved: false } })), []);
		const heavy = practice([picks, ...problem("pr1"), ...conclude("co1", { outcome: "solvedWithHints", rung: "R3" })]);
		assert.deepEqual(ankiMissesOf(heavy, settingsWith({ triggers: { practiceHeavyHint: false } })), []);
	});

	it("dates a practice miss by its conclusion against enabledAt", () => {
		const record = practice([picks, ...problem("pr1"), ...conclude("co1", { outcome: "movedOn" }, 5_000)]);
		assert.equal(ankiMissesOf(record, settingsWith({ enabledAt: new Date(5_000).toISOString() })).length, 1);
		assert.deepEqual(ankiMissesOf(record, settingsWith({ enabledAt: new Date(5_001).toISOString() })), []);
	});

	it("keeps a target outside the session's picks as written", () => {
		const record = practice([picks, ...problem("pr1", { target: '["p9", "Chain rule"]' }), ...conclude("co1", { outcome: "movedOn" })]);
		assert.deepEqual(only(ankiMissesOf(record, DEFAULTS)).targets, ["p9", "p1"]);
	});

	it("reads practice only from practice sessions", () => {
		const record = { id: "chat_teach", kind: "teach" as const, messages: [picks, ...problem("pr1"), ...conclude("co1", { outcome: "movedOn" })] };
		assert.deepEqual(ankiMissesOf(record, DEFAULTS), []);
	});
});

// ── misses: the golden recordings ────────────────────────────────────────────

const golden = (name: string): ChatRecord =>
	JSON.parse(readFileSync(new URL(`./fixtures/golden-data/chats/${name}.json`, import.meta.url), "utf8")) as ChatRecord;

describe("ankiMissesOf: golden recordings", () => {
	it("finds the recorded teach session's misses in order", () => {
		const record = golden("chat_mv27rrra_feff23b6");
		const misses = ankiMissesOf(record, DEFAULTS);
		assert.deepEqual(
			misses.map((miss) => [miss.messageIndex, miss.tool, miss.phase, miss.kind, miss.questionType]),
			[
				[22, "recall", "probe", "freeText", null],
				[49, "quiz", "teach", "dontKnow", "predict"],
				[55, "quiz", "teach", "wrong", "check"],
				[67, "explain", "teach", "freeText", "predict"],
				[69, "explain", "teach", "freeText", "check"],
			],
		);
		for (const miss of misses) assert.equal(miss.key, `${record.id}:${miss.toolCallId}`);

		const wrong = misses[2]!;
		assert.equal(wrong.planNode, "Transition: only unmastered mass moves");
		assert.equal(wrong.correctAnswer, "A, by +0.16 versus B's +0.04 — the change is proportional to the unmastered mass.");
		assert.equal(wrong.learnerAnswer, "B, by +0.16 versus A's +0.04 — belief closer to 1 has more mastery available to be reinforced.");
		assert.equal(wrong.confidence, 0);
		assert.equal(wrong.learnerThinking, "Now I'm gonna get this one wrong on purpose.\n\nAlright. Thinking while reading field.");
		assert.equal(wrong.options.length, 4);
		assert.equal(wrong.options[0], "A, by +0.16 versus B's +0.04 — the change is proportional to the unmastered mass.");
		assert.equal(wrong.answeredAt, Date.parse("2026-10-10T10:03:49.243Z"));
		assert.equal(misses[1]!.planNode, "Predict step: advance, then correct");
	});

	it("re-grades the recording and follows the confidence threshold", () => {
		const record = golden("chat_mv27rrra_feff23b6");
		// The probe at 17 was right with confidence 70.
		const guesses = ankiMissesOf(record, settingsWith({ lowConfidenceMax: 70 })).filter((miss) => miss.kind === "lowConfidence");
		assert.deepEqual(guesses.map((miss) => [miss.messageIndex, miss.phase, miss.confidence]), [[17, "probe", 70]]);
		// Tampering with the stored verdict changes nothing.
		const tampered = structuredClone(record);
		(tampered.messages[55] as { details: { correct: boolean } }).details.correct = true;
		assert.equal(ankiMissesOf(tampered, DEFAULTS).find((miss) => miss.messageIndex === 55)?.kind, "wrong");
		// Only "I don't know" left when wrong is off.
		assert.deepEqual(
			ankiMissesOf(record, settingsWith({ triggers: { wrong: false } })).map((miss) => miss.kind),
			["dontKnow"],
		);
	});

	it("finds nothing in the recorded practice session (solved, then dismissed)", () => {
		assert.deepEqual(ankiMissesOf(golden("chat_mv293wv5_10656952"), DEFAULTS), []);
	});

	it("turns the recorded practice session's first problem into a miss when it was not solved", () => {
		const record = golden("chat_mv293wv5_10656952");
		const conclusion = record.messages[7] as unknown as { content: Array<{ arguments: Record<string, unknown> }> };
		conclusion.content.find((block) => "arguments" in block)!.arguments.outcome = "surrendered";
		const miss = only(ankiMissesOf(record, DEFAULTS));
		assert.equal(miss.kind, "practiceNotSolved");
		assert.equal(miss.toolCallId, "call_3413e7014ab74b0383cc1024");
		assert.deepEqual(miss.targets, ["n_9b19474daaf7"]);
		assert.equal(miss.messageIndex, 7);
		assert.ok(miss.question.startsWith("Knowledge tracing is standardly characterized"));
		assert.ok(miss.correctAnswer.startsWith("The three features:"));
		assert.ok(miss.explanation.startsWith("All three ingredients correct"));
		assert.equal(miss.learnerAnswer.split("\n\n").length >= 2, true);
		assert.ok(miss.learnerAnswer.startsWith("Are you asking for the assumptions"));
	});
});

// ── transcript excerpt ───────────────────────────────────────────────────────

describe("ankiTranscriptExcerpt", () => {
	const record = teachChat([
		assistant([text("Before the miss.")]),
		...asked("q1", "quiz", teachQuiz(), mcAnswer("quiz", ["b"])),
		assistant([thinking("private reasoning"), text("Not quite: alpha is right because of $x$."), call("v1", "visual", { prompt: "draw" })]),
		{ id: msgId(), role: "user", content: "ok, why?", timestamp: 3_000 } as unknown as LhMessage,
		assistant([call("s1", "send_to_user", { message: "Here is the full reason." })]),
		result("s1", "send_to_user", null),
		...asked("q2", "quiz", teachQuiz(), mcAnswer("quiz", ["a"])),
	]);
	const miss = only(ankiMissesOf(record, DEFAULTS).filter((m) => m.toolCallId === "q1"));

	it("keeps the tutor's prose after the miss and notes later answers", () => {
		assert.equal(
			ankiTranscriptExcerpt(record, miss, 4000),
			[
				"Not quite: alpha is right because of $x$.",
				"Here is the full reason.",
				"Here is a question.",
				'[Learner\'s answer to "Which one?": Alpha]',
			].join("\n\n"),
		);
	});

	it("keeps the start and the newest text when cut, within the limit", () => {
		const newest = "Newest: alpha holds because the slope at the origin is zero.";
		const long = teachChat([
			...asked("q1", "quiz", teachQuiz(), mcAnswer("quiz", ["b"])),
			assistant([text(`First reaction: ${"beta misses the point ".repeat(20)}`)]),
			...Array.from({ length: 6 }, (_, i) => assistant([text(`Middle ${i}: ${"filler words here ".repeat(15)}`)])),
			assistant([text(newest)]),
		]);
		const longMiss = only(ankiMissesOf(long, DEFAULTS));
		for (const max of [400, 600, 1000]) {
			const excerpt = ankiTranscriptExcerpt(long, longMiss, max);
			assert.ok(excerpt.length <= max, `${excerpt.length} > ${max}`);
			assert.ok(excerpt.startsWith("First reaction: beta misses the point"));
			assert.ok(excerpt.includes("\n\n[…]\n\n"));
			assert.ok(excerpt.endsWith(newest));
			const [head] = excerpt.split("\n\n[…]\n\n");
			assert.ok(head!.length <= Math.ceil(max / 3), "the head is about a third");
		}
		// A later explanation changes what the writer sees on the next run.
		const before = ankiTranscriptExcerpt(long, longMiss, 600);
		long.messages.push(assistant([text("Even newer: the explanation the learner needed.")]));
		const after = ankiTranscriptExcerpt(long, longMiss, 600);
		assert.notEqual(after, before);
		assert.ok(after.endsWith("Even newer: the explanation the learner needed."));
	});

	it("keeps only the newest text when the limit is tiny, and nothing at zero", () => {
		const cut = ankiTranscriptExcerpt(record, miss, 20);
		assert.ok(cut.length <= 20);
		assert.ok(cut.startsWith("…"));
		assert.ok(cut.endsWith("Alpha]"));
		assert.equal(ankiTranscriptExcerpt(record, miss, 0), "");
		assert.equal(ankiTranscriptExcerpt(record, { ...miss, messageIndex: record.messages.length - 1 }, 100), "");
	});

	it("reads the golden recording after its wrong check, up to the session's last words", () => {
		const golden0 = golden("chat_mv27rrra_feff23b6");
		const wrong = ankiMissesOf(golden0, DEFAULTS).find((m) => m.messageIndex === 55)!;
		const excerpt = ankiTranscriptExcerpt(golden0, wrong, 4000);
		assert.ok(excerpt.startsWith("Wrong, and it carries no information"));
		assert.ok(excerpt.length <= 4000);
		assert.ok(excerpt.includes("\n\n[…]\n\n"));
		assert.ok(excerpt.endsWith("PDF extraction remains untested."));
		assert.ok(!excerpt.includes("He deliberately picked wrong")); // the tutor's thinking stays out
	});
});

describe("ankiTutorRepliedAfter", () => {
	const failedTurn = (blocks: Block[]): LhMessage => ({ ...assistant(blocks), stopReason: "error" }) as unknown as LhMessage;

	it("waits for the tutor's prose after parallel answers", () => {
		const record = teachChat([
			assistant([text("Two questions."), call("q1", "quiz", teachQuiz()), call("q2", "quiz", teachQuiz())]),
			result("q1", "quiz", mcAnswer("quiz", ["b"])),
			result("q2", "quiz", mcAnswer("quiz", ["c"])),
		]);
		const misses = ankiMissesOf(record, DEFAULTS);
		assert.equal(misses.length, 2);
		const replied = () => misses.map((miss) => ankiTutorRepliedAfter(record, miss));
		assert.deepEqual(replied(), [false, false]);

		// Thinking and other tool calls are no reply; neither is a failed turn
		// nor a failed output call.
		record.messages.push(assistant([thinking("Both wrong."), call("v1", "visual", { prompt: "draw" })]));
		record.messages.push(result("v1", "visual", null));
		record.messages.push(failedTurn([text("Both are wro")]));
		record.messages.push(assistant([call("s1", "send_to_user", { message: "Partial" })]));
		record.messages.push(result("s1", "send_to_user", null, 2_000, true));
		assert.deepEqual(replied(), [false, false]);

		record.messages.push(assistant([text("Both wrong: alpha was right in each.")]));
		assert.deepEqual(replied(), [true, true]);
	});

	it("counts the explicit output tool as a reply", () => {
		const record = teachChat([
			...asked("q1", "quiz", teachQuiz(), mcAnswer("quiz", ["b"])),
			assistant([call("s1", "send_to_user", { message: "Not quite." })]),
			result("s1", "send_to_user", null),
		]);
		assert.equal(ankiTutorRepliedAfter(record, only(ankiMissesOf(record, DEFAULTS))), true);
	});

	it("is always true in practice, where the conclusion carries the verdict", () => {
		const record = {
			id: "chat_practice_1234",
			kind: "practice" as const,
			messages: [
				assistant([call("pr1", "problem", { statement: "S", mode: "recall", target: [], modelSolution: "M" })]),
				result("pr1", "problem", null),
				assistant([call("co1", "conclude", { outcome: "movedOn", verdict: "V" })]),
				result("co1", "conclude", null),
			],
		};
		const miss = only(ankiMissesOf(record, DEFAULTS));
		assert.equal(miss.phase, "practice");
		assert.equal(ankiTutorRepliedAfter(record, miss), true);
	});
});

// ── format ───────────────────────────────────────────────────────────────────

describe("ankiCardId", () => {
	it("is FNV-1a 64 as 16 hex chars, stable and distinct", () => {
		assert.equal(ankiCardId(""), "cbf29ce484222325");
		assert.equal(ankiCardId("a"), "af63dc4c8601ec8c");
		assert.equal(ankiCardId("foobar"), "85944171f73967e8");
		const key = "chat_mv27rrra_feff23b6:call_f1ec47cb3eb94cc6b180ba2c318ee065";
		assert.match(ankiCardId(key), /^[0-9a-f]{16}$/);
		assert.equal(ankiCardId(key), ankiCardId(key));
		assert.notEqual(ankiCardId(key), ankiCardId(`${key}#2`));
		assert.equal(ankiCardId("ação"), ankiCardId("ação"));
		assert.notEqual(ankiCardId("ação"), ankiCardId("acao"));
	});

	it("the barrel's browser copy is the same function", async () => {
		const { ankiCardId: fromBarrel } = await import("../src/core/index.ts");
		assert.equal(fromBarrel, ankiCardId);
	});
});

describe("which misses wait for the explanation", () => {
	it("a probe miss is explained with its answer; a prediction waits for the teaching; the rest need neither", () => {
		assert.equal(ankiMissExplainedOnAnswer({ phase: "probe" }), true);
		assert.equal(ankiMissExplainedOnAnswer({ phase: "teach" }), false);
		assert.equal(ankiMissExplainedOnAnswer({ phase: "practice" }), false);
		assert.equal(missNeedsTeaching({ phase: "probe", questionType: null }), false);
		assert.equal(missNeedsTeaching({ phase: "teach", questionType: "predict" }), true);
		assert.equal(missNeedsTeaching({ phase: "teach", questionType: "check" }), false);
		assert.equal(missNeedsTeaching({ phase: "practice", questionType: null }), false);
	});
});

describe("ankiDeckName", () => {
	it("fills the folder path and the session title", () => {
		assert.equal(ankiDeckName("LearnHarness::{folder}", { folderPath: ["Math", "Calculus"], sessionTitle: "Limits" }), "LearnHarness::Math::Calculus");
		assert.equal(ankiDeckName("LearnHarness::{folder}", { folderPath: [], sessionTitle: "Limits" }), "LearnHarness");
		assert.equal(ankiDeckName("{pasta}::{sessao}", { folderPath: ["Física"], sessionTitle: "Ondas" }), "Física::Ondas");
		assert.equal(ankiDeckName("Study::{Session}", { folderPath: [], sessionTitle: "Ondas" }), "Study::Ondas");
		assert.equal(ankiDeckName("Plain deck", { folderPath: ["x"], sessionTitle: "y" }), "Plain deck");
	});

	it("sanitizes inserted values and drops empty segments", () => {
		assert.equal(
			ankiDeckName("LH::{folder}::{session}", { folderPath: ["  A::B  ", "", "  "], sessionTitle: 'The "chain"\trule\n' }),
			"LH::A B::The chain rule",
		);
		assert.equal(ankiDeckName("::A::::{session}::", { folderPath: [], sessionTitle: "::" }), "A");
		assert.equal(ankiDeckName("{folder}::{session}", { folderPath: [], sessionTitle: "" }), "LearnHarness");
		assert.equal(ankiDeckName("", { folderPath: [], sessionTitle: "" }), "LearnHarness");
		const long = ankiDeckName("{session}", { folderPath: [], sessionTitle: "x".repeat(59) + " yz" });
		assert.equal(long, "x".repeat(59));
		assert.equal(ankiDeckName("{session}", { folderPath: [], sessionTitle: "y".repeat(80) }).length, 60);
		assert.equal(ankiDeckName("{session}::Z", { folderPath: [], sessionTitle: "Foo:" }), "Foo::Z");
	});
});

describe("ankiTags", () => {
	const base = { chatId: "chat_mv27rrra_feff23b6", sessionTitle: "Ação e Reação — Física!", phase: "teach" as const, missClass: null, confident: false };

	it("tags root, phase, miss, type, confident error and session", () => {
		assert.deepEqual(ankiTags({ ...base, kind: "wrong" }), [
			"LearnHarness",
			"LearnHarness::phase::teach",
			"LearnHarness::miss::wrong",
			"LearnHarness::session::acao-e-reacao-fisica_feff23b6",
		]);
		assert.deepEqual(ankiTags({ ...base, phase: "practice", kind: "practiceHeavyHint", missClass: "discrimination", confident: true }), [
			"LearnHarness",
			"LearnHarness::phase::practice",
			"LearnHarness::miss::heavy-hint",
			"LearnHarness::type::discrimination",
			"LearnHarness::confident-error",
			"LearnHarness::session::acao-e-reacao-fisica_feff23b6",
		]);
	});

	it("names every miss kind", () => {
		const missTag = (kind: AnkiMiss["kind"]) => ankiTags({ ...base, kind })[2];
		assert.equal(missTag("wrong"), "LearnHarness::miss::wrong");
		assert.equal(missTag("freeText"), "LearnHarness::miss::wrong");
		assert.equal(missTag("dontKnow"), "LearnHarness::miss::dont-know");
		assert.equal(missTag("lowConfidence"), "LearnHarness::miss::guess");
		assert.equal(missTag("practiceNotSolved"), "LearnHarness::miss::not-solved");
		assert.equal(missTag("practiceHeavyHint"), "LearnHarness::miss::heavy-hint");
	});

	it("slugs the session title for a tag without spaces", () => {
		const sessionOf = (sessionTitle: string, chatId = base.chatId) => ankiTags({ ...base, kind: "wrong", sessionTitle, chatId }).at(-1);
		assert.equal(sessionOf("  Straße & Œuvre  "), "LearnHarness::session::strasse-oeuvre_feff23b6");
		const long = sessionOf("The quick brown fox jumps over the lazy dog again and again");
		assert.equal(long, "LearnHarness::session::the-quick-brown-fox-jumps-over-the-lazy_feff23b6");
		assert.equal(sessionOf("日本語"), "LearnHarness::session::feff23b6");
		assert.equal(sessionOf("Title", "a b:c"), "LearnHarness::session::title_abc");
		for (const tag of ankiTags({ ...base, kind: "wrong" })) assert.doesNotMatch(tag, /\s/);
	});
});

describe("markdownToAnkiHtml", () => {
	it("is empty for empty text", () => {
		assert.equal(markdownToAnkiHtml(""), "");
		assert.equal(markdownToAnkiHtml("  \n "), "");
	});

	it("escapes HTML", () => {
		assert.equal(markdownToAnkiHtml('<script>alert("x")</script> & co'), "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; co");
	});

	it("turns dollar math into Anki's MathJax delimiters", () => {
		assert.equal(markdownToAnkiHtml("Let $x^2$ be"), "Let \\(x^2\\) be");
		assert.equal(markdownToAnkiHtml("So $$\\int f$$ holds"), "So \\[\\int f\\] holds");
		assert.equal(markdownToAnkiHtml("Above:\n$$\n\\frac{a}{b}\n$$\nBelow."), "Above:\\[\\frac{a}{b}\\]Below.");
		assert.equal(markdownToAnkiHtml("Keep \\(a+b\\) and \\[c\\]"), "Keep \\(a+b\\) and \\[c\\]");
		assert.equal(markdownToAnkiHtml("If $a < b$ and $c > d$"), "If \\(a &lt; b\\) and \\(c &gt; d\\)");
	});

	it("never formats inside math", () => {
		assert.equal(markdownToAnkiHtml("$a_1 * b_2 * c$ and $x_i_j$"), "\\(a_1 * b_2 * c\\) and \\(x_i_j\\)");
		assert.equal(markdownToAnkiHtml("**$a**b$**"), "<b>\\(a**b\\)</b>");
	});

	it("leaves money and escaped dollars alone", () => {
		assert.equal(markdownToAnkiHtml("It costs $5 and $10 in total."), "It costs $5 and $10 in total.");
		assert.equal(markdownToAnkiHtml("Between $5 and $6."), "Between $5 and $6.");
		assert.equal(markdownToAnkiHtml("A \\$5 bill and $x$"), "A $5 bill and \\(x\\)");
		assert.equal(markdownToAnkiHtml("$5$ apples"), "\\(5\\) apples");
	});

	it("repairs JSON-escape damage inside math", () => {
		assert.equal(markdownToAnkiHtml("Half is $\frac{1}{2}$"), "Half is \\(\\frac{1}{2}\\)");
		assert.equal(markdownToAnkiHtml("A $\text{word}$"), "A \\(\\text{word}\\)");
	});

	it("bold, italic and inline code", () => {
		assert.equal(markdownToAnkiHtml("**bold** and *it* and _it_ and __b__"), "<b>bold</b> and <i>it</i> and <i>it</i> and <b>b</b>");
		assert.equal(markdownToAnkiHtml("snake_case_name stays, 2 * 3 * 4 too"), "snake_case_name stays, 2 * 3 * 4 too");
		assert.equal(markdownToAnkiHtml("Use `a*b*c <tag>` here"), "Use <code>a*b*c &lt;tag&gt;</code> here");
		assert.equal(markdownToAnkiHtml("\\*not italic\\*"), "*not italic*");
		assert.equal(markdownToAnkiHtml("Code: `$x$`"), "Code: <code>$x$</code>");
	});

	it("fenced code blocks", () => {
		assert.equal(markdownToAnkiHtml("Before\n```js\nconst a = 1 < 2;\n**x**\n```\nAfter"), "Before<pre><code>const a = 1 &lt; 2;\n**x**</code></pre>After");
	});

	it("lines, paragraphs, lists and headings", () => {
		assert.equal(markdownToAnkiHtml("one\ntwo\n\n\nthree"), "one<br>two<br><br>three");
		assert.equal(markdownToAnkiHtml("Steps:\n- first $a$\n- **second**\n\n1. one\n2. two"), "Steps:<ul><li>first \\(a\\)</li><li><b>second</b></li></ul><ol><li>one</li><li>two</li></ol>");
		assert.equal(markdownToAnkiHtml("1) Predict: $p$. 2) Correct: Bayes."), "1) Predict: \\(p\\). 2) Correct: Bayes.");
		assert.equal(markdownToAnkiHtml("1. Predict, then 2. correct"), "1. Predict, then 2. correct");
		assert.equal(markdownToAnkiHtml("1) Predict, see 2. below"), "<ol><li>Predict, see 2. below</li></ol>");
		assert.equal(markdownToAnkiHtml("## Title\nBody"), "<b>Title</b><br>Body");
		assert.equal(markdownToAnkiHtml("Line\r\nNext"), "Line<br>Next");
	});
});

describe("ankiNoteFields", () => {
	const record: AnkiCardRecord & { card: AnkiCardDraft } = {
		id: "0123456789abcdef",
		key: "chat_x:q1",
		chatId: "chat_x",
		toolCallId: "q1",
		sessionTitle: "Limits <and> continuity",
		phase: "teach",
		kind: "wrong",
		missClass: null,
		confident: false,
		targets: [],
		status: "queued",
		attempts: 0,
		createdAt: "2026-10-31T12:00:00.000Z",
		updatedAt: "2026-10-31T12:00:00.000Z",
		card: { front: "What is $\\lim_{x\\to 0} \\frac{\\sin x}{x}$?", back: "**1**", why: "", pitfall: "Plugging in $x=0$ gives $0/0$, not $0$." },
	};
	const date = new Date(2026, 9, 31, 12, 0, 0);

	it("fills every field of the note type", () => {
		const fields = ankiNoteFields(record, { date, locale: "en-US" });
		assert.deepEqual(Object.keys(fields), [...ANKI_NOTE_FIELDS]);
		assert.equal(fields["LH ID"], "0123456789abcdef");
		assert.equal(fields.Front, "What is \\(\\lim_{x\\to 0} \\frac{\\sin x}{x}\\)?");
		assert.equal(fields.Back, "<b>1</b>");
		assert.equal(fields.Why, "");
		assert.equal(fields.Pitfall, "Plugging in \\(x=0\\) gives \\(0/0\\), not \\(0\\).");
		const day = new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(date);
		assert.equal(fields.Source, `LearnHarness · Limits &lt;and&gt; continuity · ${day}`);
		assert.match(fields.Source, /2026/);
	});

	it("dates the source in the given locale, and survives a bad locale", () => {
		const pt = ankiNoteFields(record, { date, locale: "pt-BR" }).Source;
		assert.equal(pt, `LearnHarness · Limits &lt;and&gt; continuity · ${new Intl.DateTimeFormat("pt-BR", { dateStyle: "medium" }).format(date)}`);
		assert.match(ankiNoteFields(record, { date, locale: "not a locale!" }).Source, /2026/);
		assert.equal(ankiNoteFields({ ...record, sessionTitle: "" }, { date: new Date(Number.NaN), locale: "en" }).Source, "LearnHarness");
	});
});
