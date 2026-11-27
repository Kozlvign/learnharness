/**
 * Session titles chosen by the tutor (fork, docs/session-titles.md): who set
 * a title (including records from before the field), the title check, the
 * rename_session tool and the learner's sovereignty over their own title,
 * the milestone gates (probe_done, plan_init, problem — also when the rename
 * rides the same batch), the store's events and the silent transcript.
 * Runs under an isolated LH_DATA_DIR: every app-module import is dynamic.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";

// ── the seam, BEFORE any config-loading import ──────────────────────────────
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-session-title-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { chatStore } = await import("../src/store/chats.ts");
const { subscribe } = await import("../src/core/events.ts");
const { titleFromPrompt, TITLE_MAX_CHARS } = await import("../src/core/contracts.ts");
const {
	effectiveTitleSource, needsSessionTitle, validateSessionTitle, sessionTitleContextNote, RENAME_SESSION_TOOL, SESSION_TITLE_REQUIRED,
} = await import("../src/core/session-title.ts");
const { renameSessionTool } = await import("../src/agent/tools/session-title.ts");
const { probeDoneTool } = await import("../src/agent/tools/probe.ts");
const { planTools } = await import("../src/agent/tools/plan.ts");
const { admitPracticeProblem, createPracticeGate, problemTool } = await import("../src/agent/tools/practice.ts");
const { createProberAgent, CONVERSATION_TOOL_NAMES } = await import("../src/agent/teacher-agent.ts");
const { sessionMarkdown } = await import("../src/core/session-markdown.ts");
const { POST } = await import("../app/api/chats/route.ts");
const { PUT } = await import("../app/api/chats/[id]/route.ts");
type LhMessage = import("../src/core/native-messages.ts").LhMessage;
type ChatRecord = import("../src/core/contracts.ts").ChatRecord;

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

const T0 = Date.parse("2026-11-27T12:00:00Z");

function user(id: string, content: unknown): LhMessage {
	return { id, role: "user", content, timestamp: T0 } as unknown as LhMessage;
}

function assistantCalls(id: string, calls: Array<{ id: string; name: string; args: unknown }>): LhMessage {
	return {
		id, role: "assistant",
		content: calls.map((c) => ({ type: "toolCall", id: c.id, name: c.name, arguments: c.args })),
		api: "openai-completions", provider: "faux", model: "faux", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		stopReason: "toolUse", timestamp: T0,
	} as unknown as LhMessage;
}

function toolResult(id: string, toolCallId: string, toolName: string, details: unknown): LhMessage {
	return { id, role: "toolResult", toolCallId, toolName, content: [{ type: "text", text: "ok" }], details, isError: false, timestamp: T0 } as unknown as LhMessage;
}

/** A record as POST /api/chats leaves it once the first message is saved. */
function autoChat(text = "me ensina limites e derivadas do capítulo 2 do Stewart, por favor", kind?: "practice"): ChatRecord {
	const chat = chatStore.createChat(titleFromPrompt(text), kind, { titleSource: "auto" });
	chatStore.saveMessages(chat.id, [user("u1", text)]);
	return chatStore.getChat(chat.id)!;
}

function rec(fields: Partial<ChatRecord>): Pick<ChatRecord, "title" | "titleSource" | "messages"> {
	return { title: "x", messages: [], ...fields };
}

async function details(result: Promise<{ details: unknown }>) {
	return (await result).details as { ok: boolean; error?: string; title?: string };
}

const ASSESSMENT = {
	strands: [{ strand: "limits", assessment: "Floor: slope intuition. Ceiling: formal ε–δ." }],
	summary: "Enter at the formal definition.",
};

describe("who set the title", () => {
	it("a record with the field answers directly", () => {
		for (const source of ["auto", "agent", "user"] as const) assert.equal(effectiveTitleSource(rec({ titleSource: source })), source);
	});

	it("legacy records: the automatic title is recognized, any other title is the learner's", () => {
		const long = "Explain why the derivative of sin(2x) carries a factor of two and how the chain rule makes that obvious";
		assert.equal(effectiveTitleSource(rec({ title: titleFromPrompt(long), messages: [user("u", long)] })), "auto", "a cut first message");
		assert.equal(effectiveTitleSource(rec({ title: "teach me limits", messages: [user("u", "  teach me limits ")] })), "auto");
		assert.equal(effectiveTitleSource(rec({ title: "Cálculo I", messages: [user("u", "teach me limits")] })), "user", "renamed by the learner");
		// Text blocks with attached images, and an image-only opening.
		const image = { type: "image", mimeType: "image/png", data: "", attachment: `${"a".repeat(32)}.png` };
		assert.equal(effectiveTitleSource(rec({ title: "solve this", messages: [user("u", [image, { type: "text", text: "solve this" }])] })), "auto");
		assert.equal(effectiveTitleSource(rec({ title: "Image", messages: [user("u", [image])] })), "auto");
		assert.equal(effectiveTitleSource(rec({ title: "Images", messages: [user("u", [image, image])] })), "auto");
		// The first learner message counts, after a graph-context marker.
		const marker = { id: "g", role: "custom", customType: "graph-context", content: "", display: false, details: null, timestamp: T0 } as unknown as LhMessage;
		assert.equal(effectiveTitleSource(rec({ title: "drill parity", messages: [marker, user("u", "drill parity")] })), "auto");
	});

	it("legacy records: a course from create_course and a record without learner messages are the learner's", () => {
		const seed = { id: "s", role: "custom", customType: "course-seed", content: "seed", display: false, details: null, timestamp: T0 } as unknown as LhMessage;
		assert.equal(effectiveTitleSource(rec({ title: "Análise real", messages: [seed, user("u", "Análise real")] })), "user");
		assert.equal(effectiveTitleSource(rec({ title: "Untitled session", messages: [] })), "user");
		assert.equal(needsSessionTitle(rec({ title: "Untitled session", messages: [] })), false);
	});

	it("POST /api/chats creates an automatic title and a manual rename makes it the learner's", async () => {
		const res = await POST(new Request("http://test/api/chats", {
			method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "teach me the chain rule" }),
		}));
		const { id } = (await res.json()) as { id: string };
		assert.equal(chatStore.getChat(id)!.titleSource, "auto");
		const put = await PUT(new Request(`http://test/api/chats/${id}`, {
			method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "Regra da cadeia" }),
		}), { params: Promise.resolve({ id }) });
		assert.equal(put.status, 200);
		const record = chatStore.getChat(id)!;
		assert.equal(record.title, "Regra da cadeia");
		assert.equal(record.titleSource, "user");
	});
});

describe("the title check and the prompt note", () => {
	it("collapses whitespace to one line and refuses empty or over-long titles", () => {
		assert.deepEqual(validateSessionTitle("  Limites e Derivadas\n — Stewart  Cap. 2 "), { ok: true, title: "Limites e Derivadas — Stewart Cap. 2" });
		assert.equal(validateSessionTitle(" \n\t ").ok, false);
		assert.equal(validateSessionTitle("x".repeat(TITLE_MAX_CHARS)).ok, true, "exactly at the cap fits");
		const long = validateSessionTitle("x".repeat(TITLE_MAX_CHARS + 1));
		assert.equal(long.ok, false);
		assert.match(long.ok ? "" : long.problem, new RegExp(`limit is ${TITLE_MAX_CHARS}`));
	});

	it("the note names the title and what the tutor may do with it", () => {
		assert.match(sessionTitleContextNote(rec({ title: "me ensina", titleSource: "auto" })), /^<session_title>Current title: "me ensina", set automatically.*rename_session as soon as.*<\/session_title>$/);
		assert.match(sessionTitleContextNote(rec({ title: "Árvores B", titleSource: "agent" })), /"Árvores B", named by you\. Refine it/);
		assert.match(sessionTitleContextNote(rec({ title: "Meu curso", titleSource: "user" })), /named by the learner\. Change it only when the learner asks, with rename_session and requestedByUser: true/);
		assert.equal(sessionTitleContextNote(rec({ title: "a", titleSource: "agent" })).includes("\n"), false, "one line");
	});
});

describe("the store: titleSource, order and events", () => {
	it("renameChat defaults to the learner, keeps updatedAt and announces chats-changed + chat-renamed", () => {
		const chat = autoChat();
		const before = chatStore.getChat(chat.id)!.updatedAt;
		const heard: Array<{ type: string; chatId?: string; title?: string }> = [];
		const off = subscribe((event) => { if (event.type === "chats-changed" || event.type === "chat-renamed") heard.push(event as never); });
		try {
			chatStore.renameChat(chat.id, "Limites — Stewart Cap. 2", "agent");
			assert.equal(chatStore.getChat(chat.id)!.titleSource, "agent");
			chatStore.renameChat(chat.id, "Meu nome");
			assert.equal(chatStore.getChat(chat.id)!.titleSource, "user", "manual renames are the learner's");
		} finally { off(); }
		assert.deepEqual(heard, [
			{ type: "chats-changed" }, { type: "chat-renamed", chatId: chat.id, title: "Limites — Stewart Cap. 2" },
			{ type: "chats-changed" }, { type: "chat-renamed", chatId: chat.id, title: "Meu nome" },
		]);
		assert.equal(chatStore.getChat(chat.id)!.updatedAt, before, "a rename never reorders the sidebar");
		const summary = chatStore.listChats().find((c) => c.id === chat.id)!;
		assert.equal("titleSource" in summary, false, "the list payload keeps its shape");
	});
});

describe("rename_session", () => {
	const rename = (chatId: string, input: Record<string, unknown>) => details(renameSessionTool({ chatId, chatStore }).execute("call", input as never));

	it("names an automatic title as the tutor's, then refines it", async () => {
		const chat = autoChat();
		assert.deepEqual(await rename(chat.id, { title: " Limites e Derivadas — Stewart Cap. 2 " }), { ok: true, title: "Limites e Derivadas — Stewart Cap. 2" });
		assert.equal(chatStore.getChat(chat.id)!.titleSource, "agent");
		assert.equal((await rename(chat.id, { title: "Limites, Derivadas e Integrais" })).ok, true, "the tutor refines its own title");
		assert.equal(chatStore.getChat(chat.id)!.title, "Limites, Derivadas e Integrais");
		assert.equal(chatStore.getChat(chat.id)!.titleSource, "agent");
	});

	it("keeps the learner's title unless the learner asked, and a requested name becomes theirs", async () => {
		const chat = autoChat();
		chatStore.renameChat(chat.id, "Meu curso de cálculo");
		const refused = await rename(chat.id, { title: "Cálculo — Stewart" });
		assert.equal(refused.ok, false);
		assert.match(refused.error!, /The learner named this session/);
		assert.equal(chatStore.getChat(chat.id)!.title, "Meu curso de cálculo");
		assert.equal((await rename(chat.id, { title: "Cálculo I", requestedByUser: true })).ok, true);
		assert.equal(chatStore.getChat(chat.id)!.title, "Cálculo I");
		assert.equal(chatStore.getChat(chat.id)!.titleSource, "user");

		const asked = autoChat();
		assert.equal((await rename(asked.id, { title: "Cálculo I", requestedByUser: true })).ok, true);
		assert.equal(chatStore.getChat(asked.id)!.titleSource, "user", "a name the learner asked for is locked as theirs");
		assert.equal((await rename(asked.id, { title: "Outro nome" })).ok, false);
	});

	it("refuses an invalid title without renaming", async () => {
		const chat = autoChat();
		const before = chatStore.getChat(chat.id)!.title;
		const empty = await rename(chat.id, { title: "   " });
		assert.equal(empty.ok, false);
		assert.match(empty.error!, /empty/);
		assert.equal((await rename(chat.id, { title: "x".repeat(TITLE_MAX_CHARS + 1) })).ok, false);
		assert.equal(chatStore.getChat(chat.id)!.title, before);
		assert.equal(chatStore.getChat(chat.id)!.titleSource, "auto");
	});

	it("is sequential and reserved among the conversation builtins", () => {
		assert.equal(renameSessionTool({ chatId: "x", chatStore }).executionMode, "sequential");
		assert.ok((CONVERSATION_TOOL_NAMES as readonly string[]).includes(RENAME_SESSION_TOOL));
	});
});

describe("the milestone gates", () => {
	it("probe_done refuses while the title is automatic and passes once it is named", async () => {
		const chat = autoChat();
		const tools = probeDoneTool({ chatId: chat.id, chatStore, deliver: () => {} });
		assert.equal(tools.probe_done!.executionMode, "sequential");
		assert.deepEqual(await details(tools.probe_done!.execute("p1", { assessment: ASSESSMENT })), { ok: false, error: SESSION_TITLE_REQUIRED });
		chatStore.renameChat(chat.id, "Limites — Stewart Cap. 2", "agent");
		assert.equal((await details(tools.probe_done!.execute("p2", { assessment: ASSESSMENT }))).ok, true);
	});

	it("plan_init refuses while the title is automatic and passes once it is named", async () => {
		const chat = autoChat();
		const plan = planTools({ chatId: chat.id, chatStore }).plan_init!;
		assert.equal(plan.executionMode, "sequential");
		const mermaid = "graph TD\n  limits[Limits] --> derivatives[Derivatives]";
		assert.deepEqual(await details(plan.execute("i1", { mermaid })), { ok: false, error: SESSION_TITLE_REQUIRED });
		assert.equal(chatStore.getChat(chat.id)!.tree, undefined, "no tree is saved on a refusal");
		chatStore.renameChat(chat.id, "Limites e Derivadas", "agent");
		assert.equal((await details(plan.execute("i2", { mermaid }))).ok, true);
	});

	it("problem refuses while the title is automatic, without arming the gate, then poses once named", async () => {
		const chat = autoChat("drill me on parity proofs", "practice");
		const gate = createPracticeGate({ chatId: chat.id, chatStore });
		const pose = { statement: "Prove the sum of two odd numbers is even.", mode: "recall", modelSolution: "2a+1 + 2b+1 = 2(a+b+1)." };
		const refused = await problemTool(gate).execute("x1", pose as never);
		assert.equal(refused.isError, true);
		assert.match((refused.content[0] as { text: string }).text, /Name the session first/);
		assert.equal(gate.problemActive, false, "a refused pose never arms the slot");
		// Plugin poses share the same admission.
		assert.equal(admitPracticeProblem(gate, {}, undefined, "plugin_problem")?.isError, true);
		chatStore.renameChat(chat.id, "Paridade — provas", "agent");
		const posed = await problemTool(gate).execute("x2", pose as never);
		assert.notEqual(posed.isError, true);
		assert.equal(gate.problemActive, true);
	});

	it("a learner-named or legacy session is never gated", async () => {
		const chat = chatStore.createChat("Old session");
		chatStore.saveMessages(chat.id, [user("u1", "teach me limits")]);
		assert.equal(needsSessionTitle(chatStore.getChat(chat.id)!), false);
		assert.equal((await details(probeDoneTool({ chatId: chat.id, chatStore, deliver: () => {} }).probe_done!.execute("p", { assessment: ASSESSMENT }))).ok, true);
	});

	it("a rename and probe_done in one batch both land in the same turn, and the prompt carries the note", async () => {
		const chat = autoChat();
		const faux = createFauxCore({});
		faux.setResponses([
			fauxAssistantMessage([
				fauxToolCall(RENAME_SESSION_TOOL, { title: "Limites e Derivadas — Stewart Cap. 2" }, { id: "rename-1" }),
				fauxToolCall("probe_done", { assessment: ASSESSMENT }, { id: "done-1" }),
			], { stopReason: "toolUse" }),
			fauxAssistantMessage("Vamos montar o plano."),
		]);
		const agent = createProberAgent(
			{ chatId: chat.id, chatStore, deliver: () => {}, jobStore: {} as never, spawn: () => {} },
			{ engine: { model: faux.getModel(), streamFn: faux.streamSimple } },
		);
		assert.ok(agent.state.tools.some((tool) => tool.name === RENAME_SESSION_TOOL));
		assert.ok(agent.state.systemPrompt.endsWith(sessionTitleContextNote(chat)), "the note closes the prompt");
		await agent.prompt("Pode concluir.");
		const results = agent.state.messages.filter((m) => m.role === "toolResult") as Array<{ toolName: string; details: { ok?: boolean } }>;
		assert.deepEqual(results.map((r) => [r.toolName, r.details.ok]), [[RENAME_SESSION_TOOL, true], ["probe_done", true]]);
		assert.equal(chatStore.getChat(chat.id)!.title, "Limites e Derivadas — Stewart Cap. 2");
	});
});

describe("silence in the transcript export", () => {
	it("the markdown export skips the rename's result", () => {
		const messages = [
			user("u1", "teach me limits"),
			assistantCalls("a1", [{ id: "r1", name: RENAME_SESSION_TOOL, args: { title: "Limites" } }]),
			toolResult("t1", "r1", RENAME_SESSION_TOOL, { ok: true, title: "Limites" }),
		];
		const md = sessionMarkdown(messages, { anchors: false });
		assert.equal(md.includes(RENAME_SESSION_TOOL), false);
		assert.equal(md, "### Learner\n\nteach me limits");
	});
});
