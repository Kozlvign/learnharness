/**
 * Anki cards from mistakes (fork feature, docs/anki.md): the miss fold.
 *
 * Which learner answers in a chat record may become flashcards. Like the
 * practice evidence (src/core/evidence.ts), nothing here is stored: the
 * question calls, their answers and the practice conclusions already live
 * in the record, so the misses are a pure fold over it, recomputed on
 * every run. Pure and browser-safe.
 *
 * - Multiple choice (`probe`, `quiz`): graded again here from the call's
 *   own arguments (option values + correctAnswer), never from the verdict
 *   the browser stored in the answer. Only a call whose arguments cannot
 *   be parsed falls back to that verdict.
 * - Free text (`recall`, `explain`): the record carries no grade, so every
 *   answer is a candidate (`freeText`); the card writer judges it later.
 * - Practice: the evidence fold's conclusions (`movedOn`/`surrendered`, or
 *   solved only with a hint at R3 or above). Careless slips never count.
 * - `ask_user_question` is never graded and never counts. Skipped
 *   (dismissed) questions and errored calls never count either.
 */

import { healEncodedArguments } from "../argument-heal.ts";
import { resolveTargetId } from "../chains.ts";
import type { ChatRecord } from "../contracts/chat.ts";
import { practiceEvidenceOf, type HintRung, type PracticeEvidence } from "../evidence.ts";
import {
	PRACTICE_CONCLUDE_TOOL,
	PRACTICE_PROBLEM_TOOL,
	failedOutputCallIds,
	userFacingTextOf,
	type LhMarkerMessage,
	type LhMessage,
} from "../native-messages.ts";
import { QUESTION_TOOLS } from "../pending.ts";
import { coerceCorrectAnswer, normalizeOptions, normalizeQuizType, type QuizOption } from "../question-core.ts";
import { parseExplainInput, parseQuizInput } from "../tool-parts.ts";
import { stripModelValueDebris } from "../value-debris.ts";
import type { AnkiMiss, AnkiMissKind, AnkiPhase, AnkiSettings, AnkiTrigger } from "./contract.ts";

/** Each kind is switched by one trigger; free-text misses ride `wrong`. */
const TRIGGER_OF: Readonly<Record<AnkiMissKind, AnkiTrigger>> = {
	wrong: "wrong",
	dontKnow: "dontKnow",
	lowConfidence: "lowConfidence",
	freeText: "wrong",
	practiceNotSolved: "practiceNotSolved",
	practiceHeavyHint: "practiceHeavyHint",
};

/** The practice doctrine reads R3+ as "over the edge": the hint named the
 *  proposition, or more. */
const HEAVY_RUNGS: ReadonlySet<HintRung> = new Set(["R3", "R4", "R5"]);

const MULTIPLE_CHOICE_TOOLS: ReadonlySet<string> = new Set(["probe", "quiz"]);
const FREE_TEXT_TOOLS: ReadonlySet<string> = new Set(["recall", "explain"]);

/** The answer record as stored (QuestionAnswerData), read defensively:
 *  old and hand-edited records may miss any field. */
interface StoredAnswer {
	tool?: unknown;
	questionType?: unknown;
	questionText?: unknown;
	options?: unknown;
	dontKnow?: unknown;
	answers?: unknown;
	text?: unknown;
	other?: unknown;
	thinking?: unknown;
	note?: unknown;
	readingThinking?: unknown;
	confidence?: unknown;
	correct?: unknown;
	correctIndices?: unknown;
	committed?: unknown;
	explanation?: unknown;
	dismissed?: unknown;
	answeredAt?: unknown;
}

/** Everything about a miss except its identity and position. */
type MissBody = Omit<AnkiMiss, "key" | "chatId" | "messageIndex">;

/** `occurrence`: which answer to this call id this is (1 = the first); a
 *  provider can reuse call ids. Counted before any setting filters. */
type Found = { body: MissBody; messageIndex: number; occurrence: number };

const roleOf = (message: LhMessage): string | undefined => (message as { role?: string }).role;

function objectOf(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

const stringOf = (value: unknown): string => (typeof value === "string" ? value : "");

const joinBlocks = (parts: readonly unknown[]): string =>
	parts
		.filter((part): part is string => typeof part === "string" && part.trim() !== "")
		.map((part) => part.trim())
		.join("\n\n");

/** The plan node a teach question is about (the teach schemas require it). */
function nodeIdOf(args: Record<string, unknown> | null): string | null {
	const raw = args?.nodeId;
	if (typeof raw !== "string") return null;
	const id = stripModelValueDebris(raw);
	return id === "" ? null : id;
}

/** probe/recall → probe; quiz/explain → teach. Before the probe tools got
 *  their own names (2026-10-09) the prober also called `quiz`/`explain`;
 *  those calls carry no `nodeId`, which every clean teach call does (the
 *  teach schemas require it), so an untagged call is a probe question. */
function phaseOf(tool: string, args: Record<string, unknown> | null): Exclude<AnkiPhase, "practice"> {
	if (tool === "probe" || tool === "recall") return "probe";
	return nodeIdOf(args) === null ? "probe" : "teach";
}

/** Epoch ms of the answer: its own ISO stamp, else the message's. */
function answeredAtOf(answer: StoredAnswer, message: LhMessage): number {
	const parsed = typeof answer.answeredAt === "string" ? Date.parse(answer.answeredAt) : Number.NaN;
	if (Number.isFinite(parsed)) return parsed;
	const timestamp = (message as { timestamp?: unknown }).timestamp;
	return typeof timestamp === "number" ? timestamp : 0;
}

/** The learner's thinking on the question (`thinking`, or the pre-rename
 *  `note`), then the thinking while reading the teaching. */
function thinkingOf(answer: StoredAnswer): string {
	return joinBlocks([answer.thinking ?? answer.note, answer.readingThinking]);
}

interface Graded {
	question: string;
	/** Labels in authored order. */
	options: string[];
	correctAnswer: string;
	learnerAnswer: string;
	explanation: string;
	/** null = cannot be graded at all. */
	correct: boolean | null;
}

/** The selected answers as stored: `{ label, value, index }`. */
function selectedOf(answer: StoredAnswer): Array<{ label: string; value: string | null; index: number }> {
	if (!Array.isArray(answer.answers)) return [];
	const out: Array<{ label: string; value: string | null; index: number }> = [];
	for (const raw of answer.answers) {
		const item = objectOf(raw);
		if (!item) continue;
		out.push({
			label: stringOf(item.label).trim(),
			value: typeof item.value === "string" ? item.value.trim() : null,
			index: typeof item.index === "number" ? item.index : 0,
		});
	}
	return out;
}

/** Grade a multiple-choice answer again from the call's arguments: the
 *  selected values against `correctAnswer`, as an exact set (the dock's
 *  rule). The stored `correct` is only a fallback for a call whose
 *  arguments no longer parse. */
function gradeMultipleChoice(rawArgs: unknown, args: Record<string, unknown> | null, answer: StoredAnswer): Graded {
	const selected = selectedOf(answer);
	const dontKnow = answer.dontKnow === true;
	const parsed = parseQuizInput(rawArgs);
	let options: QuizOption[] = [];
	if (parsed) {
		try {
			options = normalizeOptions(parsed.options);
		} catch {
			options = [];
		}
	}
	if (parsed && options.length > 0) {
		const correctValues = new Set(coerceCorrectAnswer(parsed.correctAnswer, options.map((option) => option.value)));
		const byValue = new Map(options.map((option) => [option.value, option]));
		const byLabel = new Map(options.map((option) => [option.label, option]));
		const chosen = new Set<string>();
		const labels: string[] = [];
		for (const item of selected) {
			const option = (item.value !== null ? byValue.get(item.value) : undefined) ?? byLabel.get(item.label);
			const value = option?.value ?? item.value ?? item.label;
			chosen.add(value);
			labels.push(option?.label ?? item.label);
		}
		const correct =
			!dontKnow && chosen.size === correctValues.size && [...chosen].every((value) => correctValues.has(value));
		return {
			question: parsed.question,
			options: options.map((option) => option.label),
			correctAnswer: options
				.filter((option) => correctValues.has(option.value))
				.map((option) => option.label)
				.join("; "),
			learnerAnswer: dontKnow ? "" : labels.join("; "),
			explanation: parsed.explanation,
			correct,
		};
	}

	// Unparseable call: the stored snapshot and verdict are all there is.
	const snapshot: Array<{ index: number; label: string }> = [];
	if (Array.isArray(answer.options)) {
		for (const raw of answer.options) {
			const item = objectOf(raw);
			if (item && typeof item.index === "number" && typeof item.label === "string") {
				snapshot.push({ index: item.index, label: item.label.trim() });
			}
		}
	}
	snapshot.sort((a, b) => a.index - b.index);
	let authored: string[] = [];
	try {
		authored = normalizeOptions(args?.options as never).map((option) => option.label);
	} catch {
		authored = [];
	}
	const correctIndices = Array.isArray(answer.correctIndices) ? answer.correctIndices : [];
	return {
		question: stringOf(args?.question).trim() || stringOf(answer.questionText),
		options: authored.length > 0 ? authored : snapshot.map((option) => option.label),
		correctAnswer: snapshot
			.filter((option) => correctIndices.includes(option.index))
			.map((option) => option.label)
			.join("; "),
		learnerAnswer: dontKnow ? "" : selected.map((item) => item.label).join("; "),
		explanation: stringOf(args?.explanation) || stringOf(answer.explanation),
		correct: dontKnow ? false : typeof answer.correct === "boolean" ? answer.correct : null,
	};
}

/** One answered question → its candidate miss, or null when it can never
 *  be one. Settings are not applied here: a correct answer with a stated
 *  confidence is a candidate guess, and the threshold is applied later. */
function questionMiss(
	toolCallId: string,
	tool: string,
	rawArgs: unknown,
	answer: StoredAnswer,
	message: LhMessage,
	record: Pick<ChatRecord, "tree">,
): MissBody | null {
	const args = objectOf(rawArgs);
	const phase = phaseOf(tool, args);
	const nodeId = phase === "teach" ? nodeIdOf(args) : null;
	const questionType =
		phase === "teach" ? (normalizeQuizType(args?.type) ?? normalizeQuizType(answer.questionType) ?? null) : null;
	const planNode = nodeId ? (record.tree?.nodes.find((node) => node.id === nodeId)?.title ?? null) : null;
	const dontKnow = answer.dontKnow === true;
	const common = {
		toolCallId,
		phase,
		tool,
		questionType,
		learnerThinking: thinkingOf(answer),
		missClass: null,
		rung: null,
		targets: [],
		planNode,
		answeredAt: answeredAtOf(answer, message),
	} satisfies Partial<MissBody>;

	if (MULTIPLE_CHOICE_TOOLS.has(tool)) {
		const graded = gradeMultipleChoice(rawArgs, args, answer);
		const confidence =
			!dontKnow && typeof answer.confidence === "number" && Number.isFinite(answer.confidence) ? answer.confidence : null;
		let kind: AnkiMissKind | null = null;
		if (dontKnow) kind = "dontKnow";
		else if (graded.correct === false) kind = "wrong";
		else if (graded.correct === true && confidence !== null) kind = "lowConfidence";
		if (kind === null) return null;
		return {
			...common,
			kind,
			question: graded.question,
			options: graded.options,
			correctAnswer: graded.correctAnswer,
			explanation: graded.explanation,
			learnerAnswer: graded.learnerAnswer,
			confidence,
		};
	}

	const parsed = parseExplainInput(rawArgs);
	const text = stringOf(answer.text).trim();
	const kind: AnkiMissKind | null = dontKnow ? "dontKnow" : text !== "" ? "freeText" : null;
	if (kind === null) return null;
	return {
		...common,
		kind,
		question: parsed?.question ?? (stringOf(args?.question).trim() || stringOf(answer.questionText)),
		options: [],
		correctAnswer: parsed?.correctAnswer ?? (stringOf(answer.committed) || stringOf(args?.correctAnswer)),
		explanation: "",
		learnerAnswer: dontKnow ? "" : text,
		confidence: null,
	};
}

/** The question candidates, in answer order. */
function questionMisses(record: Pick<ChatRecord, "messages" | "tree">): Found[] {
	const found: Found[] = [];
	const answersPerCall = new Map<string, number>();
	// The latest call per id seen so far: a result answers the call before it.
	const calls = new Map<string, { name: string; args: unknown }>();
	record.messages.forEach((message, messageIndex) => {
		const role = roleOf(message);
		if (role === "assistant") {
			const content = (message as { content?: unknown }).content;
			if (!Array.isArray(content)) return;
			for (const block of content) {
				const call = block as { type?: unknown; id?: unknown; name?: unknown; arguments?: unknown };
				if (call.type === "toolCall" && typeof call.id === "string" && typeof call.name === "string") {
					calls.set(call.id, { name: call.name, args: call.arguments });
				}
			}
			return;
		}
		if (role !== "toolResult") return;
		const result = message as { toolCallId?: unknown; toolName?: unknown; isError?: unknown; details?: unknown };
		if (result.isError === true || typeof result.toolCallId !== "string") return;
		const answer = objectOf(result.details) as StoredAnswer | null;
		const call = calls.get(result.toolCallId);
		const tool =
			call?.name ??
			(typeof result.toolName === "string" ? result.toolName : typeof answer?.tool === "string" ? answer.tool : "");
		if (!MULTIPLE_CHOICE_TOOLS.has(tool) && !FREE_TEXT_TOOLS.has(tool)) return;
		const occurrence = (answersPerCall.get(result.toolCallId) ?? 0) + 1;
		answersPerCall.set(result.toolCallId, occurrence);
		if (!answer || answer.dismissed === true) return;
		const body = questionMiss(result.toolCallId, tool, call?.args, answer, message, record);
		if (body) found.push({ body, messageIndex, occurrence });
	});
	return found;
}

const PROBLEM_TARGET_HEAL = { properties: { target: { type: "array" } } };

/** The nodes practice targets resolve against. The fold has no graph, so
 *  targets resolve against the session's picks (the graph-context card,
 *  ids and names); any other target is kept as written, debris stripped,
 *  which for a well-behaved model is already a proposition id. */
function targetNodesOf(messages: readonly LhMessage[]): Array<{ id: string; name: string }> {
	const picks: Array<{ id: string; name: string }> = [];
	const raws: string[] = [];
	for (const message of messages) {
		const role = roleOf(message);
		if (role === "custom") {
			const marker = message as LhMarkerMessage;
			const propositions = objectOf(marker.details)?.propositions;
			if (marker.customType !== "graph-context" || !Array.isArray(propositions)) continue;
			for (const raw of propositions) {
				const pick = objectOf(raw);
				if (pick && typeof pick.id === "string") picks.push({ id: pick.id, name: stringOf(pick.name) });
			}
			continue;
		}
		if (role !== "assistant") continue;
		const content = (message as { content?: unknown }).content;
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			const call = block as { type?: unknown; name?: unknown; arguments?: unknown };
			if (call.type !== "toolCall" || call.name !== PRACTICE_PROBLEM_TOOL) continue;
			const target = objectOf(healEncodedArguments(call.arguments, PROBLEM_TARGET_HEAL))?.target;
			if (Array.isArray(target)) raws.push(...target.filter((t): t is string => typeof t === "string"));
		}
	}
	const nodes = [...picks];
	for (const raw of raws) {
		const id = stripModelValueDebris(raw);
		if (id !== "" && resolveTargetId(raw, picks) === null && !nodes.some((node) => node.id === id)) {
			nodes.push({ id, name: id });
		}
	}
	return nodes;
}

function practiceKindOf(item: PracticeEvidence): AnkiMissKind | null {
	if (item.outcome === "dismissed" || item.missClass === "careless") return null;
	if (item.outcome === "movedOn" || item.outcome === "surrendered") return "practiceNotSolved";
	if (item.outcome === "solvedWithHints" && item.rung !== null && HEAVY_RUNGS.has(item.rung)) return "practiceHeavyHint";
	return null;
}

/** The practice misses, from the evidence fold's conclusions. */
function practiceMisses(record: Pick<ChatRecord, "id" | "kind" | "messages">): Found[] {
	if (record.kind !== "practice") return [];
	const messages = record.messages;
	const evidence = practiceEvidenceOf(record, targetNodesOf(messages));
	if (evidence.length === 0) return [];

	const callArgs = new Map<string, Record<string, unknown> | null>();
	const callIndex = new Map<string, number>();
	const attempts = new Map<string, string[]>();
	messages.forEach((message, index) => {
		const role = roleOf(message);
		if (role === "custom") {
			const marker = message as LhMarkerMessage;
			const details = objectOf(marker.details);
			if (marker.customType !== "practice-thinking" || typeof details?.problemCallId !== "string") return;
			const list = attempts.get(details.problemCallId) ?? [];
			list.push(stringOf(details.text));
			attempts.set(details.problemCallId, list);
			return;
		}
		if (role !== "assistant") return;
		const content = (message as { content?: unknown }).content;
		if (!Array.isArray(content)) return;
		for (const block of content) {
			const call = block as { type?: unknown; id?: unknown; name?: unknown; arguments?: unknown };
			if (call.type !== "toolCall" || typeof call.id !== "string") continue;
			if (call.name !== PRACTICE_PROBLEM_TOOL && call.name !== PRACTICE_CONCLUDE_TOOL) continue;
			callArgs.set(call.id, objectOf(call.arguments));
			callIndex.set(call.id, index);
		}
	});

	const found: Found[] = [];
	for (const item of evidence) {
		const kind = practiceKindOf(item);
		if (kind === null || item.concludeCallId === null) continue;
		const problem = callArgs.get(item.problemCallId) ?? null;
		const conclusion = callArgs.get(item.concludeCallId) ?? null;
		// The evidence fold gives one item per problem call id.
		found.push({
			occurrence: 1,
			messageIndex: callIndex.get(item.concludeCallId) ?? 0,
			body: {
				toolCallId: item.problemCallId,
				phase: "practice",
				tool: PRACTICE_PROBLEM_TOOL,
				kind,
				questionType: null,
				question: stringOf(problem?.statement),
				options: [],
				correctAnswer: stringOf(problem?.modelSolution),
				explanation: stringOf(conclusion?.verdict),
				learnerAnswer: joinBlocks(attempts.get(item.problemCallId) ?? []),
				learnerThinking: "",
				confidence: null,
				missClass: item.missClass,
				rung: item.rung,
				targets: item.targets,
				planNode: null,
				answeredAt: item.concludedAt,
			},
		});
	}
	return found;
}

/** A candidate passes the settings: its trigger is on, a guess is at or
 *  below the confidence threshold, and it was answered at or after the
 *  moment the feature was turned on (past mistakes never become cards). */
function passes(found: Found, settings: AnkiSettings, since: number): boolean {
	const { body } = found;
	if (settings.triggers[TRIGGER_OF[body.kind]] !== true) return false;
	if (body.kind === "lowConfidence" && (body.confidence === null || body.confidence > settings.lowConfidenceMax)) return false;
	return !Number.isFinite(since) || body.answeredAt >= since;
}

/** The record's misses that the settings let through, in message order.
 *  `key` is `${chatId}:${toolCallId}`; a call id the provider reused in the
 *  same record gets `#2`, `#3`… by its answer's position among every answer
 *  to that id. Keys are fixed before the settings filter, and the record is
 *  append-only, so a key never moves to another miss. */
export function ankiMissesOf(
	record: Pick<ChatRecord, "id" | "kind" | "messages" | "tree">,
	settings: AnkiSettings,
): AnkiMiss[] {
	const since = settings.enabledAt ? Date.parse(settings.enabledAt) : Number.NaN;
	return [...questionMisses(record), ...practiceMisses(record)]
		.filter((found) => passes(found, settings, since))
		.sort((a, b) => a.messageIndex - b.messageIndex)
		.map(({ body, messageIndex, occurrence }) => {
			const base = `${record.id}:${body.toolCallId}`;
			return {
				key: occurrence === 1 ? base : `${base}#${occurrence}`,
				chatId: record.id,
				...body,
				messageIndex,
			};
		});
}

// ─── the transcript after a miss (the card writer's evidence) ───────────────

const ANSWER_QUESTION_MAX = 160;
const ANSWER_TEXT_MAX = 300;

function clip(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	if (flat.length <= max) return flat;
	return `${dropDanglingSurrogate(flat.slice(0, max - 1)).trimEnd()}…`;
}

function dropDanglingSurrogate(text: string): string {
	const last = text.charCodeAt(text.length - 1);
	return last >= 0xd800 && last <= 0xdbff ? text.slice(0, -1) : text;
}

/** A later answer, in one line: what the learner answered to what. */
function answerLine(details: unknown): string | null {
	const answer = objectOf(details) as StoredAnswer | null;
	if (!answer || answer.dismissed === true || typeof answer.questionText !== "string") return null;
	const selected = selectedOf(answer).map((item) => item.label).filter((label) => label !== "");
	const response =
		answer.dontKnow === true
			? "I don't know"
			: selected.length > 0
				? selected.join("; ")
				: stringOf(answer.text) || stringOf(answer.other);
	if (response.trim() === "") return null;
	return `[Learner's answer to "${clip(answer.questionText, ANSWER_QUESTION_MAX)}": ${clip(response, ANSWER_TEXT_MAX)}]`;
}

/** The tutor's learner-facing prose in one message: text parts and the
 *  explicit output tool, never thinking or other tool calls. "" for any
 *  other message, and for a generation that failed. */
function tutorProseOf(message: LhMessage, failed: ReadonlySet<string>): string {
	if (roleOf(message) !== "assistant" || (message as { stopReason?: unknown }).stopReason === "error") return "";
	return joinBlocks(userFacingTextOf((message as { content?: unknown }).content, failed));
}

/** Has the tutor said anything to the learner after the miss? Parallel
 *  questions save their answers before the reply, and a failed turn can
 *  settle with no reply at all: a miss is not judged before the tutor has
 *  reacted. Always true in practice, where the conclude call carries the
 *  verdict and the solution. */
export function ankiTutorRepliedAfter(record: Pick<ChatRecord, "messages">, miss: AnkiMiss): boolean {
	if (miss.phase === "practice") return true;
	const failed = failedOutputCallIds(record.messages);
	for (let i = miss.messageIndex + 1; i < record.messages.length; i++) {
		if (tutorProseOf(record.messages[i]!, failed) !== "") return true;
	}
	return false;
}

/** Marks the part left out of a long excerpt. */
const CUT_LINE = "\n\n[…]\n\n";
/** A cut moves back (head) or forward (tail) to a space at most this far. */
const WORD_SNAP = 40;

/** The first `max` characters at most, ending at a word boundary. */
function headOf(text: string, max: number): string {
	let head = dropDanglingSurrogate(text.slice(0, max));
	if (!/\s/.test(text.charAt(max))) {
		const space = head.search(/\s\S*$/);
		if (space > 0 && space >= head.length - WORD_SNAP) head = head.slice(0, space);
	}
	return head.trimEnd();
}

/** The last `max` characters at most, starting at a word boundary. */
function tailOf(text: string, max: number): string {
	if (max <= 0) return "";
	let tail = text.slice(text.length - max);
	const first = tail.charCodeAt(0);
	if (first >= 0xdc00 && first <= 0xdfff) tail = tail.slice(1);
	if (!/\s/.test(text.charAt(text.length - max - 1))) {
		const space = tail.search(/\s/);
		if (space >= 0 && space < WORD_SNAP) tail = tail.slice(space);
	}
	return tail.trimStart();
}

/**
 * What came after the miss, as plain text: the tutor's prose, with later
 * answers as one-line notes, from `miss.messageIndex` on. When it is longer
 * than `maxChars`, the excerpt keeps the start (about a third: the tutor's
 * first reaction), a `[…]` line, and the end (the rest: the newest prose),
 * so an explanation given later is always seen. Never longer than
 * `maxChars`.
 */
export function ankiTranscriptExcerpt(
	record: Pick<ChatRecord, "messages">,
	miss: AnkiMiss,
	maxChars: number,
): string {
	if (maxChars <= 0) return "";
	const messages = record.messages;
	const failed = failedOutputCallIds(messages);
	const blocks: string[] = [];
	for (let i = miss.messageIndex + 1; i < messages.length; i++) {
		const message = messages[i]!;
		const block =
			roleOf(message) !== "toolResult"
				? tutorProseOf(message, failed)
				: (message as { isError?: unknown }).isError === true
					? null
					: answerLine((message as { details?: unknown }).details);
		if (block) blocks.push(block);
	}
	const text = blocks.join("\n\n");
	if (text.length <= maxChars) return text;
	// Too small for a head worth keeping: the newest text only.
	if (maxChars < CUT_LINE.length * 4) return `…${tailOf(text, maxChars - 1)}`;
	const head = headOf(text, Math.floor((maxChars - CUT_LINE.length) / 3));
	return `${head}${CUT_LINE}${tailOf(text, maxChars - CUT_LINE.length - head.length)}`;
}

// ─── the tutor's cards (anki_card) ──────────────────────────────────────────

/** Below this, a prefix or inclusion match says too little; an exact match
 *  links at any length ("2+2?"). */
const MATCH_MIN = 12;

/** Case, width, Markdown and math markup, and spacing do not tell two
 *  copies of a question apart. */
function matchText(text: string): string {
	return text
		.normalize("NFKC")
		.toLowerCase()
		// Inline markup hugs the text it marks: drop it. Block and link markup
		// separates words: a space.
		.replace(/[*_~`$\\{}]/g, "")
		.replace(/[#>|[\]()]/g, " ")
		.replace(/\s+/g, " ")
		.replace(/ ([?.!,;:])/g, "$1")
		.trim();
}

/**
 * The miss a tutor card's question hint names: the hint and the question
 * (or practice problem statement) match exactly, or one contains the other
 * (a prefix included) with at least MATCH_MIN characters on the contained
 * side. The most recent miss wins. null = none, or the hint is empty.
 */
export function ankiMatchMiss(misses: readonly AnkiMiss[], hint: string | null | undefined): AnkiMiss | null {
	const wanted = matchText(hint ?? "");
	if (wanted === "") return null;
	let best: AnkiMiss | null = null;
	for (const miss of misses) {
		const question = matchText(miss.question);
		if (question === "") continue;
		const matched =
			question === wanted ||
			(wanted.length >= MATCH_MIN && question.includes(wanted)) ||
			(question.length >= MATCH_MIN && wanted.includes(question));
		if (matched && (!best || miss.messageIndex > best.messageIndex)) best = miss;
	}
	return best;
}

const AUTOMATIC_INPUTS: ReadonlySet<string> = new Set(["probe-handoff", "subagent-steer", "practice-thinking", "practice-next"]);

/** A message that starts a tutor turn: the learner's message, an answered
 *  question, or a marker that wakes the tutor. */
function startsTurn(message: LhMessage): boolean {
	const role = roleOf(message);
	if (role === "user") return true;
	if (role === "custom") return AUTOMATIC_INPUTS.has(String((message as { customType?: unknown }).customType));
	if (role !== "toolResult") return false;
	const result = message as { toolName?: unknown; isError?: unknown; details?: unknown };
	const details = objectOf(result.details);
	return (
		(QUESTION_TOOLS as readonly string[]).includes(String(result.toolName)) &&
		result.isError !== true &&
		details !== null &&
		details.dismissed !== true
	);
}

/**
 * How many tutor replies (turns) were completed after the miss: the
 * messages after it, split where a turn starts (a learner message, an
 * answer, a waking marker), counting each stretch with an assistant message
 * that did not fail. The record is stored at turn end, so its last stretch
 * is a completed turn too. For a practice miss the rest of the turn that
 * concluded the problem is the first reply.
 */
export function ankiTutorRepliesAfter(record: Pick<ChatRecord, "messages">, miss: Pick<AnkiMiss, "messageIndex">): number {
	let replies = 0;
	let replied = false;
	for (let i = miss.messageIndex + 1; i < record.messages.length; i++) {
		const message = record.messages[i]!;
		if (startsTurn(message)) {
			if (replied) replies++;
			replied = false;
			continue;
		}
		if (roleOf(message) !== "assistant") continue;
		const stop = (message as { stopReason?: unknown }).stopReason;
		if (stop !== "error" && stop !== "aborted") replied = true;
	}
	return replied ? replies + 1 : replies;
}
