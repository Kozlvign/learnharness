"use client";
/**
 * The tutor's Anki card in the chat (fork feature, docs/anki.md): the
 * `anki_card` tool part. Collapsed, the front; expanded, the back, why and
 * pitfall, where the card stands (read from the ledger with
 * GET /api/anki/cards/<id>), and Remove with the same two-step confirm as
 * Settings → Anki. The same view, inline, shows a probe question's card
 * inside its answered card (./anki-question-card.tsx).
 *
 * Parse, don't cast (src/core/tool-parts.ts): the input is the model's and
 * shows only if the tool's own schema parses it; the output is ours. A
 * refusal (`ok: false`, e.g. the miss already has a card) and an errored
 * call are model-facing bookkeeping: nothing renders. While the input
 * streams, the chat's LiveToolCard shows the call.
 *
 * The card text is the learner's content: Markdown with math, rendered the
 * way the chat renders it (and never translated).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import { ToolContentResponse } from "@/components/ai-elements/message";
import { cn } from "@/lib/utils";
import {
	parseAnkiCardToolInput,
	type AnkiCardRecord,
	type AnkiCardToolInput,
	type AnkiCardToolResult,
	type ArtifactPartProps,
} from "@/src/core";
import { ANKI_REQUEST_FAILED, loadAnkiCard, removeAnkiCard } from "./api";
import { ankiCardCanRemove, ankiCardReason, ankiCardRemovesNote, ankiCardStatusLabel } from "./card-record";

/** While the card waits to reach Anki, its status is read once more after
 *  this long (one look, no polling loop). */
export const ANKI_CHIP_RECHECK_MS = 5000;

const EYEBROW = "text-xs font-medium uppercase tracking-wide text-muted-foreground";
const ACTION = "shrink-0 text-xs text-foreground underline-offset-2 hover:underline disabled:text-muted-foreground/40 disabled:no-underline";

/** What the part shows: the parsed input and the card's id; null when
 *  nothing renders (still running, refused, errored, or unparsable). */
export function ankiCardChipData(part: ArtifactPartProps["part"]): { input: AnkiCardToolInput; cardId: string } | null {
	if (part.state !== "output-available") return null;
	const output = part.output as AnkiCardToolResult | null | undefined;
	if (!output || typeof output !== "object" || output.ok !== true || typeof output.cardId !== "string" || !output.cardId) return null;
	const input = parseAnkiCardToolInput(part.input);
	return input ? { input, cardId: output.cardId } : null;
}

export interface AnkiCardChipViewProps {
	input: AnkiCardToolInput;
	open: boolean;
	/** undefined = not read yet; null = the ledger has no such card. */
	record: AnkiCardRecord | null | undefined;
	/** Remove waits for Confirm. */
	confirming: boolean;
	/** The removal is running. */
	busy: boolean;
	/** The last failed removal. */
	error: string | null;
	onToggle: () => void;
	/** Remove pressed (true) or Cancel pressed (false). */
	onRemoveAsk: (asking: boolean) => void;
	/** Confirm pressed. */
	onRemove: () => void;
	/** Inside another card (a probe question's): no frame of its own, and
	 *  collapsed it is the header line alone, the front shows on expand. */
	inline?: boolean;
}

export function AnkiCardChipView({ input, open, record, confirming, busy, error, onToggle, onRemoveAsk, onRemove, inline = false }: AnkiCardChipViewProps) {
	const canRemove = !!record && ankiCardCanRemove(record);
	const reason = record ? ankiCardReason(record) : null;
	return (
		<div
			data-testid={inline ? "anki-question-card" : "anki-card-chip"}
			data-status={record?.status}
			className={inline ? "mt-3 border-t pt-2" : "lh-card-enter my-1 w-full max-w-2xl rounded-xl border bg-card p-3"}
		>
			<button
				type="button"
				aria-expanded={open}
				onClick={onToggle}
				className={cn("flex w-full cursor-pointer items-center gap-2 text-left", EYEBROW)}
				data-testid="anki-card-chip-toggle"
			>
				<span>Anki card created</span>
				{input.reason === "request" && (
					<span className="rounded bg-muted px-1.5 py-0.5 normal-case tracking-normal" data-testid="anki-card-chip-request">you asked</span>
				)}
				<ChevronRight aria-hidden="true" className={cn("ml-auto size-3 shrink-0 opacity-50 transition-transform", open && "rotate-90")} />
			</button>
			{(!inline || open) && (
				<div className="mt-1.5 text-[15px]" data-testid="anki-card-chip-front">
					<ToolContentResponse>{input.front}</ToolContentResponse>
				</div>
			)}
			{open && (
				<div className="mt-2 space-y-2 border-t pt-2" data-testid="anki-card-chip-details">
					{input.back.trim() && (
						<div className="text-sm font-semibold" data-testid="anki-card-chip-back">
							<ToolContentResponse>{input.back}</ToolContentResponse>
						</div>
					)}
					{input.why.trim() && (
						<div data-testid="anki-card-chip-why">
							<div className={EYEBROW}>Why</div>
							<div className="text-sm text-foreground/80">
								<ToolContentResponse>{input.why}</ToolContentResponse>
							</div>
						</div>
					)}
					{input.pitfall.trim() && (
						<div data-testid="anki-card-chip-pitfall">
							<div className={EYEBROW}>Pitfall</div>
							<div className="text-sm text-foreground/80">
								<ToolContentResponse>{input.pitfall}</ToolContentResponse>
							</div>
						</div>
					)}
					<div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 pt-1">
						{record !== null && (
							<span className="text-xs text-muted-foreground" data-testid="anki-card-chip-status">
								{record === undefined ? "Checking…" : ankiCardStatusLabel(record)}
							</span>
						)}
						{canRemove && record && (confirming ? (
							<span className="flex flex-wrap items-center justify-end gap-x-3 gap-y-0.5" data-testid="anki-card-chip-confirm">
								<span className="text-xs text-muted-foreground" data-testid="anki-card-chip-confirm-question">
									{ankiCardRemovesNote(record) ? "Remove from Anki?" : "Remove?"}
								</span>
								<button type="button" className={ACTION} disabled={busy} onClick={onRemove} data-testid="anki-card-chip-confirm-remove">
									Confirm
								</button>
								<button type="button" className={ACTION} disabled={busy} onClick={() => onRemoveAsk(false)} data-testid="anki-card-chip-cancel-remove">
									Cancel
								</button>
							</span>
						) : (
							<button type="button" className={ACTION} disabled={busy} onClick={() => onRemoveAsk(true)} data-testid="anki-card-chip-remove">
								Remove
							</button>
						))}
					</div>
					{reason && <p className="text-[11px] text-muted-foreground/70" data-testid="anki-card-chip-reason">{reason}</p>}
					{error && <p role="alert" className="text-xs text-red-500" data-testid="anki-card-chip-error">{error}</p>}
				</div>
			)}
		</div>
	);
}

export function AnkiCardChip({ part }: ArtifactPartProps) {
	const data = ankiCardChipData(part);
	return data ? <AnkiCardChipLive input={data.input} cardId={data.cardId} /> : null;
}

function AnkiCardChipLive({ input, cardId }: { input: AnkiCardToolInput; cardId: string }) {
	const live = useAnkiCardLive(cardId);
	const rechecked = useRef(false);

	// One more look while the card waits to reach Anki.
	const status = live.record?.status;
	const { read } = live;
	useEffect(() => {
		if ((status !== "queued" && status !== "waiting") || rechecked.current) return;
		const timer = setTimeout(() => {
			rechecked.current = true;
			void read();
		}, ANKI_CHIP_RECHECK_MS);
		return () => clearTimeout(timer);
	}, [status, read]);

	return <AnkiCardChipView input={input} {...live.viewProps} />;
}

/** A card's ledger record, read on mount, and the view's open / Remove
 *  state: the tutor's card in the chat and a probe question's card share
 *  it. `read` asks again (only the newest answer is shown). */
export function useAnkiCardLive(cardId: string) {
	const [open, setOpen] = useState(false);
	const [record, setRecord] = useState<AnkiCardRecord | null | undefined>(undefined);
	const [confirming, setConfirming] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const alive = useRef(true);
	// Only the newest request's answer is shown.
	const latest = useRef(0);

	const read = useCallback(async () => {
		const ticket = ++latest.current;
		try {
			const next = await loadAnkiCard(cardId);
			if (alive.current && ticket === latest.current) setRecord(next);
		} catch {
			// The status is a courtesy: a failed read keeps what was shown.
			if (alive.current && ticket === latest.current) setRecord((current) => (current === undefined ? null : current));
		}
	}, [cardId]);

	useEffect(() => {
		alive.current = true;
		void read();
		return () => {
			alive.current = false;
		};
	}, [read]);

	const remove = async () => {
		setConfirming(false);
		setBusy(true);
		setError(null);
		const ticket = ++latest.current;
		try {
			const next = await removeAnkiCard(cardId);
			const removed = next.cards.find((card) => card.id === cardId) ?? (record ? { ...record, status: "removed" as const } : null);
			if (alive.current && ticket === latest.current) setRecord(removed);
		} catch (failure) {
			if (alive.current) setError(failure instanceof Error && failure.message ? failure.message : ANKI_REQUEST_FAILED);
		} finally {
			if (alive.current) setBusy(false);
		}
	};

	const viewProps: Omit<AnkiCardChipViewProps, "input" | "inline"> = {
		open,
		record,
		confirming,
		busy,
		error,
		onToggle: () => {
			if (!open) void read();
			setOpen(!open);
		},
		onRemoveAsk: (asking) => {
			setConfirming(asking);
			setError(null);
		},
		onRemove: () => void remove(),
	};
	return { record, read, viewProps };
}
