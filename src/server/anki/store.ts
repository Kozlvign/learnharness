/**
 * Anki cards from mistakes, server storage (fork feature, docs/anki.md):
 * the settings in `<data>/anki.json` and the card ledger in
 * `<data>/anki-cards.json`, both beside upstream's records. Writes go to a
 * temporary file and are renamed into place, so a reader never sees half a
 * file. Ledger updates are serialized in-process: concurrent callers never
 * interleave a read-modify-write.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { PATHS } from "../../../config.ts";
import { ANKI_CARD_STATUSES, DEFAULT_ANKI_SETTINGS, type AnkiCardRecord, type AnkiLedger, type AnkiSettings } from "../../core/anki/contract.ts";
import { parseAnkiSettings } from "../../core/anki/settings.ts";

const SETTINGS = Symbol.for("lh.anki.settings");
const LEDGER_CHAIN = Symbol.for("lh.anki.ledger.chain");
type SettingsState = { file: string; mtimeMs: number; settings: AnkiSettings };
const globalState = globalThis as typeof globalThis & { [SETTINGS]?: SettingsState; [LEDGER_CHAIN]?: Promise<unknown> };

let temporaryCount = 0;
function temporaryFile(file: string): string {
	temporaryCount += 1;
	return `${file}.${process.pid}.${temporaryCount}.tmp`;
}

function serialized(value: unknown): string {
	return `${JSON.stringify(value, null, "\t")}\n`;
}

// ─── settings ───────────────────────────────────────────────────────────────

export function ankiSettingsFile(): string {
	return path.join(PATHS.data, "anki.json");
}

/** The current settings. The file is re-read only when it changes on disk. */
export function ankiSettings(): AnkiSettings {
	const file = ankiSettingsFile();
	let mtimeMs = -1;
	try { mtimeMs = statSync(file).mtimeMs; } catch { /* no file yet: defaults */ }
	const cached = globalState[SETTINGS];
	if (cached && cached.file === file && cached.mtimeMs === mtimeMs) return cached.settings;
	let settings: AnkiSettings = DEFAULT_ANKI_SETTINGS;
	if (mtimeMs >= 0) {
		try { settings = parseAnkiSettings(JSON.parse(readFileSync(file, "utf8"))); } catch { /* unreadable: defaults */ }
	}
	globalState[SETTINGS] = { file, mtimeMs, settings };
	return settings;
}

/** `enabledAt` is the server's: now when `enabled` turns on against the
 *  stored settings, else the stored value (whatever `next` carries). */
export function saveAnkiSettings(next: AnkiSettings): AnkiSettings {
	const stored = ankiSettings();
	const parsed = parseAnkiSettings(next);
	const settings: AnkiSettings = { ...parsed, enabledAt: parsed.enabled && !stored.enabled ? new Date().toISOString() : (stored.enabledAt ?? null) };
	const file = ankiSettingsFile();
	mkdirSync(path.dirname(file), { recursive: true });
	const temporary = temporaryFile(file);
	writeFileSync(temporary, serialized(settings));
	renameSync(temporary, file);
	globalState[SETTINGS] = { file, mtimeMs: statSync(file).mtimeMs, settings };
	return settings;
}

// ─── the card ledger ────────────────────────────────────────────────────────

export function ankiLedgerFile(): string {
	return path.join(PATHS.data, "anki-cards.json");
}

const STATUSES: ReadonlySet<string> = new Set(ANKI_CARD_STATUSES);

const EPOCH = new Date(0).toISOString();

/** A stored record made safe to use, or null when it cannot identify a
 *  card (no string id, key or chatId, or an unknown status). */
function normalizedRecord(value: unknown): AnkiCardRecord | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (typeof record.id !== "string" || typeof record.key !== "string" || typeof record.chatId !== "string") return null;
	if (typeof record.status !== "string" || !STATUSES.has(record.status)) return null;
	const createdAt = typeof record.createdAt === "string" ? record.createdAt : null;
	const updatedAt = typeof record.updatedAt === "string" ? record.updatedAt : null;
	const normalized: AnkiCardRecord = {
		...(record as unknown as AnkiCardRecord),
		targets: Array.isArray(record.targets) ? (record.targets as string[]) : [],
		attempts: typeof record.attempts === "number" && Number.isFinite(record.attempts) ? record.attempts : 0,
		createdAt: createdAt ?? updatedAt ?? EPOCH,
		updatedAt: updatedAt ?? createdAt ?? EPOCH,
	};
	// Who wrote the card: a record from before the tutor's card tool that has
	// a card was written by the reserve writer.
	if (record.writtenBy !== "tutor" && record.writtenBy !== "writer") {
		if (record.card && typeof record.card === "object") normalized.writtenBy = "writer";
		else delete normalized.writtenBy;
	}
	if (typeof record.questionHint !== "string") delete normalized.questionHint;
	if (typeof record.covers !== "string") delete normalized.covers;
	return normalized;
}

/**
 * The ledger as stored. Tolerant: no file = an empty ledger; a file that is
 * not a version-1 ledger is renamed aside (`anki-cards.json.corrupt-<ms>`,
 * plus `-<n>` when that name is taken, so an earlier copy is never replaced)
 * and the ledger starts empty; records without a string id, key, chatId and
 * a known status are dropped, and the rest get safe `targets`, `attempts`,
 * `createdAt` and `updatedAt`. Any other read failure throws, so an update
 * never writes over a ledger it could not read.
 */
export function readAnkiLedger(): AnkiLedger {
	const file = ankiLedgerFile();
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (cause) {
		if ((cause as NodeJS.ErrnoException | null)?.code === "ENOENT") return { version: 1, cards: [] };
		throw cause;
	}
	let parsed: unknown;
	try { parsed = JSON.parse(text); } catch { parsed = undefined; }
	const stored = parsed as Partial<AnkiLedger> | undefined;
	if (!stored || typeof stored !== "object" || Array.isArray(stored) || stored.version !== 1 || !Array.isArray(stored.cards)) {
		try {
			const base = `${file}.corrupt-${Date.now()}`;
			let aside = base;
			for (let n = 1; existsSync(aside); n++) aside = `${base}-${n}`;
			renameSync(file, aside);
		} catch (cause) {
			// Another reader moved it first.
			if ((cause as NodeJS.ErrnoException | null)?.code !== "ENOENT") throw cause;
		}
		console.error(`[anki] the card ledger could not be read; moved aside and starting empty: ${file}`);
		return { version: 1, cards: [] };
	}
	return { version: 1, cards: stored.cards.map(normalizedRecord).filter((record): record is AnkiCardRecord => record !== null) };
}

/** How long a refused rename is retried, and the longest pause between tries. */
const RENAME_WINDOW_MS = 2000;
const RENAME_MAX_PAUSE_MS = 400;

async function writeLedger(ledger: AnkiLedger): Promise<void> {
	const file = ankiLedgerFile();
	mkdirSync(path.dirname(file), { recursive: true });
	const temporary = temporaryFile(file);
	try {
		await writeFile(temporary, serialized({ version: 1, cards: ledger.cards }));
		// Windows refuses a rename while another process (an indexer, a virus
		// scanner, a sync client) briefly holds the target; keep trying for
		// a while, backing off.
		const deadline = Date.now() + RENAME_WINDOW_MS;
		for (let pause = 25; ; pause = Math.min(pause * 2, RENAME_MAX_PAUSE_MS)) {
			try {
				await rename(temporary, file);
				return;
			} catch (cause) {
				const code = (cause as NodeJS.ErrnoException | null)?.code;
				const transient = code === "EPERM" || code === "EACCES" || code === "EBUSY";
				if (!transient || Date.now() + pause > deadline) throw cause;
				await new Promise((resolve) => setTimeout(resolve, pause));
			}
		}
	} catch (cause) {
		await unlink(temporary).catch(() => undefined);
		throw cause;
	}
}

/**
 * Read the ledger fresh, let `mutate` change it in place, write it back
 * atomically, and return what `mutate` returned. Calls run one at a time,
 * in call order, across every caller in the process. A `mutate` that throws
 * writes nothing and rejects; the next call still runs. An unchanged ledger
 * is not rewritten.
 */
export function updateAnkiLedger<T>(mutate: (ledger: AnkiLedger) => T | Promise<T>): Promise<T> {
	const previous = globalState[LEDGER_CHAIN] ?? Promise.resolve();
	const run = previous.then(async () => {
		const ledger = readAnkiLedger();
		const before = serialized(ledger);
		const result = await mutate(ledger);
		if (serialized({ version: 1, cards: ledger.cards }) !== before) await writeLedger(ledger);
		return result;
	});
	globalState[LEDGER_CHAIN] = run.catch(() => undefined);
	return run;
}
