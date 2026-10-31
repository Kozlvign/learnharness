/**
 * Anki cards from mistakes, the tutor's card tool on the server (fork
 * feature, docs/anki.md): what `anki_card` does when the teacher or the
 * practice agent calls it.
 *
 * The tutor writes the card right after explaining a learner mistake, or
 * when the learner asks for one. The card goes into the ledger as `queued`
 * (`writtenBy: "tutor"`) and reaches Anki with the pipeline's next flush,
 * at the end of the reply. A mistake card is tied to its miss: the stored
 * chat record's misses are folded and the tutor's question hint picks one
 * (`ankiMatchMiss`). When none matches (a practice problem concluded in this
 * same turn: the record is stored at turn end), the card is kept unlinked
 * with its hint, and the pipeline links it once the record shows the miss.
 * Either way the reserve writer never makes a second card for that miss.
 *
 * Light by design: the chat handler imports it. The chat and folder stores
 * directly, no pipeline, no model stack.
 */

import {
	type AnkiCardDraft,
	type AnkiCardRecord,
	type AnkiCardToolInput,
	type AnkiCardToolResult,
	type AnkiLedger,
	type AnkiMiss,
	type AnkiPhase,
	CONFIDENT_ERROR_MIN,
} from "../../core/anki/contract.ts";
import { ankiCardId, ankiDeckName, ankiTags } from "../../core/anki/format.ts";
import { ankiMatchMiss, ankiMissesOf } from "../../core/anki/misses.ts";
import type { ChatRecord } from "../../core/contracts/chat.ts";
import { placementOf, type SourceOrganization } from "../../core/source-organization.ts";
import { chatStore } from "../../store/chats.ts";
import { sourceOrganizationStore } from "../../store/source-organization.ts";
import { ankiSettings, updateAnkiLedger } from "./store.ts";

/** What the tool's execute returns: `text` for the tutor, `details` for
 *  the record and the chat's card. */
export interface AnkiCardToolOutcome {
	text: string;
	details: AnkiCardToolResult;
}

/** The phases a tutor card can come from (the prober has no card tool). */
export type AnkiTutorPhase = Extract<AnkiPhase, "teach" | "practice">;

/** At most this many misses in the reminder after a saved card. */
export const ANKI_REMINDER_MAX = 5;
const REMINDER_CHARS = 100;

// ─── shared record helpers (also used by the pipeline) ──────────────────────

/** The source's folder path in the sources list, outermost first ([] at
 *  the root, or when the placement points at a folder that is gone). */
export function ankiFolderPathOf(organization: SourceOrganization, sourceId: string): string[] {
	const names: string[] = [];
	const seen = new Set<string>();
	let folderId = placementOf(organization, sourceId)?.folderId ?? null;
	while (folderId !== null && !seen.has(folderId)) {
		seen.add(folderId);
		const folder = organization.folders.find((f) => f.id === folderId);
		if (!folder) break;
		names.unshift(folder.name);
		folderId = folder.parentId;
	}
	return names;
}

/** The chat's folder path from the stored source organization. */
export function ankiChatFolderPath(chatId: string): string[] {
	try {
		return ankiFolderPathOf(sourceOrganizationStore.read(), chatId);
	} catch (err) {
		console.error("[anki] the source organization could not be read:", err);
		return [];
	}
}

/** A ledger record for a miss, not written yet (`waiting`). */
export function ankiRecordForMiss(miss: AnkiMiss, sessionTitle: string, nowIso: string): AnkiCardRecord {
	return {
		id: ankiCardId(miss.key),
		key: miss.key,
		chatId: miss.chatId,
		toolCallId: miss.toolCallId,
		sessionTitle,
		phase: miss.phase,
		kind: miss.kind,
		missClass: miss.missClass,
		confident: miss.kind === "wrong" && miss.confidence !== null && miss.confidence >= CONFIDENT_ERROR_MIN,
		targets: [...miss.targets],
		status: "waiting",
		attempts: 0,
		createdAt: nowIso,
		updatedAt: nowIso,
	};
}

/** Miss key → the record that has it as its key or covers it. A miss is
 *  known to the ledger when either holds. */
export function ankiRecordsByMiss(ledger: AnkiLedger): Map<string, AnkiCardRecord> {
	const byMiss = new Map<string, AnkiCardRecord>();
	for (const card of ledger.cards) {
		if (card.covers && !byMiss.has(card.covers)) byMiss.set(card.covers, card);
	}
	for (const card of ledger.cards) byMiss.set(card.key, card);
	return byMiss;
}

/** Counts toward the per-session limit: a mistake card of its own, in Anki
 *  or on its way. Cards the learner asked for are outside the limit. */
export function ankiCountsTowardLimit(card: AnkiCardRecord): boolean {
	return (card.status === "queued" || card.status === "sent") && !card.duplicateOf && card.kind !== "request";
}

/** The session's mistake cards so far. */
export function ankiSessionCardCount(ledger: AnkiLedger, chatId: string): number {
	return ledger.cards.filter((card) => card.chatId === chatId && ankiCountsTowardLimit(card)).length;
}

/** Write the card on the record: queued, by `writtenBy`, with the deck and
 *  tags fixed now (the chat's current title and folder). Send attempts
 *  start over. */
export function ankiWriteCard(
	card: AnkiCardRecord,
	draft: AnkiCardDraft,
	opts: { writtenBy: "tutor" | "writer"; sessionTitle: string; deck: string; nowIso: string },
): void {
	card.sessionTitle = opts.sessionTitle;
	card.card = { ...draft };
	card.writtenBy = opts.writtenBy;
	card.deck = opts.deck;
	card.tags = ankiTags(card);
	card.status = "queued";
	card.attempts = 0;
	card.updatedAt = opts.nowIso;
	delete card.reason;
}

// ─── the tool's server side ─────────────────────────────────────────────────

function refuse(error: string): AnkiCardToolOutcome {
	return { text: error, details: { ok: false, error } };
}

function clip(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/** The misses still without a card (no record, or one still waiting),
 *  newest first; free-text answers last (they may have been right). */
function reminder(misses: readonly AnkiMiss[], ledger: AnkiLedger, except: string | null): string {
	const byMiss = ankiRecordsByMiss(ledger);
	const open = misses
		.filter((miss) => miss.key !== except && miss.question.trim() !== "")
		.filter((miss) => {
			const card = byMiss.get(miss.key);
			return !card || card.status === "waiting";
		})
		.sort((a, b) => Number(a.kind === "freeText") - Number(b.kind === "freeText") || b.messageIndex - a.messageIndex)
		.slice(0, ANKI_REMINDER_MAX);
	if (open.length === 0) return "";
	return [
		"",
		"Mistakes still without a card (make each one's card once you have explained it; skip any the learner got right):",
		...open.map((miss) => `- "${clip(miss.question, REMINDER_CHARS)}"`),
	].join("\n");
}

type Decision =
	| { ok: false; error: string }
	| { ok: true; card: AnkiCardRecord; linked: AnkiMiss | null };

/**
 * The anki_card call: save the tutor's card in the ledger (queued, tied to
 * its miss when one matches), or refuse with a reason the tutor can act on.
 * Never throws for a refusal; `text` goes back to the tutor.
 */
export async function createTutorCard(
	chatId: string,
	phase: AnkiTutorPhase,
	input: AnkiCardToolInput,
	toolCallId: string,
): Promise<AnkiCardToolOutcome> {
	const settings = ankiSettings();
	if (!settings.enabled) return refuse("Anki cards are turned off; no card was made.");
	const draft: AnkiCardDraft = {
		front: input.front.trim(),
		back: input.back.trim(),
		why: (input.why ?? "").trim(),
		pitfall: (input.pitfall ?? "").trim(),
	};
	if (!draft.front || !draft.back) return refuse("A card needs a front and a back; no card was made.");
	const record: ChatRecord | null = chatStore.getChat(chatId);
	if (!record) return refuse(`Chat not found: ${chatId}`);

	const misses = input.reason === "mistake" ? ankiMissesOf(record, settings) : [];
	const matched = input.reason === "mistake" ? ankiMatchMiss(misses, input.question) : null;
	const sessionTitle = record.title;
	const deck = ankiDeckName(settings.deckTemplate, { folderPath: ankiChatFolderPath(chatId), sessionTitle });
	const limit = settings.perSessionLimit;
	const limitReached = (ledger: AnkiLedger) => input.reason === "mistake" && limit > 0 && ankiSessionCardCount(ledger, chatId) >= limit;
	const limitText = `This session already has its ${limit} mistake cards (the learner's limit); no card was made.`;

	let reminderText = "";
	const decision = await updateAnkiLedger((ledger): Decision => {
		const nowIso = new Date().toISOString();
		const write = (card: AnkiCardRecord) => ankiWriteCard(card, draft, { writtenBy: "tutor", sessionTitle, deck, nowIso });

		// A retried call (same call id): the card is already saved.
		const ownKey = `${chatId}:${toolCallId}`;
		const again = ledger.cards.find((card) => card.key === ownKey);
		if (again) return { ok: true, card: again, linked: null };

		if (matched) {
			const known = ankiRecordsByMiss(ledger).get(matched.key);
			if (known) {
				if (known.status === "queued" || known.status === "sent" || known.status === "failed") {
					return { ok: false, error: `This mistake already has a card: "${clip(known.card?.front ?? "", 160)}".` };
				}
				if (known.status === "removed") return { ok: false, error: "No card for this mistake: the learner removed its card, so it is not made again." };
				if (known.status === "skipped") {
					return { ok: false, error: `No card for this mistake: it was skipped${known.reason ? ` (${known.reason})` : ""}.` };
				}
			}
			if (limitReached(ledger)) return { ok: false, error: limitText };
			// Waiting for the reserve writer, or not in the ledger yet.
			const card = known ?? ankiRecordForMiss(matched, sessionTitle, nowIso);
			if (!known) ledger.cards.push(card);
			write(card);
			delete card.checkedAt;
			reminderText = reminder(misses, ledger, matched.key);
			return { ok: true, card, linked: matched };
		}

		if (limitReached(ledger)) return { ok: false, error: limitText };
		// A card the learner asked for, or a mistake the stored record does not
		// show yet: keyed by this call.
		const card: AnkiCardRecord = {
			id: ankiCardId(ownKey),
			key: ownKey,
			chatId,
			toolCallId,
			sessionTitle,
			phase,
			// An unlinked mistake reads as "wrong" until the pipeline links it
			// to its miss (which brings the miss's kind, class and targets).
			kind: input.reason === "request" ? "request" : "wrong",
			missClass: null,
			confident: false,
			targets: [],
			status: "queued",
			attempts: 0,
			createdAt: nowIso,
			updatedAt: nowIso,
		};
		const hint = input.reason === "mistake" ? (input.question ?? "").trim() : "";
		if (hint) card.questionHint = hint;
		write(card);
		ledger.cards.push(card);
		if (input.reason === "mistake") reminderText = reminder(misses, ledger, null);
		return { ok: true, card, linked: null };
	});

	if (!decision.ok) return refuse(decision.error);
	console.info(`[anki ${chatId}] the tutor wrote card ${decision.card.id}${decision.linked ? ` for ${decision.linked.key}` : ""}`);
	return {
		text: `Card saved. It goes to the learner's Anki at the end of this reply.${reminderText ? `\n${reminderText}` : ""}`,
		details: { ok: true, cardId: decision.card.id, linked: decision.linked !== null },
	};
}
