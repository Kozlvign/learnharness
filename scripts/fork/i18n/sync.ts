/**
 * Translates interface text the pt-BR catalog lacks, using the user's own
 * Claude Code (fork feature, docs/language.md). The release script runs it
 * after merging upstream, so new upstream text reaches the Portuguese
 * interface without manual work.
 *
 *   npx tsx scripts/fork/i18n/sync.ts            translate and write the catalog
 *   npx tsx scripts/fork/i18n/sync.ts --dry-run  show what would be translated
 *
 * Exit code 0 when the catalog is complete (or was completed), 1 when some
 * text could not be translated. Text without an entry stays in English, so
 * a failure never breaks the app.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { claudeCodeEnv } from "../../../src/agent/claude/environment.ts";
import { findClaudeExecutable } from "../../../src/agent/claude/executable.ts";
import { missingEntries, readCatalog, ROOT, writeCatalog } from "./check.mjs";

type Entry = { text: string; kind: string; where: string[] };

const BATCH = 80;
const MODEL = process.env.LH_I18N_MODEL || "sonnet";
const GUIDE = readFileSync(path.join(ROOT, "scripts", "fork", "i18n", "GUIDE.md"), "utf8");

/** A few lines around the first place the text appears. */
function codeAround(where: string): string {
	const match = /^(.*):(\d+)$/.exec(where);
	if (!match) return "";
	try {
		const lines = readFileSync(path.join(ROOT, match[1]!), "utf8").split("\n");
		const line = Number(match[2]) - 1;
		return lines.slice(Math.max(0, line - 3), line + 4).join("\n");
	} catch {
		return "";
	}
}

const placeholders = (text: string) => (text.match(/\{\d+\}/g) ?? []).sort().join();

/** Keeps only answers for the asked texts with the same placeholders. */
function validated(entries: Entry[], answer: unknown): Record<string, string | null> {
	const out: Record<string, string | null> = {};
	if (!answer || typeof answer !== "object") return out;
	const record = answer as Record<string, unknown>;
	for (const { text } of entries) {
		const value = record[text];
		if (value === null) out[text] = null;
		else if (typeof value === "string" && value.trim() && placeholders(value) === placeholders(text)) out[text] = value;
	}
	return out;
}

async function translateBatch(entries: Entry[]): Promise<Record<string, string | null>> {
	const executable = findClaudeExecutable();
	if (!executable) throw new Error("Claude Code is not installed");
	const items = entries.map((entry) => ({ text: entry.text, where: entry.where, code: codeAround(entry.where[0] ?? "") }));
	const prompt = [
		GUIDE,
		"## Your task",
		"Translate each `text` below. Reply with one JSON object and nothing else: keys are the `text` values, byte-identical; values are the Portuguese text, the identical string, or null.",
		"",
		...items.map((item) => JSON.stringify(item)),
	].join("\n");
	const abort = new AbortController();
	const timer = setTimeout(() => abort.abort(), 10 * 60_000);
	let result = "";
	try {
		for await (const message of query({
			prompt,
			options: {
				pathToClaudeCodeExecutable: executable.path,
				...(executable.script ? { executable: "node" as const } : {}),
				cwd: ROOT,
				env: claudeCodeEnv(),
				model: MODEL,
				systemPrompt: "You translate software interface text into Brazilian Portuguese, following the guide you are given exactly. You reply with JSON only.",
				tools: [],
				settingSources: [],
				mcpServers: {},
				strictMcpConfig: true,
				persistSession: false,
				abortController: abort,
			},
		})) {
			if (message.type === "result") {
				if (message.subtype !== "success") throw new Error(`Claude Code stopped: ${message.subtype}`);
				result = message.result;
			}
		}
	} finally {
		clearTimeout(timer);
	}
	const start = result.indexOf("{");
	const end = result.lastIndexOf("}");
	if (start < 0 || end <= start) throw new Error("Claude Code did not return JSON");
	return validated(entries, JSON.parse(result.slice(start, end + 1)));
}

async function main() {
	const catalog = readCatalog();
	const missing = missingEntries(ROOT, catalog) as Entry[];
	if (missing.length === 0) {
		console.log("Every interface text has a pt-BR entry.");
		return;
	}
	console.log(`${missing.length} interface texts have no pt-BR entry.`);
	if (process.argv.includes("--dry-run")) {
		for (const entry of missing) console.log(`  ${JSON.stringify(entry.text)}  ${entry.where[0]}`);
		return;
	}
	let added = 0;
	for (let index = 0; index < missing.length; index += BATCH) {
		const batch = missing.slice(index, index + BATCH);
		try {
			const translated = await translateBatch(batch);
			Object.assign(catalog.messages, translated);
			added += Object.keys(translated).length;
			writeCatalog(catalog);
		} catch (cause) {
			console.error(`Batch ${index / BATCH + 1} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
		}
	}
	const left = missing.length - added;
	console.log(`Added ${added} pt-BR entries${left ? `; ${left} stay in English for now` : ""}.`);
	if (left) process.exitCode = 1;
}

await main();
