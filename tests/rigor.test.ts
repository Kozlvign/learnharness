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
import { Value } from "typebox/value";
import type { LhMessage } from "../src/core/native-messages.ts";

assert.equal(process.env.NODE_ENV, "test");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-rigor-"));
process.env.LH_DATA_DIR = path.join(scratch, "data");
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const { teachTagProblems, askPurposeProblems, TEACH_INTENTS, teachQuizInputObject, teachExplainInputObject } = await import("../src/core/question-core.ts");
const { quizMechanics, createTeacherTools, createProberTools, teachQuizToolFor, teachExplainToolFor, probeExplainTool, askUserQuestionTool, explainExampleBody, teachExampleTags } = await import("../src/agent/tools.ts");
const { CONVERSATION_TOOL_NAMES } = await import("../src/agent/teacher-agent.ts");
const { composeQuizMechanics } = await import("../components/settings/agent-section.tsx");
const { sessionResumeFor, formatResumeGap, SESSION_RESUME_GAP_MS, needsContinuation, endsInDismissal, toLlmMessages } = await import("../src/core/native-messages.ts");
const { inputAppends } = await import("../src/core/input-events.ts");
const { projectView } = await import("../src/core/view.ts");
const { courseConsentOf, courseSeedText, newCourseSeedMessage, CREATE_COURSE_TOOL } = await import("../src/core/course.ts");
const { auditChat, renderAuditMarkdown, gapLedger } = await import("../src/core/teaching-audit.ts");
const { ankiCardDescription } = await import("../src/agent/tools/anki-card.ts");
const { parseAnkiSettings } = await import("../src/core/anki/settings.ts");
const { ankiSameConcept } = await import("../src/core/anki/misses.ts");
const { ankiCountsTowardLimit, createTutorCard } = await import("../src/server/anki/tutor.ts");
const ankiStore = await import("../src/server/anki/store.ts");
const { saveLanguageSettings } = await import("../src/agent/language.ts");
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

function probeDone(at: number): LhMessage[] {
	return [
		assistant("pd_call", at, [{ id: "pd_1", name: "probe_done", args: { summary: "ready" } }]),
		{
			id: "r_pd_1",
			role: "toolResult",
			toolCallId: "pd_1",
			toolName: "probe_done",
			content: [{ type: "text", text: "ok" }],
			details: { ok: true },
			isError: false,
			timestamp: at + 1,
		} as unknown as LhMessage,
	];
}

const quiz = (extra: Record<string, unknown>) => ({
	type: "check",
	nodeId: "limits",
	question: "Which is even?",
	options: [{ label: "2", value: "a", explanation: "Divisible by 2." }, { label: "3", value: "b", explanation: "Leaves remainder 1." }],
	explanation: "2 is divisible by 2.",
	correctAnswer: "a",
	...extra,
});

describe("audit tags on teach questions (docs/rigor.md)", () => {
	it("intent is required, rung on checks, challenge needs check+rung 4-6, repair needs check+gap, gaps are slugs", () => {
		assert.deepEqual(teachTagProblems({ type: "check", intent: "step", rung: 2 }), []);
		assert.deepEqual(teachTagProblems({ type: "predict", intent: "step" }), [], "a prediction needs no rung");
		assert.match(teachTagProblems({ type: "check", rung: 2 })[0]!, /intent is required/);
		assert.match(teachTagProblems({ type: "check", intent: "climb" })[0]!, /rung is required on checks/);
		assert.match(teachTagProblems({ type: "predict", intent: "challenge" })[0]!, /intent challenge must use type "check"/);
		assert.match(teachTagProblems({ type: "check", intent: "challenge", rung: 2 })[0]!, /intent challenge needs rung 4–6/);
		assert.deepEqual(teachTagProblems({ type: "check", intent: "challenge", rung: 4 }), []);
		assert.match(teachTagProblems({ type: "predict", intent: "repair", gap: "x" })[0]!, /intent repair must use type "check"/);
		assert.match(teachTagProblems({ type: "check", intent: "repair", rung: 1 })[0]!, /gap is required with intent repair/);
		assert.match(teachTagProblems({ type: "check", intent: "review", rung: 3, gap: "Not A Slug" })[0]!, /lowercase slug/);
		assert.deepEqual(teachTagProblems({ type: "check", intent: "repair", rung: 1, gap: "cancel-keeps-restriction" }), []);
		assert.deepEqual([...TEACH_INTENTS], ["step", "climb", "challenge", "repair", "review", "exam", "exercise", "detour"]);
	});

	it("the teach quiz and explain schemas require intent upfront, and execute validates cross-field rules", async () => {
		const chat = chatStore.createChat("Rigor: tags");
		chatStore.saveTree(chat.id, { nodes: [{ id: "limits", title: "Limits" }], edges: [], version: 1 });
		const ctx = { chatId: chat.id, chatStore };
		const quizTool = teachQuizToolFor(ctx);
		assert.equal(Value.Check(teachQuizInputObject, quiz({})), false, "quiz JSON Schema requires intent");
		assert.equal(Value.Check(teachQuizInputObject, quiz({ intent: "climb", rung: 3 })), true);
		const refused = await quizTool.execute("c1", quiz({}) as never, undefined as never);
		assert.equal((refused as { isError?: boolean }).isError, true);
		assert.match(JSON.stringify(refused.content), /intent is required/);
		const accepted = await quizTool.execute("c2", quiz({ intent: "climb", rung: 3 }) as never, undefined as never);
		assert.doesNotMatch(JSON.stringify(accepted.content), /required/);
		const explainTool = teachExplainToolFor(ctx);
		assert.equal(
			Value.Check(teachExplainInputObject, { type: "check", nodeId: "limits", question: "Prove it.", correctAnswer: "Because…" }),
			false,
			"explain JSON Schema requires intent",
		);
		assert.equal(Value.Check(teachExplainInputObject, { ...teachExampleTags, ...explainExampleBody }), true);
		const noRung = await explainTool.execute("c3", { type: "check", nodeId: "limits", intent: "challenge", question: "Prove it.", correctAnswer: "Because…" } as never, undefined as never);
		assert.match(JSON.stringify(noRung.content), /rung is required/);
		const lowChallenge = await explainTool.execute("c4", { type: "check", nodeId: "limits", intent: "challenge", rung: 2, question: "Prove it.", correctAnswer: "Because…" } as never, undefined as never);
		assert.match(JSON.stringify(lowChallenge.content), /rung 4–6/);
	});

	it("both quiz and explain descriptions lead their JSON examples with type, nodeId, and audit tags, and builtins are reserved", () => {
		const chat = chatStore.createChat("Rigor: example");
		const quizDesc = teachQuizToolFor({ chatId: chat.id, chatStore }).description;
		assert.match(quizDesc, /```json\n\{\n {2}"type": "check",\n {2}"nodeId": "chain-rule",\n {2}"intent": "climb",\n {2}"rung": 3,/);
		assert.match(quizDesc, /audit tags/);
		const explainDesc = teachExplainToolFor({ chatId: chat.id, chatStore }).description;
		assert.match(explainDesc, /```json\n\{\n {2}"type": "check",\n {2}"nodeId": "chain-rule",\n {2}"intent": "climb",\n {2}"rung": 3,/);
		assert.ok(explainDesc.includes("a LaTeX backslash is \\\\ and a newline is \\n"));
		assert.ok(!probeExplainTool.description.includes("nodeId"), "probe recall example carries no phase metadata");
		assert.ok((CONVERSATION_TOOL_NAMES as readonly string[]).includes("create_course"));
		assert.ok((CONVERSATION_TOOL_NAMES as readonly string[]).includes("anki_card"));
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
	const probed = probeDone(T0 - 5000);
	const posed = assistant("a1", T0, [{ id: "q1", name: "quiz", args: quiz({ intent: "step", rung: 2 }) }]);
	it("formats the gap in hours, then days", () => {
		assert.equal(formatResumeGap(13 * HOUR + 10 * 60_000), "13 h");
		assert.equal(formatResumeGap(30 * 60_000), "1 h");
		assert.equal(formatResumeGap(72 * HOUR), "3 d");
	});
	it("only for teaching chats, after probing and a teacher reply, past 3 hours", () => {
		const duringProbe = assistant("p0", T0, [{ id: "pr1", name: "probe", args: quiz({}) }]);
		assert.equal(sessionResumeFor({ messages: [duringProbe] }, T0 + 5 * HOUR), null, "never during probe phase");
		assert.equal(sessionResumeFor({ messages: probed }, T0 + 5 * HOUR), null, "no teacher reply after probe_done yet");
		assert.equal(sessionResumeFor({ messages: [...probed, posed] }, T0 + 2 * HOUR), null);
		assert.equal(sessionResumeFor({ messages: [...probed, posed], kind: "practice" }, T0 + 5 * HOUR), null);
		assert.equal(sessionResumeFor({ messages: [user("u", T0, "hi")] }, T0 + 5 * HOUR), null, "no tutor reply yet");
		const marker = sessionResumeFor({ messages: [...probed, posed] }, T0 + SESSION_RESUME_GAP_MS + 1);
		assert.ok(marker);
		assert.equal(marker!.customType, "session-resume");
		assert.match(marker!.content, /^\[Session context\] New class: the learner is back after 3 h away/);
	});
	it("an answer after the gap: result first, then the marker; the tail still owes the reply", () => {
		const record = { messages: [...probed, posed] };
		const original = Date.now;
		try {
			Date.now = () => T0 + 13 * HOUR;
			const appended = inputAppends(record, { type: "answer", toolCallId: "q1", answer: { kind: "quiz", questionText: "q", dontKnow: false, answers: [{ label: "2", value: "a", index: 1 }], answeredAt: new Date(T0 + 13 * HOUR).toISOString(), correct: true } } as never);
			assert.deepEqual(appended.map((m) => m.role === "custom" ? m.customType : m.role), ["toolResult", "session-resume"]);
			const after = [...probed, posed, ...appended];
			assert.equal(needsContinuation(after), needsContinuation([...probed, posed, appended[0]!]), "the marker is tail-transparent");
			assert.equal(endsInDismissal(after), false);
			const wire = toLlmMessages(after as never);
			assert.deepEqual(wire.slice(-3).map((m) => m.role), ["assistant", "toolResult", "user"], "the result stays right after its call");
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
			const appended = inputAppends({ messages: [...probed, done] }, { type: "text", text: "Back!" } as never);
			assert.deepEqual(appended.map((m) => m.role === "custom" ? m.customType : m.role), ["session-resume", "user"]);
		} finally {
			Date.now = original;
		}
	});
	it("dismissing a stale pending question right before typing preserves the away gap", () => {
		const dismissed = answer("q1", "quiz", T0 + 10 * HOUR, { dismissed: true });
		const original = Date.now;
		try {
			Date.now = () => T0 + 10 * HOUR + 5_000;
			const appended = inputAppends({ messages: [...probed, posed, dismissed] }, { type: "text", text: "Voltei!" } as never);
			const resume = appended.find((m) => m.role === "custom" && m.customType === "session-resume") as Extract<LhMessage, { role: "custom" }> | undefined;
			assert.ok(resume, "expected session-resume after dismissing a stale question");
			assert.equal(((resume!.details as { gapMs?: number }).gapMs ?? 0) >= 10 * HOUR, true);
			assert.equal(appended.at(-1)?.role, "user");
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
			const first = inputAppends({ messages: [...probed, two] }, ans("s1", T0 + 10 * HOUR));
			assert.deepEqual(first.map((m) => m.role), ["toolResult"]);
			Date.now = () => T0 + 10 * HOUR + 60_000;
			const second = inputAppends({ messages: [...probed, two, ...first] }, ans("s2", T0 + 10 * HOUR + 60_000));
			assert.deepEqual(second.map((m) => m.role === "custom" ? m.customType : m.role), ["toolResult", "session-resume"]);
		} finally {
			Date.now = original;
		}
	});
	it("mixed builtin+plugin sibling batch: plugin answers first, then the final builtin answer emits one marker measured from the question", () => {
		const occurrence = { messageId: "a4", contentIndex: 1, toolCallId: "p1", toolName: "plugin_code" };
		const mixed = {
			...assistant("a4", T0, [
				{ id: "b1", name: "quiz", args: quiz({ intent: "step", rung: 2 }) },
				{ id: "p1", name: "plugin_code", args: { type: "check", nodeId: "limits", question: "Write code", payload: {} } },
			]),
			lhQuestions: {
				"1": {
					protocolVersion: 1,
					pluginId: "fixture",
					typeId: "code",
					label: "Code",
					variant: "teach",
					questionId: "pq1",
					occurrence,
					contractVersion: 1,
					input: { type: "check", nodeId: "limits", question: "Write code", payload: {} },
					questionSchema: { type: "object", properties: {} },
					answerSchema: { type: "string" },
					showThinking: false,
					requiresAnswerRefinement: false,
				},
			},
		} as unknown as LhMessage;
		const pluginAnswered = {
			id: "r_p1",
			role: "toolResult",
			toolCallId: "p1",
			toolName: "plugin_code",
			content: [{ type: "text", text: "ok" }],
			lhQuestionOccurrence: occurrence,
			details: {
				kind: "plugin-question",
				pluginId: "fixture",
				typeId: "code",
				questionId: "pq1",
				contractVersion: 1,
				answer: "print(1)",
				answeredAt: new Date(T0 + 10 * HOUR).toISOString(),
			},
			isError: false,
			timestamp: T0 + 10 * HOUR,
		} as unknown as LhMessage;
		const original = Date.now;
		try {
			Date.now = () => T0 + 10 * HOUR;
			assert.throws(
				() => inputAppends({ messages: [...probed, mixed] }, {
					type: "answer",
					toolCallId: "b1",
					answer: { kind: "quiz", questionText: "q", dontKnow: false, answers: [{ label: "2", value: "a", index: 1 }], answeredAt: new Date(T0 + 10 * HOUR).toISOString(), correct: true },
				} as never),
				/pending plugin question first/,
			);
			Date.now = () => T0 + 10 * HOUR + 60_000;
			const finalAppended = inputAppends({ messages: [...probed, mixed, pluginAnswered] }, {
				type: "answer",
				toolCallId: "b1",
				answer: { kind: "quiz", questionText: "q", dontKnow: false, answers: [{ label: "2", value: "a", index: 1 }], answeredAt: new Date(T0 + 10 * HOUR + 60_000).toISOString(), correct: true },
			} as never);
			assert.deepEqual(finalAppended.map((m) => m.role === "custom" ? m.customType : m.role), ["toolResult", "session-resume"]);
			assert.equal(((finalAppended[1] as Extract<LhMessage, { role: "custom" }>).details as { gapMs?: number }).gapMs, 10 * HOUR + 60_000);
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
		const other = answer("ask_p1", "ask_user_question", T0 + 1000, { answers: [], other: "Pode criar, mas só depois do capítulo 3" });
		assert.deepEqual(courseConsentOf([ask, other]), { status: "declined", askCallId: "ask_p1", answeredOther: true });
		const encodedAsk = assistant("pe", T0, [{ id: "ask_pe", name: "ask_user_question", args: { question: "New course?", purpose: '"course"', options: [{ label: "Criar", value: "create" }, { label: "Agora não", value: "skip" }] } }]);
		const encodedYes = answer("ask_pe", "ask_user_question", T0 + 1000, { answers: [{ label: "Criar", value: "create", index: 1 }] });
		assert.equal(courseConsentOf([encodedAsk, encodedYes]).status, "granted");
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

	it("deduplicates concept cards within a course without colliding distinct concepts", async () => {
		assert.equal(
			ankiSameConcept(
				{ front: "Qual é a **definição** de continuidade em $a$?", back: "$\\lim_{x \\to a} f(x) = f(a)$" },
				{ front: "Qual a definicao de continuidade em a?", back: "Outra redação" },
			),
			true,
		);
		assert.equal(
			ankiSameConcept(
				{ front: "Definição de limite", back: "Aproximação bilateral." },
				{ front: "Definição de limite lateral", back: "Aproximação por um lado apenas." },
			),
			false,
		);
		assert.equal(
			ankiSameConcept(
				{ front: "Enuncie o Teorema do Confronto", back: "Se g(x) <= f(x) <= h(x) e g, h tendem a L, então f tende a L." },
				{ front: "Qual é o critério do sanduíche?", back: "Se $g(x) <= f(x) <= h(x)$ e $g, h$ tendem a $L$, então $f$ tende a $L$." },
			),
			true,
		);

		const chat = chatStore.createChat("Anki concept dedup");
		ankiStore.saveAnkiSettings(parseAnkiSettings({ enabled: true, conceptCards: true }));
		const first = await createTutorCard(
			chat.id,
			"teach",
			{
				reason: "concept",
				front: "Qual é a definição de continuidade em $a$?",
				back: "$\\lim_{x \\to a} f(x) = f(a)$.",
				why: "Exige existência do limite, de f(a) e igualdade.",
				pitfall: "",
			},
			"anki_c1",
		);
		assert.equal(first.details.ok, true);

		const dup = await createTutorCard(
			chat.id,
			"teach",
			{
				reason: "concept",
				front: "Qual a definicao de continuidade em a?",
				back: "f(a) coincide com o limite.",
				why: "",
				pitfall: "",
			},
			"anki_c2",
		);
		assert.equal(dup.details.ok, false);
		assert.match(dup.text, /This concept already has a card/);

		const second = await createTutorCard(
			chat.id,
			"teach",
			{
				reason: "concept",
				front: "O que diz o Teorema do Valor Intermediário?",
				back: "Uma função contínua em [a, b] assume todo valor entre f(a) e f(b).",
				why: "",
				pitfall: "",
			},
			"anki_c3",
		);
		assert.equal(second.details.ok, true);
		assert.match(second.text, /Central concepts already carded in this course/);
		assert.match(second.text, /continuidade/);

		// A concept card the learner removed is not recreated.
		await ankiStore.updateAnkiLedger((ledger) => {
			const c = ledger.cards.find((card) => card.toolCallId === "anki_c3");
			if (c) c.status = "removed";
		});
		const removedDup = await createTutorCard(
			chat.id,
			"teach",
			{
				reason: "concept",
				front: "O que diz o Teorema do Valor Intermediário?",
				back: "Qualquer valor intermediário é atingido.",
				why: "",
				pitfall: "",
			},
			"anki_c4",
		);
		assert.equal(removedDup.details.ok, false);
		assert.match(removedDup.text, /learner removed its card/);
	});
});

describe("the teaching audit", () => {
	const handoff = { id: "h", role: "custom", customType: "probe-handoff", content: "plan", display: true, details: {}, timestamp: T0 } as unknown as LhMessage;
	const plan = assistant("plan", T0 + 1000, [{ id: "pl", name: "plan_init", args: { mermaid: 'graph TD\nlimits["Limits"]\nlaws["Laws"]\nlimits --> laws' } }]);
	const planResult = { id: "r_pl", role: "toolResult", toolCallId: "pl", toolName: "plan_init", content: [{ type: "text", text: "{}" }], details: { ok: true }, isError: false, timestamp: T0 + 1001 } as unknown as LhMessage;
	const planPresented = assistant("plan_pres", T0 + 1500, [], "Aqui está o plano do curso. Podemos começar?", "stop");
	const planAccepted = user("u_acc", T0 + 1800, "Pode começar.");
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
	const messages = [handoff, plan, planResult, planPresented, planAccepted, stall, q1, a1, q2, a2, q3, a3, q4, a4, q5];
	const record = { id: "chat_audit", title: "Audit fixture", messages };

	it("finds the classes, the stall (ignoring plan presentation), the missed climb, the node left without a challenge and the unverified gap", () => {
		const report = auditChat(record);
		assert.equal(report.classes.length, 2);
		assert.equal(report.classes[1]!.gapBeforeMs! >= 3 * HOUR, true);
		const rules = report.flags.map((f) => f.rule);
		assert.equal(report.flags.filter((f) => f.rule === "C7").length, 1, "plan presentation is not flagged; only the post-acceptance stall is");
		assert.ok(rules.includes("E3"), "a confident rung-2 success followed by rung 2");
		assert.ok(rules.includes("E7"), "limits left without a challenge");
		assert.ok(rules.includes("L4"), "the repaired gap never re-checked later");
		assert.equal(report.tagCoverage, 1);
		assert.deepEqual(gapLedger(report.questions).map((g) => [g.slug, g.repairs, g.verifiedLater, g.freeChecksLater]), [["slope-is-a-ratio", 1, false, 0]]);
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

	it("a delayed free answer or dismissed answer is not evidence of a repaired gap, and free checks are distinguished in the table", () => {
		const review = assistant("review", T0 + 14 * HOUR, [{ id: "review-gap", name: "explain", args: {
			type: "check", nodeId: "limits", intent: "review", rung: 3, gap: "slope-is-a-ratio", question: "Why?", correctAnswer: "A ratio.",
		} }]);
		const response = answer("review-gap", "explain", T0 + 14 * HOUR + 1000, { text: "Not necessarily correct." });
		const extended = { ...record, messages: [...messages, review, response] };
		const reviewed = auditChat(extended);
		assert.equal(gapLedger(reviewed.questions)[0]!.verifiedLater, false);
		assert.equal(gapLedger(reviewed.questions)[0]!.freeChecksLater, 1);
		const md = renderAuditMarkdown(reviewed, extended);
		assert.match(md, /slope-is-a-ratio \| 1 \| 0 \| 1 \| 2 \| resposta livre \(conferir\)/);
		const last = reviewed.questions.at(-1)!;
		assert.equal(gapLedger([...reviewed.questions, { ...last, correct: true, dismissed: true }])[0]!.verifiedLater, false);
		assert.equal(gapLedger([...reviewed.questions, { ...last, correct: true }])[0]!.verifiedLater, true);
	});

	it("L4 does not prematurely flag a gap repaired in the latest class", () => {
		const singleClass = { id: "single", title: "Single class", messages: [handoff, plan, planResult, q2, a2, q3, a3] };
		const report = auditChat(singleClass);
		assert.equal(report.flags.some((f) => f.rule === "L4"), false);
		assert.match(renderAuditMarkdown(report, singleClass), /slope-is-a-ratio \| 1 \| 0 \| 1 \| 1 \| aguardando aula posterior/);
	});

	it("sibling answers and their resume marker open only one new class", () => {
		const probed = probeDone(T0 - 5000);
		const posed = assistant("siblings", T0, [
			{ id: "s1", name: "quiz", args: quiz({ intent: "step", rung: 2 }) },
			{ id: "s2", name: "quiz", args: quiz({ intent: "step", rung: 2 }) },
		]);
		const first = answer("s1", "quiz", T0 + 13 * HOUR, { correct: true });
		const second = answer("s2", "quiz", T0 + 13 * HOUR + 1000, { correct: true });
		const marker = sessionResumeFor({ messages: [...probed, posed, first] }, second.timestamp, { skipTrailingResults: true })!;
		const report = auditChat({ ...record, messages: [posed, first, second, marker] });
		assert.equal(report.classes.length, 2);
		assert.equal(report.classes[1]!.marked, true);
		assert.equal(report.classes[1]!.gapBeforeMs, 13 * HOUR);
	});

	it("supports Claude send_to_user in transcripts and C7 previews, and ignores Claude pre-teaching plan presentation", () => {
		const longProse = "Explicação detalhada do teorema fundamental. ".repeat(15) + "Conclusão final.";
		const sendResult = (id: string, at: number, isError = false) => ({
			id: `r_${id}`,
			role: "toolResult",
			toolCallId: id,
			toolName: "send_to_user",
			content: [{ type: "text", text: isError ? "failed" : "sent" }],
			details: {},
			isError,
			timestamp: at,
		} as unknown as LhMessage);
		const claudePlanSend = assistant("cp_send", T0 + 1200, [{ id: "su_plan", name: "send_to_user", args: { message: "Apresentando o plano." } }]);
		const claudePlanClose = assistant("cp_close", T0 + 1300, [], "", "stop");
		const claudeStallSend = assistant("cs_send", T0 + 4500, [
			{ id: "su_bad", name: "send_to_user", args: { message: "Erro descartado." } },
			{ id: "su_ok", name: "send_to_user", args: { message: longProse } },
		]);
		const claudeStallClose = assistant("cs_close", T0 + 4600, [], "", "stop");
		const claudeRecord = {
			id: "claude_audit",
			title: "Claude chat",
			messages: [
				handoff,
				plan,
				planResult,
				claudePlanSend,
				sendResult("su_plan", T0 + 1250),
				claudePlanClose,
				planAccepted,
				q1,
				a1,
				claudeStallSend,
				sendResult("su_bad", T0 + 4510, true),
				sendResult("su_ok", T0 + 4520, false),
				claudeStallClose,
			],
		};
		const report = auditChat(claudeRecord);
		const c7 = report.flags.filter((f) => f.rule === "C7");
		assert.equal(c7.length, 1, "Claude plan_init + send_to_user presentation is not flagged; post-teach stall is");
		assert.match(c7[0]!.message, /Explicação detalhada do teorema fundamental\./);
		assert.doesNotMatch(c7[0]!.message, /Erro descartado/);
		const md = renderAuditMarkdown(report, claudeRecord, { transcript: true });
		assert.ok(md.includes(longProse), "full send_to_user prose appears without 300-char JSON clipping");
		assert.doesNotMatch(md, /\*\(send_to_user:/);
		assert.match(md, /\*\(send_to_user recusado\)\*/);
		assert.match(md, /\*\(turno encerrado sem texto adicional\)\*/);
	});

	it("never crashes renderTranscript on rejected duplicate-option quiz calls", () => {
		const badCall = assistant("bad_q", T0 + 1000, [{
			id: "bq1",
			name: "quiz",
			args: {
				type: "check",
				nodeId: "limits",
				intent: "step",
				rung: 2,
				question: "Dupes?",
				options: [{ label: "2", value: "dup" }, { label: "3", value: "dup" }],
				correctAnswer: "dup",
			},
		}]);
		const badResult = {
			id: "r_bq1",
			role: "toolResult",
			toolCallId: "bq1",
			toolName: "quiz",
			content: [{ type: "text", text: "Two options resolve to the same value" }],
			details: {},
			isError: true,
			timestamp: T0 + 1001,
		} as unknown as LhMessage;
		const badRecord = { id: "bad_opt", title: "Bad options", messages: [handoff, badCall, badResult] };
		const md = renderAuditMarkdown(auditChat(badRecord), badRecord, { transcript: true });
		assert.match(md, /Chamada recusada; a pergunta não foi apresentada ao aluno\./);
		assert.match(md, /- 2\n- 3/);
	});

	it("heals raw JSON-encoded question args and defaults legacy untyped teach questions to check", () => {
		const healedCall = assistant("heal_q", T0 + 1000, [{
			id: "hq1",
			name: "quiz",
			args: {
				type: '"check"',
				nodeId: "limits",
				intent: '"climb"',
				rung: "3",
				question: "Even?",
				options: '[{"label":"2","value":"a"},{"label":"3","value":"b"}]',
				correctAnswer: "a",
			},
		}]);
		const legacyCall = assistant("leg_q", T0 + 2000, [{
			id: "lq1",
			name: "quiz",
			args: {
				nodeId: "limits",
				question: "Legacy?",
				options: [{ label: "Yes", value: "y" }, { label: "No", value: "n" }],
				correctAnswer: "y",
			},
		}]);
		const rec = {
			id: "heal_rec",
			title: "Heal",
			messages: [
				handoff,
				healedCall,
				answer("hq1", "quiz", T0 + 1500, { correct: true, confidence: 90 }),
				legacyCall,
				answer("lq1", "quiz", T0 + 2500, { correct: true, confidence: 90 }),
			],
		};
		const report = auditChat(rec);
		assert.equal(report.questions[0]!.type, "check");
		assert.equal(report.questions[0]!.intent, "climb");
		assert.equal(report.questions[0]!.rung, 3);
		assert.equal(report.questions[1]!.type, "check");
		const md = renderAuditMarkdown(report, rec, { transcript: true });
		assert.match(md, /type=check nodeId=limits intent=climb rung=3/);
		assert.match(md, /\*\*\(certa\)\*\* 2/);
	});

	it("reads canonical plan_init tree details first and ignores Mermaid comments in fallback", () => {
		const canonicalPlan = assistant("p_can", T0 + 1000, [{ id: "pc", name: "plan_init", args: { mermaid: "graph TD\nfoo --> bar" } }]);
		const canonicalRes = {
			id: "r_pc",
			role: "toolResult",
			toolCallId: "pc",
			toolName: "plan_init",
			content: [{ type: "text", text: "{}" }],
			details: { ok: true, tree: { nodes: [{ id: "limits", title: "Limites (intuição)" }, { id: "eps", title: "Opcional: Épsilon-delta" }], edges: [], version: 1 } },
			isError: false,
			timestamp: T0 + 1001,
		} as unknown as LhMessage;
		const r1 = auditChat({ id: "can", title: "Canonical", messages: [handoff, canonicalPlan, canonicalRes] });
		assert.deepEqual(r1.nodeTitles, { limits: "Limites (intuição)", eps: "Opcional: Épsilon-delta" });

		const fallbackPlan = assistant("p_fb", T0 + 1000, [{
			id: "pf",
			name: "plan_init",
			args: { mermaid: '%% comment-with-dash\ngraph TD\nintro(Introdução)\nopt["Opcional: Provas (extra)"]\nintro --> opt' },
		}]);
		const fallbackRes = {
			id: "r_pf",
			role: "toolResult",
			toolCallId: "pf",
			toolName: "plan_init",
			content: [{ type: "text", text: "{}" }],
			details: { ok: true },
			isError: false,
			timestamp: T0 + 1001,
		} as unknown as LhMessage;
		const r2 = auditChat({ id: "fb", title: "Fallback", messages: [handoff, fallbackPlan, fallbackRes] });
		assert.deepEqual(r2.nodeTitles, { intro: "Introdução", opt: "Opcional: Provas (extra)" });
	});

	it("E3 ignores predictions, same-message siblings, cross-class checks, and exercise/exam follow-ups", () => {
		const batch = assistant("b1", T0 + 1000, [
			{ id: "b1a", name: "quiz", args: quiz({ intent: "step", rung: 2 }) },
			{ id: "b1b", name: "quiz", args: quiz({ intent: "step", rung: 2 }) },
		]);
		const pred = assistant("pr", T0 + 2000, [{ id: "pr1", name: "quiz", args: quiz({ type: "predict", intent: "step", rung: 1 }) }]);
		const ex = assistant("ex", T0 + 3000, [{ id: "ex1", name: "quiz", args: quiz({ intent: "exercise", rung: 2 }) }]);
		const exam = assistant("xm", T0 + 4000, [{ id: "xm1", name: "quiz", args: quiz({ intent: "exam", rung: 2 }) }]);
		const nextClassUser = user("u_next", T0 + 10 * HOUR, "Voltei");
		const nextClassCheck = assistant("nc", T0 + 10 * HOUR + 1000, [{ id: "nc1", name: "quiz", args: quiz({ intent: "step", rung: 2 }) }]);
		const report = auditChat({
			id: "e3_clean",
			title: "E3 precision",
			messages: [
				handoff,
				batch,
				answer("b1a", "quiz", T0 + 1100, { correct: true, confidence: 100 }),
				answer("b1b", "quiz", T0 + 1200, { correct: true, confidence: 100 }),
				pred,
				answer("pr1", "quiz", T0 + 2100, { correct: true, confidence: 100 }),
				ex,
				answer("ex1", "quiz", T0 + 3100, { correct: true, confidence: 100 }),
				exam,
				answer("xm1", "quiz", T0 + 4100, { correct: true, confidence: 100 }),
				nextClassUser,
				nextClassCheck,
				answer("nc1", "quiz", T0 + 10 * HOUR + 2000, { correct: true, confidence: 100 }),
			],
		});
		assert.equal(report.flags.some((f) => f.rule === "E3"), false);
	});

	it("E8 ignores same-message parallel siblings and next-class C3 review openings", () => {
		const batch = assistant("e8b", T0 + 1000, [
			{ id: "e8a", name: "quiz", args: quiz({ intent: "step", rung: 2 }) },
			{ id: "e8s", name: "quiz", args: quiz({ intent: "step", rung: 2 }) },
		]);
		const rep = assistant("e8r", T0 + 2000, [{ id: "e8r1", name: "quiz", args: quiz({ intent: "repair", rung: 1, gap: "parity" }) }]);
		const nextClassUser = user("u_e8", T0 + 10 * HOUR, "Voltei");
		const rev = assistant("e8rev", T0 + 10 * HOUR + 1000, [{ id: "e8rev1", name: "quiz", args: quiz({ intent: "review", rung: 2, gap: "parity" }) }]);
		const report = auditChat({
			id: "e8_clean",
			title: "E8 precision",
			messages: [
				handoff,
				batch,
				answer("e8a", "quiz", T0 + 1100, { correct: false, confidence: 80 }),
				answer("e8s", "quiz", T0 + 1200, { correct: true, confidence: 100 }),
				rep,
				answer("e8r1", "quiz", T0 + 2100, { correct: false, confidence: 50 }),
				nextClassUser,
				rev,
				answer("e8rev1", "quiz", T0 + 10 * HOUR + 2000, { correct: true, confidence: 90 }),
			],
		});
		assert.equal(report.flags.some((f) => f.rule === "E8"), false);
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

	it("the transcript keeps each quiz option's own explanation under it; older calls render as before", () => {
		const posed = assistant("option_whys", T0, [
			{ id: "whys", name: "quiz", args: quiz({ intent: "climb", rung: 3, options: [
				{ label: "2", value: "a", explanation: "Divisible by 2." },
				{ label: "3", value: "b", explanation: "Leaves remainder 1\nwhen halved." },
			] }) },
			{ id: "legacy", name: "probe", args: { question: "Pick", options: [{ label: "x" }, { label: "y" }], correctAnswer: "x", explanation: "Because." } },
		]);
		const record = { id: "option_whys", title: "Option whys", messages: [posed] };
		const markdown = renderAuditMarkdown(auditChat(record), record, { transcript: true });
		assert.ok(markdown.includes("- **(certa)** 2\n  - Explicação da opção: Divisible by 2.\n- 3\n  - Explicação da opção: Leaves remainder 1\n    when halved."));
		assert.ok(markdown.includes("- **(certa)** x\n- y\n"));
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

	it("refuses without the learner's create, explains Other refusals, and does not consume consent on unreadable files", async () => {
		const origin = chatStore.createChat("Origin: refusals");
		chatStore.saveMessages(origin.id, [ask]);
		await assert.rejects(createProposedCourse(origin.id, input), /not answered the course proposal yet/);
		const other = answer("ask_pa", "ask_user_question", T0 + 1000, { answers: [], other: "Só se tiver Spivak" });
		chatStore.saveMessages(origin.id, [ask, other]);
		await assert.rejects(createProposedCourse(origin.id, input), /answered via "Other" instead of choosing create/);
		chatStore.saveMessages(origin.id, [ask, yes]);
		await assert.rejects(
			createProposedCourse(origin.id, { ...input, books: [{ ...input.books[0]!, path: path.join(scratch, "missing.pdf") }] }),
			/cannot be read, so no course was created/,
		);
		// A failed path check leaves the learner's consent intact for a corrected retry.
		const retried = await createProposedCourse(origin.id, input);
		assert.equal(retried.ok, true);
	});

	it("unwraps backtick- and quote-wrapped book paths and prevents intra-turn duplicate courses", async () => {
		const origin = chatStore.createChat("Origin: quotes and intra-turn");
		chatStore.saveMessages(origin.id, [ask, yes]);
		const backtickPath = `\`${pdf}\``;
		const doubleQuotedPath = `"${pdf}"`;
		const created = await createProposedCourse(origin.id, {
			...input,
			books: [
				{ ...input.books[0]!, path: backtickPath },
				{ ...input.books[1]!, title: "Quoted copy", path: doubleQuotedPath },
			],
		});
		assert.equal(created.ok, true);
		assert.deepEqual(created.withFiles, ["Calculus", "Quoted copy"]);
		// Even before the first toolResult is persisted back to chatStore (same turn),
		// a second call against the same yes must be refused.
		await assert.rejects(createProposedCourse(origin.id, input), /already created from the learner's latest yes/);
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
		// A second course reuses the same folder — even after switching UI language.
		saveLanguageSettings({ ui: "pt-BR", tutor: "app" });
		try {
			const again = chatStore.createChat("Another origin");
			chatStore.saveMessages(again.id, [ask, yes]);
			const second = await createProposedCourse(again.id, { ...input, title: "Topologia" });
			assert.equal(second.folder, created.folder, "reuses the existing localized suggested-courses folder");
			const rootFolders = sourceDirectory.read().organization.folders.filter((f) => f.parentId === null);
			assert.equal(rootFolders.filter((f) => f.name === "Suggested courses" || f.name === "Cadeiras sugeridas").length, 1);
		} finally {
			saveLanguageSettings({ ui: "en", tutor: "app" });
		}
	});
});
