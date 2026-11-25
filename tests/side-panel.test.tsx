import assert from "node:assert/strict";
import { describe, it } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import type { LhViewMessage } from "../src/core/index.ts";
import { actionForBinding, bindingForAction, kbdEventForAction } from "../src/core/keyboard.ts";
import { materialElement, SidePanel, type SidePanelHandle } from "../components/side-panel.tsx";
import { OpenInSidePanelButton, SidePanelContext, type SidePanelControls } from "../components/side-panel-context.tsx";
import { findMaterial, sessionMaterials, type SessionMaterial } from "../components/session-materials.ts";
import { CLOSED_SIDE_PANEL, type SidePanelState } from "../components/side-panel-state.ts";

/** Fork: side panel (docs/side-panel.md). */

const MESSAGES: LhViewMessage[] = [
	{ id: "steer_demo", role: "user", metadata: { subagentResult: { jobId: "j1", kind: "demo", toolCallId: "c1" } }, parts: [
		{ type: "data-subagent-artifact", data: { kind: "demo", result: { title: "Dois pontos e a inclinação da secante", html: "<p>demo</p>", tested: true } } },
	] },
	{ id: "steer_figure", role: "user", metadata: { subagentResult: { jobId: "j2", kind: "visual", toolCallId: "c2" } }, parts: [
		{ type: "data-subagent-artifact", data: { kind: "visual", result: { svg: "<svg width=\"10\" height=\"10\"><rect/></svg>" } } },
	] },
];
const ITEMS = sessionMaterials(MESSAGES, { plan: false });

function handle(state: Partial<SidePanelState>, items: SessionMaterial[] = ITEMS): SidePanelHandle {
	const full = { ...CLOSED_SIDE_PANEL, open: true, ...state };
	const browsable = items.filter((item) => item.kind !== "plan");
	return {
		ready: true,
		state: full,
		width: 480,
		browsable,
		current: browsable.find((item) => item.id === full.selectedId) ?? browsable.at(-1) ?? null,
		toggle() {}, close() {}, select() {}, setTab() {}, resize() {}, commitWidth() {},
	};
}

const render = (node: React.ReactElement) => parseHTML(`<html><body>${renderToStaticMarkup(node)}</body></html>`).document;

describe("the side panel", () => {
	it("shows the Materials tab with the current item under the selector", () => {
		const doc = render(<SidePanel panel={handle({ selectedId: "material:steer_demo" })} items={ITEMS} onShowInChat={() => {}} onOpenPlan={() => {}} />);
		assert.ok(doc.querySelector('[data-testid="side-panel"]'));
		assert.equal(doc.querySelector('[data-testid="side-panel-tab-materials"]')!.getAttribute("aria-selected"), "true");
		assert.equal(doc.querySelector('[data-testid="side-panel-tab-side-question"]'), null, "no Side question tab without a pinned side question");
		assert.match(doc.querySelector('[data-testid="side-panel-selector"]')!.textContent!, /Dois pontos e a inclinação da secante/);
		assert.equal(doc.querySelector('[data-testid="side-panel-selector"] [data-lh-i18n="off"]')!.textContent, "Dois pontos e a inclinação da secante", "the teacher's title is never translated");
		assert.ok(doc.querySelector('[data-testid="side-panel-previous"]')!.hasAttribute("disabled"), "the first item has no previous");
		assert.equal(doc.querySelector('[data-testid="side-panel-next"]')!.hasAttribute("disabled"), false);
		assert.ok(doc.querySelector('[data-testid="side-panel-body"] [data-testid="demo-card"]'));
		assert.equal(doc.querySelector('[data-testid="open-in-side-panel"]'), null, "cards inside the panel offer no Open in side panel");
	});

	it("keeps an opened demo mounted but hidden while another item shows", () => {
		const doc = render(<SidePanel panel={handle({ selectedId: "material:steer_figure", alive: ["material:steer_demo"] })} items={ITEMS} onShowInChat={() => {}} onOpenPlan={() => {}} />);
		const demo = doc.querySelector('[data-testid="side-panel-demo"]')!;
		assert.equal(demo.getAttribute("aria-hidden"), "true");
		assert.match(demo.getAttribute("class")!, /invisible/);
		assert.ok(doc.querySelector('[data-testid="visual-card"]'));
		assert.match(doc.querySelector('[data-testid="side-panel-selector"]')!.textContent!, /Figure 1/);
	});

	it("adds the Side question tab while a side question is pinned", () => {
		const doc = render(<SidePanel panel={handle({ tab: "side-question" })} items={ITEMS} onShowInChat={() => {}} onOpenPlan={() => {}}
			sideQuestion={<div data-testid="pinned-side-question" />} />);
		assert.equal(doc.querySelector('[data-testid="side-panel-tab-side-question"]')!.getAttribute("aria-selected"), "true");
		assert.match(doc.querySelector('[data-testid="side-panel-materials"]')!.getAttribute("class")!, /\bhidden\b/, "Materials stays mounted behind the tab");
		assert.ok(doc.querySelector('[data-testid="side-panel-side-question"] [data-testid="pinned-side-question"]'));
	});

	it("explains itself when the session has no materials yet", () => {
		const doc = render(<SidePanel panel={handle({}, [])} items={[]} onShowInChat={() => {}} onOpenPlan={() => {}} />);
		assert.match(doc.querySelector('[data-testid="side-panel-empty"]')!.textContent!, /Nothing here yet/);
	});
});

describe("Open in side panel", () => {
	const controls: SidePanelControls = { canOpen: (target) => findMaterial(ITEMS, target) !== undefined, open() {} };

	it("shows only on the chat page, for this session's items", () => {
		assert.equal(renderToStaticMarkup(<OpenInSidePanelButton target={{ messageId: "steer_demo" }} />), "", "no chat page, no button");
		const known = render(<SidePanelContext.Provider value={controls}><OpenInSidePanelButton target={{ messageId: "steer_demo" }} /></SidePanelContext.Provider>);
		assert.equal(known.querySelector('[data-testid="open-in-side-panel"]')!.getAttribute("aria-label"), "Open in side panel");
		const unknown = render(<SidePanelContext.Provider value={controls}><OpenInSidePanelButton target={{ chart: "graph TD" }} /></SidePanelContext.Provider>);
		assert.equal(unknown.querySelector('[data-testid="open-in-side-panel"]'), null);
	});
});

describe("Show in chat — finding the item in the transcript", () => {
	const { document } = parseHTML(`<html><body><main>
		<div data-material-id="material:steer_demo"><div data-testid="demo-card"></div></div>
		<div data-testid="user-message" data-material-ids="material:u1:image:0 material:u1:image:1"></div>
		<div data-text-part-key="a2:0"><div data-testid="md-mermaid"></div><div data-streamdown="mermaid-error"></div></div>
	</main></body></html>`);
	const main = document.querySelector("main")!;
	const items = sessionMaterials([
		...MESSAGES,
		{ id: "a2", role: "assistant", parts: [{ type: "text", id: "a2:0", text: "```mermaid\ngraph TD\n```\n```mermaid\nbroken\n```" }] },
		{ id: "u1", role: "user", parts: [{ type: "image", attachment: "a.png" }, { type: "image", attachment: "b.png" }] },
	], { plan: true });

	it("finds cards, the learner's row and the n-th diagram of a text part", () => {
		assert.equal(materialElement(main, items.find((item) => item.kind === "demo")!)!.getAttribute("data-material-id"), "material:steer_demo");
		assert.equal(materialElement(main, items.find((item) => item.kind === "learner-image" && item.index === 1)!)!.getAttribute("data-testid"), "user-message");
		const diagrams = items.filter((item) => item.kind === "diagram");
		assert.equal(materialElement(main, diagrams[0]!)!.getAttribute("data-testid"), "md-mermaid");
		assert.equal(materialElement(main, diagrams[1]!)!.getAttribute("data-streamdown"), "mermaid-error");
		assert.equal(materialElement(main, items.find((item) => item.kind === "figure")!), null, "an item not in the DOM is not found");
	});
});

describe("Ctrl+E toggles the side panel", () => {
	it("is a rebindable chat action", () => {
		assert.equal(actionForBinding("mod+e"), "toggle-side-panel");
		assert.equal(bindingForAction("toggle-side-panel"), "mod+e");
		assert.equal(kbdEventForAction("toggle-side-panel"), "lh:kbd-toggle-side-panel");
	});
});
