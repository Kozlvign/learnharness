/**
 * Practice evidence, server read (fork feature, docs/evidence.md): the
 * golden data copied into an isolated LH_DATA_DIR, read through the real
 * stores. The read writes nothing to the graph.
 *
 * The seam is set before any config-loading import, so every app-module
 * import is dynamic (the schema-stamps discipline).
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-evidence-"));
process.env.LH_DATA_DIR = TMP_DATA;
const GOLDEN = path.join(import.meta.dirname, "fixtures", "golden-data");
for (const dir of ["chats", "graph"]) fs.cpSync(path.join(GOLDEN, dir), path.join(TMP_DATA, dir), { recursive: true });

const { practicedPropositionEvidence, propositionEvidenceView } = await import("../src/server/evidence.ts");

test.after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

const graphDigest = () => {
	const dir = path.join(TMP_DATA, "graph");
	const hash = createHash("sha256");
	for (const name of fs.readdirSync(dir).sort()) hash.update(name).update(fs.readFileSync(path.join(dir, name)));
	return hash.digest("hex");
};

test("the practiced view holds the golden practice session's two problems", () => {
	const before = graphDigest();
	const views = practicedPropositionEvidence();
	assert.deepEqual(Object.keys(views).sort(), ["n_9b19474daaf7", "n_ed4b233efa54"]);

	const solved = views.n_9b19474daaf7!;
	assert.equal(solved.items.length, 1);
	assert.equal(solved.items[0]?.evidence.outcome, "solved");
	assert.equal(solved.items[0]?.spacing, "review");
	assert.equal(solved.stage.kind, "solvedWithoutHelp");
	assert.equal(solved.stage.chatId, "chat_mv293wv5_10656952");
	assert.equal(solved.firstContact?.kind, "taught");

	const dismissed = views.n_ed4b233efa54!;
	assert.equal(dismissed.items[0]?.evidence.outcome, "dismissed");
	assert.equal(dismissed.items[0]?.spacing, null);
	assert.notEqual(dismissed.stage.kind, "solvedWithoutHelp");
	assert.ok(["taughtNotPracticed", "importedNotPracticed"].includes(dismissed.stage.kind), "a dismissal is not practice");

	assert.equal(graphDigest(), before, "the read leaves the graph untouched");
});

test("the full view covers every proposition, practiced or not", () => {
	const all = propositionEvidenceView();
	assert.ok(Object.keys(all).length > 2);
	const unpracticed = Object.values(all).filter((view) => view.items.length === 0);
	assert.ok(unpracticed.length > 0);
	for (const view of unpracticed) {
		assert.ok(["taughtNotPracticed", "importedNotPracticed", "noEvidence"].includes(view.stage.kind), view.propositionId);
	}
});
