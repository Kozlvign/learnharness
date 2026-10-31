/**
 * Practice evidence (fork feature, docs/evidence.md): the pure fold over
 * practice session records, the per-proposition view, the enums' pin to the
 * practice tools, and the clarification rules in the prompts.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
	HINT_RUNGS,
	MISS_CLASSES,
	PRACTICE_MODES,
	PRACTICE_OUTCOMES,
	practiceEvidenceHref,
	practiceEvidenceOf,
	propositionEvidenceOf,
	type PracticeEvidence,
} from "../src/core/evidence.ts";
import type { ChatRecord } from "../src/core/contracts/chat.ts";
import type { GraphNode } from "../src/core/contracts/graph.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import { concludeInputObject, problemInputObject } from "../src/agent/tools/practice.ts";
import { composeInstructions } from "../src/agent/teacher-agent.ts";

// ── record builders ──────────────────────────────────────────────────────────

let seq = 0;
const msgId = () => `msg_${++seq}`;

type Call = { id: string; name: string; arguments: Record<string, unknown> };

function assistant(timestamp: number, calls: Call[], stopReason = "toolUse"): LhMessage {
	return {
		id: msgId(),
		role: "assistant",
		content: calls.map((c) => ({ type: "toolCall", ...c })),
		api: "faux",
		provider: "faux",
		model: "faux",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason,
		timestamp,
	} as unknown as LhMessage;
}

function result(toolCallId: string, toolName: string, timestamp: number, isError = false, details: unknown = null): LhMessage {
	return {
		id: msgId(),
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: "ok" }],
		details,
		isError,
		timestamp,
	} as unknown as LhMessage;
}

function marker(customType: string, details: unknown, timestamp: number): LhMessage {
	return { id: msgId(), role: "custom", customType, content: "", display: true, details, timestamp } as unknown as LhMessage;
}

const context = (ids: string[], timestamp = 1) =>
	marker("graph-context", { propositions: ids.map((id) => ({ id, name: id, statement: id })), chains: [] }, timestamp);

/** A posed and cleanly acknowledged problem. */
const pose = (id: string, timestamp: number, args: Record<string, unknown>): LhMessage[] => [
	assistant(timestamp, [{ id, name: "problem", arguments: { statement: "S", modelSolution: "M", ...args } }]),
	result(id, "problem", timestamp + 1),
];

/** A cleanly acknowledged conclude. */
const conclude = (id: string, timestamp: number, args: Record<string, unknown>): LhMessage[] => [
	assistant(timestamp, [{ id, name: "conclude", arguments: { verdict: "V", ...args } }]),
	result(id, "conclude", timestamp + 1),
];

const chat = (id: string, messages: LhMessage[], kind: ChatRecord["kind"] = "practice") => ({ id, kind, messages });

const NODES: Array<Pick<GraphNode, "id" | "name">> = [
	{ id: "n_a", name: "Alpha" },
	{ id: "n_b", name: "Beta" },
	{ id: "n_c", name: "Gamma" },
];

const solvedNoHint = { outcome: "solved", rung: null, missClass: null, retest: false };

// ── the enums mirror the practice tools ──────────────────────────────────────

describe("practice evidence enums", () => {
	const constsOf = (schema: unknown): string[] =>
		((schema as { anyOf?: Array<{ const?: unknown }> }).anyOf ?? [])
			.map((member) => member.const)
			.filter((value): value is string => typeof value === "string");

	it("match the problem and conclude schemas", () => {
		const conclude = concludeInputObject.properties as Record<string, unknown>;
		const problem = problemInputObject.properties as Record<string, unknown>;
		assert.deepEqual(constsOf(conclude.outcome), [...PRACTICE_OUTCOMES]);
		assert.deepEqual(constsOf(conclude.rung), [...HINT_RUNGS]);
		assert.deepEqual(constsOf(conclude.missClass), [...MISS_CLASSES]);
		assert.deepEqual(constsOf(problem.mode), [...PRACTICE_MODES]);
	});
});

// ── one session ──────────────────────────────────────────────────────────────

describe("practiceEvidenceOf", () => {
	it("reads concluded problems with their targets, hints, errors and submissions", () => {
		const items = practiceEvidenceOf(
			chat("chat_1", [
				context(["n_a", "n_b"]),
				...pose("call_p1", 100, { mode: "recall", target: ["n_a"] }),
				marker("practice-thinking", { problemCallId: "call_p1", text: "first" }, 110),
				marker("practice-thinking", { problemCallId: "call_p1", text: "second" }, 120),
				...conclude("call_c1", 130, solvedNoHint),
				...pose("call_p2", 200, { mode: "recall", target: ["n_b"] }),
				...conclude("call_c2", 230, { outcome: "solvedWithHints", rung: "R1", missClass: "execution", retest: true }),
			]),
			NODES,
		);
		assert.equal(items.length, 2);
		const [first, second] = items as [PracticeEvidence, PracticeEvidence];
		assert.deepEqual(
			{ ...first },
			{
				source: "practice",
				chatId: "chat_1",
				problemCallId: "call_p1",
				concludeCallId: "call_c1",
				targets: ["n_a"],
				mode: "recall",
				outcome: "solved",
				rung: null,
				missClass: null,
				retest: false,
				submissions: 2,
				posedAt: 100,
				concludedAt: 130,
				targetContext: "among-picks",
				independent: true,
			},
		);
		assert.equal(first.learnerConfidence, undefined, "reserved and absent");
		assert.equal(second.rung, "R1");
		assert.equal(second.missClass, "execution");
		assert.equal(second.retest, true);
		assert.equal(second.independent, false, "R1 is a content cue");
	});

	it("independence: solved at rung null or R0, never with a later rung or without a solve", () => {
		const outcomes: Array<[Record<string, unknown>, boolean]> = [
			[{ outcome: "solved", rung: null, missClass: null, retest: false }, true],
			[{ outcome: "solvedWithHints", rung: "R0", missClass: null, retest: false }, true],
			[{ outcome: "solvedWithHints", rung: "R1", missClass: null, retest: false }, false],
			[{ outcome: "solvedWithHints", rung: "R3", missClass: "cue", retest: true }, false],
			[{ outcome: "movedOn", rung: null, missClass: "cue", retest: true }, false],
			[{ outcome: "surrendered", rung: "R5", missClass: "structural", retest: true }, false],
		];
		for (const [args, independent] of outcomes) {
			const [item] = practiceEvidenceOf(
				chat("chat_i", [...pose("call_p", 1, { mode: "recall", target: ["n_a"] }), ...conclude("call_c", 2, args)]),
				NODES,
			);
			assert.equal(item?.independent, independent, JSON.stringify(args));
			assert.equal(item?.targetContext, "none", "no graph-context marker");
		}
	});

	it("the session's only pick as a target gives the target away", () => {
		const [only] = practiceEvidenceOf(
			chat("chat_s", [context(["n_a"]), ...pose("call_p", 10, { mode: "recall", target: ["n_a"] }), ...conclude("call_c", 20, solvedNoHint)]),
			NODES,
		);
		assert.equal(only?.targetContext, "only-pick");
		assert.equal(only?.independent, false);
		const [other] = practiceEvidenceOf(
			chat("chat_s2", [context(["n_a"]), ...pose("call_p", 10, { mode: "recall", target: ["n_b"] }), ...conclude("call_c", 20, solvedNoHint)]),
			NODES,
		);
		assert.equal(other?.targetContext, "none");
		assert.equal(other?.independent, true);
	});

	it("heals raw model arguments and resolves names; unknown targets are dropped", () => {
		const [item] = practiceEvidenceOf(
			chat("chat_h", [
				...pose("call_p", 10, { mode: '"discrimination"', target: '["Beta", "n_zzz", "n_b"]' }),
				...conclude("call_c", 20, { outcome: '"solvedWithHints"', rung: '"R2"', missClass: "null", retest: "true" }),
			]),
			NODES,
		);
		assert.deepEqual(item?.targets, ["n_b"]);
		assert.equal(item?.mode, "discrimination");
		assert.equal(item?.outcome, "solvedWithHints");
		assert.equal(item?.rung, "R2");
		assert.equal(item?.missClass, null);
		assert.equal(item?.retest, true);
	});

	it("only calls that went through count: errored poses, retry leftovers and pending problems give nothing", () => {
		const items = practiceEvidenceOf(
			chat("chat_e", [
				assistant(10, [{ id: "call_bad", name: "problem", arguments: { mode: "recall", target: ["n_c"] } }]),
				result("call_bad", "problem", 11, true),
				...pose("call_p", 20, { mode: "recall", target: ["n_a"] }),
				// A failed attempt the retry left on disk: a conclude without a result.
				assistant(25, [{ id: "call_lost", name: "conclude", arguments: solvedNoHint }], "error"),
				...conclude("call_c", 30, { outcome: "movedOn", rung: null, missClass: "cue", retest: true }),
				...pose("call_pending", 40, { mode: "recall", target: ["n_b"] }),
			]),
			NODES,
		);
		assert.equal(items.length, 1);
		assert.equal(items[0]?.problemCallId, "call_p");
		assert.equal(items[0]?.concludeCallId, "call_c");
		assert.equal(items[0]?.outcome, "movedOn");
	});

	it("a dismissal is one item: the marker sets the date, the later synthetic conclude only adds its id", () => {
		const before = practiceEvidenceOf(
			chat("chat_d", [
				...pose("call_p", 10, { mode: "recall", target: ["n_a"] }),
				marker("problem-dismissed", { problemCallId: "call_p" }, 50),
			]),
			NODES,
		);
		assert.equal(before.length, 1);
		assert.equal(before[0]?.outcome, "dismissed");
		assert.equal(before[0]?.concludeCallId, null);
		assert.equal(before[0]?.concludedAt, 50);
		assert.equal(before[0]?.retest, null);

		const after = practiceEvidenceOf(
			chat("chat_d", [
				...pose("call_p", 10, { mode: "recall", target: ["n_a"] }),
				marker("problem-dismissed", { problemCallId: "call_p" }, 50),
				assistant(90, [{ id: "call_conc_call_p", name: "conclude", arguments: { outcome: "dismissed" } }]),
				result("call_conc_call_p", "conclude", 90, false, { outcome: "dismissed", problemCallId: "call_p" }),
				...pose("call_p2", 100, { mode: "recall", target: ["n_b"] }),
				...conclude("call_c2", 120, solvedNoHint),
			]),
			NODES,
		);
		assert.equal(after.length, 2);
		assert.equal(after[0]?.concludeCallId, "call_conc_call_p");
		assert.equal(after[0]?.concludedAt, 50, "the dismissal time, not the synthesis time");
		assert.equal(after[1]?.problemCallId, "call_p2");
	});

	it("teaching sessions give no evidence", () => {
		assert.deepEqual(
			practiceEvidenceOf(chat("chat_t", [...pose("call_p", 1, { mode: "recall", target: ["n_a"] }), ...conclude("call_c", 2, solvedNoHint)], "teach"), NODES),
			[],
		);
	});

	it("reads the recorded practice session in the golden data", () => {
		const record = JSON.parse(
			readFileSync(new URL("./fixtures/golden-data/chats/chat_mv293wv5_10656952.json", import.meta.url), "utf8"),
		) as ChatRecord;
		const nodes = readFileSync(new URL("./fixtures/golden-data/graph/nodes.jsonl", import.meta.url), "utf8")
			.split("\n")
			.filter((line) => line.trim())
			.map((line) => JSON.parse(line) as GraphNode);
		const items = practiceEvidenceOf(record, nodes);
		assert.equal(items.length, 2);
		assert.equal(items[0]?.outcome, "solved");
		assert.deepEqual(items[0]?.targets, ["n_9b19474daaf7"]);
		assert.equal(items[0]?.targetContext, "among-picks");
		assert.equal(items[0]?.independent, true);
		assert.equal(items[0]?.submissions, 2);
		assert.equal(items[1]?.outcome, "dismissed");
		assert.deepEqual(items[1]?.targets, ["n_ed4b233efa54"]);
		assert.equal(items[1]?.concludeCallId, "call_conc_call_4346ebc77ffd408997a78857");
		assert.equal(items[1]?.concludedAt, 1791628421999);
	});
});

// ── per proposition ──────────────────────────────────────────────────────────

const evidence = (over: Partial<PracticeEvidence>): PracticeEvidence => ({
	source: "practice",
	chatId: "chat_1",
	problemCallId: "call_p",
	concludeCallId: "call_c",
	targets: ["n_a"],
	mode: "recall",
	outcome: "solved",
	rung: null,
	missClass: null,
	retest: false,
	submissions: 1,
	posedAt: 0,
	concludedAt: 0,
	targetContext: "none",
	independent: true,
	...over,
});

const graphNode = (id: string, birth: string | null): Pick<GraphNode, "id" | "createdAt" | "provenance"> => ({
	id,
	createdAt: "2026-09-01T00:00:00.000Z",
	provenance: birth ? [{ chatId: birth, messageId: "" }] : [],
});

describe("propositionEvidenceOf", () => {
	it("orders newest first and marks retests in the same session; dismissals are not worked items", () => {
		const views = propositionEvidenceOf(
			[
				evidence({ problemCallId: "p0", outcome: "dismissed", independent: false, concludedAt: 5 }),
				evidence({ problemCallId: "p1", concludedAt: 10, outcome: "movedOn", independent: false }),
				evidence({ problemCallId: "p2", concludedAt: 20 }),
				evidence({ problemCallId: "p3", chatId: "chat_2", concludedAt: 30 }),
			],
			[graphNode("n_a", "chat_teach")],
			new Set(),
		);
		const view = views.n_a!;
		assert.deepEqual(
			view.items.map(({ evidence: e, spacing }) => [e.problemCallId, spacing]),
			[
				["p3", "review"],
				["p2", "same-session"],
				["p1", "review"],
				["p0", null],
			],
		);
	});

	it("the stage reads the most recent session with worked items, dated by its latest item", () => {
		const september = Date.UTC(2026, 8, 10);
		const october = Date.UTC(2026, 9, 10);
		const views = propositionEvidenceOf(
			[
				evidence({ chatId: "chat_sep", problemCallId: "p1", concludedAt: september }),
				evidence({ chatId: "chat_oct", problemCallId: "p2", concludedAt: october, outcome: "movedOn", independent: false }),
				evidence({ chatId: "chat_oct", problemCallId: "p3", concludedAt: october + 1000, outcome: "surrendered", independent: false }),
				evidence({ chatId: "chat_nov", problemCallId: "p4", concludedAt: october + 5000, outcome: "dismissed", independent: false }),
			],
			[graphNode("n_a", "chat_teach")],
			new Set(),
		);
		assert.deepEqual(views.n_a!.stage, { kind: "practicedNotSolved", chatId: "chat_oct", at: october + 1000 });
	});

	it("solved with help when the session solved nothing independently", () => {
		const views = propositionEvidenceOf(
			[
				evidence({ problemCallId: "p1", concludedAt: 1, outcome: "solvedWithHints", rung: "R3", independent: false }),
				evidence({ problemCallId: "p2", concludedAt: 2, targetContext: "only-pick", independent: false }),
			],
			[graphNode("n_a", "chat_teach")],
			new Set(),
		);
		assert.equal(views.n_a!.stage.kind, "solvedWithHelp");
		const alone = propositionEvidenceOf([evidence({ concludedAt: 3 })], [graphNode("n_a", "chat_teach")], new Set());
		assert.equal(alone.n_a!.stage.kind, "solvedWithoutHelp");
	});

	it("first contact comes from the birth source; unpracticed stages stay in the data", () => {
		const views = propositionEvidenceOf(
			[evidence({ targets: ["n_b"], outcome: "dismissed", independent: false })],
			[graphNode("n_a", "chat_teach"), graphNode("n_b", "src_notes"), graphNode("n_c", null)],
			new Set(["src_notes"]),
		);
		assert.deepEqual(views.n_a!.firstContact, { kind: "taught", sourceId: "chat_teach", at: "2026-09-01T00:00:00.000Z" });
		assert.equal(views.n_a!.stage.kind, "taughtNotPracticed");
		assert.equal(views.n_b!.firstContact?.kind, "imported");
		assert.equal(views.n_b!.stage.kind, "importedNotPracticed", "a dismissal is not practice");
		assert.equal(views.n_b!.items.length, 1);
		assert.equal(views.n_c!.firstContact, null);
		assert.equal(views.n_c!.stage.kind, "noEvidence");
	});

	it("a multi-target problem lands on each target", () => {
		const views = propositionEvidenceOf(
			[evidence({ targets: ["n_a", "n_b"] })],
			[graphNode("n_a", "chat_t"), graphNode("n_b", "chat_t")],
			new Set(),
		);
		assert.equal(views.n_a!.items.length, 1);
		assert.equal(views.n_b!.items.length, 1);
	});
});

describe("practiceEvidenceHref", () => {
	it("links to the conclusion card, or to the problem card while a dismissal has no conclude", () => {
		assert.equal(practiceEvidenceHref({ chatId: "chat_1", concludeCallId: "call_c", problemCallId: "call_p" }), "/chat/chat_1#message-call_c");
		assert.equal(practiceEvidenceHref({ chatId: "chat_1", concludeCallId: null, problemCallId: "call_p" }), "/chat/chat_1#message-call_p");
	});
});

// ── the clarification rules ──────────────────────────────────────────────────

describe("clarification rules in the prompts", () => {
	const normalize = (text: string) => text.replace(/\s+/g, " ");

	it("practice asks before judging an unclear answer, and a clarification is not a hint", () => {
		const practice = normalize(composeInstructions("practice"));
		assert.ok(practice.includes("**On an unclear answer** — one that could be read two ways"));
		assert.ok(practice.includes("A clarification request reveals nothing and is not a hint: it moves no rung."));
	});

	it("the teacher and the prober ask before grading an unclear free-recall answer", () => {
		for (const kind of ["teacher", "prober"] as const) {
			const text = normalize(composeInstructions(kind));
			assert.ok(text.includes("**Unclear free-recall answers.** If you cannot tell whether his words match the committed answer"), kind);
		}
	});
});
