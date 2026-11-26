/**
 * The teaching audit's command line (fork, docs/rigor.md):
 *
 *   npm run audit:session -- <chat id | path to chat .json> [--data <dir>] [--out <file>] [--no-transcript]
 *
 * A chat id is looked up in <data>/chats/<id>.json, where <data> is
 * --data, else LH_DATA_DIR, else the desktop app's data folder when it
 * exists (%APPDATA%\LearnHarness\data on Windows), else the repository's
 * data/. Prints the Markdown report, or writes it to --out.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { auditChat, renderAuditMarkdown, type AuditRecord } from "../src/core/teaching-audit.ts";

function desktopDataDir(): string | null {
	const candidates =
		process.platform === "win32"
			? [process.env.APPDATA && path.join(process.env.APPDATA, "LearnHarness", "data")]
			: process.platform === "darwin"
				? [path.join(os.homedir(), "Library", "Application Support", "LearnHarness", "data")]
				: [path.join(os.homedir(), ".config", "LearnHarness", "data")];
	return candidates.find((dir): dir is string => !!dir && fs.existsSync(dir)) ?? null;
}

function dataDir(explicit: string | undefined): string {
	if (explicit) return path.resolve(explicit);
	if (process.env.LH_DATA_DIR) return path.resolve(process.env.LH_DATA_DIR);
	const desktop = desktopDataDir();
	if (desktop) return desktop;
	return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
}

function main(argv: string[]): number {
	let target: string | undefined;
	let data: string | undefined;
	let out: string | undefined;
	let transcript = true;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "--data") data = argv[++i];
		else if (arg === "--out") out = argv[++i];
		else if (arg === "--no-transcript") transcript = false;
		else if (arg === "--help" || arg === "-h") target = undefined;
		else target = arg;
	}
	if (!target) {
		console.error("Usage: npm run audit:session -- <chat id | path to chat .json> [--data <dir>] [--out <file>] [--no-transcript]");
		return 2;
	}
	const file = target.endsWith(".json") || fs.existsSync(target) ? path.resolve(target) : path.join(dataDir(data), "chats", `${target}.json`);
	if (!fs.existsSync(file)) {
		console.error(`Chat file not found: ${file}`);
		return 1;
	}
	const record = JSON.parse(fs.readFileSync(file, "utf8")) as AuditRecord;
	if (!Array.isArray(record.messages)) {
		console.error(`Not a chat record: ${file}`);
		return 1;
	}
	const markdown = renderAuditMarkdown(auditChat(record), record, { transcript });
	if (out) {
		fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
		fs.writeFileSync(out, markdown);
		console.error(`Report written to ${path.resolve(out)}`);
	} else {
		process.stdout.write(`${markdown}\n`);
	}
	return 0;
}

process.exitCode = main(process.argv.slice(2));
