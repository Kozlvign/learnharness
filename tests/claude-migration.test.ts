// Fork: saved Claude connection models move from `claude-code` to `claude` (docs/claude.md).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-claude-migration-"));
process.env.LH_DATA_DIR = scratch;
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const { PATHS, SETTINGS_FILE } = await import("../config.ts");
const { migratedClaudeModel, migratedClaudeModelKey } = await import("../src/core/contracts/claude.ts");
const { settingsStore } = await import("../src/store/settings.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { jobStore } = await import("../src/store/jobs.ts");

const write = (file: string, value: unknown) => {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(value, null, "\t"));
};
const read = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));

describe("the old Claude connection id", () => {
	it("maps only this connection's models; upstream's Claude Code ids stay", () => {
		assert.deepEqual(migratedClaudeModel({ provider: "claude-code", id: "claude-opus" }), { provider: "claude", id: "claude-opus" });
		assert.deepEqual(migratedClaudeModel({ provider: "claude-code", id: "claude-opus-4-8" }), { provider: "claude", id: "claude-opus-4-8" });
		assert.equal(migratedClaudeModel({ provider: "claude-code", id: "opus" }), null, "upstream's own option");
		assert.equal(migratedClaudeModel({ provider: "claude", id: "claude-opus" }), null, "already migrated");
		assert.equal(migratedClaudeModel({ provider: "anthropic", id: "claude-opus-4-8" }), null);
		assert.equal(migratedClaudeModelKey("claude-code:claude-sonnet"), "claude:claude-sonnet");
		assert.equal(migratedClaudeModelKey("claude-code:sonnet"), null);
		assert.equal(migratedClaudeModelKey("anthropic:claude-sonnet-5"), null);
	});

	it("settings: the slots and role overrides move, once", () => {
		write(SETTINGS_FILE, {
			version: 1,
			models: {
				strong: { model: { provider: "claude-code", id: "claude-opus" }, thinkingLevel: "xhigh" },
				cheap: { model: { provider: "claude-code", id: "sonnet" }, thinkingLevel: "medium" },
				vision: { model: { provider: "claude-code", id: "claude-sonnet" }, thinkingLevel: "medium" },
			},
			agent: { models: { auditor: { model: { provider: "claude-code", id: "claude-haiku" } } } },
		});
		const record = settingsStore.readSettings()!;
		assert.deepEqual(record.models?.strong, { model: { provider: "claude", id: "claude-opus" }, thinkingLevel: "xhigh" });
		assert.deepEqual(record.models?.cheap?.model, { provider: "claude-code", id: "sonnet" }, "upstream's model stays");
		assert.deepEqual(record.models?.vision?.model, { provider: "claude", id: "claude-sonnet" });
		assert.deepEqual(record.agent?.models?.auditor?.model, { provider: "claude", id: "claude-haiku" });
		assert.deepEqual(read(SETTINGS_FILE).models.strong.model, { provider: "claude", id: "claude-opus" }, "written back");
		const written = fs.statSync(SETTINGS_FILE).mtimeMs;
		fs.utimesSync(SETTINGS_FILE, new Date(0), new Date(0));
		settingsStore.readSettings();
		assert.equal(fs.statSync(SETTINGS_FILE).mtimeMs, 0, "a migrated file is not written again");
		assert.ok(written > 0);
	});

	it("chats: the model, the recorded responses and the usage logs move", () => {
		const file = path.join(PATHS.chats, "chat_old.json");
		write(file, {
			id: "chat_old", title: "Old", createdAt: "2026-10-26T00:00:00.000Z", updatedAt: "2026-10-26T00:00:00.000Z", version: 1,
			settings: { model: { provider: "claude-code", id: "claude-opus" }, thinkingLevel: "xhigh" },
			messages: [
				{ id: "m1", role: "user", content: "Hi", timestamp: 1 },
				{ id: "m2", role: "assistant", api: "claude-code", provider: "claude-code", model: "claude-opus", content: [], stopReason: "stop", timestamp: 2, usage: {} },
				{ id: "m3", role: "assistant", api: "claude-code-cli", provider: "claude-code", model: "opus", content: [], stopReason: "stop", timestamp: 3, usage: {} },
			],
			turns: [{ id: "t1", model: "claude-code:claude-opus", steps: [] }, { id: "t2", model: "claude-code:opus", steps: [] }],
			extractions: [{ startedAt: 1, at: "x", durationMs: 1, stages: { extractor: { model: "claude-code:claude-sonnet", steps: [] }, auditor: { model: "openai:gpt-5", steps: [] } } }],
		});
		const record = chatStore.getChat("chat_old")!;
		assert.deepEqual(record.settings?.model, { provider: "claude", id: "claude-opus" });
		const [, mine, theirs] = record.messages as unknown as { api: string; provider: string }[];
		assert.deepEqual([mine!.api, mine!.provider], ["claude", "claude"]);
		assert.deepEqual([theirs!.api, theirs!.provider], ["claude-code-cli", "claude-code"], "upstream's responses stay");
		assert.deepEqual(record.turns?.map((turn) => turn.model), ["claude:claude-opus", "claude-code:opus"]);
		assert.equal(record.extractions?.[0]?.stages.extractor.model, "claude:claude-sonnet");
		assert.equal(record.extractions?.[0]?.stages.auditor.model, "openai:gpt-5");
		const disk = read(file);
		assert.deepEqual(disk.settings.model, { provider: "claude", id: "claude-opus" }, "written back");
		assert.equal(disk.updatedAt, "2026-10-26T00:00:00.000Z", "a migration is not conversation activity");
		fs.utimesSync(file, new Date(0), new Date(0));
		chatStore.getChat("chat_old");
		assert.equal(fs.statSync(file).mtimeMs, 0, "a migrated chat is not written again");
	});

	it("jobs: the usage model moves", () => {
		const file = path.join(PATHS.data, "jobs", "job_old.json");
		write(file, { id: "job_old", chatId: "chat_old", usage: { model: "claude-code:claude-sonnet", inputTokens: 1 } });
		assert.equal(jobStore.getJob("job_old")?.usage?.model, "claude:claude-sonnet");
		assert.equal(read(file).usage.model, "claude:claude-sonnet");
	});
});
