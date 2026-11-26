/**
 * The rigor doctrine's code (fork, docs/rigor.md): the audit tags and ask
 * purposes, the mixed quizzing mechanic, the new-class marker, proposed
 * courses, concept cards and the teaching audit.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import type { LhMessage } from "../src/core/native-messages.ts";

assert.equal(process.env.NODE_ENV, "test");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-rigor-"));
process.env.LH_DATA_DIR = path.join(scratch, "data");
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const { teachTagProblems, askPurposeProblems, TEACH_INTENTS } = await import("../src/core/question-core.ts");
const { quizMechanics, createTeacherTools, createProberTools, teachQuizToolFor, teachExplainToolFor, askUserQuestionTool } = await import("../src/agent/tools.ts");
const { composeQuizMechanics } = await import("../components/settings/agent-section.tsx");
const { sessionResumeFor, formatResumeGap, SESSION_RESUME_GAP_MS, needsContinuation, endsInDismissal, toLlmMessages } = await import("../src/core/native-messages.ts");
const { inputAppends } = await import("../src/core/input-events.ts");
const { projectView } = await import("../src/core/view.ts");
const { courseConsentOf, courseSeedText, newCourseSeedMessage, CREATE_COURSE_TOOL } = await import("../src/core/course.ts");
const { auditChat, renderAuditMarkdown, gapLedger } = await import("../src/core/teaching-audit.ts");
const { ankiCardDescription } = await import("../src/agent/tools/anki-card.ts");
const { parseAnkiSettings } = await import("../src/core/anki/settings.ts");
const { ankiCountsTowardLimit } = await import("../src/server/anki/tutor.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { jobStore } = await import("../src/store/jobs.ts");

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 10, 24, 20, 0, 0);

function assistant(id: string, at: number, calls: Array<{ id: string; name: string; args: Record<string, unknown> }>, text = "", stopReason = "toolUse"): LhMessage {
	return {
		id,
		role: "assistant",
		content: [
			...(text ? [{ type: "text" as const, text }] : []),
			...calls.map((c) => ({ type: "toolCall" as const, id: c.id, name: c.name, arguments: c.args })),
		],
		api: "faux",
		provider: "faux",
		model: "faux-model",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason,
		timestamp: at,
	} as unknown as LhMessage;
}

function answer(callId: string, tool: string, at: number, details: Record<string, unknown>): LhMessage {
	return {
		id: `r_${callId}`,
		role: "toolResult",
		toolCallId: callId,
		toolName: tool,
		content: [{ type: "text", text: JSON.stringify(details) }],
		details: { kind: tool === "ask_user_question" ? "ask" : tool === "explain" ? "explain" : "quiz", tool, questionText: "q", dontKnow: false, answers: [], answeredAt: new Date(at).toISOString(), ...details },
		isError: false,
		timestamp: at,
	} as unknown as LhMessage;
}

function user(id: string, at: number, text: string): LhMessage {
	return { id, role: "user", content: text, timestamp: at } as unknown as LhMessage;
}

const quiz = (extra: Record<string, unknown>) => ({
	type: "check",
	nodeId: "limits",
	question: "Which is even?",
	options: [{ label: "2", value: "a" }, { label: "3", value: "b" }],
	explanation: "2 is divisible by 2.",
	correctAnswer: "a",
	...extra,
});

describe("audit tags on teach questions (docs/rigor.md)", () => {
	it("intent is required, rung on checks, gap with repair, gaps are slugs", () => {
		assert.deepEqual(teachTagProblems({ type: "check", intent: "step", rung: 2 }), []);
		assert.deepEqual(teachTagProblems({ type: "predict", intent: "step" }), [], "a prediction needs no rung");
		assert.match(teachTagProblems({ type: "check", rung: 2 })[0]!, /intent is required/);
		assert.match(teachTagProblems({ type: "check", intent: "climb" })[0]!, /rung is required on checks/);
		assert.match(teachTagProblems({ type: "check", intent: "repair", rung: 1 })[0]!, /gap is required with intent repair/);
		assert.match(teachTagProblems({ type: "check", intent: "review", rung: 3, gap: "Not A Slug" })[0]!, /lowercase slug/);
		assert.deepEqual(teachTagProblems({ type: "check", intent: "repair", rung: 1, gap: "cancel-keeps-restriction" }), []);
		assert.deepEqual([...TEACH_INTENTS], ["step", "climb", "challenge", "repair", "review", "exam", "exercise", "detour"]);
	});

	it("the teach quiz and explain refuse a call without its tags, and accept a tagged one", async () => {
		const chat = chatStore.createChat("Rigor: tags");
		chatStore.saveTree(chat.id, { nodes: [{ id: "limits", title: "Limits" }], edges: [], version: 1 });
		const ctx = { chatId: chat.id, chatStore };
		const quizTool = teachQuizToolFor(ctx);
		const refused = await quizTool.execute("c1", quiz({}) as never, undefined as never);
		assert.equal((refused as { isError?: boolean }).isError, true);
		assert.match(JSON.stringify(refused.content), /intent is required/);
		const accepted = await quizTool.execute("c2", quiz({ intent: "climb", rung: 3 }) as never, undefined as never);
		assert.doesNotMatch(JSON.stringify(accepted.content), /required/);
		const explainTool = teachExplainToolFor(ctx);
		const noRung = await explainTool.execute("c3", { type: "check", nodeId: "limits", intent: "challenge", question: "Prove it.", correctAnswer: "Because…" } as never, undefined as never);
		assert.match(JSON.stringify(noRung.content), /rung is required/);
	});

	it("the description's example leads with type and nodeId, then the tags", () => {
		const chat = chatStore.createChat("Rigor: example");
		const desc = teachQuizToolFor({ chatId: chat.id, chatStore }).description;
		assert.match(desc, /```json\n\{\n {2}"type": "check",\n {2}"nodeId": "chain-rule",\n {2}"intent": "climb",\n {2}"rung": 3,/);
		assert.match(desc, /audit tags/);
	});
});

describe("ask purposes", () => {
	const opts = (...values: string[]) => values.map((value) => ({ label: value, value }));
	it("a purposeful ask offers exactly its fixed values, single choice", () => {
		assert.deepEqual(askPurposeProblems({ options: opts("a", "b") }), [], "no purpose, no rule");
		assert.deepEqual(askPurposeProblems({ purpose: "detour", options: opts("skip", "explore", "save") }), []);
		assert.deepEqual(askPurposeProblems({ purpose: "reading", options: opts("read-first", "direct") }), []);
		assert.deepEqual(askPurposeProblems({ purpose: "course", options: opts("create", "skip") }), []);
		assert.match(askPurposeProblems({ purpose: "course", options: opts("yes", "no") })[0]!, /create, skip/);
		assert.match(askPurposeProblems({ purpose: "detour", options: opts("explore", "save", "skip"), multiSelect: true })[0]!, /single choice/);
		assert.match(askPurposeProblems({ purpose: "nope" })[0]!, /purpose must be one of/);
	});
	it("ask_user_question refuses a purpose with the wrong values", async () => {
		const result = await askUserQuestionTool.execute("a1", { question: "Explore?", purpose: "detour", options: opts("yes", "no") } as never, undefined as never);
		assert.match(JSON.stringify(result.content), /explore, save, skip/);
	});
});

describe("the mixed quizzing mechanic (fork default)", () => {
	it("absent = mixed, false = multiple choice, true = free recall", () => {
		assert.equal(quizMechanics(undefined), "mixed");
		assert.equal(quizMechanics({}), "mixed");
		assert.equal(quizMechanics({ explain: false }), "choice");
		assert.equal(quizMechanics({ explain: true }), "free");
	});
	it("mixed arms both quizzing tools for the teacher and the prober", () => {
		const chat = chatStore.createChat("Rigor: mixed");
		const teacher = createTeacherTools({ chatId: chat.id, chatStore, jobStore, spawn: () => {} });
		assert.ok(teacher.quiz && teacher.explain);
		const choice = createTeacherTools({ chatId: chat.id, chatStore, jobStore, spawn: () => {} }, { explain: false });
		assert.ok(choice.quiz && !choice.explain);
		const prober = createProberTools({ chatId: chat.id, chatStore, deliver: () => {}, jobStore, spawn: () => {} });
		assert.ok(prober.probe && prober.recall);
	});
	it("the control's write: mixed removes the key, the others write it", () => {
		const before = { tools: { research: false, explain: true } };
		assert.deepEqual(composeQuizMechanics(before, "mixed").tools, { research: false });
		assert.deepEqual(composeQuizMechanics(before, "choice").tools, { research: false, explain: false });
		assert.deepEqual(composeQuizMechanics(undefined, "free").tools, { explain: true });
	});
});

describe("a new class after hours away (rule C3)", () => {
	const posed = assistant("a1", T0, [{ id: "q1", name: "quiz", args: quiz({ intent: "step", rung: 2 }) }]);
	it("formats the gap in hours, then days", () => {
		assert.equal(formatResumeGap(13 * HOUR + 10 * 60_000), "13 h");
		assert.equal(formatResumeGap(30 * 60_000), "1 h");
		assert.equal(formatResumeGap(72 * HOUR), "3 d");
	});
	it("only for teaching chats, after a class happened, past 3 hours", () => {
		assert.equal(sessionResumeFor({ messages: [posed] }, T0 + 2 * HOUR), null);
		assert.equal(sessionResumeFor({ messages: [posed], kind: "practice" }, T0 + 5 * HOUR), null);
		assert.equal(sessionResumeFor({ messages: [user("u", T0, "hi")] }, T0 + 5 * HOUR), null, "no tutor reply yet");
		const marker = sessionResumeFor({ messages: [posed] }, T0 + SESSION_RESUME_GAP_MS + 1);
		assert.ok(marker);
		assert.equal(marker!.customType, "session-resume");
		assert.match(marker!.content, /^\[Session context\] New class: the learner is back after 3 h away/);
	});
	it("an answer after the gap: result first, then the marker; the tail still owes the reply", () => {
		const record = { messages: [posed] };
		const original = Date.now;
		try {
			Date.now = () => T0 + 13 * HOUR;
			const appended = inputAppends(record, { type: "answer", toolCallId: "q1", answer: { kind: "quiz", questionText: "q", dontKnow: false, answers: [{ label: "2", value: "a", index: 1 }], answeredAt: new Date(T0 + 13 * HOUR).toISOString(), correct: true } } as never);
			assert.deepEqual(appended.map((m) => m.role === "custom" ? m.customType : m.role), ["toolResult", "session-resume"]);
			const after = [posed, ...appended];
			assert.equal(needsContinuation(after), needsContinuation([posed, appended[0]!]), "the marker is tail-transparent");
			assert.equal(endsInDismissal(after), false);
			const wire = toLlmMessages(after as never);
			assert.deepEqual(wire.map((m) => m.role), ["assistant", "toolResult", "user"], "the result stays right after its call");
			const view = projectView(after);
			assert.ok(view.some((m) => m.parts.some((p) => p.type === "data-session-resume")));
		} finally {
			Date.now = original;
		}
	});
	it("a text message after the gap: the marker comes first", () => {
		const done = assistant("a2", T0, [], "Done for today.", "stop");
		const original = Date.now;
		try {
			Date.now = () => T0 + 20 * HOUR;
			const appended = inputAppends({ messages: [done] }, { type: "text", text: "Back!" } as never);
			assert.deepEqual(appended.map((m) => m.role === "custom" ? m.customType : m.role), ["session-resume", "user"]);
		} finally {
			Date.now = original;
		}
	});
	it("sibling questions: no marker until the batch's last answer, measured from the question", () => {
		const two = assistant("a3", T0, [
			{ id: "s1", name: "quiz", args: quiz({ intent: "step", rung: 2 }) },
			{ id: "s2", name: "quiz", args: quiz({ intent: "step", rung: 2 }) },
		]);
		const original = Date.now;
		try {
			const ans = (id: string, at: number) => ({ type: "answer", toolCallId: id, answer: { kind: "quiz", questionText: "q", dontKnow: false, answers: [{ label: "2", value: "a", index: 1 }], answeredAt: new Date(at).toISOString(), correct: true } }) as never;
			Date.now = () => T0 + 10 * HOUR;
			const first = inputAppends({ messages: [two] }, ans("s1", T0 + 10 * HOUR));
			assert.deepEqual(first.map((m) => m.role), ["toolResult"]);
			Date.now = () => T0 + 10 * HOUR + 60_000;
			const second = inputAppends({ messages: [two, ...first] }, ans("s2", T0 + 10 * HOUR + 60_000));
			assert.deepEqual(second.map((m) => m.role === "custom" ? m.customType : m.role), ["toolResult", "session-resume"]);
		} finally {
			Date.now = original;
		}
	});
});

describe("proposed courses (rule R7)", () => {
	const proposal = (id: string, at: number) => assistant(id, at, [{ id: `ask_${id}`, name: "ask_user_question", args: { question: "New course?", purpose: "course", options: [{ label: "Criar", value: "create" }, { label: "Agora não", value: "skip" }] } }]);
	it("the latest course proposal decides, and one yes makes one course", () => {
		assert.equal(courseConsentOf([]).status, "none");
		const ask = proposal("p1", T0);
		assert.equal(courseConsentOf([ask]).status, "pending");
		const no = answer("ask_p1", "ask_user_question", T0 + 1000, { answers: [{ label: "Agora não", value: "skip", index: 2 }] });
		assert.equal(courseConsentOf([ask, no]).status, "declined");
		const yes = answer("ask_p1", "ask_user_question", T0 + 1000, { answers: [{ label: "Criar", value: "create", index: 1 }] });
		assert.equal(courseConsentOf([ask, yes]).status, "granted");
		const created = assistant("c1", T0 + 2000, [{ id: "cc1", name: CREATE_COURSE_TOOL, args: { title: "Real analysis" } }]);
		const createdResult = { id: "r_cc1", role: "toolResult", toolCallId: "cc1", toolName: CREATE_COURSE_TOOL, content: [{ type: "text", text: "ok" }], details: { ok: true }, isError: false, timestamp: T0 + 2001 } as unknown as LhMessage;
		assert.equal(courseConsentOf([ask, yes, created, createdResult]).status, "used");
	});
	it("the seed note carries the goal, the origin, the background and each book's file", () => {
		const details = {
			title: "Análise real",
			goal: "Provar os teoremas de limite com ε-δ",
			reason: "Surgiu na seção 2.4",
			timing: "after" as const,
			background: "Domina fatoração e limites informais",
			books: [
				{ title: "Calculus", author: "Michael Spivak", edition: "4th", level: "advanced", why: "Provas limpas", path: "D:\\Livros\\spivak.pdf" },
				{ title: "Understanding Analysis", author: "Stephen Abbott", level: "intermediate", why: "Motivação" },
			],
			origin: { chatId: "chat_x", title: "Calculus - Limits" },
		};
		const text = courseSeedText(details);
		assert.match(text, /^\[Session context\] This course was proposed in another course, “Calculus - Limits”/);
		assert.match(text, /Learner's file: D:\\Livros\\spivak\.pdf/);
		assert.match(text, /Understanding Analysis — Stephen Abbott \(intermediate\): Motivação The learner has no file of it yet\./);
		const marker = newCourseSeedMessage(details, T0);
		assert.equal(marker.customType, "course-seed");
		const view = projectView([marker]);
		assert.equal(view[0]!.parts[0]!.type, "data-course-seed");
	});
});

describe("concept cards (rule K1)", () => {
	it("on by default, parsed, described for the teacher only, outside the limit", () => {
		assert.equal(parseAnkiSettings({}).conceptCards, true);
		assert.equal(parseAnkiSettings({ conceptCards: false }).conceptCards, false);
		const triggers = { wrong: true, dontKnow: true, lowConfidence: true, practiceNotSolved: true, practiceHeavyHint: true };
		assert.match(ankiCardDescription({ phase: "teach", triggers, lowConfidenceMax: 30, conceptCards: true }), /reason "concept"/);
		assert.doesNotMatch(ankiCardDescription({ phase: "teach", triggers, lowConfidenceMax: 30, conceptCards: false }), /reason "concept"/);
		assert.doesNotMatch(ankiCardDescription({ phase: "practice", triggers, lowConfidenceMax: 30, conceptCards: true }), /reason "concept"/);
		assert.equal(ankiCountsTowardLimit({ status: "queued", kind: "concept" } as never), false);
		assert.equal(ankiCountsTowardLimit({ status: "queued", kind: "wrong" } as never), true);
	});
});

describe("the teaching audit", () => {
	const handoff = { id: "h", role: "custom", customType: "probe-handoff", content: "plan", display: true, details: {}, timestamp: T0 } as unknown as LhMessage;
	const plan = assistant("plan", T0 + 1000, [{ id: "pl", name: "plan_init", args: { mermaid: 'graph TD\nlimits["Limits"]\nlaws["Laws"]\nlimits --> laws' } }]);
	const planResult = { id: "r_pl", role: "toolResult", toolCallId: "pl", toolName: "plan_init", content: [{ type: "text", text: "{}" }], details: { ok: true }, isError: false, timestamp: T0 + 1001 } as unknown as LhMessage;
	const stall = assistant("stall", T0 + 2000, [], "We'll start with limits next.", "stop");
	const q1 = assistant("q1m", T0 + 3000, [{ id: "q1", name: "quiz", args: quiz({ intent: "step", rung: 2 }) }]);
	const a1 = answer("q1", "quiz", T0 + 4000, { correct: true, confidence: 100 });
	const q2 = assistant("q2m", T0 + 5000, [{ id: "q2", name: "quiz", args: quiz({ intent: "step", rung: 2 }) }]);
	const a2 = answer("q2", "quiz", T0 + 6000, { correct: false, confidence: 80 });
	const q3 = assistant("q3m", T0 + 7000, [{ id: "q3", name: "quiz", args: quiz({ intent: "repair", rung: 1, gap: "slope-is-a-ratio" }) }]);
	const a3 = answer("q3", "quiz", T0 + 8000, { correct: true, confidence: 90 });
	// A new class 13 h later that does not open with review, on the next node.
	const q4 = assistant("q4m", T0 + 9000, [{ id: "q4", name: "quiz", args: quiz({ nodeId: "laws", intent: "step", rung: 3 }) }]);
	const a4 = answer("q4", "quiz", T0 + 13 * HOUR, { correct: true, confidence: 100 });
	const q5 = assistant("q5m", T0 + 13 * HOUR + 1000, [{ id: "q5", name: "quiz", args: quiz({ nodeId: "laws", intent: "step", rung: 3 }) }]);
	const messages = [handoff, plan, planResult, stall, q1, a1, q2, a2, q3, a3, q4, a4, q5];
	const record = { id: "chat_audit", title: "Audit fixture", messages };

	it("finds the classes, the stall, the missed climb, the node left without a challenge and the unverified gap", () => {
		const report = auditChat(record);
		assert.equal(report.classes.length, 2);
		assert.equal(report.classes[1]!.gapBeforeMs! >= 3 * HOUR, true);
		const rules = report.flags.map((f) => f.rule);
		assert.ok(rules.includes("C7"), "the stalled turn");
		assert.ok(rules.includes("E3"), "a confident rung-2 success followed by rung 2");
		assert.ok(rules.includes("E7"), "limits left without a challenge");
		assert.ok(rules.includes("L4"), "the repaired gap never re-checked later");
		assert.equal(report.tagCoverage, 1);
		assert.deepEqual(gapLedger(report.questions).map((g) => [g.slug, g.repairs, g.verifiedLater]), [["slope-is-a-ratio", 1, false]]);
	});

	it("renders the report and the transcript in Portuguese", () => {
		const md = renderAuditMarkdown(auditChat(record), record, { transcript: true });
		assert.match(md, /^# Auditoria de ensino: Audit fixture/);
		assert.match(md, /## Alertas por regra/);
		assert.match(md, /\*\*C7\*\* \(1\)/);
		assert.match(md, /slope-is-a-ratio \| 1 \| 0 \| 1 \| 1 \| \*\*não\*\*/);
		assert.match(md, /## Transcrição/);
		assert.match(md, /intent=repair rung=1 gap=slope-is-a-ratio/);
	});

	it("a delayed free answer or dismissed answer is not evidence of a repaired gap", () => {
		const review = assistant("review", T0 + 14 * HOUR, [{ id: "review-gap", name: "explain", args: {
			type: "check", nodeId: "limits", intent: "review", rung: 3, gap: "slope-is-a-ratio", question: "Why?", correctAnswer: "A ratio.",
		} }]);
		const response = answer("review-gap", "explain", T0 + 14 * HOUR + 1000, { text: "Not necessarily correct." });
		const reviewed = auditChat({ ...record, messages: [...messages, review, response] });
		assert.equal(gapLedger(reviewed.questions)[0]!.verifiedLater, false);
		const last = reviewed.questions.at(-1)!;
		assert.equal(gapLedger([...reviewed.questions, { ...last, correct: true, dismissed: true }])[0]!.verifiedLater, false);
		assert.equal(gapLedger([...reviewed.questions, { ...last, correct: true }])[0]!.verifiedLater, true);
	});

	it("sibling answers and their resume marker open only one new class", () => {
		const posed = assistant("siblings", T0, [
			{ id: "s1", name: "quiz", args: quiz({ intent: "step", rung: 2 }) },
			{ id: "s2", name: "quiz", args: quiz({ intent: "step", rung: 2 }) },
		]);
		const first = answer("s1", "quiz", T0 + 13 * HOUR, { correct: true });
		const second = answer("s2", "quiz", T0 + 13 * HOUR + 1000, { correct: true });
		const marker = sessionResumeFor({ messages: [posed, first] }, second.timestamp, { skipTrailingResults: true })!;
		const report = auditChat({ ...record, messages: [posed, first, second, marker] });
		assert.equal(report.classes.length, 2);
		assert.equal(report.classes[1]!.marked, true);
		assert.equal(report.classes[1]!.gapBeforeMs, 13 * HOUR);
	});

	it("rejected tool calls do not count as questions or attempted repairs", () => {
		const rejected = { ...a3, isError: true } as LhMessage;
		const report = auditChat({ ...record, messages: [handoff, q3, rejected] });
		assert.equal(report.questions.length, 0);
		assert.equal(gapLedger(report.questions).length, 0);
	});

	it("the highest rung does not demand an impossible climb", () => {
		const top = (id: string, at: number) => assistant(id, at, [{ id, name: "quiz", args: quiz({ intent: "challenge", rung: 6 }) }]);
		const report = auditChat({ ...record, messages: [
			top("top1", T0), answer("top1", "quiz", T0 + 1000, { correct: true, confidence: 100 }),
			top("top2", T0 + 2000), answer("top2", "quiz", T0 + 3000, { correct: true, confidence: 100 }),
		] });
		assert.equal(report.flags.some((flag) => flag.rule === "E3"), false);
	});

	it("the transcript preserves commitments and distinguishes choices from ungraded asks", () => {
		const longAnswer = "Full derivation. ".repeat(60) + "Final conclusion.";
		const posed = assistant("transcript", T0, [
			{ id: "free", name: "explain", args: { question: "Prove it", correctAnswer: longAnswer, details: "Show every step." } },
			{ id: "choice", name: "quiz", args: { question: "Pick", options: [{ label: "2" }, { label: "3" }], correctAnswer: "2", explanation: "Because it is even." } },
			{ id: "ask", name: "ask_user_question", args: { question: "Preference?", options: [{ label: "Either" }] } },
		]);
		const record = { id: "transcript", title: "Transcript", messages: [posed] };
		const markdown = renderAuditMarkdown(auditChat(record), record, { transcript: true });
		assert.ok(markdown.includes(longAnswer));
		assert.match(markdown, /Show every step\./);
		assert.match(markdown, /Explicação comprometida: Because it is even\./);
		assert.equal(markdown.split("**(certa)**").length - 1, 1);
		assert.match(markdown, /\*\*\(certa\)\*\* 2/);
	});

	it("an untagged chat still gets the indicators that need no tags", () => {
		const untagged = messages.map((m) => {
			if (m.role !== "assistant") return m;
			return { ...m, content: m.content.map((b) => b.type === "toolCall" && b.name === "quiz" ? { ...b, arguments: { ...b.arguments, intent: undefined, rung: undefined, gap: undefined } } : b) } as LhMessage;
		});
		const report = auditChat({ ...record, messages: untagged });
		assert.equal(report.tagCoverage, 0);
		assert.deepEqual(report.flags.map((f) => f.rule), ["C7"]);
		assert.match(renderAuditMarkdown(report, { ...record, messages: untagged }), /sem dado/);
	});
});

describe("create_course on the server (rule R7)", async () => {
	const { createProposedCourse } = await import("../src/server/courses.ts");
	const { sourceDirectory } = await import("../src/server/source-organization.ts");
	const ask = assistant("pa", T0, [{ id: "ask_pa", name: "ask_user_question", args: { question: "New course?", purpose: "course", options: [{ label: "Criar", value: "create" }, { label: "Agora não", value: "skip" }] } }]);
	const yes = answer("ask_pa", "ask_user_question", T0 + 1000, { answers: [{ label: "Criar", value: "create", index: 1 }] });
	const pdf = path.join(scratch, "spivak.pdf");
	fs.writeFileSync(pdf, "%PDF-1.4 fixture");
	const input = {
		title: "Análise real",
		goal: "Provar os teoremas de limite",
		reason: "Surgiu na 2.4",
		timing: "after" as const,
		background: "Domina limites informais",
		books: [
			{ title: "Calculus", author: "Michael Spivak", level: "advanced", why: "Provas limpas", path: pdf },
			{ title: "Understanding Analysis", author: "Stephen Abbott", level: "intermediate", why: "Motivação" },
		],
	};

	it("refuses without the learner's create, and with an unreadable file", async () => {
		const origin = chatStore.createChat("Origin: refusals");
		chatStore.saveMessages(origin.id, [ask]);
		await assert.rejects(createProposedCourse(origin.id, input), /not answered the course proposal yet/);
		chatStore.saveMessages(origin.id, [ask, yes]);
		await assert.rejects(
			createProposedCourse(origin.id, { ...input, books: [{ ...input.books[0]!, path: path.join(scratch, "missing.pdf") }] }),
			/cannot be read, so no course was created/,
		);
	});

	it("creates the course in the suggested-courses folder with its seed note, once per yes", async () => {
		const origin = chatStore.createChat("Calculus - Limits");
		chatStore.saveMessages(origin.id, [ask, yes]);
		const created = await createProposedCourse(origin.id, input);
		assert.equal(created.ok, true);
		assert.deepEqual(created.withFiles, ["Calculus"]);
		assert.deepEqual(created.withoutFiles, ["Understanding Analysis"]);
		const record = chatStore.getChat(created.chatId)!;
		assert.equal(record.title, "Análise real");
		const seed = record.messages[0] as Extract<LhMessage, { role: "custom" }>;
		assert.equal(seed.customType, "course-seed");
		assert.match(seed.content, /proposed in another course, “Calculus - Limits”/);
		assert.match(seed.content, /Learner's file: .*spivak\.pdf/);
		const organization = sourceDirectory.read().organization;
		const folder = organization.folders.find((f) => f.name === created.folder && f.parentId === null);
		assert.ok(folder, "the folder exists at the root");
		assert.equal(organization.placements[created.chatId]?.folderId, folder!.id);
		// The tool's success consumes the yes.
		const call = assistant("cc", T0 + 2000, [{ id: "cc_ok", name: CREATE_COURSE_TOOL, args: input }]);
		const done = { id: "r_cc_ok", role: "toolResult", toolCallId: "cc_ok", toolName: CREATE_COURSE_TOOL, content: [{ type: "text", text: "ok" }], details: created, isError: false, timestamp: T0 + 2001 } as unknown as LhMessage;
		chatStore.saveMessages(origin.id, [ask, yes, call, done]);
		await assert.rejects(createProposedCourse(origin.id, input), /already created from the learner's latest yes/);
		// A second course reuses the same folder.
		const again = chatStore.createChat("Another origin");
		chatStore.saveMessages(again.id, [ask, yes]);
		const second = await createProposedCourse(again.id, { ...input, title: "Topologia" });
		assert.equal(sourceDirectory.read().organization.folders.filter((f) => f.name === second.folder).length, 1);
	});
});
