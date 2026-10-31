/**
 * Practice evidence (fork feature, docs/evidence.md).
 *
 * What happened when a proposition was exercised in practice, read from the
 * practice session records. Nothing here is stored: the `problem` and
 * `conclude` calls already live in the chat record, so evidence is a pure
 * fold over it, recomputed on every read. Shown as evidence, never as a
 * grade. Pure and browser-safe.
 */

import { healEncodedArguments } from "./argument-heal.ts";
import { resolveTargetId } from "./chains.ts";
import type { ChatRecord } from "./contracts/chat.ts";
import type { GraphNode } from "./contracts/graph.ts";
import {
	PRACTICE_CONCLUDE_TOOL,
	PRACTICE_PROBLEM_TOOL,
	type LhMarkerMessage,
	type LhMessage,
} from "./native-messages.ts";
import { messageAnchorId } from "./session-navigation.ts";

// The enums mirror the practice tools' schemas (src/agent/tools/practice.ts);
// tests/evidence.test.ts pins them together. Core cannot import the agent layer.
export const PRACTICE_OUTCOMES = ["solved", "solvedWithHints", "movedOn", "surrendered", "dismissed"] as const;
export const HINT_RUNGS = ["R0", "R1", "R2", "R3", "R4", "R5"] as const;
export const MISS_CLASSES = ["cue", "discrimination", "execution", "careless", "structural"] as const;
export const PRACTICE_MODES = ["recall", "discrimination", "composition"] as const;

export type PracticeOutcome = (typeof PRACTICE_OUTCOMES)[number];
export type HintRung = (typeof HINT_RUNGS)[number];
export type MissClass = (typeof MISS_CLASSES)[number];
export type PracticeMode = (typeof PRACTICE_MODES)[number];

/** Where the problem's targets stood against the session's picked
 *  propositions (the graph-context card, whose statements the learner can
 *  open at any time): "only-pick" means the session had one pick and it is a
 *  target, so which idea to use was given away. */
export type TargetContext = "none" | "among-picks" | "only-pick";

/** One concluded practice problem: the unit of evidence. */
export interface PracticeEvidence {
	/** Which kind of record produced it. Only practice today. */
	source: "practice";
	chatId: string;
	problemCallId: string;
	/** null = dismissed, and the synthetic conclude is not written yet. */
	concludeCallId: string | null;
	/** Canonical ids that exist in the current graph ([] = untagged). */
	targets: string[];
	mode: PracticeMode | null;
	outcome: PracticeOutcome;
	/** null = no hint (always null on dismissals). */
	rung: HintRung | null;
	missClass: MissClass | null;
	/** null = not recorded (dismissals). */
	retest: boolean | null;
	/** The learner's practice-thinking sends for this problem. */
	submissions: number;
	/** Epoch ms of the problem call's message. */
	posedAt: number;
	/** Epoch ms of the conclude message, or of the dismissal marker. */
	concludedAt: number;
	targetContext: TargetContext;
	/** Solved (with or without hints) at rung null or R0, and the target was
	 *  not the session's only pick. */
	independent: boolean;
	/** The learner's own confidence. Reserved: always absent in this version.
	 *  A grader's confidence, if ever recorded, is a separate field named
	 *  `graderConfidence`. */
	learnerConfidence?: number;
}

export type EvidenceStage =
	// Shown on the node card.
	| "solvedWithoutHelp"
	| "solvedWithHelp"
	| "practicedNotSolved"
	// Data only.
	| "taughtNotPracticed"
	| "importedNotPracticed"
	| "noEvidence";

/** "review" = the first worked item of this proposition in its session;
 *  "same-session" = a later one in that session (a retest), which is not a
 *  new spaced review; null = dismissed (nothing was worked). */
export type EvidenceSpacing = "review" | "same-session" | null;

export interface PropositionEvidence {
	propositionId: string;
	/** When the idea first reached the learner: the proposition's birth source
	 *  (a teaching session or imported notes) and its creation date. */
	firstContact: { kind: "taught" | "imported"; sourceId: string; at: string } | null;
	/** Newest first. */
	items: Array<{ evidence: PracticeEvidence; spacing: EvidenceSpacing }>;
	/** Practice stages come from the most recent session with a worked item;
	 *  `at` is that session's latest worked item. */
	stage: { kind: EvidenceStage; chatId: string | null; at: number | null };
}

/** The practice stages, in priority order. */
export const PRACTICE_STAGES = ["solvedWithoutHelp", "solvedWithHelp", "practicedNotSolved"] as const;

const literals = (values: readonly string[]) => values.map((value) => ({ const: value }));

// Plain JSON-schema shapes for the weak-model heal: the record keeps the raw
// arguments (the heal at the tool boundary works on a copy), so reads heal
// the same wobble again.
const PROBLEM_HEAL_SCHEMA = {
	properties: {
		mode: { anyOf: literals(PRACTICE_MODES) },
		target: { type: "array" },
	},
};
const CONCLUDE_HEAL_SCHEMA = {
	properties: {
		outcome: { anyOf: literals(PRACTICE_OUTCOMES) },
		rung: { anyOf: [...literals(HINT_RUNGS), { type: "null" }] },
		missClass: { anyOf: [...literals(MISS_CLASSES), { type: "null" }] },
		retest: { type: "boolean" },
	},
};

function member<T extends string>(values: readonly T[], value: unknown): T | null {
	return typeof value === "string" && (values as readonly string[]).includes(value) ? (value as T) : null;
}

function healed(args: unknown, schema: typeof PROBLEM_HEAL_SCHEMA | typeof CONCLUDE_HEAL_SCHEMA): Record<string, unknown> {
	const value = healEncodedArguments(args, schema);
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

const roleOf = (message: LhMessage): string | undefined => (message as { role?: string }).role;

/** Tool calls that went through: a non-error result exists. Errored and
 *  dangling calls never happened (the honest-activation rule of
 *  native-messages.ts, whose helper is private). */
function cleanCallIds(messages: readonly LhMessage[]): Set<string> {
	const ids = new Set<string>();
	for (const message of messages) {
		if (roleOf(message) !== "toolResult") continue;
		const result = message as { toolCallId?: unknown; isError?: unknown };
		if (typeof result.toolCallId === "string" && result.isError !== true) ids.add(result.toolCallId);
	}
	return ids;
}

function detailsOf(marker: LhMarkerMessage): Record<string, unknown> {
	return marker.details && typeof marker.details === "object" ? (marker.details as Record<string, unknown>) : {};
}

function targetContextOf(targets: readonly string[], picks: ReadonlySet<string>): TargetContext {
	if (picks.size === 1 && targets.some((target) => picks.has(target))) return "only-pick";
	return targets.some((target) => picks.has(target)) ? "among-picks" : "none";
}

function isSolved(outcome: PracticeOutcome): boolean {
	return outcome === "solved" || outcome === "solvedWithHints";
}

const DISMISSED_PREFIX = "call_conc_";

/** The evidence of one session, in conclusion order. Non-practice sessions
 *  give none. Targets resolve against `nodes` (the current graph); unknown
 *  ones (a deleted proposition) are dropped. */
export function practiceEvidenceOf(
	record: Pick<ChatRecord, "id" | "kind" | "messages">,
	nodes: ReadonlyArray<Pick<GraphNode, "id" | "name">>,
): PracticeEvidence[] {
	if (record.kind !== "practice") return [];
	const messages = record.messages;
	const clean = cleanCallIds(messages);

	const picks = new Set<string>();
	const submissions = new Map<string, number>();
	for (const message of messages) {
		if (roleOf(message) !== "custom") continue;
		const marker = message as LhMarkerMessage;
		const details = detailsOf(marker);
		if (marker.customType === "graph-context" && Array.isArray(details.propositions)) {
			for (const pick of details.propositions) {
				const id = (pick as { id?: unknown } | null)?.id;
				if (typeof id === "string") picks.add(id);
			}
		}
		if (marker.customType === "practice-thinking" && typeof details.problemCallId === "string") {
			submissions.set(details.problemCallId, (submissions.get(details.problemCallId) ?? 0) + 1);
		}
	}

	type Posed = { callId: string; args: Record<string, unknown>; posedAt: number };
	const posed = new Map<string, Posed>();
	const done = new Map<string, PracticeEvidence>();
	const items: PracticeEvidence[] = [];
	let active: Posed | null = null;

	const emit = (
		problem: Posed,
		conclusion: { callId: string | null; at: number; outcome: PracticeOutcome; args: Record<string, unknown> },
	) => {
		if (done.has(problem.callId)) return;
		const rawTargets = Array.isArray(problem.args.target) ? problem.args.target : [];
		const targets: string[] = [];
		for (const raw of rawTargets) {
			if (typeof raw !== "string") continue;
			const id = resolveTargetId(raw, nodes);
			if (id !== null && !targets.includes(id)) targets.push(id);
		}
		const dismissed = conclusion.outcome === "dismissed";
		const rung = dismissed ? null : member(HINT_RUNGS, conclusion.args.rung);
		const targetContext = targetContextOf(targets, picks);
		const evidence: PracticeEvidence = {
			source: "practice",
			chatId: record.id,
			problemCallId: problem.callId,
			concludeCallId: conclusion.callId,
			targets,
			mode: member(PRACTICE_MODES, problem.args.mode),
			outcome: conclusion.outcome,
			rung,
			missClass: dismissed ? null : member(MISS_CLASSES, conclusion.args.missClass),
			retest: !dismissed && typeof conclusion.args.retest === "boolean" ? conclusion.args.retest : null,
			submissions: submissions.get(problem.callId) ?? 0,
			posedAt: problem.posedAt,
			concludedAt: conclusion.at,
			targetContext,
			independent:
				isSolved(conclusion.outcome) && (rung === null || rung === "R0") && targetContext !== "only-pick",
		};
		done.set(problem.callId, evidence);
		items.push(evidence);
	};

	for (const message of messages) {
		const role = roleOf(message);
		if (role === "custom") {
			const marker = message as LhMarkerMessage;
			if (marker.customType !== "problem-dismissed") continue;
			const problemCallId = detailsOf(marker).problemCallId;
			const problem = typeof problemCallId === "string" ? posed.get(problemCallId) : undefined;
			if (!problem) continue;
			emit(problem, { callId: null, at: marker.timestamp, outcome: "dismissed", args: {} });
			if (active?.callId === problem.callId) active = null;
			continue;
		}
		if (role !== "assistant") continue;
		const content = (message as { content?: unknown }).content;
		if (!Array.isArray(content)) continue;
		const at = (message as { timestamp?: unknown }).timestamp;
		const timestamp = typeof at === "number" ? at : 0;
		for (const block of content) {
			const call = block as { type?: unknown; id?: unknown; name?: unknown; arguments?: unknown };
			if (call.type !== "toolCall" || typeof call.id !== "string" || !clean.has(call.id)) continue;
			if (call.name === PRACTICE_PROBLEM_TOOL) {
				const problem: Posed = { callId: call.id, args: healed(call.arguments, PROBLEM_HEAL_SCHEMA), posedAt: timestamp };
				posed.set(call.id, problem);
				active = problem;
				continue;
			}
			if (call.name !== PRACTICE_CONCLUDE_TOOL) continue;
			const args = healed(call.arguments, CONCLUDE_HEAL_SCHEMA);
			const outcome = member(PRACTICE_OUTCOMES, args.outcome);
			if (outcome === "dismissed") {
				// The dismissal's deferred conclude pair: its call id names the
				// problem. The marker usually already produced the item.
				const problemCallId = call.id.startsWith(DISMISSED_PREFIX) ? call.id.slice(DISMISSED_PREFIX.length) : null;
				const problem = problemCallId ? posed.get(problemCallId) : undefined;
				if (problem) {
					const existing = done.get(problem.callId);
					if (existing) existing.concludeCallId ??= call.id;
					else emit(problem, { callId: call.id, at: timestamp, outcome, args });
					if (active?.callId === problem.callId) active = null;
				}
				continue;
			}
			const problem: Posed | null = active;
			active = null;
			if (!problem || outcome === null) continue;
			emit(problem, { callId: call.id, at: timestamp, outcome, args });
		}
	}
	return items;
}

/** Per-proposition views for every node, items newest first. Nodes are the
 *  merged graph nodes; `importedSourceIds` are the notes-source ids. */
export function propositionEvidenceOf(
	items: readonly PracticeEvidence[],
	nodes: ReadonlyArray<Pick<GraphNode, "id" | "createdAt" | "provenance">>,
	importedSourceIds: ReadonlySet<string>,
): Record<string, PropositionEvidence> {
	const byProposition = new Map<string, PracticeEvidence[]>();
	for (const item of items) {
		for (const target of item.targets) {
			const list = byProposition.get(target) ?? [];
			list.push(item);
			byProposition.set(target, list);
		}
	}

	const views: Record<string, PropositionEvidence> = {};
	for (const node of nodes) {
		const chronological = [...(byProposition.get(node.id) ?? [])].sort(
			(a, b) => a.concludedAt - b.concludedAt || a.posedAt - b.posedAt,
		);
		const seen = new Set<string>();
		const withSpacing = chronological.map((evidence) => {
			if (evidence.outcome === "dismissed") return { evidence, spacing: null };
			const spacing: EvidenceSpacing = seen.has(evidence.chatId) ? "same-session" : "review";
			seen.add(evidence.chatId);
			return { evidence, spacing };
		});

		const birth = node.provenance[0]?.chatId;
		const firstContact: PropositionEvidence["firstContact"] = birth
			? { kind: importedSourceIds.has(birth) ? "imported" : "taught", sourceId: birth, at: node.createdAt }
			: null;

		views[node.id] = {
			propositionId: node.id,
			firstContact,
			items: withSpacing.reverse(),
			stage: stageOf(chronological, firstContact),
		};
	}
	return views;
}

function stageOf(
	chronological: readonly PracticeEvidence[],
	firstContact: PropositionEvidence["firstContact"],
): PropositionEvidence["stage"] {
	const worked = chronological.filter((item) => item.outcome !== "dismissed");
	const latest = worked.at(-1);
	if (!latest) {
		const kind: EvidenceStage = !firstContact
			? "noEvidence"
			: firstContact.kind === "imported"
				? "importedNotPracticed"
				: "taughtNotPracticed";
		return { kind, chatId: null, at: null };
	}
	const session = worked.filter((item) => item.chatId === latest.chatId);
	const kind: EvidenceStage = session.some((item) => item.independent)
		? "solvedWithoutHelp"
		: session.some((item) => isSolved(item.outcome))
			? "solvedWithHelp"
			: "practicedNotSolved";
	return { kind, chatId: latest.chatId, at: Math.max(...session.map((item) => item.concludedAt)) };
}

/** The link to the item in its session: the conclusion card, or the problem
 *  card while a dismissal has no conclude yet. */
export function practiceEvidenceHref(item: Pick<PracticeEvidence, "chatId" | "concludeCallId" | "problemCallId">): string {
	return `/chat/${encodeURIComponent(item.chatId)}#${encodeURIComponent(messageAnchorId(item.concludeCallId ?? item.problemCallId))}`;
}
