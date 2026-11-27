/**
 * The teaching audit (fork, docs/rigor.md): a pure fold over one chat
 * record that measures the session against the rigor doctrine's rules and
 * renders a Markdown report in Portuguese (the learner's language) for
 * review conversations. `scripts/audit-session.ts` is its command line.
 *
 * It reads only what the record holds: the question calls' audit tags
 * (intent, rung, gap, source, purpose), the learner's answers, the markers
 * (session-resume, course-seed) and the timestamps. Old chats without tags
 * still get every indicator that does not need them; classes are inferred
 * from 3-hour gaps when no marker exists.
 */
import { healEncodedArguments } from "./argument-heal.ts";
import {
	failedOutputCallIds,
	formatResumeGap,
	SEND_TO_USER_TOOL,
	sendToUserText,
	SESSION_RESUME_GAP_MS,
	userFacingTextOf,
	type LhMessage,
} from "./native-messages.ts";
import { ASK_PURPOSES, normalizeOptions, normalizeQuizType, resolveCorrect, TEACH_INTENTS } from "./question-core.ts";
import { CREATE_COURSE_TOOL } from "./course.ts";

type Assistant = Extract<LhMessage, { role: "assistant" }>;
type ToolResult = Extract<LhMessage, { role: "toolResult" }>;

/** The audited shape of a chat record (the JSON file's fields). */
export interface AuditRecord {
	id: string;
	title: string;
	createdAt?: string;
	updatedAt?: string;
	kind?: string;
	messages: readonly LhMessage[];
}

export interface AuditQuestion {
	/** Index of the posing assistant message in the record. */
	index: number;
	callId: string;
	at: number;
	tool: string;
	phase: "probe" | "teach" | "ask";
	format: "choice" | "free" | "ask";
	type?: "predict" | "check";
	nodeId?: string;
	intent?: string;
	rung?: number;
	gap?: string;
	source?: string;
	purpose?: string;
	text: string;
	classIndex: number;
	answered: boolean;
	answeredAt?: number;
	/** Multiple choice only; null for free recall (the tutor grades it in prose). */
	correct?: boolean | null;
	dontKnow?: boolean;
	confidence?: number;
	reasoning: boolean;
	answerValue?: string;
	answerText?: string;
	dismissed?: boolean;
}

export interface AuditClass {
	index: number;
	start: number;
	end: number;
	gapBeforeMs: number | null;
	/** A session-resume marker recorded this class's start. */
	marked: boolean;
	questions: number;
	/** The intents of the class's first teach questions (up to 4). */
	openingIntents: (string | undefined)[];
}

export interface AuditFlag {
	rule: string;
	/** Message index the flag points at. */
	index: number;
	message: string;
}

export interface AuditPlanChange {
	index: number;
	at: number;
	nodes: number;
	added: string[];
	removed: string[];
}

export interface AuditReport {
	id: string;
	title: string;
	createdAt?: string;
	updatedAt?: string;
	models: string[];
	messageCount: number;
	questions: AuditQuestion[];
	classes: AuditClass[];
	flags: AuditFlag[];
	planChanges: AuditPlanChange[];
	nodeTitles: Record<string, string>;
	ankiCards: Record<string, number>;
	coursesCreated: { index: number; title: string; ok: boolean }[];
	/** Share of teach questions carrying an intent tag (0–1). */
	tagCoverage: number;
}

const QUESTION_TOOL_NAMES = new Set(["quiz", "explain", "probe", "recall", "ask_user_question"]);
const CONFIDENT = 70;

const AUDIT_QUESTION_HEAL_SCHEMA = {
	properties: {
		type: { anyOf: [{ const: "predict" }, { const: "check" }] },
		intent: { anyOf: TEACH_INTENTS.map((intent) => ({ const: intent })) },
		rung: { type: "integer" },
		purpose: { anyOf: ASK_PURPOSES.map((purpose) => ({ const: purpose })) },
		options: { type: "array" },
		multiSelect: { type: "boolean" },
		correctAnswer: { type: "array" },
	},
};

function healedQuestionArgs(raw: unknown): Record<string, unknown> {
	const healed = healEncodedArguments(raw ?? {}, AUDIT_QUESTION_HEAL_SCHEMA);
	return typeof healed === "object" && healed !== null && !Array.isArray(healed) ? (healed as Record<string, unknown>) : {};
}

function str(v: unknown): string | undefined {
	return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function num(v: unknown): number | undefined {
	return typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : undefined;
}

function isLearnerInput(m: LhMessage): boolean {
	if (m.role === "user") return true;
	if (m.role === "toolResult") return QUESTION_TOOL_NAMES.has(m.toolName);
	return m.role === "custom" && (m.customType === "session-resume" || m.customType === "practice-thinking");
}

/** Plan node ids and titles from a plan_init mermaid block (fallback when the
 *  result carries no parsed tree, e.g. synthetic fixtures or old records). */
function planNodesFromMermaid(mermaid: string): Map<string, string> {
	const nodes = new Map<string, string>();
	const record = (rawId: string, rawTitle?: string) => {
		const id = rawId.trim();
		if (!id || /^(graph|flowchart|td|tb|lr|rl|bt|subgraph|end|style|classdef|class|linkstyle)$/i.test(id)) return;
		const cleaned = (rawTitle ?? "").trim().replace(/^"(.*)"$/, "$1").trim();
		if (!nodes.has(id) || (cleaned && nodes.get(id) === id)) nodes.set(id, cleaned || nodes.get(id) || id);
	};
	for (const rawLine of mermaid.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("%%")) continue;
		if (/^(?:graph|flowchart)\s+(?:TD|TB|LR|RL|BT)\b/i.test(line)) continue;
		if (/^(?:subgraph|end|style|classDef|class|linkStyle)\b/i.test(line)) continue;
		const parts = line.split(/\s*(?:--[^-\n]+-->|-->|==>|-\.->)(?:\|[^|]*\|)?\s*/);
		for (const part of parts) {
			const token = part.trim().replace(/;+$/, "").trim();
			const m = token.match(/^([a-z0-9]+(?:[_-][a-z0-9]+)*)(?:\s*(?:\[\s*"([^"]*)"\s*\]|\[([^\]]*)\]|\(\s*"([^"]*)"\s*\)|\(([^)]*)\)))?$/i);
			if (m) record(m[1]!, m[2] ?? m[3] ?? m[4] ?? m[5]);
		}
	}
	return nodes;
}

/** Plan node ids and titles from a plan_init tool result: prefer the canonical
 *  parsed tree stored in `details.tree.nodes`, falling back to Mermaid parsing. */
function planNodesFromResult(details: unknown, mermaid: string): Map<string, string> {
	const rawNodes = (details as { tree?: { nodes?: unknown } } | null)?.tree?.nodes;
	if (Array.isArray(rawNodes) && rawNodes.length > 0) {
		const nodes = new Map<string, string>();
		for (const entry of rawNodes) {
			if (!entry || typeof entry !== "object") continue;
			const id = str((entry as { id?: unknown }).id);
			if (!id) continue;
			const title = str((entry as { title?: unknown }).title) ?? id;
			nodes.set(id, title);
		}
		if (nodes.size > 0) return nodes;
	}
	return planNodesFromMermaid(mermaid);
}

export function auditChat(record: AuditRecord): AuditReport {
	const messages = record.messages;
	const flags: AuditFlag[] = [];
	const models = new Set<string>();
	const failedOutputs = failedOutputCallIds(messages);
	const results = new Map<string, { message: ToolResult; index: number }>();
	messages.forEach((m, index) => {
		if (m.role === "toolResult") results.set(m.toolCallId, { message: m, index });
	});

	// Classes: a session-resume marker, or a 3-hour gap before learner input.
	const classOf: number[] = [];
	const classes: AuditClass[] = [];
	let current = -1;
	messages.forEach((m, i) => {
		const prev = i > 0 ? messages[i - 1] : undefined;
		const gap = prev && typeof prev.timestamp === "number" && typeof m.timestamp === "number" ? m.timestamp - prev.timestamp : null;
		const isMarker = m.role === "custom" && m.customType === "session-resume";
		let boundary = i === 0;
		if (!boundary && isMarker) {
			// A marker after the last sibling answer joins the class opened
			// by the first answer, even when several results precede it.
			const start = classes[current]?.start;
			const followsOpeningAnswers = start !== undefined && start < i &&
				messages.slice(start, i).every((entry) => entry.role === "toolResult" && QUESTION_TOOL_NAMES.has(entry.toolName));
			boundary = !followsOpeningAnswers;
			if (!boundary) classes[current]!.marked = true;
		} else if (!boundary && gap !== null && gap >= SESSION_RESUME_GAP_MS && isLearnerInput(m)) {
			boundary = true;
		}
		if (boundary) {
			current++;
			const markerGap = isMarker ? num((m.details as { gapMs?: unknown } | null)?.gapMs) : undefined;
			classes.push({ index: current, start: i, end: i, gapBeforeMs: i === 0 ? null : markerGap ?? gap, marked: isMarker, questions: 0, openingIntents: [] });
		}
		classOf[i] = current;
		classes[current]!.end = i;
	});

	// Questions and the other audited calls.
	const questions: AuditQuestion[] = [];
	const planChanges: AuditPlanChange[] = [];
	const nodeTitles: Record<string, string> = {};
	const ankiCards: Record<string, number> = {};
	const coursesCreated: AuditReport["coursesCreated"] = [];
	let previousPlan: Set<string> | null = null;
	let teachStart = Number.POSITIVE_INFINITY;
	let firstTeachQuestionIndex = Number.POSITIVE_INFINITY;
	messages.forEach((m, index) => {
		if (m.role === "custom" && m.customType === "probe-handoff" && teachStart === Number.POSITIVE_INFINITY) teachStart = index;
		if (m.role !== "assistant") return;
		const a = m as Assistant;
		if (a.provider && a.model) models.add(`${a.provider}:${a.model}`);
		for (const block of a.content) {
			if (block.type !== "toolCall") continue;
			const rawArgs = (block.arguments ?? {}) as Record<string, unknown>;
			const result = results.get(block.id);
			if (block.name === "plan_init" && result && !result.message.isError) {
				const nodes = planNodesFromResult(result.message.details, String(rawArgs.mermaid ?? ""));
				for (const [id, title] of nodes) nodeTitles[id] = title;
				const ids = new Set(nodes.keys());
				planChanges.push({
					index,
					at: a.timestamp,
					nodes: ids.size,
					added: previousPlan ? [...ids].filter((id) => !previousPlan!.has(id)) : [...ids],
					removed: previousPlan ? [...previousPlan].filter((id) => !ids.has(id)) : [],
				});
				previousPlan = ids;
			}
			if (block.name === "anki_card" && result && !result.message.isError && (result.message.details as { ok?: boolean } | null)?.ok !== false) {
				const reason = str(rawArgs.reason) ?? "?";
				ankiCards[reason] = (ankiCards[reason] ?? 0) + 1;
			}
			if (block.name === CREATE_COURSE_TOOL && result) {
				coursesCreated.push({ index, title: str(rawArgs.title) ?? "?", ok: !result.message.isError });
			}
			if (!QUESTION_TOOL_NAMES.has(block.name)) continue;
			// A rejected tool invocation never posed a question to the learner.
			if (result?.message.isError) continue;
			const args = healedQuestionArgs(block.arguments);
			const phase = block.name === "quiz" || block.name === "explain" ? "teach" : block.name === "ask_user_question" ? "ask" : "probe";
			if (phase === "teach" && index < firstTeachQuestionIndex) firstTeachQuestionIndex = index;
			const format = block.name === "quiz" || block.name === "probe" ? "choice" : block.name === "ask_user_question" ? "ask" : "free";
			const details = (result?.message.details ?? null) as Record<string, unknown> | null;
			const answers = Array.isArray(details?.answers) ? (details!.answers as Array<{ value?: unknown; label?: unknown }>) : [];
			const text = str(details?.text) ?? str(details?.other);
			const thinking = str(details?.thinking) ?? str(details?.note);
			const q: AuditQuestion = {
				index,
				callId: block.id,
				at: a.timestamp,
				tool: block.name,
				phase,
				format,
				type: phase === "teach" ? (normalizeQuizType(args.type) ?? "check") : undefined,
				nodeId: str(args.nodeId),
				intent: str(args.intent),
				rung: num(args.rung),
				gap: str(args.gap),
				source: str(args.source),
				purpose: str(args.purpose),
				text: str(args.question) ?? "",
				classIndex: classOf[index] ?? 0,
				answered: !!result && !result.message.isError,
				answeredAt: result?.message.timestamp,
				correct: format === "choice" && typeof details?.correct === "boolean" ? (details.correct as boolean) : format === "free" ? null : undefined,
				dontKnow: details?.dontKnow === true,
				confidence: num(details?.confidence),
				reasoning: !!thinking || (format === "free" && !!text),
				answerValue: str(answers[0]?.value),
				answerText: text ?? (answers.length ? answers.map((x) => String(x.label ?? "")).join(" | ") : undefined),
				dismissed: details?.dismissed === true,
			};
			questions.push(q);
			const cls = classes[q.classIndex];
			if (cls) {
				cls.questions++;
				if (q.phase === "teach" && cls.openingIntents.length < 4) cls.openingIntents.push(q.intent);
			}
		}
	});

	const teach = questions.filter((q) => q.phase === "teach" && q.answered && !q.dismissed);
	const tagged = questions.filter((q) => q.phase === "teach" && q.intent);
	const tagCoverage = questions.some((q) => q.phase === "teach") ? tagged.length / questions.filter((q) => q.phase === "teach").length : 0;

	// C3 — every class after the first opens with retrieval.
	for (const cls of classes.slice(1)) {
		if (cls.openingIntents.length === 0) continue;
		if (!cls.openingIntents.some((intent) => intent !== undefined)) continue; // untagged: no data
		if (cls.openingIntents[0] !== "review") {
			flags.push({ rule: "C3", index: cls.start, message: `A aula ${cls.index + 1} não abriu com revisão (primeiras intenções: ${cls.openingIntents.map((x) => x ?? "?").join(", ")}).` });
		}
	}

	// E3 — climb after a confident correct check; no same rung twice on a node
	// within the same class. Skip predictions, same-message parallel siblings,
	// cross-class checks, and repair/review/exercise/exam follow-ups.
	teach.forEach((q, i) => {
		if (!q.nodeId || q.type !== "check" || q.correct !== true || (q.confidence ?? 0) < CONFIDENT || q.rung === 6) return;
		const next = teach.slice(i + 1).find((n) => n.nodeId === q.nodeId && n.type === "check" && n.index > q.index);
		if (!next || next.classIndex !== q.classIndex) return;
		if (
			q.rung !== undefined &&
			next.rung !== undefined &&
			next.rung <= q.rung &&
			next.intent !== "repair" &&
			next.intent !== "review" &&
			next.intent !== "exercise" &&
			next.intent !== "exam"
		) {
			flags.push({ rule: "E3", index: next.index, message: `Depois de um acerto confiante no degrau ${q.rung} (nó ${q.nodeId}), a pergunta seguinte ficou no degrau ${next.rung}.` });
		}
	});

	// E7 — a challenge before leaving each node.
	const runs: { nodeId: string; from: number; to: number }[] = [];
	for (const q of questions.filter((x) => x.phase === "teach" && x.nodeId)) {
		const last = runs[runs.length - 1];
		if (last && last.nodeId === q.nodeId) last.to = q.index;
		else runs.push({ nodeId: q.nodeId!, from: q.index, to: q.index });
	}
	const challenged = new Set<string>();
	runs.forEach((run, i) => {
		for (const q of questions) if (q.phase === "teach" && q.nodeId === run.nodeId && q.intent === "challenge" && q.index <= run.to) challenged.add(run.nodeId);
		if (i < runs.length - 1 && tagCoverage > 0 && !challenged.has(run.nodeId) && !runs.slice(i + 1).some((r) => r.nodeId === run.nodeId)) {
			flags.push({ rule: "E7", index: run.to, message: `O nó ${run.nodeId} foi deixado sem um desafio de saída.` });
		}
	});

	// E8/L1 — a missed check is followed by repair (skip same-message parallel
	// siblings, and allow a C3 review opening when a new class begins next).
	teach.forEach((q, i) => {
		if (q.type !== "check" || !(q.correct === false || q.dontKnow)) return;
		const next = teach.slice(i + 1).find((n) => n.index > q.index);
		if (!next) return;
		if (next.classIndex !== q.classIndex && next.intent === "review") return;
		if (next.intent !== undefined && next.intent !== "repair") {
			flags.push({ rule: "E8", index: next.index, message: `Depois do erro na checagem do nó ${q.nodeId ?? "?"}, a pergunta seguinte não foi de reparo (intenção: ${next.intent}).` });
		}
	});

	// L4 — every repaired gap is re-checked in a later class (only flag once
	// at least one later class has happened).
	const lastClassIndex = Math.max(0, classes.length - 1);
	const gaps = gapLedger(questions);
	for (const gap of gaps) {
		if (gap.repairs > 0 && gap.firstClass < lastClassIndex && !gap.verifiedLater) {
			const detail = gap.freeChecksLater > 0
				? `A lacuna ${gap.slug} foi reparada e teve ${gap.freeChecksLater} resposta(s) livre(s) em aula posterior (correção em prosa: conferir na transcrição), mas sem reverificação automática confirmada.`
				: `A lacuna ${gap.slug} foi reparada mas nunca reverificada numa aula posterior.`;
			flags.push({ rule: "L4", index: gap.firstIndex, message: detail });
		}
	}

	// C7 — a teaching turn ends with a question (except pre-teaching plan
	// presentation/revision, 10-planning.md:43, where plan_init runs and the
	// tutor pauses for the learner to accept or revise the plan).
	messages.forEach((m, index) => {
		if (index <= teachStart || m.role !== "assistant") return;
		const a = m as Assistant;
		if (a.stopReason !== "stop") return;
		const turnChunks: string[] = [];
		let calledPlanInit = false;
		for (let j = index; j > teachStart; j--) {
			const msg = messages[j]!;
			if (msg.role === "user") break;
			if (msg.role === "custom") {
				if (msg.customType === "plan-block") continue;
				break;
			}
			if (msg.role === "toolResult") {
				if (QUESTION_TOOL_NAMES.has(msg.toolName)) break;
				continue;
			}
			if (msg.role === "assistant") {
				const am = msg as Assistant;
				if (j < index && am.stopReason === "stop") break;
				const spoken = userFacingTextOf(am.content, failedOutputs).join(" ").replace(/\s+/g, " ").trim();
				if (spoken) turnChunks.unshift(spoken);
				for (const block of am.content) {
					if (block.type === "toolCall" && block.name === "plan_init") {
						const res = results.get(block.id);
						if (res && !res.message.isError) calledPlanInit = true;
					}
				}
			}
		}
		if (calledPlanInit && index < firstTeachQuestionIndex) return;
		const text = turnChunks.join(" ").trim();
		flags.push({ rule: "C7", index, message: `Turno de ensino terminou sem pergunta: “${clip(text, 140)}”. Conferir na transcrição: um balanço após o aluno pedir para parar é uma exceção legítima.` });
	});

	return {
		id: record.id,
		title: record.title,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
		models: [...models],
		messageCount: messages.length,
		questions,
		classes,
		flags: flags.sort((x, y) => x.index - y.index),
		planChanges,
		nodeTitles,
		ankiCards,
		coursesCreated,
		tagCoverage,
	};
}

export interface GapEntry {
	slug: string;
	firstIndex: number;
	firstClass: number;
	misses: number;
	repairs: number;
	/** A correct multiple-choice answer tagged with the gap in a class after its first. */
	verifiedLater: boolean;
	/** Answered free-response checks tagged with the gap in a class after its first (graded in prose). */
	freeChecksLater: number;
	questions: number;
}

export function gapLedger(questions: readonly AuditQuestion[]): GapEntry[] {
	const bySlug = new Map<string, GapEntry>();
	for (const q of questions) {
		if (!q.gap || q.phase !== "teach") continue;
		const entry = bySlug.get(q.gap) ?? {
			slug: q.gap,
			firstIndex: q.index,
			firstClass: q.classIndex,
			misses: 0,
			repairs: 0,
			verifiedLater: false,
			freeChecksLater: 0,
			questions: 0,
		};
		entry.questions++;
		if (q.intent === "repair") entry.repairs++;
		if (q.correct === false || q.dontKnow) entry.misses++;
		if (q.classIndex > entry.firstClass && q.answered && !q.dismissed && !q.dontKnow) {
			if (q.correct === true) entry.verifiedLater = true;
			else if (q.format === "free") entry.freeChecksLater++;
		}
		bySlug.set(q.gap, entry);
	}
	return [...bySlug.values()];
}

function clip(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function pct(part: number, whole: number): string {
	return whole === 0 ? "—" : `${Math.round((100 * part) / whole)}% (${part}/${whole})`;
}

function when(ms: number | undefined): string {
	if (ms === undefined || !Number.isFinite(ms)) return "?";
	const d = new Date(ms);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const INTENT_LABELS: Record<string, string> = {
	step: "passo",
	climb: "subida",
	challenge: "desafio",
	repair: "reparo",
	review: "revisão",
	exam: "prova",
	exercise: "exercício",
	detour: "desvio",
};

function row(cells: (string | number)[]): string {
	return `| ${cells.map((c) => String(c).replace(/\|/g, "\\|").replace(/\n/g, " ")).join(" | ")} |`;
}

/** The report in Markdown (Portuguese). `transcript` appends the readable
 *  transcript of the whole chat. */
export function renderAuditMarkdown(report: AuditReport, record: AuditRecord, options: { transcript?: boolean } = {}): string {
	const L: string[] = [];
	const teach = report.questions.filter((q) => q.phase === "teach");
	const answeredTeach = teach.filter((q) => q.answered && !q.dismissed);
	const noTags = report.tagCoverage === 0 && teach.length > 0;
	const nodeName = (id?: string) => (id ? (report.nodeTitles[id] && report.nodeTitles[id] !== id ? `${id} (${report.nodeTitles[id]})` : id) : "—");

	L.push(`# Auditoria de ensino: ${report.title}`, "");
	L.push(`- Chat: \`${report.id}\``);
	L.push(`- Criado: ${report.createdAt ?? "?"} · atualizado: ${report.updatedAt ?? "?"}`);
	L.push(`- Modelos: ${report.models.join(", ") || "?"}`);
	L.push(`- Mensagens: ${report.messageCount} · aulas: ${report.classes.length} · perguntas de ensino: ${teach.length} · sondagem: ${report.questions.filter((q) => q.phase === "probe").length}`);
	L.push(`- Etiquetas de auditoria nas perguntas de ensino: ${Math.round(report.tagCoverage * 100)}%${noTags ? " (chat anterior às etiquetas: os indicadores que dependem delas aparecem como \"sem dado\")" : ""}`);
	L.push("");

	L.push("## Alertas por regra", "");
	if (report.flags.length === 0) L.push("Nenhum alerta.");
	const byRule = new Map<string, AuditFlag[]>();
	for (const f of report.flags) byRule.set(f.rule, [...(byRule.get(f.rule) ?? []), f]);
	for (const [rule, list] of [...byRule.entries()].sort()) {
		L.push(`**${rule}** (${list.length})`);
		for (const f of list) L.push(`- [msg ${f.index}] ${f.message}`);
		L.push("");
	}

	L.push("## Aulas (C3)", "");
	L.push(row(["Aula", "Início", "Intervalo antes", "Marcador", "Perguntas", "Abertura (intenções)"]));
	L.push(row(["---", "---", "---", "---", "---", "---"]));
	for (const c of report.classes) {
		const opening = c.openingIntents.length === 0 ? "—" : c.openingIntents.every((x) => x === undefined) ? "sem dado" : c.openingIntents.map((x) => (x ? INTENT_LABELS[x] ?? x : "?")).join(", ");
		L.push(row([c.index + 1, when(record.messages[c.start]?.timestamp), c.gapBeforeMs === null ? "—" : formatResumeGap(c.gapBeforeMs), c.marked ? "sim" : "não", c.questions, opening]));
	}
	L.push("");

	L.push("## Acerto por degrau (E1, meta 70–80% nas checagens)", "");
	const choiceChecks = answeredTeach.filter((q) => q.type === "check" && q.format === "choice");
	const ok = (list: AuditQuestion[]) => list.filter((q) => q.correct === true).length;
	L.push(`- Checagens de múltipla escolha, primeira tentativa: ${pct(ok(choiceChecks), choiceChecks.length)}`);
	const predictions = answeredTeach.filter((q) => q.type === "predict" && q.format === "choice");
	L.push(`- Previsões de múltipla escolha: ${pct(ok(predictions), predictions.length)}`);
	if (noTags) L.push("- Por degrau: sem dado.");
	else {
		L.push("", row(["Degrau", "Checagens", "Acerto (múltipla escolha)", "Respostas livres"]), row(["---", "---", "---", "---"]));
		for (let rung = 1; rung <= 6; rung++) {
			const at = answeredTeach.filter((q) => q.type === "check" && q.rung === rung);
			if (at.length === 0) continue;
			const mc = at.filter((q) => q.format === "choice");
			L.push(row([rung, at.length, pct(ok(mc), mc.length), at.filter((q) => q.format === "free").length]));
		}
	}
	L.push("", "Por aula:", "");
	for (const c of report.classes) {
		const list = choiceChecks.filter((q) => q.classIndex === c.index);
		if (list.length) L.push(`- Aula ${c.index + 1}: ${pct(ok(list), list.length)}`);
	}
	L.push("");

	L.push("## Formato e raciocínio (E10)", "");
	L.push(`- Perguntas de ensino em múltipla escolha: ${teach.filter((q) => q.format === "choice").length} · resposta livre: ${teach.filter((q) => q.format === "free").length}`);
	const highMc = answeredTeach.filter((q) => q.format === "choice" && q.type === "check" && (q.rung ?? 0) >= 3);
	L.push(`- Raciocínio escrito nas checagens de múltipla escolha: ${pct(answeredTeach.filter((q) => q.format === "choice" && q.type === "check" && q.reasoning).length, choiceChecks.length)}`);
	L.push(`- …nas de degrau 3 ou mais: ${noTags ? "sem dado" : pct(highMc.filter((q) => q.reasoning).length, highMc.length)}`);
	const confident = choiceChecks.filter((q) => q.correct && (q.confidence ?? 0) >= CONFIDENT).length;
	L.push(`- Acertos com confiança ≥ ${CONFIDENT}%: ${pct(confident, choiceChecks.length)}`);
	L.push("");

	L.push("## Intenções (E2–E8)", "");
	if (noTags) L.push("Sem dado.");
	else {
		const counts = new Map<string, number>();
		for (const q of teach) counts.set(q.intent ?? "(sem etiqueta)", (counts.get(q.intent ?? "(sem etiqueta)") ?? 0) + 1);
		for (const [intent, n] of counts) L.push(`- ${INTENT_LABELS[intent] ?? intent}: ${n}`);
	}
	L.push("");

	L.push("## Lacunas (L1, L3, L4)", "");
	L.push("Respostas livres têm correção em prosa: confira-a na transcrição; responder, por si só, não comprova a reverificação da lacuna.", "");
	const lastClassIndex = Math.max(0, report.classes.length - 1);
	const gaps = gapLedger(report.questions);
	if (gaps.length === 0) L.push(noTags ? "Sem dado." : "Nenhuma lacuna etiquetada.");
	else {
		L.push(row(["Lacuna", "Aula em que surgiu", "Erros", "Reparos", "Perguntas", "Reverificada depois?"]), row(["---", "---", "---", "---", "---", "---"]));
		for (const g of gaps) {
			const status = g.verifiedLater
				? "sim"
				: g.firstClass >= lastClassIndex
					? "aguardando aula posterior"
					: g.freeChecksLater > 0
						? "resposta livre (conferir)"
						: "**não**";
			L.push(row([g.slug, g.firstClass + 1, g.misses, g.repairs, g.questions, status]));
		}
		const repeated = gaps.filter((g) => g.misses >= 2);
		if (repeated.length) L.push("", `Lacunas com erro repetido (L3: mudar a representação e procurar mais fundo): ${repeated.map((g) => g.slug).join(", ")}`);
	}
	L.push("");

	L.push("## Partes do plano (E7, L5)", "");
	const nodesSeen = [...new Set(teach.map((q) => q.nodeId).filter((x): x is string => !!x))];
	if (nodesSeen.length === 0) L.push("Nenhuma pergunta de ensino.");
	else {
		L.push(row(["Nó", "Perguntas", "Degrau máximo com acerto", "Desafio", "Exercícios", "Provas"]), row(["---", "---", "---", "---", "---", "---"]));
		for (const id of nodesSeen) {
			const qs = teach.filter((q) => q.nodeId === id);
			const best = qs.filter((q) => q.correct === true && q.rung !== undefined).reduce((m, q) => Math.max(m, q.rung!), 0);
			L.push(row([nodeName(id), qs.length, noTags ? "sem dado" : best || "—", noTags ? "sem dado" : qs.some((q) => q.intent === "challenge") ? "sim" : "não", qs.filter((q) => q.intent === "exercise").length, qs.filter((q) => q.intent === "exam").length]));
		}
	}
	L.push("");

	L.push("## Fontes (S2, S3)", "");
	const sourced = teach.filter((q) => q.source);
	if (sourced.length === 0) L.push("Nenhuma pergunta com referência a material do aluno.");
	else for (const q of sourced) L.push(`- [msg ${q.index}] ${q.source} (${INTENT_LABELS[q.intent ?? ""] ?? q.intent ?? "?"})`);
	const readings = report.questions.filter((q) => q.purpose === "reading");
	if (readings.length) L.push(`- Leituras oferecidas: ${readings.length} · respostas: ${readings.map((q) => q.answerValue ?? (q.answered ? "outra" : "sem resposta")).join(", ")}`);
	L.push("");

	L.push("## Desvios e novas cadeiras (R3, R4, R7)", "");
	const detours = report.questions.filter((q) => q.purpose === "detour");
	L.push(`- Desvios oferecidos: ${detours.length}${detours.length ? ` · respostas: ${detours.map((q) => q.answerValue ?? (q.answered ? "outra" : "sem resposta")).join(", ")}` : ""}`);
	const optional = Object.entries(report.nodeTitles).filter(([, title]) => /^(opcional|optional)\s*:/i.test(title));
	L.push(`- Nós opcionais no mapa: ${optional.length ? optional.map(([id, t]) => `${id} (${t})`).join(", ") : "nenhum"}`);
	const proposals = report.questions.filter((q) => q.purpose === "course");
	L.push(`- Propostas de cadeira: ${proposals.length}${proposals.length ? ` · respostas: ${proposals.map((q) => q.answerValue ?? (q.answered ? "outra" : "sem resposta")).join(", ")}` : ""}`);
	L.push(`- Cadeiras criadas: ${report.coursesCreated.filter((c) => c.ok).map((c) => c.title).join(", ") || "nenhuma"}`);
	L.push("");

	L.push("## Anki (K1)", "");
	const cards = Object.entries(report.ankiCards);
	L.push(cards.length ? cards.map(([reason, n]) => `- ${reason}: ${n}`).join("\n") : "Nenhum card criado pelo tutor.");
	L.push("");

	L.push("## Mudanças do plano (C2)", "");
	for (const p of report.planChanges) {
		L.push(`- [msg ${p.index}] ${when(p.at)}: ${p.nodes} nós${p.added.length ? ` · +${p.added.join(", +")}` : ""}${p.removed.length ? ` · -${p.removed.join(", -")}` : ""}`);
	}
	if (report.planChanges.length === 0) L.push("Nenhum plano.");
	L.push("");

	if (options.transcript) L.push("## Transcrição", "", renderTranscript(record));
	return L.join("\n");
}

/** A readable transcript: the tutor's prose, every question with its tags,
 *  options and committed answer, the learner's answers, and the markers. */
export function renderTranscript(record: AuditRecord): string {
	const L: string[] = [];
	const results = new Map<string, ToolResult>();
	for (const m of record.messages) if (m.role === "toolResult") results.set(m.toolCallId, m);
	const failedOutputs = failedOutputCallIds(record.messages);
	record.messages.forEach((m, i) => {
		if (m.role === "user") {
			const content = typeof m.content === "string" ? m.content : m.content.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join(" ");
			L.push(`### [${i}] Aluno · ${when(m.timestamp)}`, "", content, "");
		} else if (m.role === "custom") {
			if (m.customType === "plan-block") return;
			L.push(`> [${i}] ${m.customType} · ${when(m.timestamp)}: ${clip(m.content.replace(/\s+/g, " "), 600)}`, "");
		} else if (m.role === "assistant") {
			const a = m as Assistant;
			const body: string[] = [];
			for (const block of a.content) {
				if (block.type === "text" && block.text.trim()) body.push(block.text.trim(), "");
				if (block.type !== "toolCall") continue;
				if (block.name === SEND_TO_USER_TOOL) {
					if (failedOutputs.has(block.id)) {
						body.push("*(send_to_user recusado)*", "");
					} else {
						const spoken = sendToUserText(block);
						if (spoken) body.push(spoken, "");
					}
					continue;
				}
				if (QUESTION_TOOL_NAMES.has(block.name)) {
					const args = healedQuestionArgs(block.arguments);
					const tags = ["type", "nodeId", "intent", "rung", "gap", "source", "purpose"].filter((k) => args[k] !== undefined).map((k) => `${k}=${String(args[k])}`).join(" ");
					body.push(`**→ ${block.name}**${tags ? ` \`${tags}\`` : ""}`, "", String(args.question ?? ""), "");
					if (str(args.details)) body.push(String(args.details), "");
					const rawOptions = Array.isArray(args.options) ? args.options : [];
					const options = rawOptions.map((o): { label?: unknown; value?: unknown; explanation?: unknown } => (o && typeof o === "object" ? o : { label: String(o ?? "") }));
					const graded = block.name === "quiz" || block.name === "probe";
					let correct: number[] = [];
					if (graded && options.length > 0) {
						try {
							const normalized = normalizeOptions(options.map((o) => ({ label: String(o.label ?? ""), value: typeof o.value === "string" ? o.value : undefined })));
							const commitment = typeof args.correctAnswer === "string" || (Array.isArray(args.correctAnswer) && args.correctAnswer.every((value) => typeof value === "string")) ? args.correctAnswer : undefined;
							correct = resolveCorrect(commitment, normalized).indices;
						} catch {
							// Malformed or duplicate-option rejected call — render raw options without crashing.
							correct = [];
						}
					}
					for (const [index, o] of options.entries()) {
						body.push(`- ${correct.includes(index + 1) ? "**(certa)** " : ""}${String(o.label ?? "")}`);
						// Each quiz option's own explanation (owner, 2026-11-27); older calls carry none.
						const why = graded ? str(o.explanation) : undefined;
						if (why) body.push(`  - Explicação da opção: ${why.replace(/\n/g, "\n    ")}`);
					}
					if (block.name === "explain" || block.name === "recall") body.push(`- Resposta comprometida: ${String(args.correctAnswer ?? "")}`);
					if (str(args.explanation)) body.push("", `Explicação comprometida: ${String(args.explanation)}`);
					const r = results.get(block.id);
					const d = (r?.details ?? null) as Record<string, unknown> | null;
					if (r?.isError) {
						body.push("", "Chamada recusada; a pergunta não foi apresentada ao aluno.", ...r.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text));
					} else if (d?.dismissed) {
						body.push("", "← **Aluno**: pergunta dispensada.");
					} else if (d) {
						const answers = Array.isArray(d.answers) ? (d.answers as Array<{ label?: unknown }>).map((x) => String(x.label ?? "")).join(" | ") : "";
						const verdict = d.dontKnow ? "" : typeof d.correct === "boolean" ? (d.correct ? "certo" : "errado") : "";
						body.push("", `← **Aluno** · ${when(r!.timestamp)}: ${d.dontKnow ? "NÃO SEI" : answers || String(d.text ?? d.other ?? "")}${verdict ? ` · ${verdict}` : ""}${typeof d.confidence === "number" ? ` · confiança ${d.confidence}%` : ""}`);
						const thinking = str(d.thinking) ?? str(d.note);
						if (thinking) body.push(`  - Raciocínio: ${thinking}`);
						if (typeof d.readingThinking === "string" && d.readingThinking.trim()) body.push(`  - Lendo: ${d.readingThinking.trim()}`);
					}
					body.push("");
				} else if (block.name !== "plan_init") {
					const args = (block.arguments ?? {}) as Record<string, unknown>;
					body.push(`*(${block.name}: ${clip(JSON.stringify(args), 300)})*`, "");
				} else {
					body.push(`*(plan_init)*`, "");
				}
			}
			if (body.length === 0 && a.stopReason === "stop") {
				body.push("*(turno encerrado sem texto adicional)*", "");
			}
			L.push(`### [${i}] Tutor · ${when(a.timestamp)}`, "", ...body);
		}
	});
	return L.join("\n");
}
