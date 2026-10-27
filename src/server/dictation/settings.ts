/**
 * The dictation engine choice (fork feature, docs/dictation.md), kept in
 * its own file, `<data>/dictation.json`, beside upstream's settings record.
 * It lives on the server because the desktop app serves every launch from
 * a new port, which empties the browser's storage.
 */
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PATHS } from "../../../config.ts";
import { DEFAULT_DICTATION_SETTINGS, parseDictationSettings, type DictationSettings } from "../../core/dictation.ts";

const STATE = Symbol.for("lh.dictation.settings");
type State = { file: string; mtimeMs: number; settings: DictationSettings };
const globalState = globalThis as typeof globalThis & { [STATE]?: State };

export function dictationSettingsFile(): string {
	return path.join(PATHS.data, "dictation.json");
}

/** The current choice. The file is re-read only when it changes on disk. */
export function dictationSettings(): DictationSettings {
	const file = dictationSettingsFile();
	let mtimeMs = -1;
	try { mtimeMs = statSync(file).mtimeMs; } catch { /* no file yet: defaults */ }
	const cached = globalState[STATE];
	if (cached && cached.file === file && cached.mtimeMs === mtimeMs) return cached.settings;
	let settings: DictationSettings = DEFAULT_DICTATION_SETTINGS;
	if (mtimeMs >= 0) {
		try { settings = parseDictationSettings(JSON.parse(readFileSync(file, "utf8"))); } catch { /* unreadable: defaults */ }
	}
	globalState[STATE] = { file, mtimeMs, settings };
	return settings;
}

export function saveDictationSettings(next: DictationSettings): DictationSettings {
	const settings = parseDictationSettings(next);
	const file = dictationSettingsFile();
	mkdirSync(path.dirname(file), { recursive: true });
	const temporary = `${file}.${process.pid}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(settings, null, "\t")}\n`);
	renameSync(temporary, file);
	globalState[STATE] = { file, mtimeMs: statSync(file).mtimeMs, settings };
	return settings;
}
