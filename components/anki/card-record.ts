/**
 * A card record in words (fork feature, docs/anki.md): shared by Settings →
 * Anki's recent cards and the chat's card. Interface text only; the card's
 * own text is the learner's content and is rendered by the callers.
 */
import { ANKI_REASONS, type AnkiCardRecord } from "@/src/core";

export function ankiCardStatusLabel(card: AnkiCardRecord): string {
	switch (card.status) {
		case "waiting":
			return card.reason === ANKI_REASONS.noModel ? "Waiting for a background model" : "Waiting for the explanation";
		case "queued":
			return "Waiting for Anki";
		case "sent":
			return card.duplicateOf ? "Brought forward for review" : "In Anki";
		case "skipped":
			return "Skipped";
		case "failed":
			return "Failed";
		case "removed":
			return "Removed";
	}
}

/** Who made the card: the learner's request, the tutor (anki_card), or the
 *  reserve writer. A record with a card but no `writtenBy` predates the
 *  field and was the writer's; null before the card is written. */
export function ankiCardAuthorLabel(card: AnkiCardRecord): string | null {
	if (card.kind === "request") return "you asked";
	if (card.writtenBy === "tutor") return "by the tutor";
	if (card.writtenBy === "writer" || card.card) return "by the reserve writer";
	return null;
}

/** The reason shown under the status (skipped and failed cards only). */
export function ankiCardReason(card: AnkiCardRecord): string | null {
	return (card.status === "skipped" || card.status === "failed") && card.reason ? card.reason : null;
}

export function ankiCardCanOpen(card: AnkiCardRecord): boolean {
	return card.status === "sent" && typeof card.noteId === "number";
}

export function ankiCardCanRetry(card: AnkiCardRecord): boolean {
	return card.status === "failed";
}

export function ankiCardCanRemove(card: AnkiCardRecord): boolean {
	return card.status !== "removed" && card.status !== "skipped";
}

/** Removing this card deletes a note of its own from Anki (the server's rule:
 *  a card folded into another has none). */
export function ankiCardRemovesNote(card: AnkiCardRecord): boolean {
	return card.status === "sent" && typeof card.noteId === "number" && !card.duplicateOf;
}
