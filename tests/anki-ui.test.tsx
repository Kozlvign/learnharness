/**
 * Anki cards from mistakes on screen (fork feature, docs/anki.md): the
 * Settings → Anki view in every connection state, its controls, the
 * recent cards, the requests it sends, the settings nav, the tutor's card
 * in the chat (anki_card), and the Portuguese catalog behind every text
 * they show. SSR render pins of the pure views plus mounted flows; no
 * request ever reaches Anki.
 */

import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { after, afterEach, before, describe, it, mock } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";

import {
	ANKI_API,
	ANKI_HEADER,
	ANKI_REASONS,
	ANKICONNECT_ADDON_CODE,
	DEFAULT_ANKI_SETTINGS,
	type AnkiCardRecord,
	type AnkiCardStatus,
	type AnkiCardToolInput,
	type AnkiConnection,
	type AnkiSettings,
	type AnkiStatus,
	CATALOGS,
	createTranslator,
} from "../src/core/index.ts";
import {
	ANKI_TRIGGER_LABELS,
	AnkiSettings as AnkiSettingsContainer,
	AnkiSettingsView,
	ankiCardFront,
	ankiPlainText,
	ankiTruncate,
	type AnkiSettingsViewProps,
} from "../components/anki/anki-settings.tsx";
import { loadAnkiCard, loadAnkiStatus, openAnkiCard, removeAnkiCard, retryAnkiCard, saveAnkiSettings, syncAnki } from "../components/anki/api.ts";
import { ankiCardAuthorLabel } from "../components/anki/card-record.ts";
import {
	ANKI_CHIP_RECHECK_MS,
	AnkiCardChip,
	AnkiCardChipView,
	ankiCardChipData,
	type AnkiCardChipViewProps,
} from "../components/anki/anki-card-chip.tsx";
import { artifactRenderers } from "../components/artifacts/index.ts";
import { SettingsDialogBody } from "../components/settings/settings-dialog.tsx";
import { startDomTranslation } from "../components/i18n/dom-translator.ts";

// ─── fixtures ────────────────────────────────────────────────────────────────

const settings = (over: Partial<AnkiSettings> = {}): AnkiSettings => ({
	...DEFAULT_ANKI_SETTINGS,
	triggers: { ...DEFAULT_ANKI_SETTINGS.triggers },
	enabled: true,
	...over,
});

const CONNECTED: AnkiConnection = { state: "connected", apiVersion: 6, ankiVersion: "25.02.5", profile: "User 1" };

const status = (over: Partial<AnkiStatus> = {}): AnkiStatus => ({
	settings: settings(),
	connection: CONNECTED,
	apiKeySet: false,
	cards: [],
	pending: 0,
	...over,
});

let serial = 0;
const card = (over: Partial<AnkiCardRecord> = {}): AnkiCardRecord => {
	serial++;
	return {
		id: serial.toString(16).padStart(16, "0"),
		key: `chat_1:call_${serial}`,
		chatId: "chat_1",
		toolCallId: `call_${serial}`,
		sessionTitle: "Linear algebra",
		phase: "teach",
		kind: "wrong",
		missClass: null,
		confident: false,
		targets: [],
		status: "sent",
		card: { front: "What is the **rank** of $A$?", back: "Its number of pivots.", why: "", pitfall: "" },
		noteId: 1_700_000_000_000,
		attempts: 1,
		createdAt: "2026-10-30T12:00:00.000Z",
		updatedAt: "2026-10-30T12:00:00.000Z",
		...over,
	};
};

const noop = () => {};
function render(value: AnkiStatus | null, props: Partial<AnkiSettingsViewProps> = {}): string {
	return renderToStaticMarkup(
		<AnkiSettingsView
			status={value}
			error={null}
			cardError={null}
			busy={null}
			busyCard={null}
			removing={null}
			onSettings={noop}
			onCheck={noop}
			onSendNow={noop}
			onOpenCard={noop}
			onRetryCard={noop}
			onRemoveAsk={noop}
			onRemoveCard={noop}
			{...props}
		/>,
	);
}

function dom(html: string) {
	const { window, document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
	return { window, document };
}
const doc = (html: string) => dom(html).document;
const q = (root: ParentNode, testid: string) => root.querySelector<HTMLElement>(`[data-testid="${testid}"]`);
const qa = (root: ParentNode, testid: string) => [...root.querySelectorAll<HTMLElement>(`[data-testid="${testid}"]`)];
const text = (element: Element | null) => (element?.textContent ?? "").replace(/\s+/g, " ").trim();
const enableSwitch = (root: ParentNode) => q(root, "anki-enabled")!.querySelector<HTMLElement>('[role="switch"]')!;

// ─── the view ────────────────────────────────────────────────────────────────

describe("Settings → Anki: the switch and what it reveals", () => {
	it("loading: the switch shows, locked and off, and nothing else", () => {
		const page = doc(render(null));
		const toggle = enableSwitch(page);
		assert.equal(toggle.getAttribute("aria-checked"), "false");
		assert.ok(toggle.hasAttribute("disabled"));
		assert.equal(toggle.getAttribute("aria-label"), "Create Anki cards from mistakes");
		assert.match(text(q(page, "anki-enabled")), /Each mistake becomes a flashcard in your Anki, written after the tutor explains the right idea\./);
		for (const id of ["anki-connection", "anki-deck", "group-anki-triggers", "anki-limit", "anki-api-key", "group-anki-cards"]) {
			assert.equal(q(page, id), null, id);
		}
	});

	it("the stateful container renders the loading state on the server (no request runs)", () => {
		const page = doc(renderToStaticMarkup(<AnkiSettingsContainer />));
		assert.ok(enableSwitch(page).hasAttribute("disabled"));
		assert.equal(q(page, "anki-connection"), null);
	});

	it("off: only the switch, even with cards waiting; the recent cards stay", () => {
		const page = doc(render(status({ settings: settings({ enabled: false }), pending: 3, cards: [card()] })));
		const toggle = enableSwitch(page);
		assert.equal(toggle.getAttribute("aria-checked"), "false");
		assert.ok(!toggle.hasAttribute("disabled"));
		for (const id of ["anki-connection", "anki-pending", "anki-deck", "group-anki-triggers", "anki-limit", "anki-api-key"]) {
			assert.equal(q(page, id), null, id);
		}
		assert.ok(q(page, "group-anki-cards"), "the list stays while there are records");
	});

	it("off with no records: no list either", () => {
		assert.equal(q(doc(render(status({ settings: settings({ enabled: false }) }))), "group-anki-cards"), null);
	});

	it("on: switch, connection, deck, the mistakes, the limit, the API key and the cards, in that order", () => {
		const html = render(status({ cards: [card()] }));
		const page = doc(html);
		assert.equal(enableSwitch(page).getAttribute("aria-checked"), "true");
		const order = ["anki-enabled", "anki-connection", "anki-deck", "group-anki-triggers", "anki-limit", "anki-api-key", "group-anki-cards"];
		const at = order.map((id) => html.indexOf(`data-testid="${id}"`));
		for (const [index, position] of at.entries()) assert.ok(position >= 0, `missing ${order[index]}`);
		assert.deepEqual([...at].sort((a, b) => a - b), at);
	});

	it("a failed request shows its route error inline", () => {
		const page = doc(render(status(), { error: "Could not save the Anki settings" }));
		const alert = q(page, "anki-error")!;
		assert.equal(alert.getAttribute("role"), "alert");
		assert.equal(text(alert), "Could not save the Anki settings");
	});

	it("no coloured status badges: words only (errors excepted)", () => {
		const html = render(status({ cards: (["waiting", "queued", "sent", "skipped", "failed", "removed"] as const).map((s) => card({ status: s })) }));
		assert.doesNotMatch(html, /text-(green|emerald|amber|yellow|orange|red)-|bg-(green|emerald|amber|yellow|orange|red)-/);
	});
});

describe("Settings → Anki: the connection", () => {
	const cases: Array<[string, AnkiConnection, string, string[]]> = [
		["connected, version and profile known", CONNECTED, "Connected to Anki 25.02.5", ["Profile: User 1"]],
		["connected, nothing known", { state: "connected", apiVersion: 6, ankiVersion: null, profile: null }, "Connected to Anki", []],
		[
			"AnkiConnect missing",
			{ state: "unreachable", addonInstalled: false, error: "ECONNREFUSED" },
			"AnkiConnect is not installed.",
			[`In Anki: Tools → Add-ons → Get Add-ons…, code ${ANKICONNECT_ADDON_CODE}, then restart Anki.`],
		],
		["Anki closed", { state: "unreachable", addonInstalled: true, error: "ECONNREFUSED" }, "Anki is closed. Open Anki and check again.", []],
		["add-on unknown", { state: "unreachable", addonInstalled: null, error: "ECONNREFUSED" }, "Anki is closed. Open Anki and check again.", []],
		["API key wanted", { state: "unauthorized", error: "valid api key must be provided" }, "AnkiConnect asked for an API key. Enter the key from its settings below.", []],
		["other error", { state: "error", error: "unsupported action" }, "Could not reach AnkiConnect.", ["unsupported action"]],
	];
	for (const [name, connection, line, details] of cases) {
		it(name, () => {
			const page = doc(render(status({ connection })));
			assert.equal(text(q(page, "anki-connection-status")), line);
			assert.deepEqual(qa(page, "anki-connection-detail").map(text), details);
			const check = q(page, "anki-check-again")!;
			assert.equal(text(check), "Check again");
			assert.ok(!check.hasAttribute("disabled"));
		});
	}

	it("the add-on code is the contract's", () => {
		assert.equal(ANKICONNECT_ADDON_CODE, "2055492159");
	});

	it("while checking: Checking…, buttons locked", () => {
		const page = doc(render(status({ pending: 2 }), { busy: "check" }));
		assert.equal(text(q(page, "anki-connection-status")), "Checking…");
		assert.deepEqual(qa(page, "anki-connection-detail"), []);
		assert.ok(q(page, "anki-check-again")!.hasAttribute("disabled"));
		assert.ok(q(page, "anki-send-now")!.hasAttribute("disabled"));
	});

	it("cards waiting: the count and Send now; none waiting: neither", () => {
		const many = doc(render(status({ pending: 3 })));
		assert.equal(text(q(many, "anki-pending")!.querySelector("span")), "3 cards waiting");
		assert.equal(text(q(many, "anki-send-now")), "Send now");
		assert.ok(!q(many, "anki-send-now")!.hasAttribute("disabled"));
		const one = doc(render(status({ pending: 1 })));
		assert.equal(text(q(one, "anki-pending")!.querySelector("span")), "1 card waiting");
		assert.equal(q(doc(render(status({ pending: 0 }))), "anki-pending"), null);
	});

	it("while sending: both buttons locked", () => {
		const page = doc(render(status({ pending: 2 }), { busy: "send" }));
		assert.ok(q(page, "anki-send-now")!.hasAttribute("disabled"));
		assert.ok(q(page, "anki-check-again")!.hasAttribute("disabled"));
		assert.equal(text(q(page, "anki-connection-status")), "Connected to Anki 25.02.5");
	});
});

describe("Settings → Anki: deck, mistakes, limit, API key", () => {
	it("the deck shows the stored template and the placeholders hint", () => {
		const page = doc(render(status()));
		const row = q(page, "anki-deck")!;
		assert.equal(q(row, "input-anki-deck")!.getAttribute("value"), "LearnHarness::{folder}");
		assert.equal(q(row, "input-anki-deck")!.getAttribute("aria-label"), "Deck");
		assert.match(text(row), /^Deck/);
		assert.match(
			text(row),
			/\{folder\}: the session's folder in your sources\. \{session\}: the session name\. :: separates subdecks\./,
		);
	});

	it("the five mistakes, in the contract's order, each with its switch", () => {
		const page = doc(render(status({ settings: settings({ triggers: { ...DEFAULT_ANKI_SETTINGS.triggers, lowConfidence: false } }) })));
		const group = q(page, "group-anki-triggers")!;
		assert.match(text(group), /^Which mistakes/);
		const rows = [...group.querySelectorAll<HTMLElement>('[data-testid^="anki-trigger-"]')];
		assert.deepEqual(
			rows.map((row) => row.getAttribute("data-testid")),
			["anki-trigger-wrong", "anki-trigger-dontKnow", "anki-trigger-lowConfidence", "anki-trigger-practiceNotSolved", "anki-trigger-practiceHeavyHint"],
		);
		assert.deepEqual(rows.map(text), [
			"Wrong answers",
			"“I don't know”",
			"Lucky guesses (right, with low confidence)",
			"Practice problems not solved",
			"Practice problems solved only with strong hints",
		]);
		assert.deepEqual(
			rows.map((row) => row.querySelector('[role="switch"]')!.getAttribute("aria-checked")),
			["true", "true", "false", "true", "true"],
		);
	});

	it("cards per session: 5, 10, 20 or no limit, the stored one selected", () => {
		const options = (limit: number) => {
			const select = q(doc(render(status({ settings: settings({ perSessionLimit: limit }) }))), "select-anki-limit")!;
			assert.equal(select.getAttribute("aria-label"), "Cards per session");
			return [...select.querySelectorAll("option")].map((option) => [option.getAttribute("value"), text(option), option.hasAttribute("selected")]);
		};
		assert.deepEqual(options(10), [["5", "5", false], ["10", "10", true], ["20", "20", false], ["0", "No limit", false]]);
		assert.deepEqual(options(0).at(-1), ["0", "No limit", true]);
		assert.deepEqual(
			options(15).map(([value]) => value),
			["5", "10", "15", "20", "0"],
			"a stored value outside the list stays visible",
		);
	});

	it("the API key is write-only: an empty password field, no Clear without a stored key", () => {
		const row = q(doc(render(status())), "anki-api-key")!;
		const input = q(row, "input-anki-api-key")!;
		assert.equal(input.getAttribute("type"), "password");
		assert.equal(input.getAttribute("value"), "");
		assert.equal(input.getAttribute("aria-label"), "AnkiConnect API key (optional)");
		assert.equal(input.hasAttribute("placeholder"), false);
		assert.equal(q(row, "anki-api-key-clear"), null);
	});

	it("a stored key: the field stays empty, says a key is saved, and offers Clear", () => {
		// Even a server that sent the key back never gets it shown.
		const html = render(status({ apiKeySet: true, settings: settings({ apiKey: "s3cret" }) }));
		assert.ok(!html.includes("s3cret"));
		const row = q(doc(html), "anki-api-key")!;
		const input = q(row, "input-anki-api-key")!;
		assert.equal(input.getAttribute("type"), "password");
		assert.equal(input.getAttribute("value"), "");
		assert.equal(input.getAttribute("placeholder"), "A key is saved");
		assert.equal(text(q(row, "anki-api-key-clear")), "Clear");
	});
});

describe("Settings → Anki: recent cards", () => {
	const row = (record: AnkiCardRecord, props: Partial<AnkiSettingsViewProps> = {}) => q(doc(render(status({ cards: [record] }), props)), `anki-card-${record.id}`)!;
	const label = (record: AnkiCardRecord) => text(q(row(record), "anki-card-status"));

	it("each status has its words", () => {
		const labels: Record<AnkiCardStatus, string> = {
			waiting: "Waiting for the explanation",
			queued: "Waiting for Anki",
			sent: "In Anki",
			skipped: "Skipped",
			failed: "Failed",
			removed: "Removed",
		};
		for (const [state, words] of Object.entries(labels)) assert.equal(label(card({ status: state as AnkiCardStatus })), words, state);
		assert.equal(label(card({ status: "waiting", reason: ANKI_REASONS.noModel })), "Waiting for a background model");
		assert.equal(label(card({ status: "sent", noteId: undefined, duplicateOf: "00000000000000aa" })), "Brought forward for review");
	});

	it("skipped and failed cards show their reason; the others do not", () => {
		assert.equal(text(q(row(card({ status: "skipped", reason: ANKI_REASONS.sessionLimit })), "anki-card-reason")), "Session limit reached");
		assert.equal(text(q(row(card({ status: "failed", reason: "cannot create note because it is empty" })), "anki-card-reason")), "cannot create note because it is empty");
		assert.equal(q(row(card({ status: "waiting", reason: ANKI_REASONS.noModel })), "anki-card-reason"), null);
		assert.equal(q(row(card({ status: "removed", reason: ANKI_REASONS.removedByUser })), "anki-card-reason"), null);
	});

	it("skip reasons translate only as whole phrases; failure reasons are interface text", () => {
		const skipped = q(row(card({ status: "skipped", reason: "Already covered by another card" })), "anki-card-reason")!;
		assert.equal(skipped.getAttribute("data-lh-i18n"), "names", "the writer's own words");
		const failed = q(row(card({ status: "failed", reason: "http://127.0.0.1:8765 did not answer as AnkiConnect." })), "anki-card-reason")!;
		assert.equal(failed.hasAttribute("data-lh-i18n"), false, "Anki's and the client's messages");
	});

	it("who wrote each card: the tutor, the reserve writer, or the learner's request", () => {
		const author = (record: AnkiCardRecord) => {
			const element = q(row(record), "anki-card-author");
			return element ? text(element) : null;
		};
		assert.equal(author(card({ writtenBy: "tutor" })), "by the tutor");
		assert.equal(author(card({ writtenBy: "writer" })), "by the reserve writer");
		assert.equal(author(card({ writtenBy: undefined })), "by the reserve writer", "a card from before the field was the writer's");
		assert.equal(author(card({ kind: "request", writtenBy: "tutor" })), "you asked");
		assert.equal(author(card({ status: "waiting", card: undefined, writtenBy: undefined, noteId: undefined })), null, "no card yet, no author");
		const element = row(card({ writtenBy: "tutor" }));
		assert.equal(q(element, "anki-card-author")!.hasAttribute("data-lh-i18n"), false, "interface text, unlike the title");
		assert.equal(text(q(element, "anki-card-session")), "Linear algebra");
	});

	it("the author label as a rule", () => {
		assert.equal(ankiCardAuthorLabel(card({ kind: "request", writtenBy: undefined })), "you asked");
		assert.equal(ankiCardAuthorLabel(card({ writtenBy: "tutor" })), "by the tutor");
		assert.equal(ankiCardAuthorLabel(card({ writtenBy: "writer", card: undefined })), "by the reserve writer");
		assert.equal(ankiCardAuthorLabel(card({ writtenBy: undefined, card: undefined })), null);
	});

	it("the front as plain text, the session title muted under it", () => {
		const element = row(card());
		assert.equal(text(q(element, "anki-card-front")), "What is the rank of $A$?");
		assert.equal(text(q(element, "anki-card-session")), "Linear algebra");
		assert.equal(q(element, "anki-card-front")!.getAttribute("data-lh-i18n"), "off", "card text is content");
		assert.equal(q(element, "anki-card-session")!.getAttribute("data-lh-i18n"), "names", "titles translate only as whole phrases");
	});

	it("no card yet: the session title instead of the front", () => {
		const element = row(card({ status: "waiting", card: undefined, noteId: undefined }));
		assert.equal(q(element, "anki-card-front"), null);
		assert.equal(text(q(element, "anki-card-session")), "Linear algebra");
	});

	it("long fronts are cut at 90 characters with …", () => {
		const long = `Why does ${"the determinant ".repeat(12)}vanish?`;
		const shown = text(q(row(card({ card: { front: long, back: "", why: "", pitfall: "" } })), "anki-card-front"));
		assert.ok(Array.from(shown).length <= 90, shown);
		assert.ok(Array.from(shown).length >= 85, shown);
		assert.ok(shown.endsWith("…") && !shown.endsWith(" …"), shown);
		assert.ok(long.startsWith(shown.slice(0, -1)));
	});

	it("Open in Anki only for sent cards with a note; Try again only for failed ones; Remove for all but removed and skipped", () => {
		const actions = (record: AnkiCardRecord) => {
			const element = row(record);
			return [
				q(element, "anki-card-open") ? "open" : null,
				q(element, "anki-card-retry") ? "retry" : null,
				q(element, "anki-card-remove") ? "remove" : null,
			].filter(Boolean);
		};
		assert.deepEqual(actions(card({ status: "sent" })), ["open", "remove"]);
		assert.deepEqual(actions(card({ status: "sent", noteId: undefined, duplicateOf: "00000000000000aa" })), ["remove"]);
		assert.deepEqual(actions(card({ status: "waiting", noteId: undefined })), ["remove"]);
		assert.deepEqual(actions(card({ status: "queued", noteId: undefined })), ["remove"]);
		assert.deepEqual(actions(card({ status: "failed", noteId: undefined })), ["retry", "remove"]);
		assert.deepEqual(actions(card({ status: "skipped", noteId: undefined })), []);
		assert.deepEqual(actions(card({ status: "removed" })), []);
		assert.equal(text(q(row(card()), "anki-card-open")), "Open in Anki");
		assert.equal(text(q(row(card()), "anki-card-remove")), "Remove");
		assert.equal(text(q(row(card({ status: "failed", noteId: undefined })), "anki-card-retry")), "Try again");
	});

	it("Remove asks first: the row shows the question with Confirm and Cancel", () => {
		const sent = card({ status: "sent" });
		const page = doc(render(status({ cards: [sent] }), { removing: sent.id }));
		const element = q(page, `anki-card-${sent.id}`)!;
		assert.equal(text(q(element, "anki-card-confirm-question")), "Remove from Anki?", "a note of its own leaves Anki");
		assert.equal(text(q(element, "anki-card-confirm-remove")), "Confirm");
		assert.equal(text(q(element, "anki-card-cancel-remove")), "Cancel");
		assert.equal(q(element, "anki-card-remove"), null, "Remove gives way to the question");
		assert.equal(q(element, "anki-card-open"), null, "nothing else competes with the question");
		const question = (record: AnkiCardRecord) => text(q(row(record, { removing: record.id }), "anki-card-confirm-question"));
		assert.equal(question(card({ status: "waiting", noteId: undefined })), "Remove?");
		assert.equal(question(card({ status: "queued", noteId: undefined })), "Remove?");
		assert.equal(question(card({ status: "failed", noteId: undefined })), "Remove?");
		assert.equal(question(card({ status: "sent", duplicateOf: "00000000000000aa" })), "Remove?", "a folded card has no note of its own");
		const skipped = card({ status: "skipped" });
		assert.equal(q(row(skipped, { removing: skipped.id }), "anki-card-confirm"), null, "nothing to remove");
		assert.ok(q(row(card(), { removing: "someone-else" }), "anki-card-remove"), "only the asked row changes");
	});

	it("a card's action locks while it runs, and its error shows under that row only", () => {
		const first = card();
		const second = card();
		const page = doc(render(status({ cards: [first, second] }), { busyCard: first.id, cardError: { id: first.id, error: "Could not remove the note from Anki" } }));
		const one = q(page, `anki-card-${first.id}`)!;
		const two = q(page, `anki-card-${second.id}`)!;
		assert.ok(q(one, "anki-card-open")!.hasAttribute("disabled"));
		assert.ok(q(one, "anki-card-remove")!.hasAttribute("disabled"));
		assert.ok(!q(two, "anki-card-remove")!.hasAttribute("disabled"));
		assert.equal(text(q(one, "anki-card-error")), "Could not remove the note from Anki");
		assert.equal(q(one, "anki-card-error")!.getAttribute("role"), "alert");
		assert.equal(q(two, "anki-card-error"), null);
	});

	it("at most 20 rows, newest first as the server sends them", () => {
		const cards = Array.from({ length: 25 }, () => card());
		const page = doc(render(status({ cards })));
		const rows = [...q(page, "group-anki-cards")!.querySelectorAll("li")];
		assert.equal(rows.length, 20);
		assert.equal(rows[0]!.getAttribute("data-testid"), `anki-card-${cards[0]!.id}`);
		assert.match(text(q(page, "group-anki-cards")), /^Recent cards/);
	});
});

describe("card text for the list", () => {
	it("Markdown markers go, $…$ math stays as written", () => {
		assert.equal(
			ankiPlainText("## What is the **rank** of $A_{ij}$ when `x` is *free*?"),
			"What is the rank of $A_{ij}$ when x is free?",
		);
		assert.equal(ankiPlainText("Compute $a*b*c$ and $$x_1 * x_2$$ __now__"), "Compute $a*b*c$ and $$x_1 * x_2$$ now");
		assert.equal(ankiPlainText("- see [the proof](https://example.com)\n> quoted ~~old~~"), "see the proof quoted old");
		assert.equal(ankiPlainText("keep snake_case_names and 2 * 3"), "keep snake_case_names and 2 * 3");
	});

	it("truncation counts characters, not code units", () => {
		assert.equal(ankiTruncate("short"), "short");
		assert.equal(ankiTruncate("a".repeat(90)), "a".repeat(90));
		assert.equal(ankiTruncate("a".repeat(91)), `${"a".repeat(89)}…`);
		assert.equal(Array.from(ankiTruncate("𝛼".repeat(100))).length, 90);
	});

	it("an empty front counts as no card", () => {
		assert.equal(ankiCardFront(card({ card: { front: " \t\n ", back: "", why: "", pitfall: "" } })), null);
		assert.equal(ankiCardFront(card({ card: undefined })), null);
	});
});

// ─── the requests ────────────────────────────────────────────────────────────

describe("Settings → Anki: requests", () => {
	const original = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = original;
	});
	type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };
	function stub(answer: () => Response): Call[] {
		const calls: Call[] = [];
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			calls.push({
				url: String(input),
				method: init?.method ?? "GET",
				headers: { ...(init?.headers as Record<string, string> | undefined) },
				body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
			});
			return answer();
		}) as typeof fetch;
		return calls;
	}

	it("each action calls its route; writes carry the header", async () => {
		const calls = stub(() => Response.json(status()));
		await loadAnkiStatus();
		await saveAnkiSettings({ perSessionLimit: 20 });
		await syncAnki();
		await openAnkiCard("00000000000000ab");
		await removeAnkiCard("00000000000000ab");
		await retryAnkiCard("00000000000000ab");
		assert.deepEqual(
			calls.map(({ url, method }) => `${method} ${url}`),
			[
				`GET ${ANKI_API}`,
				`PUT ${ANKI_API}`,
				`POST ${ANKI_API}/sync`,
				`POST ${ANKI_API}/cards/00000000000000ab`,
				`DELETE ${ANKI_API}/cards/00000000000000ab`,
				`POST ${ANKI_API}/cards/00000000000000ab`,
			],
		);
		assert.equal(calls[0]!.headers[ANKI_HEADER], undefined, "a read needs no header");
		for (const call of calls.slice(1)) assert.equal(call.headers[ANKI_HEADER], "1", `${call.method} ${call.url}`);
		assert.deepEqual(calls[1]!.body, { perSessionLimit: 20 }, "only the changed field");
		assert.equal(calls[1]!.headers["content-type"], "application/json");
		assert.deepEqual(calls[3]!.body, { action: "open" });
		assert.equal(calls[3]!.headers["content-type"], "application/json");
		assert.equal(calls[4]!.body, undefined);
		assert.deepEqual(calls[5]!.body, { action: "retry" });
	});

	it("a card's record: GET without the header; null when the ledger has none", async () => {
		const record = card({ writtenBy: "tutor" });
		const calls = stub(() => Response.json({ card: record }));
		assert.deepEqual(await loadAnkiCard(record.id), record);
		assert.equal(calls[0]!.url, `${ANKI_API}/cards/${record.id}`);
		assert.equal(calls[0]!.method, "GET");
		assert.equal(calls[0]!.headers[ANKI_HEADER], undefined);
		stub(() => Response.json({ card: null }));
		assert.equal(await loadAnkiCard(record.id), null);
		stub(() => Response.json({ error: "Unknown Anki card." }, { status: 404 }));
		await assert.rejects(loadAnkiCard(record.id), { message: "Unknown Anki card." });
		stub(() => Response.json({ card: { id: 3 } }));
		await assert.rejects(loadAnkiCard(record.id), { message: "Anki request failed (200)" });
	});

	it("a refused request throws the route's error; a bare failure names the status", async () => {
		stub(() => Response.json({ error: "Could not save the Anki settings" }, { status: 400 }));
		await assert.rejects(saveAnkiSettings(settings()), { message: "Could not save the Anki settings" });
		stub(() => new Response("oops", { status: 502 }));
		await assert.rejects(loadAnkiStatus(), { message: "Anki request failed (502)" });
		stub(() => Response.json({ settings: settings() }));
		await assert.rejects(loadAnkiStatus(), { message: "Anki request failed (200)" }, "a partial status is refused");
		const { apiKeySet: _apiKeySet, ...withoutKeyFlag } = status();
		stub(() => Response.json(withoutKeyFlag));
		await assert.rejects(loadAnkiStatus(), { message: "Anki request failed (200)" }, "a status without apiKeySet is refused");
	});
});

// ─── the container, mounted ──────────────────────────────────────────────────

describe("Settings → Anki, mounted", () => {
	const original = { fetch: globalThis.fetch };
	const saved = new Map<string, unknown>();
	const GLOBALS = ["window", "document", "Element", "HTMLElement", "CustomEvent", "IS_REACT_ACT_ENVIRONMENT"] as const;
	let root: Root | undefined;
	let host: HTMLElement | undefined;
	let page: Document;
	let win: { Event: typeof Event };

	before(() => {
		const { window, document } = parseHTML("<!doctype html><html><body></body></html>");
		page = document as unknown as Document;
		win = window as unknown as { Event: typeof Event };
		const next: Record<string, unknown> = {
			window,
			document,
			Element: window.Element,
			HTMLElement: window.HTMLElement,
			CustomEvent: window.CustomEvent,
			IS_REACT_ACT_ENVIRONMENT: true,
		};
		for (const name of GLOBALS) {
			saved.set(name, (globalThis as Record<string, unknown>)[name]);
			(globalThis as Record<string, unknown>)[name] = next[name];
		}
	});
	after(() => {
		for (const name of GLOBALS) (globalThis as Record<string, unknown>)[name] = saved.get(name);
	});
	afterEach(async () => {
		await act(async () => root?.unmount());
		host?.remove();
		root = undefined;
		host = undefined;
		globalThis.fetch = original.fetch;
	});

	const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
	const click = async (element: HTMLElement | null) => {
		assert.ok(element);
		await act(async () => element.click());
		await settle();
	};
	/** Picks a select option: a real change event (past React's value tracker). */
	const choose = async (element: HTMLElement | null, value: string) => {
		assert.ok(element);
		await act(async () => {
			Object.defineProperty(element, "value", { configurable: true, writable: true, value });
			element.dispatchEvent(new win.Event("change", { bubbles: true }));
		});
		await settle();
	};
	/** Types into a text field. React DOM loads before this DOM exists, so it
	 *  decides there is no `input` event and never hears typed text; the
	 *  field's own onChange is called instead. Clicks, focusout and select
	 *  changes go through real events. */
	const type = async (element: HTMLElement | null, value: string) => {
		assert.ok(element);
		const key = Object.keys(element).find((name) => name.startsWith("__reactProps$"));
		assert.ok(key, "a React-rendered field");
		const props = (element as unknown as Record<string, { onChange: (event: unknown) => void }>)[key]!;
		await act(async () => props.onChange({ target: { value }, currentTarget: { value } }));
	};
	const leave = async (element: HTMLElement | null) => {
		assert.ok(element);
		await act(async () => {
			element.dispatchEvent(new win.Event("focusout", { bubbles: true }));
		});
		await settle();
	};

	type Sent = { method: string; url: string; body: unknown };
	/** A stand-in for /api/anki: merges PUTs, answers card actions. */
	function fakeServer(initial: AnkiStatus, onCard?: (method: string, body: unknown, current: AnkiStatus) => AnkiStatus) {
		let current = initial;
		const sent: Sent[] = [];
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const method = init?.method ?? "GET";
			const url = String(input);
			const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
			sent.push({ method, url, body });
			if (method !== "GET") assert.equal((init?.headers as Record<string, string>)[ANKI_HEADER], "1");
			if (method === "PUT") {
				const { apiKey, ...fields } = body as Partial<AnkiSettings>;
				current = {
					...current,
					settings: { ...current.settings, ...fields },
					apiKeySet: apiKey === undefined ? current.apiKeySet : !!apiKey,
				};
			} else if (url.startsWith(`${ANKI_API}/cards/`) && onCard) {
				current = onCard(method, body, current);
			}
			return Response.json(current);
		}) as typeof fetch;
		return sent;
	}
	async function mount() {
		host = page.createElement("div") as unknown as HTMLElement;
		page.body.append(host);
		root = createRoot(host);
		await act(async () => root!.render(<AnkiSettingsContainer />));
		await settle();
	}

	it("each write sends only the changed fields", async () => {
		const sent = fakeServer(status({ settings: settings({ enabled: false }) }));
		await mount();
		await click(enableSwitch(page));
		await click(q(page, "anki-trigger-lowConfidence")!.querySelector<HTMLElement>('[role="switch"]'));
		await choose(q(page, "select-anki-limit"), "20");
		await type(q(page, "input-anki-deck"), "Estudos::{session}");
		await leave(q(page, "input-anki-deck"));
		const writes = sent.filter((call) => call.method === "PUT").map((call) => call.body);
		assert.deepEqual(writes, [
			{ enabled: true },
			{ triggers: { ...DEFAULT_ANKI_SETTINGS.triggers, lowConfidence: false } },
			{ perSessionLimit: 20 },
			{ deckTemplate: "Estudos::{session}" },
		]);
		for (const body of writes) {
			assert.ok(!("apiKey" in (body as object)), "the key is never sent along");
			assert.ok(!("enabledAt" in (body as object)), "enabledAt is the server's");
		}
	});

	it("the API key: a typed key is sent once and the field empties; Clear sends null", async () => {
		const sent = fakeServer(status());
		await mount();
		const input = () => q(page, "input-anki-api-key") as HTMLInputElement;
		assert.equal(q(page, "anki-api-key-clear"), null);

		await type(input(), "  k3y-secret  ");
		await leave(input());
		assert.deepEqual(sent.filter((call) => call.method === "PUT").map((call) => call.body), [{ apiKey: "k3y-secret" }]);
		assert.equal(input().value, "", "the field empties");
		assert.ok(!page.body.innerHTML.includes("k3y-secret"), "the key is never shown");
		assert.equal(input().getAttribute("placeholder"), "A key is saved");

		await type(input(), "");
		await leave(input());
		assert.equal(sent.filter((call) => call.method === "PUT").length, 1, "an empty field sends nothing");

		await click(q(page, "anki-api-key-clear"));
		assert.deepEqual(sent.filter((call) => call.method === "PUT").map((call) => call.body), [{ apiKey: "k3y-secret" }, { apiKey: null }]);
		assert.equal(q(page, "anki-api-key-clear"), null);
		assert.equal(input().hasAttribute("placeholder"), false);
	});

	it("Try again sends the retry action and shows the returned status", async () => {
		const failed = card({ status: "failed", noteId: undefined, reason: "Note 17 is no longer in Anki.", attempts: 3 });
		const sent = fakeServer(status({ cards: [failed] }), (method, body, current) => {
			assert.equal(method, "POST");
			assert.deepEqual(body, { action: "retry" });
			return { ...current, pending: 1, cards: [{ ...failed, status: "queued", attempts: 0, reason: undefined }] };
		});
		await mount();
		const rowOf = () => q(page, `anki-card-${failed.id}`)!;
		assert.equal(text(q(rowOf(), "anki-card-status")), "Failed");
		await click(q(rowOf(), "anki-card-retry"));
		assert.deepEqual(sent.map((call) => `${call.method} ${call.url}`), [`GET ${ANKI_API}`, `POST ${ANKI_API}/cards/${failed.id}`]);
		assert.equal(text(q(rowOf(), "anki-card-status")), "Waiting for Anki");
		assert.equal(q(rowOf(), "anki-card-retry"), null);
		assert.equal(q(rowOf(), "anki-card-reason"), null);
		assert.equal(text(q(page, "anki-pending")!.querySelector("span")), "1 card waiting");
	});

	it("Remove asks; Cancel puts it back; only Confirm sends the DELETE", async () => {
		const sent = card({ status: "sent" });
		let current = status({ cards: [sent] });
		const calls: string[] = [];
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const method = init?.method ?? "GET";
			calls.push(`${method} ${String(input)}`);
			if (method === "DELETE") {
				assert.equal((init?.headers as Record<string, string>)[ANKI_HEADER], "1");
				current = status({ cards: [{ ...sent, status: "removed", reason: ANKI_REASONS.removedByUser }] });
			}
			return Response.json(current);
		}) as typeof fetch;

		host = page.createElement("div") as unknown as HTMLElement;
		page.body.append(host);
		root = createRoot(host);
		await act(async () => root!.render(<AnkiSettingsContainer />));
		await settle();
		assert.deepEqual(calls, [`GET ${ANKI_API}`]);
		const rowOf = () => q(page, `anki-card-${sent.id}`)!;

		await click(q(rowOf(), "anki-card-remove"));
		assert.equal(text(q(rowOf(), "anki-card-confirm-question")), "Remove from Anki?");
		assert.equal(q(rowOf(), "anki-card-remove"), null);
		assert.deepEqual(calls, [`GET ${ANKI_API}`], "asking sends nothing");

		await click(q(rowOf(), "anki-card-cancel-remove"));
		assert.equal(q(rowOf(), "anki-card-confirm"), null);
		assert.ok(q(rowOf(), "anki-card-remove"));
		assert.deepEqual(calls, [`GET ${ANKI_API}`], "cancelling sends nothing");

		await click(q(rowOf(), "anki-card-remove"));
		await click(q(rowOf(), "anki-card-confirm-remove"));
		assert.deepEqual(calls, [`GET ${ANKI_API}`, `DELETE ${ANKI_API}/cards/${sent.id}`]);
		assert.equal(text(q(rowOf(), "anki-card-status")), "Removed");
		assert.equal(q(rowOf(), "anki-card-confirm"), null);
		assert.equal(q(rowOf(), "anki-card-remove"), null);
	});
});

// ─── the settings dialog ─────────────────────────────────────────────────────

describe("the settings dialog", () => {
	it("lists Anki right before Keyboard", () => {
		const html = renderToStaticMarkup(<SettingsDialogBody onClose={() => {}} />);
		const ids = [...html.matchAll(/data-testid="settings-nav-([^"]+)"/g)].map((match) => match[1]);
		assert.ok(ids.includes("anki"));
		assert.equal(ids[ids.indexOf("keyboard") - 1], "anki");
		assert.equal(text(q(doc(html), "settings-nav-anki")), "Anki");
	});
});

// ─── Portuguese ──────────────────────────────────────────────────────────────

describe("Settings → Anki in Portuguese", () => {
	const messages = CATALOGS["pt-BR"];
	const pt = createTranslator(messages);
	const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
	const known = (value: string) => Object.hasOwn(messages, value) || pt(value) !== null;

	/** Fixture values that stand for content or server text, not interface. */
	const FIXTURE_TEXT = new Set(["unsupported action", "cannot create note because it is empty"]);

	/** Interface text the way the DOM translator meets it: an element's text
	 *  nodes joined when they are its only children, labelling attributes,
	 *  and nothing inside content or names. */
	function interfaceTexts(html: string): string[] {
		const { document } = dom(html);
		const skip = "[data-lh-i18n='off'],[data-lh-i18n='names'],input,textarea,code,pre,.lh-prose,.katex,svg";
		const out = new Set<string>();
		for (const element of [...document.body.querySelectorAll("*")]) {
			if (element.closest(skip)) continue;
			const nodes = [...element.childNodes];
			const texts = nodes.filter((node) => node.nodeType === 3);
			if (texts.length === 0) continue;
			const pieces = nodes.every((node) => node.nodeType === 3 || node.nodeType === 8) ? [texts.map((node) => node.textContent).join("")] : texts.map((node) => node.textContent ?? "");
			for (const piece of pieces) out.add(normalize(piece));
		}
		for (const element of [...document.body.querySelectorAll("[aria-label],[title],[placeholder]")]) {
			if (element.closest("[data-lh-i18n='off']")) continue;
			for (const name of ["aria-label", "title", "placeholder"]) {
				const value = element.getAttribute(name);
				if (value) out.add(normalize(value));
			}
		}
		return [...out].filter((value) => /[A-Za-z]/.test(value) && !FIXTURE_TEXT.has(value));
	}

	const everyStatus = (["waiting", "queued", "sent", "skipped", "failed", "removed"] as const).map((state) =>
		card({ status: state, reason: state === "skipped" ? ANKI_REASONS.sessionLimit : undefined }),
	);
	const views = [
		render(null),
		render(
			status({
				pending: 3,
				cards: [
					...everyStatus,
					card({ status: "sent", duplicateOf: "00000000000000aa" }),
					card({ status: "waiting", reason: ANKI_REASONS.noModel, card: undefined }),
					card({ status: "failed", reason: "cannot create note because it is empty" }),
					card({ status: "failed", reason: "Note 1700000000000 is no longer in Anki." }),
				],
			}),
			{
				error: "Could not save the Anki settings.",
				cardError: {
					id: everyStatus[0]!.id,
					error: "Could not remove the note from Anki: Nothing answered at http://127.0.0.1:8765 (ECONNREFUSED). Open Anki and try again.",
				},
			},
		),
		render(status({ cards: [everyStatus[2]!, everyStatus[0]!] }), { removing: everyStatus[2]!.id }),
		render(status({ cards: [everyStatus[0]!] }), { removing: everyStatus[0]!.id }),
		render(status({ connection: { state: "error", error: "http://127.0.0.1:8765 did not answer as AnkiConnect." } })),
		render(status({ connection: { state: "error", error: "AnkiConnect is too old (API version 5; LearnHarness needs 6). Update the add-on in Anki." } })),
		render(status({ pending: 1, connection: { state: "connected", apiVersion: 6, ankiVersion: null, profile: null } })),
		render(status({ connection: { state: "unreachable", addonInstalled: false, error: "ECONNREFUSED" } })),
		render(status({ connection: { state: "unreachable", addonInstalled: null, error: "ECONNREFUSED" } })),
		render(status({ connection: { state: "unauthorized", error: "valid api key must be provided" } })),
		render(status({ connection: { state: "error", error: "unsupported action" } })),
		render(status({ pending: 2 }), { busy: "check" }),
	];

	it("the chat's card and the author labels have entries", () => {
		// Built here, not in the suite body: the chip fixtures are defined below.
		const chipViews = [
			renderChip(),
			renderChip({ input: toolInput({ reason: "request", question: undefined }) }),
			renderChip({ open: true, record: undefined }),
			...(["queued", "sent", "failed", "removed"] as const).map((state) =>
				renderChip({ open: true, record: chipRecord({ status: state, noteId: state === "sent" ? 17 : undefined, reason: state === "failed" ? "Note 17 is no longer in Anki." : undefined }) }),
			),
			renderChip({ open: true, record: chipRecord({ status: "sent", noteId: 17 }), confirming: true }),
			renderChip({ open: true, record: chipRecord(), confirming: true }),
			render(status({ cards: [card({ writtenBy: "tutor" }), card({ writtenBy: "writer" }), card({ kind: "request", writtenBy: "tutor" })] })),
		];
		const missing = [...new Set(chipViews.flatMap(interfaceTexts))].filter((value) => !known(value));
		assert.deepEqual(missing, []);
		assert.equal(pt("Anki card created"), "Card criado no Anki");
		assert.equal(pt("you asked"), "você pediu");
		assert.equal(pt("by the tutor"), "pelo tutor");
		assert.equal(pt("by the reserve writer"), "pela reserva");
	});

	it("every text the view shows has a pt-BR entry", () => {
		const missing = [...new Set(views.flatMap(interfaceTexts))].filter((value) => !known(value));
		assert.deepEqual(missing, []);
	});

	it("the pipeline's fixed reasons and the request fallback have entries", () => {
		for (const reason of Object.values(ANKI_REASONS)) assert.ok(pt(reason), reason);
		assert.equal(pt("Anki request failed"), "Falha na solicitação ao Anki");
		assert.equal(pt("Anki request failed (502)"), "Falha na solicitação ao Anki (502)");
		assert.ok(Object.hasOwn(messages, "Anki"), "the section's name");
	});

	it("the server's messages translate, with their values", () => {
		const url = "http://127.0.0.1:8765";
		const cases: Array<[string, string]> = [
			[`Anki did not answer at ${url} within 5 s.`, `O Anki não respondeu em ${url} dentro de 5 s.`],
			[`Nothing answered at ${url} (ECONNREFUSED).`, `Nada respondeu em ${url} (ECONNREFUSED).`],
			[`${url} did not answer as AnkiConnect.`, `${url} não respondeu como o AnkiConnect.`],
			[`${url} did not answer "findNotes" as AnkiConnect.`, `${url} não respondeu a "findNotes" como o AnkiConnect.`],
			[`${url} answered HTTP 500 to "addNote".`, `${url} respondeu HTTP 500 a "addNote".`],
			["Note 17 is no longer in Anki.", "A nota 17 não está mais no Anki."],
			["Could not read the Anki status.", "Não foi possível ler o status do Anki."],
			["Could not send the cards to Anki: duplicate", "Não foi possível enviar os cards ao Anki: duplicate"],
			[
				`Could not open the note in Anki: Nothing answered at ${url} (ECONNREFUSED). Open Anki and try again.`,
				`Não foi possível abrir a nota no Anki: nada respondeu em ${url} (ECONNREFUSED). Abra o Anki e tente novamente.`,
			],
			[
				`Could not remove the note from Anki: Anki did not answer at ${url} within 5 s. Open Anki and try again.`,
				`Não foi possível remover a nota do Anki: o Anki não respondeu em ${url} dentro de 5 s. Abra o Anki e tente novamente.`,
			],
			[
				"Could not save the Anki settings: Anki cannot take cards right now (busy). Open Anki and try again.",
				"Não foi possível salvar as configurações do Anki: Anki cannot take cards right now (busy). Abra o Anki e tente novamente.",
			],
		];
		for (const [english, portuguese] of cases) assert.equal(pt(english), portuguese, english);
	});

	it("the ledger id field, the search query and id errors stay as written", () => {
		for (const key of ["LH ID", '"LH ID:{0}" note:{1}', "Not a LearnHarness card id: {0}", "Not an Anki note id: {0}"]) {
			assert.ok(Object.hasOwn(messages, key), key);
			assert.equal(messages[key], null, key);
		}
		// Ordinary interface words app-wide: real translations, never null.
		assert.equal(messages.Front, "Frente");
		assert.equal(messages.Back, "Voltar");
		assert.equal(messages.Pitfall, "Armadilha");
	});

	it("the missing-fields message: Portuguese around it, the quoted field names kept in English", () => {
		const message = (fields: string) =>
			`The "LearnHarness" note type in Anki lacks the field(s) ${fields} and this AnkiConnect cannot add fields. ` +
			"Add them in Anki (Tools > Manage Note Types > LearnHarness > Fields), or rename that note type so LearnHarness creates a fresh one.";
		for (const fields of ['"Front", "Back", "Pitfall"', '"Back"']) {
			const translated = pt(message(fields)) ?? "";
			assert.match(translated, /^Faltam ao tipo de nota "LearnHarness" no Anki os campos /, fields);
			assert.ok(translated.includes(` ${fields}, `), translated);
			assert.ok(!/Frente|Voltar|Armadilha/.test(translated), translated);
		}
	});

	it("on the page: interface translated, {folder} and {session} kept, card text and titles untouched", () => {
		const failed = card({ status: "failed", noteId: undefined, reason: "Note 17 is no longer in Anki." });
		const { window, document } = dom(render(status({ pending: 3, cards: [card({ sessionTitle: "Álgebra linear" }), failed] }), { removing: failed.id }));
		(globalThis as { MutationObserver?: unknown }).MutationObserver = (window as unknown as { MutationObserver: unknown }).MutationObserver;
		const stop = startDomTranslation(pt, document.body);
		try {
			assert.match(text(q(document, "anki-enabled")), /^Criar cards no Anki a partir dos erros/);
			assert.equal(enableSwitch(document).getAttribute("aria-label"), "Criar cards no Anki a partir dos erros");
			const deck = text(q(document, "anki-deck"));
			assert.match(deck, /^Baralho/);
			assert.ok(deck.includes("{folder}:") && deck.includes("{session}:"), deck);
			assert.equal(text(q(document, "anki-connection-status")), "Conectado ao Anki 25.02.5");
			assert.deepEqual(qa(document, "anki-connection-detail").map(text), ["Perfil: User 1"]);
			assert.equal(text(q(document, "anki-pending")!.querySelector("span")), "3 cards aguardando");
			assert.equal(text(q(document, "anki-card-status")), "No Anki");
			const failedRow = q(document, `anki-card-${failed.id}`)!;
			assert.equal(text(q(failedRow, "anki-card-reason")), "A nota 17 não está mais no Anki.");
			assert.equal(text(q(failedRow, "anki-card-confirm-question")), "Remover?");
			assert.equal(text(q(failedRow, "anki-card-confirm-remove")), "Confirmar");
			assert.equal(text(q(failedRow, "anki-card-cancel-remove")), "Cancelar");
			assert.equal(text(q(document, "anki-card-front")), "What is the rank of $A$?");
			assert.equal(text(q(document, "anki-card-session")), "Álgebra linear");
		} finally {
			stop();
		}
	});
});

// ─── the tutor's card in the chat ────────────────────────────────────────────

const CHIP_ID = "00000000000000c1";
const toolInput = (over: Partial<AnkiCardToolInput> = {}): AnkiCardToolInput => ({
	reason: "mistake",
	question: "What is the rank of A?",
	front: "What is the **rank** of $A$?",
	back: "The number of pivots.",
	why: "Each pivot marks an independent column.",
	pitfall: "Counting rows instead of pivots.",
	...over,
});
const chipPart = (over: Partial<{ state: string; input: unknown; output: unknown }> = {}) => ({
	type: "tool-anki_card",
	state: "output-available",
	toolCallId: "call_card",
	input: toolInput() as unknown,
	output: { ok: true, cardId: CHIP_ID, linked: true } as unknown,
	...over,
});
const chipRecord = (over: Partial<AnkiCardRecord> = {}) =>
	card({ id: CHIP_ID, writtenBy: "tutor", status: "queued", noteId: undefined, card: { front: toolInput().front, back: "", why: "", pitfall: "" }, ...over });
function renderChip(props: Partial<AnkiCardChipViewProps> = {}): string {
	return renderToStaticMarkup(
		<AnkiCardChipView
			input={toolInput()}
			open={false}
			record={undefined}
			confirming={false}
			busy={false}
			error={null}
			onToggle={noop}
			onRemoveAsk={noop}
			onRemove={noop}
			{...props}
		/>,
	);
}

describe("the chat's Anki card", () => {
	it("is the registry's renderer for anki_card", () => {
		assert.equal(artifactRenderers.anki_card, AnkiCardChip);
	});

	it("collapsed: the header and the front, rendered as Markdown with math", () => {
		const html = renderChip();
		const page = doc(html);
		assert.match(text(q(page, "anki-card-chip-toggle")), /^Anki card created/);
		assert.equal(q(page, "anki-card-chip-toggle")!.getAttribute("aria-expanded"), "false");
		const front = q(page, "anki-card-chip-front")!;
		assert.ok(front.querySelector("strong"), "Markdown emphasis renders");
		assert.ok(front.querySelector(".katex"), "math renders with KaTeX");
		assert.ok(front.querySelector(".lh-prose"), "the card text is content, never translated");
		assert.equal(q(page, "anki-card-chip-details"), null);
		assert.equal(q(page, "anki-card-chip-request"), null, "a mistake card has no 'you asked'");
	});

	it("a card the learner asked for says so", () => {
		const page = doc(renderChip({ input: toolInput({ reason: "request", question: undefined }) }));
		assert.equal(text(q(page, "anki-card-chip-request")), "you asked");
	});

	it("expanded: back, why and pitfall, each only when it has text", () => {
		const full = doc(renderChip({ open: true, record: chipRecord() }));
		assert.equal(q(full, "anki-card-chip-toggle")!.getAttribute("aria-expanded"), "true");
		assert.equal(text(q(full, "anki-card-chip-back")), "The number of pivots.");
		assert.equal(text(q(full, "anki-card-chip-why")), "WhyEach pivot marks an independent column.");
		assert.equal(text(q(full, "anki-card-chip-pitfall")), "PitfallCounting rows instead of pivots.");
		const bare = doc(renderChip({ open: true, record: chipRecord(), input: toolInput({ why: "", pitfall: "  " }) }));
		assert.ok(q(bare, "anki-card-chip-back"));
		assert.equal(q(bare, "anki-card-chip-why"), null);
		assert.equal(q(bare, "anki-card-chip-pitfall"), null);
	});

	it("the status in words: checking, then where the card stands", () => {
		const shown = (record: AnkiCardRecord | null | undefined) => {
			const element = q(doc(renderChip({ open: true, record })), "anki-card-chip-status");
			return element ? text(element) : null;
		};
		assert.equal(shown(undefined), "Checking…");
		assert.equal(shown(null), null, "not in the ledger: no status");
		assert.equal(shown(chipRecord({ status: "sent", noteId: 17 })), "In Anki");
		assert.equal(shown(chipRecord({ status: "queued" })), "Waiting for Anki");
		assert.equal(shown(chipRecord({ status: "failed", reason: "Note 17 is no longer in Anki." })), "Failed");
		assert.equal(shown(chipRecord({ status: "removed" })), "Removed");
		const failed = doc(renderChip({ open: true, record: chipRecord({ status: "failed", reason: "Note 17 is no longer in Anki." }) }));
		assert.equal(text(q(failed, "anki-card-chip-reason")), "Note 17 is no longer in Anki.");
	});

	it("Remove asks first; nothing to remove once removed", () => {
		const sent = chipRecord({ status: "sent", noteId: 17 });
		const plain = doc(renderChip({ open: true, record: sent }));
		assert.equal(text(q(plain, "anki-card-chip-remove")), "Remove");
		assert.equal(q(plain, "anki-card-chip-confirm"), null);
		const asking = doc(renderChip({ open: true, record: sent, confirming: true }));
		assert.equal(text(q(asking, "anki-card-chip-confirm-question")), "Remove from Anki?");
		assert.equal(text(q(asking, "anki-card-chip-confirm-remove")), "Confirm");
		assert.equal(text(q(asking, "anki-card-chip-cancel-remove")), "Cancel");
		assert.equal(q(asking, "anki-card-chip-remove"), null);
		assert.equal(text(q(doc(renderChip({ open: true, record: chipRecord(), confirming: true })), "anki-card-chip-confirm-question")), "Remove?");
		assert.equal(q(doc(renderChip({ open: true, record: chipRecord({ status: "removed" }) })), "anki-card-chip-remove"), null);
		assert.equal(q(doc(renderChip({ open: true, record: undefined })), "anki-card-chip-remove"), null, "not before the status is known");
		const failed = doc(renderChip({ open: true, record: sent, error: "Could not remove the note from Anki." }));
		assert.equal(q(failed, "anki-card-chip-error")!.getAttribute("role"), "alert");
	});

	it("nothing renders for a refusal, an errored call, a call still running, or an input that does not parse", () => {
		assert.ok(ankiCardChipData(chipPart()));
		const nothing = [
			chipPart({ output: { ok: false, error: "This mistake already has a card." } }),
			chipPart({ state: "output-error", input: "not even an object", output: undefined }),
			chipPart({ state: "output-error" }),
			chipPart({ state: "input-available", output: undefined }),
			chipPart({ state: "input-streaming", input: { front: "What is" }, output: undefined }),
			chipPart({ input: { reason: "mistake", front: "x" } }),
			chipPart({ input: toolInput({ front: "   " }) }),
			chipPart({ output: { ok: true, linked: false } }),
			chipPart({ output: null }),
		];
		for (const part of nothing) {
			assert.equal(ankiCardChipData(part), null, JSON.stringify(part));
			assert.equal(renderToStaticMarkup(<AnkiCardChip part={part} />), "", JSON.stringify(part));
		}
		assert.match(renderToStaticMarkup(<AnkiCardChip part={chipPart()} />), /data-testid="anki-card-chip"/);
	});
});

describe("the chat's Anki card, mounted", () => {
	const saved = new Map<string, unknown>();
	const GLOBALS = ["window", "document", "Element", "HTMLElement", "CustomEvent", "IS_REACT_ACT_ENVIRONMENT"] as const;
	const originalFetch = globalThis.fetch;
	let root: Root | undefined;
	let host: HTMLElement | undefined;
	let page: Document;

	before(() => {
		const { window, document } = parseHTML("<!doctype html><html><body></body></html>");
		page = document as unknown as Document;
		const next: Record<string, unknown> = {
			window,
			document,
			Element: window.Element,
			HTMLElement: window.HTMLElement,
			CustomEvent: window.CustomEvent,
			IS_REACT_ACT_ENVIRONMENT: true,
		};
		for (const name of GLOBALS) {
			saved.set(name, (globalThis as Record<string, unknown>)[name]);
			(globalThis as Record<string, unknown>)[name] = next[name];
		}
	});
	after(() => {
		for (const name of GLOBALS) (globalThis as Record<string, unknown>)[name] = saved.get(name);
	});
	afterEach(async () => {
		mock.timers.reset();
		await act(async () => root?.unmount());
		host?.remove();
		root = undefined;
		host = undefined;
		globalThis.fetch = originalFetch;
	});

	// setImmediate, not setTimeout: one test mocks the timers.
	const settle = () => act(async () => { await new Promise((resolve) => setImmediate(resolve)); });
	const click = async (element: HTMLElement | null) => {
		assert.ok(element);
		await act(async () => element.click());
		await settle();
	};
	function fakeLedger(initial: AnkiCardRecord) {
		let current = initial;
		const calls: string[] = [];
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const method = init?.method ?? "GET";
			calls.push(`${method} ${String(input)}`);
			if (method === "GET") {
				assert.equal((init?.headers as Record<string, string> | undefined)?.[ANKI_HEADER], undefined);
				return Response.json({ card: current });
			}
			assert.equal(method, "DELETE");
			assert.equal((init?.headers as Record<string, string>)[ANKI_HEADER], "1");
			current = { ...current, status: "removed", reason: ANKI_REASONS.removedByUser };
			return Response.json(status({ cards: [current] }));
		}) as typeof fetch;
		return {
			calls,
			set(next: AnkiCardRecord) {
				current = next;
			},
		};
	}
	async function mount(part = chipPart()) {
		host = page.createElement("div") as unknown as HTMLElement;
		page.body.append(host);
		root = createRoot(host);
		await act(async () => root!.render(<AnkiCardChip part={part} />));
		await settle();
	}
	const read = `GET ${ANKI_API}/cards/${CHIP_ID}`;

	it("reads the status on mount and again on expand, then shows it", async () => {
		const ledger = fakeLedger(chipRecord({ status: "sent", noteId: 17 }));
		await mount();
		assert.deepEqual(ledger.calls, [read]);
		assert.equal(q(page, "anki-card-chip-details"), null);
		await click(q(page, "anki-card-chip-toggle"));
		assert.deepEqual(ledger.calls, [read, read]);
		assert.equal(text(q(page, "anki-card-chip-status")), "In Anki");
		assert.equal(text(q(page, "anki-card-chip-back")), "The number of pivots.");
		await click(q(page, "anki-card-chip-toggle"));
		assert.equal(q(page, "anki-card-chip-details"), null, "collapses again");
		assert.deepEqual(ledger.calls, [read, read], "collapsing reads nothing");
	});

	it("while the card waits for Anki: one more read, no loop", async () => {
		mock.timers.enable({ apis: ["setTimeout"] });
		const ledger = fakeLedger(chipRecord({ status: "queued" }));
		await mount();
		await click(q(page, "anki-card-chip-toggle"));
		assert.equal(text(q(page, "anki-card-chip-status")), "Waiting for Anki");
		const before = ledger.calls.length;
		ledger.set(chipRecord({ status: "sent", noteId: 17 }));
		await act(async () => mock.timers.tick(ANKI_CHIP_RECHECK_MS));
		await settle();
		assert.equal(ledger.calls.length, before + 1);
		assert.equal(text(q(page, "anki-card-chip-status")), "In Anki");
		ledger.set(chipRecord({ status: "queued" }));
		await click(q(page, "anki-card-chip-toggle"));
		await click(q(page, "anki-card-chip-toggle"));
		assert.equal(text(q(page, "anki-card-chip-status")), "Waiting for Anki");
		const after = ledger.calls.length;
		await act(async () => mock.timers.tick(ANKI_CHIP_RECHECK_MS * 3));
		await settle();
		assert.equal(ledger.calls.length, after, "only once per card");
	});

	it("Remove asks; Cancel puts it back; Confirm sends the DELETE and the card shows Removed", async () => {
		const ledger = fakeLedger(chipRecord({ status: "sent", noteId: 17 }));
		await mount();
		await click(q(page, "anki-card-chip-toggle"));
		await click(q(page, "anki-card-chip-remove"));
		assert.equal(text(q(page, "anki-card-chip-confirm-question")), "Remove from Anki?");
		await click(q(page, "anki-card-chip-cancel-remove"));
		assert.ok(q(page, "anki-card-chip-remove"));
		assert.ok(!ledger.calls.some((call) => call.startsWith("DELETE")), "asking and cancelling send nothing");
		await click(q(page, "anki-card-chip-remove"));
		await click(q(page, "anki-card-chip-confirm-remove"));
		assert.deepEqual(ledger.calls.filter((call) => call.startsWith("DELETE")), [`DELETE ${ANKI_API}/cards/${CHIP_ID}`]);
		assert.equal(text(q(page, "anki-card-chip-status")), "Removed");
		assert.equal(q(page, "anki-card-chip-remove"), null);
		assert.equal(q(page, "anki-card-chip-confirm"), null);
	});

	it("a refused or errored part renders nothing and reads nothing", async () => {
		const ledger = fakeLedger(chipRecord());
		await mount(chipPart({ output: { ok: false, error: "This mistake already has a card." } }));
		assert.equal(host!.innerHTML, "");
		await act(async () => root!.render(<AnkiCardChip part={chipPart({ state: "output-error", input: "{bad", output: undefined })} />));
		await settle();
		assert.equal(host!.innerHTML, "");
		assert.deepEqual(ledger.calls, []);
	});
});
