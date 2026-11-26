/** The fork's update button and panel with a fake preload bridge: no
 * Electron, git, build or install. */
import React, { act } from "react";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import type { Root } from "react-dom/client";
import { InteractionLayersProvider } from "../components/interaction-layers.tsx";
import { changeLabel, forkUpdateView, type ForkUpdateBridge, type ForkUpdateState } from "../components/fork-update-button.tsx";

const sha = (c: string) => c.repeat(40);
const state = (over: Partial<ForkUpdateState> = {}): ForkUpdateState => ({
	status: "idle", installed: { sha: sha("a"), date: "2026-11-25T10:00:00-03:00" }, latest: null,
	changes: [], changeCount: 0, step: null, version: null, error: null, message: null, log: null, revision: 1, ...over,
});

describe("what the panel says", () => {
	it("labels changes by their commit type", () => {
		assert.deepEqual(changeLabel("feat(chat): side panel with the materials"), { kind: "New feature", text: "Side panel with the materials" });
		assert.deepEqual(changeLabel("fix: keep the panel open"), { kind: "Fix", text: "Keep the panel open" });
		assert.deepEqual(changeLabel("perf!: faster graph"), { kind: "Performance", text: "Faster graph" });
		assert.deepEqual(changeLabel("chore(i18n): translate new text"), { kind: "Tweak", text: "Translate new text" });
		assert.deepEqual(changeLabel("Merge the thing"), { kind: "Change", text: "Merge the thing" });
	});

	it("counts changes and names the versions", () => {
		const latest = { sha: sha("b"), date: null };
		assert.equal(forkUpdateView(state({ status: "available", latest, changeCount: 1 })).description, "1 change since your version.");
		assert.equal(forkUpdateView(state({ status: "available", latest, changeCount: 4 })).description, "4 changes since your version.");
		assert.equal(forkUpdateView(state({ status: "available", latest, changeCount: 0 })).description, "The fork's main has a newer version than yours.");
		assert.match(forkUpdateView(state({ status: "available", latest })).version!, /^aaaaaaa \(.+\) → bbbbbbb$/);
		assert.match(forkUpdateView(state({ status: "up-to-date" })).version!, /^Version aaaaaaa \(/);
		assert.equal(forkUpdateView(state({ status: "ready", version: "0.7.3" })).version, "New version 0.7.3");
	});

	it("only an update, a ready build or a failed update put a dot on the icon", () => {
		const dotted = (["idle", "checking", "up-to-date", "available", "check-failed", "building", "ready", "build-failed"] as const)
			.filter(status => forkUpdateView(state({ status })).badge);
		assert.deepEqual(dotted, ["available", "ready", "build-failed"]);
	});

	it("turns codes and script steps into sentences", () => {
		assert.equal(forkUpdateView(state({ status: "check-failed", error: "fetch" })).description, "Couldn't reach the fork's main on GitHub. Check your connection.");
		assert.equal(forkUpdateView(state({ status: "build-failed", error: "interrupted" })).description, "The update stopped before it finished.");
		assert.equal(forkUpdateView(state({ status: "build-failed", error: "nothing" })).description, "The release script ended without a new version to install.");
		assert.equal(forkUpdateView(state({ status: "build-failed", error: "swap" })).description, "The new version couldn't replace the installed one.");
		assert.equal(forkUpdateView(state({ status: "building", step: "Building" })).description, "Building the new version…");
		assert.equal(forkUpdateView(state({ status: "building", step: "Copying the new version" })).description, "Copying the new version…");
		assert.equal(forkUpdateView(state({ status: "building", step: "Waiting for the previous update" })).description, "Waiting for the previous update to finish publishing…");
		assert.equal(forkUpdateView(state({ status: "building", step: "Something new" })).description, "Starting the release script…");
	});

	it("a build names both versions once main's commit is known", () => {
		assert.match(forkUpdateView(state({ status: "building", latest: { sha: sha("b"), date: null } })).version!, /^aaaaaaa \(.+\) → bbbbbbb$/);
		assert.equal(forkUpdateView(state({ status: "building" })).version, undefined);
	});
});

let restore: (() => void) | undefined;
let root: Root | undefined;
const byTest = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const click = async (element: HTMLElement | null) => { assert.ok(element, "missing click target"); await act(async () => { element.click(); }); };

function bridge(initial: ForkUpdateState) {
	const listeners = new Set<(value: ForkUpdateState) => void>();
	const calls = { check: 0, start: 0, restart: 0 };
	let snapshot = Promise.resolve(initial);
	const fake: ForkUpdateBridge = {
		get: () => snapshot,
		check: async () => { calls.check++; return undefined; },
		start: async () => { calls.start++; return state({ status: "building", revision: 50 }); },
		restart: () => { calls.restart++; },
		onStatus: cb => { listeners.add(cb); return () => { listeners.delete(cb); }; },
	};
	return {
		fake, calls,
		setSnapshot: (value: Promise<ForkUpdateState>) => { snapshot = value; },
		push: async (value: ForkUpdateState) => { await act(async () => { for (const listener of listeners) listener(value); }); },
	};
}

async function mount(b: ForkUpdateBridge | undefined) {
	const { window: win, document: doc } = parseHTML("<html><body><div id='root'></div></body></html>");
	let active: Element = doc.body;
	Object.defineProperty(doc, "activeElement", { get: () => active });
	Object.assign(win, { innerWidth: 1280, innerHeight: 900 });
	win.HTMLElement.prototype.focus = function () { active = this; };
	win.HTMLElement.prototype.getBoundingClientRect = () => ({ top: 800, bottom: 824, left: 220, right: 244, width: 24, height: 24, x: 220, y: 800, toJSON() {} });
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [name, value] of Object.entries({
		React, window: win, document: doc, Element: win.Element, HTMLElement: win.HTMLElement,
		HTMLInputElement: win.HTMLInputElement, HTMLTextAreaElement: win.HTMLTextAreaElement,
		Event: win.Event, CustomEvent: win.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true,
		ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
		requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
		cancelAnimationFrame: clearTimeout,
	})) {
		previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
		Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
	}
	restore = () => {
		for (const [name, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, name, descriptor);
			else delete (globalThis as Record<string, unknown>)[name];
		}
	};
	const { createRoot } = await import("react-dom/client");
	const { ForkUpdateButton } = await import("../components/fork-update-button.tsx");
	root = createRoot(doc.getElementById("root")!);
	await act(async () => { root!.render(<InteractionLayersProvider><ForkUpdateButton bridge={b} /></InteractionLayersProvider>); });
}

afterEach(async () => {
	if (root) await act(async () => { root!.unmount(); });
	root = undefined;
	restore?.();
	restore = undefined;
});

describe("the button beside Settings", () => {
	it("shows nothing without a bridge or in a build that cannot update itself", async () => {
		await mount(undefined);
		assert.equal(byTest("fork-update-button"), null);
		await act(async () => { root!.unmount(); }); root = undefined; restore?.();
		await mount(bridge(state({ status: "unsupported" })).fake);
		assert.equal(byTest("fork-update-button"), null);
	});

	it("an available update gets a dot; the panel lists the changes and updates on click", async () => {
		const changes = [
			{ sha: sha("c"), date: null, subject: "feat(chat): side panel" },
			{ sha: sha("d"), date: null, subject: "fix: keep it open" },
		];
		const b = bridge(state({ status: "available", latest: { sha: sha("b"), date: null }, changes, changeCount: 5 }));
		await mount(b.fake);
		assert.ok(byTest("fork-update-badge"));
		assert.equal(byTest("fork-update-button")!.getAttribute("aria-label"), "Update available");
		await click(byTest("fork-update-button"));
		assert.equal(byTest("fork-update-title")!.textContent, "New version available");
		const items = [...byTest("fork-update-changes")!.querySelectorAll("li")].map(li => li.textContent);
		assert.deepEqual(items, ["New featureSide panel", "FixKeep it open"]);
		assert.equal(byTest("fork-update-more")!.textContent, "and 3 more changes");
		assert.equal(byTest("fork-update-check"), null);
		await click(byTest("fork-update-start"));
		assert.equal(b.calls.start, 1);
		assert.equal(byTest("fork-update-title")!.textContent, "Preparing the update…", "the start reply shows the build");
		assert.equal(byTest("fork-update-badge"), null);
	});

	it("lists the changes while the update builds and once it is ready", async () => {
		const changes = [{ sha: sha("c"), date: null, subject: "feat: images in answers" }];
		const b = bridge(state({ status: "building", step: "Building", changes, changeCount: 1 }));
		await mount(b.fake);
		await click(byTest("fork-update-button"));
		assert.equal(byTest("fork-update-title")!.textContent, "Preparing the update…");
		assert.deepEqual([...byTest("fork-update-changes")!.querySelectorAll("li")].map(li => li.textContent), ["New featureImages in answers"]);
		await b.push(state({ status: "ready", version: "0.7.4", changes, changeCount: 1, revision: 5 }));
		assert.equal(byTest("fork-update-title")!.textContent, "Update ready");
		assert.ok(byTest("fork-update-changes"));
		await b.push(state({ status: "up-to-date", changes, changeCount: 1, revision: 6 }));
		assert.equal(byTest("fork-update-changes"), null, "nothing listed once installed");
	});

	it("follows pushes, and an older snapshot never hides a newer push", async () => {
		const b = bridge(state());
		let resolve!: (value: ForkUpdateState) => void;
		b.setSnapshot(new Promise(yes => { resolve = yes; }));
		await mount(b.fake);
		assert.equal(byTest("fork-update-button"), null, "nothing until the first state arrives");
		await b.push(state({ status: "ready", version: "0.7.3", revision: 9 }));
		await act(async () => { resolve(state({ status: "checking", revision: 3 })); });
		await click(byTest("fork-update-button"));
		assert.equal(byTest("fork-update-title")!.textContent, "Update ready");
		assert.equal(byTest("fork-update-version")!.textContent, "New version 0.7.3");
		await click(byTest("fork-update-restart"));
		assert.equal(b.calls.restart, 1);
	});

	it("up to date offers a check; a failed build shows the script's message and log", async () => {
		const b = bridge(state({ status: "up-to-date" }));
		await mount(b.fake);
		assert.equal(byTest("fork-update-badge"), null);
		await click(byTest("fork-update-button"));
		await click(byTest("fork-update-check"));
		assert.equal(b.calls.check, 1);
		await b.push(state({ status: "build-failed", error: "script", message: "Upstream has 3 new commits.", log: "C:\\logs\\release.log", revision: 4 }));
		assert.equal(byTest("fork-update-title")!.textContent, "The update didn't finish");
		const details = byTest("fork-update-details")!;
		assert.equal(details.getAttribute("data-lh-i18n"), "off", "the script's own words are not translated");
		assert.match(details.textContent!, /Upstream has 3 new commits\.C:\\logs\\release\.log/);
		assert.ok(byTest("fork-update-start"), "update again");
	});
});
