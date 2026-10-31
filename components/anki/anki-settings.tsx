"use client";
/**
 * Settings → Anki (fork feature, docs/anki.md): cards from mistakes. The
 * switch, the AnkiConnect connection, the deck, which misses become cards,
 * the per-session limit, the add-on's API key, and the recent cards with
 * where each one stands. Self-contained: it reads and writes /api/anki
 * itself, like the dictation settings.
 *
 * Calm on purpose: states are words, never coloured badges. Card text is
 * the learner's content (`data-lh-i18n="off"`); session titles and skip
 * reasons (the writer's own words) translate only as whole known phrases
 * ("names"); failure reasons are Anki's and the client's messages, so the
 * catalog's patterns translate them. Remove asks first: on a card in Anki
 * it deletes the note and its review history.
 *
 * Writes send only the changed fields (the server merges them). The API
 * key is write-only: the server never sends it back (`apiKeySet` says
 * whether one is stored) and the field never shows it.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
	ANKI_TRIGGERS,
	ANKICONNECT_ADDON_CODE,
	DEFAULT_ANKI_SETTINGS,
	type AnkiCardRecord,
	type AnkiConnection,
	type AnkiStatus,
	type AnkiTrigger,
} from "@/src/core";
import { Button } from "@/components/ui/button";
import { CommitInput, SettingsGroup, SettingsRow, ThinSelect, Toggle } from "@/components/settings/controls";
import {
	ANKI_REQUEST_FAILED,
	loadAnkiStatus,
	openAnkiCard,
	removeAnkiCard,
	retryAnkiCard,
	saveAnkiSettings,
	syncAnki,
	type AnkiSettingsPatch,
} from "./api";
import {
	ankiCardAuthorLabel,
	ankiCardCanOpen,
	ankiCardCanRemove,
	ankiCardCanRetry,
	ankiCardReason,
	ankiCardRemovesNote,
	ankiCardStatusLabel,
} from "./card-record";
import { SecretInput } from "./secret-input";

/** How many of the newest cards the list shows. */
export const ANKI_RECENT_CARDS = 20;
/** The card front's length in the list, "…" included. */
export const ANKI_FRONT_MAX = 90;
/** The per-session limits offered; 0 = no limit. */
export const ANKI_LIMITS = [5, 10, 20, 0] as const;

export const ANKI_TRIGGER_LABELS: Readonly<Record<AnkiTrigger, string>> = {
	wrong: "Wrong answers",
	dontKnow: "“I don't know”",
	lowConfidence: "Lucky guesses (right, with low confidence)",
	practiceNotSolved: "Practice problems not solved",
	practiceHeavyHint: "Practice problems solved only with strong hints",
};

const ENABLE_LABEL = "Create Anki cards from mistakes";
const API_KEY_LABEL = "AnkiConnect API key (optional)";
const ACTION = "shrink-0 text-xs text-foreground underline-offset-2 hover:underline disabled:text-muted-foreground/40 disabled:no-underline";

// ─── pure helpers (exported for the render tests) ──────────────────────────

/** The connection's status line and the lines under it. */
export function ankiConnectionText(connection: AnkiConnection): { status: string | null; details: string[] } {
	switch (connection.state) {
		case "connected":
			return {
				status: connection.ankiVersion ? `Connected to Anki ${connection.ankiVersion}` : "Connected to Anki",
				details: connection.profile ? [`Profile: ${connection.profile}`] : [],
			};
		case "unreachable":
			return connection.addonInstalled === false
				? {
						status: "AnkiConnect is not installed.",
						details: [`In Anki: Tools → Add-ons → Get Add-ons…, code ${ANKICONNECT_ADDON_CODE}, then restart Anki.`],
					}
				: { status: "Anki is closed. Open Anki and check again.", details: [] };
		case "unauthorized":
			return { status: "AnkiConnect asked for an API key. Enter the key from its settings below.", details: [] };
		case "error":
			return { status: "Could not reach AnkiConnect.", details: connection.error ? [connection.error] : [] };
		default:
			return { status: null, details: [] };
	}
}

/** Light Markdown cleanup for a one-line preview: emphasis, code ticks,
 *  links, headings, quotes and bullets go; `$…$` math stays as written. */
export function ankiPlainText(markdown: string): string {
	const lines = markdown.replace(/^[ \t]{0,3}(#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+)/gm, "");
	return lines
		.split(/(\$\$[\s\S]*?\$\$|\$[^$\n]+\$)/)
		.map((part, index) =>
			index % 2 === 1
				? part
				: part
						.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
						.replace(/(\*\*|__|~~)(?=\S)([\s\S]*?\S)\1/g, "$2")
						.replace(/(^|[^\w*])([*_])(?=\S)([\s\S]*?\S)\2(?![\w*])/g, "$1$3")
						.replace(/`+/g, ""),
		)
		.join("")
		.replace(/\s+/g, " ")
		.trim();
}

/** At most `max` characters, "…" included. */
export function ankiTruncate(text: string, max = ANKI_FRONT_MAX): string {
	const chars = Array.from(text);
	return chars.length <= max ? text : `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}

/** The card's front as list text, or null before the card is written. */
export function ankiCardFront(card: AnkiCardRecord): string | null {
	const front = card.card ? ankiPlainText(card.card.front) : "";
	return front ? ankiTruncate(front) : null;
}

/** The limits offered, plus a stored value that is not one of them. */
function limitOptions(current: number): number[] {
	const values: number[] = ANKI_LIMITS.filter((value) => value > 0);
	if (current > 0 && !values.includes(current)) values.push(current);
	values.sort((a, b) => a - b);
	return [...values, 0];
}

// ─── the view ───────────────────────────────────────────────────────────────

export type AnkiBusy = "check" | "send" | null;

export interface AnkiSettingsViewProps {
	/** null until the first load. */
	status: AnkiStatus | null;
	/** The last failed request (load, save, check, send). */
	error: string | null;
	/** A failed card action, shown under its row. */
	cardError: { id: string; error: string } | null;
	/** The connection request running, if any. */
	busy: AnkiBusy;
	/** The card whose action is running, if any. */
	busyCard: string | null;
	/** The card whose Remove waits for Confirm, if any. */
	removing: string | null;
	/** The changed fields only; `apiKey` when the key is set (a string) or
	 *  cleared (null). */
	onSettings: (patch: AnkiSettingsPatch) => void;
	onCheck: () => void;
	onSendNow: () => void;
	onOpenCard: (id: string) => void;
	onRetryCard: (id: string) => void;
	/** Remove pressed (an id) or Cancel pressed (null). */
	onRemoveAsk: (id: string | null) => void;
	/** Confirm pressed: removes the card. */
	onRemoveCard: (id: string) => void;
}

export function AnkiSettingsView({
	status,
	error,
	cardError,
	busy,
	busyCard,
	removing,
	onSettings,
	onCheck,
	onSendNow,
	onOpenCard,
	onRetryCard,
	onRemoveAsk,
	onRemoveCard,
}: AnkiSettingsViewProps) {
	const settings = status?.settings ?? null;
	const enabled = settings?.enabled === true;
	const cards = status ? status.cards.slice(0, ANKI_RECENT_CARDS) : [];
	const change = (patch: AnkiSettingsPatch) => {
		if (settings) onSettings(patch);
	};
	return (
		<div className="flex flex-col gap-2" data-testid="anki-settings">
			<SettingsRow
				label={ENABLE_LABEL}
				hint="Each mistake becomes a flashcard in your Anki, written after the tutor explains the right idea."
				testid="anki-enabled"
			>
				<Toggle checked={enabled} disabled={!settings} label={ENABLE_LABEL} onChange={(on) => change({ enabled: on })} />
			</SettingsRow>
			{error && <p role="alert" className="text-xs text-red-500" data-testid="anki-error">{error}</p>}
			{status && settings && enabled && (
				<>
					<AnkiConnectionRow status={status} busy={busy} onCheck={onCheck} onSendNow={onSendNow} />
					<SettingsRow
						label="Deck"
						hint="{folder}: the session's folder in your sources. {session}: the session name. :: separates subdecks."
						testid="anki-deck"
					>
						<CommitInput
							value={settings.deckTemplate}
							ariaLabel="Deck"
							testid="input-anki-deck"
							onCommit={(next) => change({ deckTemplate: next || DEFAULT_ANKI_SETTINGS.deckTemplate })}
						/>
					</SettingsRow>
					<SettingsGroup label="Which mistakes" testid="group-anki-triggers">
						{ANKI_TRIGGERS.map((trigger) => (
							<SettingsRow key={trigger} label={ANKI_TRIGGER_LABELS[trigger]} testid={`anki-trigger-${trigger}`}>
								<Toggle
									checked={settings.triggers[trigger]}
									label={ANKI_TRIGGER_LABELS[trigger]}
									onChange={(on) => change({ triggers: { ...settings.triggers, [trigger]: on } })}
								/>
							</SettingsRow>
						))}
					</SettingsGroup>
					<div className="mt-3 flex flex-col gap-2 border-t border-border/60 pt-4">
						<SettingsRow label="Cards per session" testid="anki-limit">
							<ThinSelect
								value={String(settings.perSessionLimit)}
								ariaLabel="Cards per session"
								testid="select-anki-limit"
								onChange={(value) => {
									const limit = Number(value);
									if (Number.isInteger(limit) && limit >= 0) change({ perSessionLimit: limit });
								}}
							>
								{limitOptions(settings.perSessionLimit).map((limit) => (
									<option key={limit} value={limit}>{limit === 0 ? "No limit" : limit}</option>
								))}
							</ThinSelect>
						</SettingsRow>
						<SettingsRow label={API_KEY_LABEL} testid="anki-api-key">
							<span className="flex shrink-0 items-center gap-2">
								<SecretInput
									placeholder={status.apiKeySet ? "A key is saved" : undefined}
									ariaLabel={API_KEY_LABEL}
									testid="input-anki-api-key"
									onCommit={(key) => change({ apiKey: key })}
								/>
								{status.apiKeySet && (
									<button type="button" className={ACTION} onClick={() => change({ apiKey: null })} data-testid="anki-api-key-clear">
										Clear
									</button>
								)}
							</span>
						</SettingsRow>
					</div>
				</>
			)}
			{cards.length > 0 && (
				<SettingsGroup label="Recent cards" testid="group-anki-cards">
					<ul className="flex flex-col divide-y divide-border/40">
						{cards.map((card) => (
							<AnkiCardRow
								key={card.id}
								card={card}
								busy={busyCard === card.id}
								confirming={removing === card.id}
								error={cardError?.id === card.id ? cardError.error : null}
								onOpen={onOpenCard}
								onRetry={onRetryCard}
								onAsk={onRemoveAsk}
								onRemove={onRemoveCard}
							/>
						))}
					</ul>
				</SettingsGroup>
			)}
		</div>
	);
}

function AnkiConnectionRow({
	status,
	busy,
	onCheck,
	onSendNow,
}: {
	status: AnkiStatus;
	busy: AnkiBusy;
	onCheck: () => void;
	onSendNow: () => void;
}) {
	const text = ankiConnectionText(status.connection);
	const waiting = status.pending === 1 ? "1 card waiting" : `${status.pending} cards waiting`;
	return (
		<div className="flex flex-col gap-1.5 py-1" data-testid="anki-connection">
			<div className="flex flex-wrap items-center gap-3">
				{(busy === "check" || text.status) && (
					<span role="status" className="text-xs text-muted-foreground" data-testid="anki-connection-status">
						{busy === "check" ? "Checking…" : text.status}
					</span>
				)}
				<Button
					type="button"
					size="xs"
					variant="outline"
					className="cursor-pointer disabled:cursor-not-allowed"
					disabled={busy !== null}
					onClick={onCheck}
					data-testid="anki-check-again"
				>
					Check again
				</Button>
			</div>
			{busy !== "check" && text.details.map((line) => (
				<p key={line} className="text-xs leading-relaxed text-muted-foreground" data-testid="anki-connection-detail">{line}</p>
			))}
			{status.pending > 0 && (
				<div className="flex flex-wrap items-center gap-3" data-testid="anki-pending">
					<span className="text-xs text-muted-foreground">{waiting}</span>
					<Button
						type="button"
						size="xs"
						variant="outline"
						className="cursor-pointer disabled:cursor-not-allowed"
						disabled={busy !== null}
						onClick={onSendNow}
						data-testid="anki-send-now"
					>
						Send now
					</Button>
				</div>
			)}
		</div>
	);
}

function AnkiCardRow({
	card,
	busy,
	confirming,
	error,
	onOpen,
	onRetry,
	onAsk,
	onRemove,
}: {
	card: AnkiCardRecord;
	busy: boolean;
	confirming: boolean;
	error: string | null;
	onOpen: (id: string) => void;
	onRetry: (id: string) => void;
	onAsk: (id: string | null) => void;
	onRemove: (id: string) => void;
}) {
	const front = ankiCardFront(card);
	const author = ankiCardAuthorLabel(card);
	const reason = ankiCardReason(card);
	const canOpen = ankiCardCanOpen(card);
	const canRetry = ankiCardCanRetry(card);
	const canRemove = ankiCardCanRemove(card);
	return (
		<li className="flex flex-col gap-1 py-1.5" data-testid={`anki-card-${card.id}`} data-status={card.status}>
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0">
					{front !== null && (
						<p className="break-words text-xs text-foreground" data-lh-i18n="off" data-testid="anki-card-front">{front}</p>
					)}
					<p className={front !== null ? "truncate text-[11px] text-muted-foreground/70" : "break-words text-xs text-foreground"}>
						<span data-lh-i18n="names" data-testid="anki-card-session">{card.sessionTitle}</span>
						{author && (
							<>
								<span aria-hidden="true"> · </span>
								<span data-testid="anki-card-author">{author}</span>
							</>
						)}
					</p>
				</div>
				<div className="flex max-w-[45%] shrink-0 flex-col items-end gap-0.5 text-right">
					<span className="text-xs text-muted-foreground" data-testid="anki-card-status">{ankiCardStatusLabel(card)}</span>
					{reason && (
						<span
							className="text-[11px] text-muted-foreground/70"
							data-lh-i18n={card.status === "skipped" ? "names" : undefined}
							data-testid="anki-card-reason"
						>
							{reason}
						</span>
					)}
					{canRemove && confirming ? (
						<span className="flex flex-wrap items-center justify-end gap-x-3 gap-y-0.5" data-testid="anki-card-confirm">
							<span className="text-xs text-muted-foreground" data-testid="anki-card-confirm-question">
								{ankiCardRemovesNote(card) ? "Remove from Anki?" : "Remove?"}
							</span>
							<button type="button" className={ACTION} disabled={busy} onClick={() => onRemove(card.id)} data-testid="anki-card-confirm-remove">
								Confirm
							</button>
							<button type="button" className={ACTION} disabled={busy} onClick={() => onAsk(null)} data-testid="anki-card-cancel-remove">
								Cancel
							</button>
						</span>
					) : (canOpen || canRetry || canRemove) && (
						<span className="flex items-center gap-3">
							{canOpen && (
								<button type="button" className={ACTION} disabled={busy} onClick={() => onOpen(card.id)} data-testid="anki-card-open">
									Open in Anki
								</button>
							)}
							{canRetry && (
								<button type="button" className={ACTION} disabled={busy} onClick={() => onRetry(card.id)} data-testid="anki-card-retry">
									Try again
								</button>
							)}
							{canRemove && (
								<button type="button" className={ACTION} disabled={busy} onClick={() => onAsk(card.id)} data-testid="anki-card-remove">
									Remove
								</button>
							)}
						</span>
					)}
				</div>
			</div>
			{error && <p role="alert" className="text-xs text-red-500" data-testid="anki-card-error">{error}</p>}
		</li>
	);
}

// ─── the stateful container ─────────────────────────────────────────────────

export function AnkiSettings() {
	const [status, setStatus] = useState<AnkiStatus | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [cardError, setCardError] = useState<{ id: string; error: string } | null>(null);
	const [busy, setBusy] = useState<AnkiBusy>(null);
	const [busyCard, setBusyCard] = useState<string | null>(null);
	const [removing, setRemoving] = useState<string | null>(null);
	const latest = useRef(0);
	const alive = useRef(true);

	/** One request. Only the newest request's answer is shown, so a slow
	 *  reply never undoes a later change. Resolves false when it failed. */
	const run = useCallback(
		async (request: () => Promise<AnkiStatus>, report: (message: string) => void): Promise<boolean> => {
			const ticket = ++latest.current;
			try {
				const next = await request();
				if (alive.current && ticket === latest.current) setStatus(next);
				return true;
			} catch (failure) {
				if (alive.current) report(failure instanceof Error && failure.message ? failure.message : ANKI_REQUEST_FAILED);
				return false;
			}
		},
		[],
	);

	useEffect(() => {
		alive.current = true;
		void run(loadAnkiStatus, setError);
		return () => {
			alive.current = false;
		};
	}, [run]);

	const connection = async (kind: "check" | "send", request: () => Promise<AnkiStatus>) => {
		setBusy(kind);
		setError(null);
		await run(request, setError);
		if (alive.current) setBusy(null);
	};

	const save = async (patch: AnkiSettingsPatch) => {
		// Shown at once; the server's answer (normalized) replaces it. The key
		// itself never enters the state: only whether one is stored.
		const { apiKey, ...fields } = patch;
		setStatus((current) =>
			current && {
				...current,
				settings: { ...current.settings, ...fields },
				apiKeySet: "apiKey" in patch ? !!apiKey : current.apiKeySet,
			},
		);
		setError(null);
		const saved = await run(() => saveAnkiSettings(patch), setError);
		// A refused save: show what is stored again, keeping the error.
		if (!saved && alive.current) void run(loadAnkiStatus, () => {});
	};

	const cardAction = async (id: string, request: () => Promise<AnkiStatus>) => {
		setBusyCard(id);
		setCardError(null);
		await run(request, (message) => setCardError({ id, error: message }));
		if (alive.current) setBusyCard((current) => (current === id ? null : current));
	};

	return (
		<AnkiSettingsView
			status={status}
			error={error}
			cardError={cardError}
			busy={busy}
			busyCard={busyCard}
			removing={removing}
			onSettings={(next) => void save(next)}
			onCheck={() => void connection("check", loadAnkiStatus)}
			onSendNow={() => void connection("send", syncAnki)}
			onOpenCard={(id) => void cardAction(id, () => openAnkiCard(id))}
			onRetryCard={(id) => void cardAction(id, () => retryAnkiCard(id))}
			onRemoveAsk={(id) => {
				setRemoving(id);
				setCardError(null);
			}}
			onRemoveCard={(id) => {
				setRemoving(null);
				void cardAction(id, () => removeAnkiCard(id));
			}}
		/>
	);
}
