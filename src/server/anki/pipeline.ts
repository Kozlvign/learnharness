/**
 * Anki cards from mistakes, the pipeline (fork feature, docs/anki.md).
 *
 * The tutor writes most cards itself (the anki_card tool, ./tutor.ts);
 * this pipeline is the reserve for the misses it leaves without one, and
 * sends every card to Anki. One run for a chat:
 *   1. fold the chat record (`ankiMissesOf`): link the tutor's unlinked
 *      cards to the misses they name, and add every other new miss to the
 *      card ledger as `waiting` (a miss already in the ledger, by key or
 *      covered by a tutor card, whatever its status, is never added again);
 *   2. evaluate the chat's waiting records: age out the ones waiting too
 *      long, then ask the card writer (a background model call, batches of
 *      ANKI_WRITER_BATCH) to write, wait or skip each one that is due: not
 *      before the tutor has had ANKI_TUTOR_GRACE_REPLIES replies to make its
 *      card, not before the tutor has replied to it, not before a teach chat's probe
 *      is done for predict misses, and again only after
 *      ANKI_RECHECK_MESSAGES new messages. A probe miss is due at once
 *      (`ankiMissExplainedOnAnswer`);
 *   3. flush: send every queued card of every chat to Anki through
 *      AnkiConnect. Anki closed (or not set up) = the cards stay queued for
 *      the next run; only a note Anki refuses counts as a failed attempt.
 *
 * A run without a chat id skips the fold and evaluates every chat that has
 * waiting records, then flushes. Runs for one chat are serialized, and
 * flushes never overlap. Errors are logged; a run never rejects.
 *
 * Triggered by the event bus (`turn-settled`, `record-changed`), debounced
 * per chat; `registerAnkiPipeline()` subscribes once per process. The
 * ledger store announces each change to a chat's records on the same bus
 * (`anki-changed`, ./store.ts); the pipeline never listens to it. This
 * module is loaded on the first event while the feature is on (./trigger.ts,
 * set up by the root instrumentation.ts). `createAnkiPipeline(deps)` takes
 * every dependency,
 * so tests run it against fakes; `runAnkiPipeline` / `registerAnkiPipeline`
 * wire the real ones.
 */

import { ROLE_SLOT, ModelsNotConfiguredError, ProviderKeyMissingError } from "../../core/settings.ts";
import { resolveRoleSpec } from "../../core/settings-resolution.ts";
import { CLAUDE_CODE_PROVIDER } from "../../core/contracts/claude-code.ts";
import type { ChatRecord } from "../../core/contracts/chat.ts";
import { subscribe as subscribeToBus, type ServerEventListener } from "../../core/events.ts";
import { hasProbeDone } from "../../core/native-messages.ts";
import {
	ANKI_MAX_SEND_ATTEMPTS,
	ANKI_MAX_WAIT_DAYS,
	ANKI_MAX_WAITS,
	ANKI_REASONS,
	ANKI_RECHECK_MESSAGES,
	ANKI_TUTOR_GRACE_REPLIES,
	ankiMissExplainedOnAnswer,
	missNeedsTeaching,
	type AnkiCardDraft,
	type AnkiCardRecord,
	type AnkiLedger,
	type AnkiMiss,
	type AnkiSettings,
	type AnkiWriterDecision,
} from "../../core/anki/contract.ts";
import { ankiMatchMiss, ankiMissesOf, ankiTranscriptExcerpt, ankiTutorRepliedAfter, ankiTutorRepliesAfter } from "../../core/anki/misses.ts";
import { ankiDeckName, ankiNoteFields, ankiTags } from "../../core/anki/format.ts";
import { piEngineForSpec, type PiEngine } from "../../agent/models.ts";
import { languageSettings } from "../../agent/language.ts";
import { connectionBackgroundAllowed as subscriptionBackgroundAllowed } from "../../agent/subscription-connections.ts";
import {
	ANKI_EXCERPT_CHARS,
	ANKI_EXCERPT_TEACHING_CHARS,
	ANKI_WRITER_BATCH,
	ANKI_WRITER_EXISTING_MAX,
	writeAnkiCards,
} from "../../agent/subagents/anki-writer.ts";
import { providerKeyPresent } from "../keys.ts";
import { refreshConnectionCatalog } from "../model-catalog.ts";
import { stores } from "../stores.ts";
import {
	AnkiActionError,
	AnkiNoteGoneError,
	AnkiProtocolError,
	AnkiSetupError,
	AnkiUnauthorizedError,
	AnkiUnreachableError,
	createAnkiClient,
	isAnkiDuplicateError,
	type AnkiClient,
} from "./client.ts";
import { ankiSettings, readAnkiLedger, updateAnkiLedger } from "./store.ts";
import {
	ankiChatFolderPath,
	ankiCountsTowardLimit,
	ankiRecordForMiss,
	ankiRecordsByMiss,
	ankiSessionCardCount,
	ankiWriteCard,
} from "./tutor.ts";

export { ankiFolderPathOf } from "./tutor.ts";

/** Quiet time after a chat's last event before its run starts. */
export const ANKI_DEBOUNCE_MS = 2000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The AnkiConnect calls a flush makes. */
export type AnkiPipelineClient = Pick<AnkiClient, "ensureNoteType" | "ensureDeck" | "addCardNote" | "findNoteByLhId" | "resurface" | "deleteNote">;

export type AnkiWriter = (opts: Parameters<typeof writeAnkiCards>[0]) => Promise<AnkiWriterDecision[]>;

export interface AnkiPipelineDeps {
	/** Read fresh at the start of every run. */
	settings(): AnkiSettings;
	getChat(chatId: string): ChatRecord | null;
	readLedger(): AnkiLedger;
	/** Serialized, atomic; a throwing mutate writes nothing. */
	updateLedger<T>(mutate: (ledger: AnkiLedger) => T | Promise<T>): Promise<T>;
	client(settings: AnkiSettings): AnkiPipelineClient;
	writer: AnkiWriter;
	/** The writer's engine. undefined, or a throw, = no background model
	 *  available: the misses keep waiting with ANKI_REASONS.noModel. */
	engine(): PiEngine | undefined | Promise<PiEngine | undefined>;
	/** The chat's folder path in the sources list, outermost first. */
	folderPath(chatId: string): string[];
	now(): Date;
	/** The interface locale, for the date on the card's Source line. */
	locale(): string;
	/** Defaults: the core fold, excerpt and reply check (src/core/anki/misses.ts). */
	missesOf?: typeof ankiMissesOf;
	excerpt?: typeof ankiTranscriptExcerpt;
	repliedAfter?: typeof ankiTutorRepliedAfter;
	repliesAfter?: typeof ankiTutorRepliesAfter;
	/** Defaults: the server event bus and ANKI_DEBOUNCE_MS. */
	subscribe?: (listener: ServerEventListener) => () => void;
	debounceMs?: number;
}

export interface AnkiPipeline {
	/** One run (see the module comment). Never rejects. */
	run(chatId?: string): Promise<void>;
	/** Listen to the event bus; returns the unsubscribe function. */
	subscribe(): () => void;
}

// ─── small helpers ──────────────────────────────────────────────────────────

/** Runs `task` one at a time; requests made while one runs collapse into
 *  a single follow-up run. */
function coalesced(task: () => Promise<void>): () => Promise<void> {
	let running: Promise<void> | null = null;
	let queued: Promise<void> | null = null;
	const start = (): Promise<void> => {
		const current: Promise<void> = task().finally(() => {
			if (running === current) running = null;
		});
		running = current;
		return current;
	};
	return () => {
		if (queued) return queued;
		if (!running) return start();
		const next = running.catch(() => undefined).then(() => {
			queued = null;
			return start();
		});
		queued = next;
		return next;
	};
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Problems of the connection or of Anki's setup, not of one card: the
 *  flush stops, and no card is blamed (no attempt counted). */
function blocksEveryCard(err: unknown): boolean {
	return err instanceof AnkiUnreachableError
		|| err instanceof AnkiUnauthorizedError
		|| err instanceof AnkiProtocolError
		|| err instanceof AnkiSetupError;
}

/** Anki refused this card's note (addCardNote, not a duplicate): the only
 *  send failure that counts as an attempt. */
class NoteRefusedError extends Error {
	override name = "NoteRefusedError";
}

function setReason(card: AnkiCardRecord, reason: string | undefined): void {
	if (reason) card.reason = reason;
	else delete card.reason;
}

/** Waiting only because no background model was available: never
 *  judged by the writer, so the days cutoff does not apply. */
function waitsOnlyForModel(card: AnkiCardRecord): boolean {
	return card.reason === ANKI_REASONS.noModel && card.attempts === 0 && card.checkedAt === undefined;
}

/** A record another card may be folded into: it has, or will get, a note. */
function canHostDuplicate(card: AnkiCardRecord | undefined): card is AnkiCardRecord {
	return !!card && !card.duplicateOf && (card.status === "queued" || (card.status === "sent" && card.noteId !== undefined));
}

/** Cards the writer may name in duplicateOf (the tutor's included): the
 *  chat's own, then the ones sharing a target with the batch, newest first. */
export function ankiExistingCards(
	ledger: AnkiLedger,
	chatId: string,
	misses: readonly AnkiMiss[],
	max = ANKI_WRITER_EXISTING_MAX,
): Array<{ id: string; front: string }> {
	const targets = new Set(misses.flatMap((miss) => miss.targets));
	const newest = (a: AnkiCardRecord, b: AnkiCardRecord) => b.createdAt.localeCompare(a.createdAt);
	const hosts = ledger.cards.filter((card) => card.card && canHostDuplicate(card));
	const own = hosts.filter((card) => card.chatId === chatId).sort(newest);
	const related = hosts.filter((card) => card.chatId !== chatId && card.targets.some((t) => targets.has(t))).sort(newest);
	return [...own, ...related].slice(0, max).map((card) => ({ id: card.id, front: card.card!.front }));
}

// ─── the pipeline ───────────────────────────────────────────────────────────

export function createAnkiPipeline(deps: AnkiPipelineDeps): AnkiPipeline {
	const missesOf = deps.missesOf ?? ankiMissesOf;
	const excerpt = deps.excerpt ?? ankiTranscriptExcerpt;
	const repliedAfter = deps.repliedAfter ?? ankiTutorRepliedAfter;
	const repliesAfter = deps.repliesAfter ?? ankiTutorRepliesAfter;
	const chatChains = new Map<string, Promise<void>>();

	/** One task at a time per chat, in call order. */
	function perChat(chatId: string, task: () => Promise<void>): Promise<void> {
		const previous = chatChains.get(chatId) ?? Promise.resolve();
		const next = previous.then(task).catch((err) => {
			console.error(`[anki ${chatId}] run failed:`, err);
		});
		chatChains.set(chatId, next);
		void next.then(() => {
			if (chatChains.get(chatId) === next) chatChains.delete(chatId);
		});
		return next;
	}

	// ── 1. the fold → linked tutor cards, new waiting records ──

	/** A tutor mistake card the stored record did not show the miss of when
	 *  it was made: it carries the tutor's question hint, waiting to be linked. */
	function unlinked(card: AnkiCardRecord, chatId: string): boolean {
		return card.chatId === chatId && card.writtenBy === "tutor" && card.kind !== "request" && !card.covers && !!card.questionHint;
	}

	async function ingest(record: ChatRecord, misses: readonly AnkiMiss[]): Promise<void> {
		if (misses.length === 0) return;
		const nowIso = deps.now().toISOString();
		const { added, linked } = await deps.updateLedger((ledger) => {
			const known = ankiRecordsByMiss(ledger);
			const ids = new Set(ledger.cards.map((card) => card.id));
			let fresh = misses.filter((miss) => !known.has(miss.key));
			// The tutor's unlinked cards take their miss first, oldest card
			// first: that miss never gets a waiting record of its own. The card
			// takes the miss's kind, phase, class and targets; its tags follow
			// while it is still on its way to Anki.
			let linked = 0;
			for (const card of ledger.cards) {
				if (!unlinked(card, record.id)) continue;
				const miss = ankiMatchMiss(fresh, card.questionHint);
				if (!miss) continue;
				card.covers = miss.key;
				card.kind = miss.kind;
				card.phase = miss.phase;
				card.missClass = miss.missClass;
				card.confident = ankiRecordForMiss(miss, card.sessionTitle, nowIso).confident;
				card.targets = [...miss.targets];
				if (card.status === "queued") card.tags = ankiTags(card);
				card.updatedAt = nowIso;
				fresh = fresh.filter((m) => m.key !== miss.key);
				linked++;
			}
			let added = 0;
			for (const miss of fresh) {
				const card = ankiRecordForMiss(miss, record.title, nowIso);
				if (ids.has(card.id)) continue;
				ledger.cards.push(card);
				ids.add(card.id);
				added++;
			}
			return { added, linked };
		});
		if (linked > 0) console.info(`[anki ${record.id}] ${linked} tutor card(s) linked to their miss`);
		if (added > 0) console.info(`[anki ${record.id}] ${added} new miss(es) waiting for a card`);
	}

	// ── 2. waiting records → the writer ──

	async function markNoModel(keys: ReadonlySet<string>): Promise<void> {
		const nowIso = deps.now().toISOString();
		await deps.updateLedger((ledger) => {
			for (const card of ledger.cards) {
				if (card.status !== "waiting" || !keys.has(card.key) || card.reason === ANKI_REASONS.noModel) continue;
				card.reason = ANKI_REASONS.noModel;
				card.updatedAt = nowIso;
			}
		});
	}

	async function resolveEngine(chatId: string): Promise<PiEngine | undefined> {
		try {
			return await deps.engine();
		} catch (err) {
			if (!(err instanceof ModelsNotConfiguredError || err instanceof ProviderKeyMissingError)) {
				console.error(`[anki ${chatId}] the background model could not be prepared:`, err);
			}
			return undefined;
		}
	}

	async function applyDecisions(record: ChatRecord, settings: AnkiSettings, decisions: readonly AnkiWriterDecision[]): Promise<void> {
		const nowIso = deps.now().toISOString();
		const folderPath = deps.folderPath(record.id);
		await deps.updateLedger((ledger) => {
			const byId = new Map(ledger.cards.map((card) => [card.id, card]));
			for (const decision of decisions) {
				const card = ledger.cards.find((c) => c.key === decision.key);
				// Removed (or decided) while the writer was busy: leave it be.
				if (!card || card.status !== "waiting") continue;
				card.attempts += 1;
				card.checkedAt = record.messages.length;
				card.updatedAt = nowIso;
				if (decision.decision === "wait") {
					if (card.attempts >= ANKI_MAX_WAITS) {
						card.status = "skipped";
						card.reason = ANKI_REASONS.neverExplained;
					} else {
						setReason(card, decision.reason);
					}
					continue;
				}
				if (decision.decision === "skip") {
					card.status = "skipped";
					setReason(card, decision.reason);
					continue;
				}
				// A card. The deck and tags are fixed now, with the chat's
				// current title and folder; send attempts start over.
				const evaluations = card.attempts;
				const deck = ankiDeckName(settings.deckTemplate, { folderPath, sessionTitle: record.title });
				ankiWriteCard(card, decision.card, { writtenBy: "writer", sessionTitle: record.title, deck, nowIso });
				const host = decision.duplicateOf ? byId.get(decision.duplicateOf) : undefined;
				if (canHostDuplicate(host) && host.id !== card.id) {
					card.duplicateOf = host.id;
					continue;
				}
				delete card.duplicateOf;
				const limit = settings.perSessionLimit;
				// The card itself is queued now: the limit counts it.
				if (limit > 0 && ankiSessionCardCount(ledger, card.chatId) > limit) {
					card.status = "skipped";
					card.reason = ANKI_REASONS.sessionLimit;
					card.attempts = evaluations;
				}
			}
		});
	}

	/** A writer call that failed (anything but a missing model): the batch
	 *  backs off until ANKI_RECHECK_MESSAGES more messages, no wait counted. */
	async function backOff(record: ChatRecord, keys: ReadonlySet<string>): Promise<void> {
		const nowIso = deps.now().toISOString();
		await deps.updateLedger((ledger) => {
			for (const card of ledger.cards) {
				if (card.status !== "waiting" || !keys.has(card.key)) continue;
				card.checkedAt = record.messages.length;
				card.updatedAt = nowIso;
			}
		});
	}

	/** Age out, then hand the chat's due waiting records to the writer.
	 *  `record` null = the chat is gone: only the age-out applies. */
	async function evaluate(chatId: string, settings: AnkiSettings, record: ChatRecord | null, misses?: readonly AnkiMiss[]): Promise<void> {
		// The miss data is not stored: it comes from the fold. A record whose
		// miss the fold no longer yields (a trigger switched off since, a miss
		// from before the feature was on, a deleted chat) is an orphan: it
		// can never be written, so only the age-out applies to it.
		const byKey = new Map((record ? (misses ?? missesOf(record, settings)) : []).map((miss) => [miss.key, miss]));
		const now = deps.now();
		const cutoff = now.getTime() - ANKI_MAX_WAIT_DAYS * DAY_MS;
		const waiting = await deps.updateLedger((ledger) => {
			const left: Array<Pick<AnkiCardRecord, "key" | "checkedAt">> = [];
			for (const card of ledger.cards) {
				if (card.chatId !== chatId || card.status !== "waiting") continue;
				const exempt = waitsOnlyForModel(card) && byKey.has(card.key);
				if (Date.parse(card.createdAt) <= cutoff && !exempt) {
					card.status = "skipped";
					card.reason = ANKI_REASONS.neverExplained;
					card.updatedAt = now.toISOString();
				} else {
					left.push({ key: card.key, checkedAt: card.checkedAt });
				}
			}
			return left;
		});
		if (waiting.length === 0 || !record) return;

		// Due for the writer: the tutor had its grace replies to make the card
		// itself; the tutor has replied to it (an answer can be
		// saved before the reply, and a failed turn may settle with none); a
		// teach chat still probing has taught nothing yet, so its predict
		// misses wait for the probe to finish; a miss the writer saw is
		// looked at again only after a few more messages. A probe miss is due
		// at once: the probe showed its correct answer and explanation with
		// the answer, and the teacher makes no card for it. Not due = nothing
		// changes.
		const probing = record.kind !== "practice" && !hasProbeDone(record.messages);
		const length = record.messages.length;
		const evaluable = waiting
			.filter((card) => card.checkedAt === undefined || length - card.checkedAt >= ANKI_RECHECK_MESSAGES)
			.flatMap((card) => byKey.get(card.key) ?? [])
			.filter((miss) => !(probing && missNeedsTeaching(miss)))
			.filter((miss) => miss.phase === "practice" || ankiMissExplainedOnAnswer(miss) || repliedAfter(record, miss))
			// The reserve: the tutor makes the card itself while it explains;
			// the writer takes the miss only after the tutor's grace replies.
			.filter((miss) => ankiMissExplainedOnAnswer(miss) || repliesAfter(record, miss) >= ANKI_TUTOR_GRACE_REPLIES)
			.sort((a, b) => a.messageIndex - b.messageIndex);
		if (evaluable.length === 0) return;

		const engine = await resolveEngine(chatId);
		if (!engine) {
			await markNoModel(new Set(evaluable.map((miss) => miss.key)));
			return;
		}
		const failures: string[] = [];
		for (let start = 0; start < evaluable.length; start += ANKI_WRITER_BATCH) {
			const batch = evaluable.slice(start, start + ANKI_WRITER_BATCH);
			const transcripts = Object.fromEntries(
				batch.map((miss) => [miss.key, excerpt(record, miss, missNeedsTeaching(miss) ? ANKI_EXCERPT_TEACHING_CHARS : ANKI_EXCERPT_CHARS)]),
			);
			// Read per batch: cards written by the previous batch count.
			const existing = ankiExistingCards(deps.readLedger(), chatId, batch);
			let decisions: AnkiWriterDecision[];
			try {
				decisions = await deps.writer({ chatId, misses: batch, transcripts, existing, engine });
			} catch (err) {
				if (err instanceof ModelsNotConfiguredError || err instanceof ProviderKeyMissingError) {
					await markNoModel(new Set(evaluable.slice(start).map((miss) => miss.key)));
					break;
				}
				failures.push(errorMessage(err));
				await backOff(record, new Set(batch.map((miss) => miss.key)));
				continue;
			}
			await applyDecisions(record, settings, decisions);
		}
		if (failures.length > 0) {
			console.error(`[anki ${chatId}] the card writer failed on ${failures.length} batch(es); retrying after more messages: ${failures[0]}`);
		}
	}

	// ── 3. queued records → Anki ──

	async function flush(): Promise<void> {
		const settings = deps.settings();
		if (!settings.enabled) return;
		const queued = deps.readLedger().cards.filter((card) => card.status === "queued" && card.card);
		if (queued.length === 0) return;
		// Cards of their own first: a duplicate waits for its host's note.
		const order = [...queued.filter((card) => !card.duplicateOf), ...queued.filter((card) => card.duplicateOf)];
		const client = deps.client(settings);
		const locale = deps.locale();
		let noteTypeReady = false;
		const decksReady = new Set<string>();
		let sent = 0;

		async function addNote(card: AnkiCardRecord & { card: AnkiCardDraft }): Promise<number> {
			if (!noteTypeReady) {
				await client.ensureNoteType();
				noteTypeReady = true;
			}
			const deck = card.deck ?? ankiDeckName(settings.deckTemplate, { folderPath: deps.folderPath(card.chatId), sessionTitle: card.sessionTitle });
			if (!decksReady.has(deck)) {
				await client.ensureDeck(deck);
				decksReady.add(deck);
			}
			const fields = ankiNoteFields(card, { date: new Date(card.createdAt), locale });
			try {
				return await client.addCardNote({ deck, fields, tags: card.tags ?? ankiTags(card) });
			} catch (err) {
				if (blocksEveryCard(err) || !(err instanceof AnkiActionError)) throw err;
				if (!isAnkiDuplicateError(err)) throw new NoteRefusedError(err.message, { cause: err });
				// A retried send: the note with this LH ID is already there.
				const noteId = await client.findNoteByLhId(card.id);
				if (noteId === null) throw new NoteRefusedError(err.message, { cause: err });
				return noteId;
			}
		}

		/** Apply to the record if it is still queued; false when it changed
		 *  meanwhile (the user removed it). */
		function commit(id: string, change: (card: AnkiCardRecord) => void): Promise<boolean> {
			return deps.updateLedger((ledger) => {
				const card = ledger.cards.find((c) => c.id === id);
				if (!card || card.status !== "queued") return false;
				change(card);
				card.updatedAt = deps.now().toISOString();
				return true;
			});
		}

		for (const snapshot of order) {
			const ledger = deps.readLedger();
			const card = ledger.cards.find((c) => c.id === snapshot.id);
			if (!card || card.status !== "queued" || !card.card) continue;
			const ready = card as AnkiCardRecord & { card: AnkiCardDraft };
			try {
				const host = card.duplicateOf ? ledger.cards.find((c) => c.id === card.duplicateOf) : undefined;
				if (card.duplicateOf && canHostDuplicate(host)) {
					// Its host has no note yet: wait for it.
					if (host.noteId === undefined) continue;
					let hostGone = false;
					try {
						// false = the host's cards are new or in learning: they
						// come up anyway, nothing to bring forward.
						await client.resurface(host.noteId);
					} catch (err) {
						if (!(err instanceof AnkiNoteGoneError)) throw err;
						hostGone = true;
					}
					if (!hostGone) {
						await commit(card.id, (c) => {
							c.status = "sent";
							c.sentAt = deps.now().toISOString();
							delete c.reason;
						});
						sent++;
						continue;
					}
				}
				// No duplicate, or its host was removed (from the ledger or
				// from Anki): a card of its own.
				const noteId = await addNote(ready);
				const applied = await commit(card.id, (c) => {
					c.status = "sent";
					c.noteId = noteId;
					c.sentAt = deps.now().toISOString();
					delete c.duplicateOf;
					delete c.reason;
				});
				if (applied) sent++;
				else {
					// Removed while the note was being added: take it back out.
					await client.deleteNote(noteId).catch((err) => console.error(`[anki] could not delete note ${noteId} of a removed card:`, err));
				}
			} catch (err) {
				const message = errorMessage(err);
				if (blocksEveryCard(err)) {
					// Anki closed, locked or not set up: everything stays queued
					// for the next run. Closed or locked shows in the connection
					// status; a setup or protocol problem goes on the card.
					if (err instanceof AnkiProtocolError || err instanceof AnkiSetupError) {
						await commit(card.id, (c) => {
							c.reason = message;
						});
					}
					console.info(`[anki] cards stay queued: ${message}`);
					break;
				}
				if (err instanceof NoteRefusedError) {
					await commit(card.id, (c) => {
						c.attempts += 1;
						c.reason = message;
						if (c.attempts >= ANKI_MAX_SEND_ATTEMPTS) c.status = "failed";
					});
					console.error(`[anki] Anki refused card ${card.id}:`, message);
					continue;
				}
				// Anything else is not this note's fault: no attempt counted;
				// the card stays queued with the reason, the others go on.
				await commit(card.id, (c) => {
					c.reason = message;
				});
				console.error(`[anki] sending card ${card.id} failed:`, err);
			}
		}
		if (sent > 0) console.info(`[anki] ${sent} card(s) sent to Anki`);
	}

	const requestFlush = coalesced(async () => {
		try {
			await flush();
		} catch (err) {
			console.error("[anki] flush failed:", err);
		}
	});

	// ── the run ──

	async function run(chatId?: string): Promise<void> {
		let settings: AnkiSettings;
		try {
			settings = deps.settings();
		} catch (err) {
			console.error("[anki] the settings could not be read:", err);
			return;
		}
		if (!settings.enabled) return;
		if (chatId) {
			await perChat(chatId, async () => {
				const fresh = deps.settings();
				if (!fresh.enabled) return;
				const record = deps.getChat(chatId);
				const misses = record ? missesOf(record, fresh) : [];
				if (record) await ingest(record, misses);
				await evaluate(chatId, fresh, record, misses);
			});
		} else {
			let chats: string[] = [];
			try {
				chats = [...new Set(deps.readLedger().cards.filter((card) => card.status === "waiting").map((card) => card.chatId))];
			} catch (err) {
				console.error("[anki] the card ledger could not be read:", err);
			}
			for (const id of chats) {
				await perChat(id, async () => {
					const fresh = deps.settings();
					if (!fresh.enabled) return;
					await evaluate(id, fresh, deps.getChat(id));
				});
			}
		}
		await requestFlush();
	}

	function subscribe(): () => void {
		const debounceMs = deps.debounceMs ?? ANKI_DEBOUNCE_MS;
		const timers = new Map<string, ReturnType<typeof setTimeout>>();
		const unsubscribe = (deps.subscribe ?? subscribeToBus)((event) => {
			if (event.type !== "turn-settled" && event.type !== "record-changed") return;
			const chatId = (event as { chatId?: unknown }).chatId;
			if (typeof chatId !== "string" || !chatId) return;
			try {
				if (!deps.settings().enabled) return;
			} catch {
				return;
			}
			const previous = timers.get(chatId);
			if (previous) clearTimeout(previous);
			const timer = setTimeout(() => {
				timers.delete(chatId);
				void run(chatId);
			}, debounceMs);
			// Never keeps the process alive on its own.
			timer.unref?.();
			timers.set(chatId, timer);
		});
		return () => {
			unsubscribe();
			for (const timer of timers.values()) clearTimeout(timer);
			timers.clear();
		};
	}

	return {
		run: (chatId) => run(chatId).catch((err) => console.error("[anki] run failed:", err)),
		subscribe,
	};
}

// ─── the real wiring ────────────────────────────────────────────────────────

/** chat-handler's private admission check, reimplemented: a subscription
 *  connection must allow background use, and the Claude Code connection
 *  needs its opt-in and installation. */
function connectionBackgroundAllowed(provider: string): boolean {
	return subscriptionBackgroundAllowed(provider) && (provider !== CLAUDE_CODE_PROVIDER || providerKeyPresent(provider));
}

/** The cheap slot, exactly as chat-handler's resolveEngine builds the
 *  extractor's engine (role override → slot), read fresh per run. A
 *  subscription connection's status is checked first, as chat-handler does
 *  before a turn (refreshConnectionCatalog): after a restart it is unknown
 *  until something asks, and the writer may run before any turn has. */
async function resolveWriterEngine(): Promise<PiEngine | undefined> {
	const spec = resolveRoleSpec("extractor", stores.settingsStore.readSettings());
	if (!spec) return undefined;
	await refreshConnectionCatalog(spec.provider);
	if (!connectionBackgroundAllowed(spec.provider) || !providerKeyPresent(spec.provider)) return undefined;
	const slot = ROLE_SLOT.extractor;
	return piEngineForSpec(spec, true, undefined, () => stores.settingsStore.readSettings()?.models?.[slot]?.cacheRetention);
}

function realDeps(): AnkiPipelineDeps {
	return {
		settings: ankiSettings,
		getChat: (chatId) => stores.chatStore.getChat(chatId),
		readLedger: readAnkiLedger,
		updateLedger: updateAnkiLedger,
		client: (settings) => createAnkiClient({ url: settings.url, apiKey: settings.apiKey }),
		writer: writeAnkiCards,
		engine: resolveWriterEngine,
		folderPath: ankiChatFolderPath,
		now: () => new Date(),
		locale: () => languageSettings().ui,
	};
}

// One pipeline per process (globalThis: Next compiles instrumentation and
// each route as separate module instances, and the locks must be shared).
const PIPELINE = Symbol.for("lh.anki.pipeline");
const UNSUBSCRIBE = Symbol.for("lh.anki.pipeline.unsubscribe");
const globalState = globalThis as typeof globalThis & { [PIPELINE]?: AnkiPipeline; [UNSUBSCRIBE]?: () => void };

function pipeline(): AnkiPipeline {
	return (globalState[PIPELINE] ??= createAnkiPipeline(realDeps()));
}

const inTests = (): boolean => process.env.NODE_ENV === "test";

/** One run now: with a chat id, that chat's misses; without, every chat's
 *  waiting cards. Then queued cards go to Anki. A no-op while the feature is
 *  off, and under tests (which drive createAnkiPipeline with fakes).
 *  Never rejects. */
export function runAnkiPipeline(chatId?: string): Promise<void> {
	if (inTests()) return Promise.resolve();
	return pipeline().run(chatId);
}

/** Subscribe the pipeline to the event bus, once per process. */
export function registerAnkiPipeline(): void {
	if (inTests() || globalState[UNSUBSCRIBE]) return;
	globalState[UNSUBSCRIBE] = pipeline().subscribe();
}
