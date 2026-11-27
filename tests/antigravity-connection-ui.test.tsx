import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { installModalDom } from "./modal-dom.ts";
import type { AntigravityStatus } from "../src/core/contracts/antigravity.ts";

// react-dom detects input events when it loads, so the DOM comes first.
const dom = parseHTML("<html><body></body></html>");
Object.defineProperty(dom.document, "oninput", { configurable: true, value: null });
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true });
installModalDom(dom);
const { createRoot } = await import("react-dom/client");
const { AntigravityBackgroundAccess, AntigravityConnection, AntigravityUIProvider } = await import("../components/settings/antigravity-connection.tsx");
const { InteractionLayersProvider } = await import("../components/interaction-layers.tsx");
const originalFetch = globalThis.fetch;
let root: Root | undefined, host: HTMLDivElement | undefined;

const BASE: AntigravityStatus = {
	state: "missing", connected: false, version: null, executable: null, source: null, account: null, models: [], allowBackgroundUse: true,
	managed: { supported: true, installed: null, latest: "1.5.18" }, install: null, login: null, checkedAt: 1, revision: 1,
};
/** The server's answers: each control returns the next state the test gives it. */
function fixture(initial: Partial<AntigravityStatus>) {
	let status: AntigravityStatus = { ...BASE, ...initial };
	const posts: Array<Record<string, unknown>> = [];
	const replies: Array<Partial<AntigravityStatus>> = [];
	globalThis.fetch = (async (url, init) => {
		assert.match(String(url), /^\/api\/antigravity(\?refresh=1)?$/);
		assert.equal(new Headers(init?.headers).get("x-learnharness-antigravity"), "1");
		if (init?.method === "POST") {
			posts.push(JSON.parse(String(init.body)));
			const next = replies.shift();
			if (next) status = { ...status, ...next, revision: status.revision + 1 };
		}
		return Response.json(status);
	}) as typeof fetch;
	return { posts, reply: (next: Partial<AntigravityStatus>) => replies.push(next) };
}
async function mount(extra?: React.ReactNode) {
	host = document.createElement("div"); document.body.append(host); root = createRoot(host);
	await act(async () => root!.render(<InteractionLayersProvider><AntigravityUIProvider><AntigravityConnection />{extra}</AntigravityUIProvider></InteractionLayersProvider>));
}
const dialog = () => document.querySelector<HTMLElement>('[data-testid="antigravity-dialog"]');
function button(text: string, scope: ParentNode = document) {
	const found = [...scope.querySelectorAll<HTMLButtonElement>("button")].find((element) => element.textContent === text);
	assert(found, `missing button ${text}`);
	return found;
}
const hasButton = (text: string, scope: ParentNode = document) => [...scope.querySelectorAll("button")].some((element) => element.textContent === text);
async function click(element: HTMLElement) { await act(async () => { element.click(); }); }
async function type(input: HTMLInputElement, value: string) {
	// The prototype setter skips React's value tracker, as typing does.
	await act(async () => {
		input.focus();
		Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
		input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
	});
}
async function open() { await click(document.querySelector<HTMLElement>('[data-testid="antigravity-connection"] button')!); }
afterEach(async () => {
	await act(async () => root?.unmount()); host?.remove(); root = undefined; host = undefined;
	globalThis.fetch = originalFetch;
});

test("not installed: the dialog offers Google's runtime and shows the download's progress", async () => {
	const server = fixture({});
	await mount();
	assert.equal(document.querySelector('[data-testid="antigravity-summary"]')?.textContent, "Antigravity not installed");
	await open();
	assert(dialog()?.textContent?.includes("Google's official runtime"));
	assert(dialog()?.querySelector('[data-testid="antigravity-notice"]')?.textContent?.includes("never falls back to an API key"));
	server.reply({ install: { phase: "downloading", version: "1.5.18", downloadedBytes: 40, totalBytes: 100, message: null } });
	await click(button("Install Antigravity", dialog()!));
	assert.deepEqual(server.posts.at(-1), { op: "install" });
	assert.match(dialog()!.querySelector('[data-testid="antigravity-install-progress"]')!.textContent!, /Downloading Antigravity 1\.5\.18… 40%/);
	assert(!hasButton("Check again", dialog()!), "only Cancel and Close while downloading");
	server.reply({ install: { phase: "cancelled", version: null, downloadedBytes: 0, totalBytes: null, message: "Installation cancelled. Nothing was changed." } });
	await click(button("Cancel", dialog()!));
	assert.deepEqual(server.posts.at(-1), { op: "cancel-install" });
	assert(dialog()!.textContent!.includes("Installation cancelled. Nothing was changed."));
});

test("signed out: Google's link opens in the browser and the pasted code goes to agy", async () => {
	const server = fixture({ state: "signed-out", version: "1.5.18", executable: "C:/agy.exe", source: "managed", managed: { supported: true, installed: "1.5.18", latest: "1.5.18" } });
	await mount();
	await open();
	assert(dialog()!.textContent!.includes("installed but not signed in"));
	server.reply({ login: { phase: "waiting", url: "https://accounts.google.com/o/oauth2/auth?state=s", message: null } });
	await click(button("Sign in with Google", dialog()!));
	assert.deepEqual(server.posts.at(-1), { op: "login-start" });
	const link = dialog()!.querySelector<HTMLAnchorElement>('[data-testid="antigravity-login-link"]')!;
	assert.equal(link.getAttribute("href"), "https://accounts.google.com/o/oauth2/auth?state=s");
	assert.equal(link.getAttribute("target"), "_blank");
	assert.equal(button("Submit", dialog()!).disabled, true);
	await type(dialog()!.querySelector<HTMLInputElement>('[data-testid="antigravity-login-code"]')!, "  4/abc-code  ");
	server.reply({ login: { phase: "verifying", url: null, message: null } });
	await click(button("Submit", dialog()!));
	assert.deepEqual(server.posts.at(-1), { op: "login-submit", code: "4/abc-code" });
	assert(dialog()!.textContent!.includes("Finishing sign-in"));
});

test("connected: account, models, background consent, update and sign-out", async () => {
	const connected: Partial<AntigravityStatus> = {
		state: "connected", connected: true, version: "1.5.17", executable: "C:/agy.exe", source: "managed",
		account: { email: "learner@example.invalid", plan: "Google AI Pro" },
		models: [{ id: "gemini-4-neon", name: "Gemini 4 Neon", levels: ["low", "high"] }, { id: "claude-opus-5-5", name: "Claude Opus 5.5", levels: [] }],
		managed: { supported: true, installed: "1.5.17", latest: "1.5.18" },
	};
	const server = fixture(connected);
	await mount(<AntigravityBackgroundAccess provider="antigravity" />);
	assert.equal(document.querySelector('[data-testid="antigravity-summary"]')?.textContent, "Google AI Pro · learner@example.invalid");
	assert(!hasButton("Enable background use"), "consent is on");
	await open();
	assert(dialog()!.textContent!.includes("Signed in as learner@example.invalid · Google AI Pro"));
	assert.equal(dialog()!.querySelector('[data-testid="antigravity-models"]')?.textContent, "Gemini 4 Neon, Claude Opus 5.5");
	assert(dialog()!.querySelector('[data-testid="antigravity-update"]')!.textContent!.includes("Antigravity 1.5.18 is available."));
	server.reply({ allowBackgroundUse: false });
	await click(dialog()!.querySelector<HTMLElement>('[role="switch"]')!);
	assert.deepEqual(server.posts.at(-1), { op: "consent", enabled: false });
	assert(hasButton("Enable background use"), "the slot shortcut appears once consent is off");
	await click(button("Remove downloaded runtime", dialog()!));
	assert(dialog()!.textContent!.includes("Remove the downloaded runtime?"));
	await click(button("Keep", dialog()!));
	assert(!server.posts.some((post) => post.op === "remove-runtime"));
	server.reply({ state: "signed-out", connected: false, account: null, models: [] });
	await click(button("Sign out", dialog()!));
	assert.deepEqual(server.posts.at(-1), { op: "logout" });
	assert(dialog()!.textContent!.includes("not signed in"));
});

test("the Strong row offers the background shortcut too: it runs the session's helpers (owner, 2026-11-27)", async () => {
	fixture({ state: "connected", connected: true, allowBackgroundUse: false });
	const antigravity = globalThis.fetch;
	globalThis.fetch = (async (url, init) => {
		const path = String(url);
		if (path.startsWith("/api/antigravity")) return antigravity(url, init);
		if (path === "/api/models") return Response.json({ models: [], defaults: null, rolePins: {}, slots: { strong: null, cheap: null, vision: null }, providers: [] });
		if (path === "/api/settings/prompts") return Response.json({ prober: [], teacher: [], practice: [] });
		if (path === "/api/search") return Response.json({ available: false, engine: null, reason: "fixture" });
		throw new Error(`Unexpected request ${path}`);
	}) as typeof fetch;
	const { AgentSection } = await import("../components/settings/agent-section.tsx");
	await mount(<AgentSection agent={undefined} models={{ strong: { model: { provider: "antigravity", id: "gemini-4-neon" } } }} graph={undefined} compaction={undefined}
		onSectionChange={() => true} onModelsChange={() => {}} onCompactionChange={() => true} />);
	assert(hasButton("Enable background use", document.querySelector('[data-testid="slot-row-strong"]')!), "the Strong row's subscription needs background use for helpers");
	assert(!hasButton("Enable background use", document.querySelector('[data-testid="slot-row-vision"]')!), "an empty Vision row has no provider to enable");
});

test("the background shortcut belongs to Antigravity slots only", async () => {
	fixture({ state: "connected", connected: true, allowBackgroundUse: false });
	await mount(<><AntigravityBackgroundAccess provider="claude" /><AntigravityBackgroundAccess provider="antigravity" /></>);
	assert.equal([...document.querySelectorAll("button")].filter((element) => element.textContent === "Enable background use").length, 1);
});
