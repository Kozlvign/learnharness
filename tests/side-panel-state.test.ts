import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	clampSidePanelWidth,
	CLOSED_SIDE_PANEL,
	parsePersistedSidePanel,
	parseSidePanelWidth,
	persistedSidePanel,
	sidePanelReducer,
	SIDE_PANEL_DEFAULT_WIDTH,
	SIDE_PANEL_MIN_WIDTH,
	sidePanelStorageKey,
	type SidePanelAction,
	type SidePanelState,
} from "../components/side-panel-state.ts";

/** Fork: side panel (docs/side-panel.md). */

const run = (actions: SidePanelAction[], from: SidePanelState = CLOSED_SIDE_PANEL) => actions.reduce(sidePanelReducer, from);

describe("side panel — opening and items", () => {
	it("opens on Materials with the newest item when nothing was chosen", () => {
		const state = run([{ type: "open", fallbackId: "demo2" }]);
		assert.deepEqual(state, { open: true, tab: "materials", selectedId: "demo2", alive: ["demo2"], openedBySideQuestion: false });
	});

	it("reopens on the item it showed before", () => {
		const state = run([{ type: "select", id: "demo1" }, { type: "close" }, { type: "open", fallbackId: "demo2" }]);
		assert.equal(state.selectedId, "demo1");
	});

	it("keeps opened demos alive until the panel closes", () => {
		const open = run([{ type: "select", id: "demo1" }, { type: "select", id: "figure" }, { type: "select", id: "demo1" }]);
		assert.deepEqual(open.alive, ["demo1", "figure"]);
		const reopened = run([{ type: "close" }, { type: "select", id: "figure" }], open);
		assert.deepEqual(reopened.alive, ["figure"], "a closed panel drops what it kept alive");
	});

	it("opens a closed panel from a card's Open in side panel", () => {
		const state = run([{ type: "select", id: "figure" }]);
		assert.equal(state.open, true);
		assert.equal(state.tab, "materials");
	});
});

describe("side panel — the pinned side question", () => {
	it("opens a closed panel on the side question's tab, and closes it again on release", () => {
		const pinned = run([{ type: "side-pinned" }]);
		assert.equal(pinned.open, true);
		assert.equal(pinned.tab, "side-question");
		assert.equal(pinned.openedBySideQuestion, true);
		const released = run([{ type: "side-released" }], pinned);
		assert.equal(released.open, false);
	});

	it("returns an already open panel to Materials on release", () => {
		const state = run([{ type: "open", fallbackId: "demo1" }, { type: "side-pinned" }, { type: "side-released" }]);
		assert.equal(state.open, true);
		assert.equal(state.tab, "materials");
		assert.equal(state.selectedId, "demo1");
	});

	it("stays open after release once the learner used Materials", () => {
		const byTab = run([{ type: "side-pinned" }, { type: "tab", tab: "materials" }, { type: "tab", tab: "side-question" }, { type: "side-released" }]);
		assert.equal(byTab.open, true);
		const byCard = run([{ type: "side-pinned" }, { type: "select", id: "demo1" }, { type: "side-released" }]);
		assert.equal(byCard.open, true);
		assert.equal(byCard.tab, "materials");
	});

	it("ignores a release while closed (the panel was closed first)", () => {
		const state = run([{ type: "open", fallbackId: null }, { type: "side-pinned" }, { type: "close" }, { type: "side-released" }]);
		assert.equal(state.open, false);
	});
});

describe("side panel — arrivals", () => {
	it("switches an open panel to a new demo", () => {
		const state = run([{ type: "open", fallbackId: "demo1" }, { type: "arrived", id: "demo2" }]);
		assert.equal(state.selectedId, "demo2");
		assert.deepEqual(state.alive, ["demo1", "demo2"]);
	});

	it("leaves a closed panel closed", () => {
		assert.equal(run([{ type: "arrived", id: "demo2" }]), CLOSED_SIDE_PANEL);
	});

	it("never takes the side question's tab away", () => {
		const state = run([{ type: "open", fallbackId: "demo1" }, { type: "side-pinned" }, { type: "arrived", id: "demo2" }]);
		assert.equal(state.tab, "side-question");
		assert.equal(state.selectedId, "demo2");
	});
});

describe("side panel — what a session remembers", () => {
	it("remembers open/closed and the item, never a side-question-only panel", () => {
		assert.deepEqual(persistedSidePanel(run([{ type: "select", id: "demo1" }])), { open: true, selectedId: "demo1" });
		assert.deepEqual(persistedSidePanel(run([{ type: "side-pinned" }])), { open: false, selectedId: null });
	});

	it("restores the remembered state", () => {
		assert.deepEqual(run([{ type: "restore", persisted: { open: true, selectedId: "figure" } }]),
			{ open: true, tab: "materials", selectedId: "figure", alive: ["figure"], openedBySideQuestion: false });
		assert.equal(run([{ type: "restore", persisted: { open: false, selectedId: "figure" } }]).open, false);
	});

	it("reads stored records tolerantly", () => {
		assert.deepEqual(parsePersistedSidePanel(null), { open: false, selectedId: null });
		assert.deepEqual(parsePersistedSidePanel("not json"), { open: false, selectedId: null });
		assert.deepEqual(parsePersistedSidePanel(JSON.stringify({ open: true, selectedId: 3 })), { open: true, selectedId: null });
		assert.equal(sidePanelStorageKey("chat_1"), "lh:side-panel:chat_1");
	});

	it("keeps the width between the minimum and 60% of the session area", () => {
		assert.equal(parseSidePanelWidth(null), SIDE_PANEL_DEFAULT_WIDTH);
		assert.equal(parseSidePanelWidth("100"), SIDE_PANEL_DEFAULT_WIDTH);
		assert.equal(parseSidePanelWidth("512.4"), 512);
		assert.equal(clampSidePanelWidth(100, 1200), SIDE_PANEL_MIN_WIDTH);
		assert.equal(clampSidePanelWidth(900, 1200), 720);
		assert.equal(clampSidePanelWidth(500, 400), SIDE_PANEL_MIN_WIDTH, "a tiny area still allows the minimum");
	});
});
