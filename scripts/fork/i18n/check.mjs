// Reports interface text the Portuguese catalog lacks (fork feature,
// docs/language.md). Text without an entry simply stays in English.
//
//   node scripts/fork/i18n/check.mjs            list what is missing
//   node scripts/fork/i18n/check.mjs --json     the same as JSON
//   node scripts/fork/i18n/check.mjs --strict   exit 1 when something is missing

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractAll } from "./extract.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export const CATALOG = path.join(ROOT, "src", "core", "i18n", "catalog", "pt-BR.json");

/** @returns {{ locale: string, messages: Record<string, string | null> }} */
export function readCatalog(file = CATALOG) {
	return JSON.parse(readFileSync(file, "utf8"));
}

/** Writes the catalog with sorted keys, so additions make small diffs. */
export function writeCatalog(catalog, file = CATALOG) {
	const messages = Object.fromEntries(Object.entries(catalog.messages).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
	const temporary = `${file}.tmp`;
	writeFileSync(temporary, `${JSON.stringify({ ...catalog, messages }, null, "\t")}\n`);
	renameSync(temporary, file);
}

export function missingEntries(root = ROOT, catalog = readCatalog()) {
	return extractAll(root).filter((item) => !Object.hasOwn(catalog.messages, item.text));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const missing = missingEntries();
	if (process.argv.includes("--json")) {
		process.stdout.write(`${JSON.stringify(missing, null, "\t")}\n`);
	} else {
		for (const item of missing) console.log(`${JSON.stringify(item.text)}  ${item.where[0]}`);
		console.log(missing.length ? `${missing.length} interface texts have no pt-BR entry.` : "Every interface text has a pt-BR entry.");
	}
	if (process.argv.includes("--strict") && missing.length) process.exitCode = 1;
}
