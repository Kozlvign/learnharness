/**
 * The helpers follow the session's teacher model (owner, 2026-11-27):
 * src/server/subagent-engines.ts resolves the researcher, demo builder,
 * visual maker, PDF reader, extractor, auditor (and the Anki writer, as the
 * extractor) on chat.model → strong slot, with the session's thinking
 * level. Only a text-only session model sends the visual maker and the PDF
 * reader to the vision slot; a missing connection refuses on the session's
 * tier instead of switching provider.
 *
 * Isolated: a temp data dir, fixture keys, no network.
 */
import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lh-session-helpers-"));
const originalEnv = process.env, originalFetch = globalThis.fetch;
process.env = {
	PATH: originalEnv.PATH, HOME: directory, USERPROFILE: directory, NODE_ENV: "test", NODE_TEST_CONTEXT: originalEnv.NODE_TEST_CONTEXT,
	LH_DATA_DIR: directory, LH_AUTH_FILE: path.join(directory, "auth.json"), OPENAI_API_KEY: "fixture", ANTHROPIC_API_KEY: "fixture",
};
fs.writeFileSync(process.env.LH_AUTH_FILE!, "{}");
globalThis.fetch = async () => { throw new Error("CLOSED: unexpected network request"); };
const { sessionSubagentEngine } = await import("../src/server/subagent-engines.ts");
const { writeSettings } = await import("../src/store/settings.ts");
const { chatStore } = await import("../src/store/chats.ts");
const connection = await import("../src/agent/antigravity/connection.ts");
after(() => { process.env = originalEnv; globalThis.fetch = originalFetch; fs.rmSync(directory, { recursive: true, force: true }); });
afterEach(() => connection.setAntigravityStateForTests(undefined));

const IMAGE = { provider: "anthropic", id: "claude-sonnet-4-6" };
const TEXT_ONLY = { provider: "openai", id: "o3-mini" };
const VISION = { provider: "openai", id: "gpt-4.1" };
const NO_KEY = { provider: "openrouter", id: "~anthropic/claude-opus-latest" };
const HELPERS = ["researcher", "demoBuilder", "extractor", "auditor", "visualMaker", "pdfReader"] as const;

function settings(models: Record<string, unknown>) { writeSettings({ version: 1, models }); }
function session(model: { provider: string; id: string }, thinkingLevel?: "low" | "medium" | "high") {
	const chat = chatStore.createChat("helpers");
	chatStore.saveSettings(chat.id, { model, ...(thinkingLevel ? { thinkingLevel } : {}) });
	return chat.id;
}
function engineOf(choice: Awaited<ReturnType<typeof sessionSubagentEngine>>) {
	assert.ok("engine" in choice, `expected an engine, got ${JSON.stringify(choice)}`);
	return choice;
}

test("every helper runs the session's model and thinking level, even with cheap and vision on other providers", async () => {
	settings({ strong: { model: TEXT_ONLY }, cheap: { model: VISION }, vision: { model: VISION } });
	const chatId = session(IMAGE, "high");
	for (const role of HELPERS) {
		const { engine, tier } = engineOf(await sessionSubagentEngine(role, chatId));
		assert.deepEqual([engine.model.provider, engine.model.id, tier], [IMAGE.provider, IMAGE.id, "strong"], role);
		assert.equal(engine.level, "high", `${role} keeps the session's thinking level`);
	}
});

test("a text-only session model sends only the visual maker and the PDF reader to the vision slot", async () => {
	settings({ strong: { model: IMAGE }, vision: { model: VISION, thinkingLevel: "low" } });
	const chatId = session(TEXT_ONLY);
	for (const role of HELPERS) {
		const { engine, tier } = engineOf(await sessionSubagentEngine(role, chatId));
		const fallback = role === "visualMaker" || role === "pdfReader";
		assert.deepEqual([engine.model.id, tier], fallback ? [VISION.id, "vision"] : [TEXT_ONLY.id, "strong"], role);
	}
	// With no vision slot there is nothing to fall back to: refuse on vision.
	settings({ strong: { model: IMAGE } });
	assert.deepEqual(await sessionSubagentEngine("pdfReader", chatId), { refusal: { kind: "models", tier: "vision" } });
	assert.equal(engineOf(await sessionSubagentEngine("researcher", chatId)).engine.model.id, TEXT_ONLY.id);
});

test("a session whose connection is gone refuses on strong — never a silent switch to the vision slot", async () => {
	settings({ strong: { model: IMAGE }, vision: { model: VISION } });
	const chatId = session(NO_KEY);
	for (const role of HELPERS) {
		const choice = await sessionSubagentEngine(role, chatId);
		assert.ok("refusal" in choice && choice.refusal.kind === "key", role);
		assert.equal(choice.refusal.envelope.provider, NO_KEY.provider);
		assert.deepEqual(choice.refusal.envelope.slots, ["strong"]);
	}
});

test("without a session (notes import) the helpers run the strong slot; nothing configured refuses on strong", async () => {
	settings({ strong: { model: IMAGE, thinkingLevel: "low" }, cheap: { model: VISION } });
	const { engine, tier } = engineOf(await sessionSubagentEngine("extractor"));
	assert.deepEqual([engine.model.id, engine.level, tier], [IMAGE.id, "low", "strong"]);
	settings({ cheap: { model: VISION }, vision: { model: VISION } });
	assert.deepEqual(await sessionSubagentEngine("auditor"), { refusal: { kind: "models", tier: "strong" } });
});

test("an Antigravity session (Gemini) reads PDFs itself: its models see images", async () => {
	connection.setAntigravityStateForTests({
		status: { state: "connected", connected: true, allowBackgroundUse: true },
		models: [{ id: "gemini-test-neon", name: "Gemini Test Neon", levels: ["low", "high"], contextWindow: 1_048_576 }],
	});
	settings({ strong: { model: TEXT_ONLY }, vision: { model: VISION } });
	const chatId = session({ provider: "antigravity", id: "gemini-test-neon" }, "high");
	for (const role of ["pdfReader", "visualMaker", "researcher"] as const) {
		const { engine, tier } = engineOf(await sessionSubagentEngine(role, chatId));
		assert.deepEqual([engine.model.provider, engine.model.id, tier, engine.level], ["antigravity", "gemini-test-neon", "strong", "high"], role);
	}
	// Signed out: the session's tier refuses; ChatGPT/OpenAI is never used instead.
	connection.setAntigravityStateForTests({ status: { state: "signed-out", connected: false }, models: [] });
	const refused = await sessionSubagentEngine("pdfReader", chatId);
	assert.ok("refusal" in refused && refused.refusal.kind === "key" && refused.refusal.envelope.provider === "antigravity");
});
