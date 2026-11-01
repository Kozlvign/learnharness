"use client";
/**
 * A probe question's Anki card, inside its answered card (fork feature,
 * docs/anki.md). The probe shows the correct answer and its explanation
 * right after the answer, so the reserve writer makes a probe mistake's card
 * seconds later. It shows here as one line, "Anki card created", that opens
 * to the card, where it stands, and Remove: the tutor's card view, inline.
 *
 * The card's id comes from the miss key (`${chatId}:${toolCallId}`), so no
 * request is needed to learn it. The ledger is read on mount, again on
 * `anki-changed` for this chat (the card is written after the answer is
 * shown) and on a reconnect. Nothing shows until the card is written, nor
 * for a mistake that was skipped, an answer that was no mistake, or while
 * the feature is off.
 */
import { useMemo } from "react";
import { useServerEvent, useServerResync } from "@/components/server-events";
import { ankiCardId, type AnkiCardRecord, type AnkiCardStatus } from "@/src/core";
import { AnkiCardChipView, useAnkiCardLive } from "./anki-card-chip";

/** The statuses of a written card that the line shows. */
const SHOWN: ReadonlySet<AnkiCardStatus> = new Set(["queued", "sent", "failed", "removed"]);

/** The record the line shows: a written card that is on its way, in Anki,
 *  refused, or removed. */
export function ankiQuestionCardShown(
	record: AnkiCardRecord | null | undefined,
): record is AnkiCardRecord & { card: NonNullable<AnkiCardRecord["card"]> } {
	return !!record?.card && SHOWN.has(record.status);
}

export function AnkiQuestionCard({ chatId, toolCallId }: { chatId: string; toolCallId: string }) {
	const cardId = useMemo(() => ankiCardId(`${chatId}:${toolCallId}`), [chatId, toolCallId]);
	const live = useAnkiCardLive(cardId);
	const { read, record } = live;
	useServerEvent("anki-changed", (event) => {
		if (event.chatId === chatId) void read();
	});
	useServerResync(() => void read());
	if (!ankiQuestionCardShown(record)) return null;
	return <AnkiCardChipView inline input={{ reason: "mistake", ...record.card }} {...live.viewProps} />;
}
