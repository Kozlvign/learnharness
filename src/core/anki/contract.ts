/**
 * Anki cards from mistakes (fork feature, docs/anki.md): the shared
 * vocabulary of the settings, the miss fold, the card ledger and the HTTP
 * API. Browser-safe: types and constants only.
 *
 * Flow: a learner miss in any phase (probe, teach checks, practice) is
 * found by a pure fold over the chat record (`ankiMissesOf`). The tutor
 * writes the card itself with its `anki_card` tool right after explaining
 * the correct idea (or when the learner asks for a card). The server
 * pipeline records every miss in the card ledger; a miss the tutor left
 * without a card for two replies goes to the reserve writer, a small
 * background model call. A probe miss goes to the writer at once: the
 * probe already showed the correct answer and its explanation. Cards reach the user's Anki through the
 * AnkiConnect add-on. Anki closed = the card waits in the ledger and goes
 * on the next run.
 */

import type { HintRung, MissClass } from "../evidence.ts";

export const ANKI_API = "/api/anki";
/** Writes carry this header, which a cross-site form cannot send. */
export const ANKI_HEADER = "x-learnharness-anki";
/** AnkiConnect's add-on code on AnkiWeb. */
export const ANKICONNECT_ADDON_CODE = "2055492159";
export const ANKICONNECT_DEFAULT_URL = "http://127.0.0.1:8765";
/** The legacy AnkiConnect protocol version this client speaks (POST /). */
export const ANKICONNECT_API_VERSION = 6;

/** The note type the integration owns. Its first field holds the ledger id,
 *  so Anki's first-field duplicate check never collides with user notes and
 *  a retried send finds the note it already created. */
export const ANKI_NOTE_TYPE_NAME = "LearnHarness";
export const ANKI_NOTE_FIELDS = ["LH ID", "Front", "Back", "Why", "Pitfall", "Source"] as const;
export type AnkiNoteField = (typeof ANKI_NOTE_FIELDS)[number];

/** The note type's single card template and styling. No words of its own:
 *  the field contents are already in the learner's language. */
export const ANKI_NOTE_TEMPLATE = Object.freeze({
	name: "Card 1",
	front: '<div class="lh-front">{{Front}}</div>',
	back:
		'{{FrontSide}}<hr id="answer"><div class="lh-back">{{Back}}</div>' +
		'{{#Why}}<div class="lh-why">{{Why}}</div>{{/Why}}' +
		'{{#Pitfall}}<div class="lh-pitfall">{{Pitfall}}</div>{{/Pitfall}}' +
		'<div class="lh-source">{{Source}}</div>',
	css:
		".card { font-family: system-ui, sans-serif; font-size: 20px; line-height: 1.5; text-align: left; max-width: 40em; margin: 0 auto; padding: 0 1em; }\n" +
		".lh-back { font-weight: 600; }\n" +
		".lh-why { margin-top: 0.8em; }\n" +
		".lh-pitfall { margin-top: 0.8em; padding: 0.4em 0.7em; border-left: 3px solid #d08700; }\n" +
		".lh-source { margin-top: 1.2em; font-size: 0.7em; opacity: 0.6; }\n",
});

/** Root tag; every other tag nests under it (`LearnHarness::phase::teach`). */
export const ANKI_ROOT_TAG = "LearnHarness";

// ─── settings (<data>/anki.json) ────────────────────────────────────────────

/**
 * Which misses become cards.
 * - wrong: a multiple-choice answer graded wrong (graded again on the server),
 *   or a free-text answer the card writer judges wrong or partial.
 * - dontKnow: "I don't know".
 * - lowConfidence: a correct multiple-choice answer given with confidence at
 *   or below `lowConfidenceMax` (a guess).
 * - practiceNotSolved: a practice problem concluded movedOn or surrendered.
 * - practiceHeavyHint: a practice problem solved only with a hint at rung R3
 *   or above (the practice doctrine reads R3+ as "over the edge").
 * Never cards: careless slips (missClass "careless") and skipped questions.
 */
export const ANKI_TRIGGERS = ["wrong", "dontKnow", "lowConfidence", "practiceNotSolved", "practiceHeavyHint"] as const;
export type AnkiTrigger = (typeof ANKI_TRIGGERS)[number];

export interface AnkiSettings {
	/** Off by default. */
	enabled: boolean;
	/** AnkiConnect's address. Only loopback http URLs are accepted
	 *  (127.0.0.1, localhost or [::1]); anything else falls back to the default. */
	url: string;
	/** AnkiConnect's optional apiKey; null = none. Never sent back to the
	 *  browser: AnkiStatus carries `apiKeySet` and `settings.apiKey` is null. */
	apiKey: string | null;
	/** Deck name template, `::` separates subdecks. Placeholders:
	 *  `{folder}` (alias `{pasta}`) = the session's folder path in the
	 *  sources list, nested with `::`; `{session}` (alias `{sessao}`) = the
	 *  session title. An empty placeholder drops its segment. */
	deckTemplate: string;
	triggers: Record<AnkiTrigger, boolean>;
	/** 0–100: a correct answer at or below this confidence counts as a guess. */
	lowConfidenceMax: number;
	/** Most cards one session may create; 0 = no limit. */
	perSessionLimit: number;
	/** ISO time the feature was last turned on, set by the server when
	 *  `enabled` goes from false to true (clients never send it). Misses
	 *  answered before it are ignored: turning the feature on does not turn
	 *  past mistakes into cards. null = unknown (treated as "no limit"). */
	enabledAt: string | null;
}

export const DEFAULT_ANKI_SETTINGS: AnkiSettings = Object.freeze({
	enabled: false,
	url: ANKICONNECT_DEFAULT_URL,
	apiKey: null,
	deckTemplate: "LearnHarness::{folder}",
	triggers: Object.freeze({
		wrong: true,
		dontKnow: true,
		lowConfidence: true,
		practiceNotSolved: true,
		practiceHeavyHint: true,
	}),
	lowConfidenceMax: 30,
	perSessionLimit: 10,
	enabledAt: null,
}) as AnkiSettings;

/** A wrong answer at or above this confidence is a confident error: the
 *  card gets the `LearnHarness::confident-error` tag (hypercorrection). */
export const CONFIDENT_ERROR_MIN = 70;

// ─── misses (pure fold over a chat record: src/core/anki/misses.ts) ─────────

export type AnkiPhase = "probe" | "teach" | "practice";

/** `freeText` = an `explain`/`recall` answer: the record carries no grade,
 *  so the card writer judges it from the tutor's reply. */
export type AnkiMissKind = "wrong" | "dontKnow" | "lowConfidence" | "freeText" | "practiceNotSolved" | "practiceHeavyHint";

export interface AnkiMiss {
	/** `${chatId}:${toolCallId}`, stable across reads. */
	key: string;
	chatId: string;
	/** The question's tool call id; the `problem` call id for practice. */
	toolCallId: string;
	phase: AnkiPhase;
	/** probe | recall | quiz | explain | problem */
	tool: string;
	kind: AnkiMissKind;
	/** Teach questions only. */
	questionType: "predict" | "check" | null;
	/** The question text, or the practice problem statement. */
	question: string;
	/** Multiple-choice option labels in authored order; [] otherwise. */
	options: string[];
	/** Multiple choice: the correct option label(s), joined with "; ".
	 *  explain/recall: the committed answer. Practice: the model solution. */
	correctAnswer: string;
	/** Multiple choice: the authored explanation. Practice: the verdict. */
	explanation: string;
	/** The selected label(s), the free text, or the practice attempts joined
	 *  with blank lines. "" on "I don't know". */
	learnerAnswer: string;
	/** The learner's thinking on the question (and while reading), if any. */
	learnerThinking: string;
	/** 0–100 or null (not asked, or "I don't know"). */
	confidence: number | null;
	missClass: MissClass | null;
	rung: HintRung | null;
	/** Graph proposition ids (practice targets); [] elsewhere. */
	targets: string[];
	/** The plan node's title (teach questions), or null. */
	planNode: string | null;
	/** Epoch ms of the answer (or the conclusion). */
	answeredAt: number;
	/** Index in record.messages of the answer (or the conclude call's message). */
	messageIndex: number;
}

/** A probe question shows its correct answer and explanation (the "Why",
 *  or Recall's committed answer) right after the learner answers. So a
 *  probe miss is explained already: the reserve writer makes its card at
 *  once, without waiting for the lesson or the tutor's replies, and the
 *  teacher makes none. */
export function ankiMissExplainedOnAnswer(miss: Pick<AnkiMiss, "phase">): boolean {
	return miss.phase === "probe";
}

/** A prediction comes before the teaching: its card waits until the tutor
 *  has explained the idea. */
export function missNeedsTeaching(miss: Pick<AnkiMiss, "phase" | "questionType">): boolean {
	return !ankiMissExplainedOnAnswer(miss) && miss.questionType === "predict";
}

// ─── the card writer (src/agent/subagents/anki-writer.ts) ───────────────────

/** Card text as Markdown with `$…$` math, in the learner's language. */
export interface AnkiCardDraft {
	/** A recall question (never multiple choice), one idea. */
	front: string;
	/** The answer, short. */
	back: string;
	/** Why it is so (may be ""). */
	why: string;
	/** The trap behind this miss and why it fails (may be ""). */
	pitfall: string;
}

// ─── the tutor's card tool (src/agent/tools/anki-card.ts) ───────────────────

/**
 * The teacher's and the practice agent's card tool, in their registries only
 * while the feature is on. Never the prober's: a probe miss gets its card
 * from the reserve writer right after the answer, which shows the correct
 * answer and its explanation (`ankiMissExplainedOnAnswer`).
 */
export const ANKI_CARD_TOOL = "anki_card";

/** Why the tutor makes a card: a learner mistake it has just explained, or
 *  the learner asked for a card ("make a card of this"). */
export const ANKI_CARD_REASONS = ["mistake", "request"] as const;
export type AnkiCardReason = (typeof ANKI_CARD_REASONS)[number];

export interface AnkiCardToolInput extends AnkiCardDraft {
	reason: AnkiCardReason;
	/** reason "mistake": the missed question's text, or the practice
	 *  problem's statement, as it was posed (its first words are enough).
	 *  The server links the card to that miss, so the reserve writer never
	 *  makes a second card for it. Ignored for "request". */
	question?: string;
}

/** The tool result's `details`: the chat's card reads `cardId`, then the
 *  record through GET /api/anki/cards/<id>. `linked` = tied to a miss. */
export type AnkiCardToolResult =
	| { ok: true; cardId: string; linked: boolean }
	| { ok: false; error: string };

/** The reserve writer does not consider a miss until the tutor has finished
 *  this many replies (turns) after it without making its card. */
export const ANKI_TUTOR_GRACE_REPLIES = 2;

export type AnkiWriterDecision =
	| {
			key: string;
			decision: "card";
			card: AnkiCardDraft;
			/** Ledger id of an existing card that already covers this same idea:
			 *  no new card; the existing one is brought forward for review today. */
			duplicateOf?: string;
	  }
	/** The correct idea has not been explained in the transcript yet. */
	| { key: string; decision: "wait"; reason: string }
	/** Not a real miss (a free-text answer judged right or unclear), or not
	 *  worth a card. */
	| { key: string; decision: "skip"; reason: string };

// ─── the card ledger (<data>/anki-cards.json) ───────────────────────────────

/**
 * - waiting: found; the writer has not produced a card yet (or answered "wait").
 * - queued: card written, not in Anki yet (Anki closed, or about to send).
 * - sent: in Anki (`noteId`), or folded into an existing card (`duplicateOf`).
 * - skipped: no card (`reason`: writer skip, session limit, never explained).
 * - failed: Anki refused the note (`reason`); retried a few times.
 * - removed: the user removed it; never re-created.
 */
export const ANKI_CARD_STATUSES = ["waiting", "queued", "sent", "skipped", "failed", "removed"] as const;
export type AnkiCardStatus = (typeof ANKI_CARD_STATUSES)[number];

/** A ledger record's kind: the miss kind, or "request" for a card the
 *  learner asked the tutor for (no miss behind it; outside the per-session
 *  limit; tag `LearnHarness::miss::requested`). */
export type AnkiCardKind = AnkiMissKind | "request";

/** Who wrote the card: the tutor (anki_card) or the reserve writer. */
export type AnkiCardAuthor = "tutor" | "writer";

export interface AnkiCardRecord {
	/** 16 hex chars, FNV-1a 64 of the key (`ankiCardId`). Also the note's
	 *  "LH ID" field, which must hold exactly this id. */
	id: string;
	/** The miss key (`${chatId}:${question toolCallId}`); for a tutor card not
	 *  linked to a miss when it was made (a request, or a miss the stored
	 *  record does not show yet), `${chatId}:${anki_card toolCallId}`. */
	key: string;
	chatId: string;
	/** The question's (or problem's) call id; the anki_card call id for an
	 *  unlinked tutor card. */
	toolCallId: string;
	sessionTitle: string;
	phase: AnkiPhase;
	kind: AnkiCardKind;
	/** Set when the card is written; absent while waiting (a record from
	 *  before this field, with a card, counts as "writer"). */
	writtenBy?: AnkiCardAuthor;
	/** An unlinked tutor mistake card: the question hint the tutor gave. The
	 *  pipeline links the card to the miss it matches once the record shows
	 *  it (`covers`), so that miss never gets a second card. */
	questionHint?: string;
	/** The miss key this unlinked tutor card was linked to later. A miss is
	 *  known to the ledger when a record has its key OR covers it. */
	covers?: string;
	missClass: MissClass | null;
	/** A wrong answer given with confidence ≥ CONFIDENT_ERROR_MIN. */
	confident: boolean;
	targets: string[];
	status: AnkiCardStatus;
	reason?: string;
	deck?: string;
	tags?: string[];
	card?: AnkiCardDraft;
	noteId?: number;
	duplicateOf?: string;
	/** While waiting: the writer's "wait" answers. Once queued: send
	 *  attempts (reset to 0 when the card is written). */
	attempts: number;
	/** The chat's message count when the writer last evaluated this miss.
	 *  A waiting miss is evaluated again only after ANKI_RECHECK_MESSAGES more
	 *  messages, so a long lesson does not use up its waits. */
	checkedAt?: number;
	/** ISO timestamps. */
	createdAt: string;
	updatedAt: string;
	sentAt?: string;
}

/** The fixed `reason` texts the pipeline writes (the interface translates
 *  them; a writer "skip" reason is free text in the learner's language). */
export const ANKI_REASONS = Object.freeze({
	sessionLimit: "Session limit reached",
	neverExplained: "Never explained in the session",
	noModel: "No background model available",
	removedByUser: "Removed by you",
});

/** A waiting miss is dropped (neverExplained) after this many "wait"
 *  answers from the writer, or this many days. Predict misses are not sent
 *  to the writer before the probe is done, and misses waiting only
 *  for a background model (ANKI_REASONS.noModel) are exempt from the days. */
export const ANKI_MAX_WAITS = 8;
/** New chat messages needed before a waiting miss is evaluated again. */
export const ANKI_RECHECK_MESSAGES = 4;
export const ANKI_MAX_WAIT_DAYS = 3;
/** A note Anki refuses is marked failed after this many attempts. */
export const ANKI_MAX_SEND_ATTEMPTS = 3;

export interface AnkiLedger {
	version: 1;
	cards: AnkiCardRecord[];
}

// ─── connection + HTTP API ──────────────────────────────────────────────────

export type AnkiConnection =
	| { state: "disabled" }
	| { state: "connected"; apiVersion: number; ankiVersion: string | null; profile: string | null }
	/** Nothing answered: Anki is closed, or AnkiConnect is not installed.
	 *  `addonInstalled` comes from the add-on folder (null = unknown). */
	| { state: "unreachable"; addonInstalled: boolean | null; error: string }
	/** AnkiConnect wants an apiKey and the stored one is missing or wrong. */
	| { state: "unauthorized"; error: string }
	| { state: "error"; error: string };

/**
 * GET  /api/anki                  → AnkiStatus (checks the connection live)
 * PUT  /api/anki                  a PARTIAL AnkiSettings, merged over the
 *                                 stored one → AnkiStatus. A field left out
 *                                 keeps its value. `apiKey`: a non-empty
 *                                 string sets it, null or "" clears it, left
 *                                 out keeps it (the browser never has it).
 *                                 `enabledAt` is ignored (server-managed).
 * POST /api/anki/sync             runs the pipeline now (writes waiting cards
 *                                 that are ready, sends queued ones) → AnkiStatus
 * GET  /api/anki/cards/<id>       → { card: AnkiCardRecord | null } from the
 *                                 ledger only (no Anki call): the chat's
 *                                 card status. No header needed.
 * POST /api/anki/cards/<id>       { action: "open" } → opens the note in
 *                                 Anki's browser → AnkiStatus
 *                                 { action: "retry" } → a failed record goes
 *                                 back to queued (attempts 0, reason cleared)
 *                                 and the pipeline runs → AnkiStatus
 * DELETE /api/anki/cards/<id>     removes the note from Anki (when sent) and
 *                                 marks the record removed → AnkiStatus
 * Writes need the same-origin rule plus ANKI_HEADER: "1".
 */
export interface AnkiStatus {
	/** `apiKey` is always null here; see `apiKeySet`. */
	settings: AnkiSettings;
	apiKeySet: boolean;
	connection: AnkiConnection;
	/** Newest first, at most 100. */
	cards: AnkiCardRecord[];
	/** waiting + queued. */
	pending: number;
}
