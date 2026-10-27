// Fork: interface and tutor language (docs/language.md).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { parseHTML } from "linkedom";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-i18n-"));
process.env.LH_DATA_DIR = scratch;
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const { createTranslator, CATALOGS, tutorLanguageNote, parseLanguageSettings, DEFAULT_LANGUAGE } = await import("../src/core/i18n/index.ts");
const { appendSystemText, languageSettings, saveLanguageSettings, withTutorLanguage } = await import("../src/agent/language.ts");
const { languageResponse } = await import("../src/server/language-http.ts");
const { startDomTranslation } = await import("../components/i18n/dom-translator.ts");

const translate = createTranslator({
	Settings: "Configurações",
	"Check again": "Verificar novamente",
	nodes: "nós",
	Skipped: null,
	Same: "Same",
	"{0} steps": "{0} passos",
	"{0}m ago": "há {0} min",
	"Delete {0} selected {1}": "Excluir seleção ({0} {1})",
	"Delete {0}": "Excluir {0}",
	"{0} of {1}": "{1}: {0}",
	"Used {0} times": "Usado {0} vezes",
	"{0} thinking": "Raciocínio {0}",
});

test("translator: exact text keeps its surrounding whitespace", () => {
	assert.equal(translate("Settings"), "Configurações");
	assert.equal(translate("  Check   again\n"), "  Verificar novamente\n");
	assert.equal(translate("Unknown"), null);
	assert.equal(translate("Skipped"), null, "null entries stay as they are");
	assert.equal(translate("Same"), null, "identical entries change nothing");
	assert.equal(translate("42 · 7"), null, "text without words is left alone");
});

test("translator: patterns fill values, translate known values and may reorder", () => {
	assert.equal(translate("12 steps"), "12 passos");
	assert.equal(translate("5m ago"), "há 5 min");
	assert.equal(translate("Delete 3 selected nodes"), "Excluir seleção (3 nós)", "the most literal pattern wins");
	assert.equal(translate("Delete chain"), "Excluir chain");
	assert.equal(translate("2 of 9"), "9: 2");
});

test("pt-BR catalog: keys are normalized, values keep their placeholders", () => {
	const messages = CATALOGS["pt-BR"];
	assert.ok(Object.keys(messages).length > 500, "the catalog covers the interface");
	const placeholders = (text: string) => (text.match(/\{\d+\}/g) ?? []).sort().join();
	for (const [source, target] of Object.entries(messages)) {
		assert.equal(source, source.replace(/\s+/g, " ").trim(), `key is normalized: ${JSON.stringify(source)}`);
		if (target === null) continue;
		assert.ok(target.trim().length > 0 || source.trim().length === 0, `empty translation for ${JSON.stringify(source)}`);
		assert.equal(placeholders(target), placeholders(source), `placeholders of ${JSON.stringify(source)}`);
	}
	const pt = createTranslator(messages);
	assert.equal(pt("Settings"), "Configurações");
	assert.equal(pt("Language"), "Idioma");
});

test("tutor note: none in English, the learner's language otherwise", () => {
	assert.equal(tutorLanguageNote(DEFAULT_LANGUAGE), null);
	assert.equal(tutorLanguageNote({ ui: "en", tutor: "en" }), null);
	const portuguese = tutorLanguageNote({ ui: "pt-BR", tutor: "app" });
	assert.match(portuguese ?? "", /Brazilian Portuguese \(pt-BR\)/);
	assert.match(portuguese ?? "", /Keep unchanged: tool names/);
	assert.equal(tutorLanguageNote({ ui: "en", tutor: "pt-BR" }), portuguese);
	const english = tutorLanguageNote({ ui: "pt-BR", tutor: "en" });
	assert.match(english ?? "", /The learner reads English\./, "a pinned English tutor is said explicitly");
	assert.deepEqual(parseLanguageSettings({ ui: "fr", tutor: 3 }), DEFAULT_LANGUAGE);
});

test("system text: appended in every context form, nothing else changes", () => {
	const tools = [{ name: "quiz", description: "", parameters: {} }] as never;
	const prompted = appendSystemText({ systemPrompt: "Base", messages: [], tools }, "NOTE");
	assert.equal(prompted.systemPrompt, "Base\n\nNOTE");
	assert.equal(prompted.tools, tools);

	const user = { role: "user" as const, content: "hi", timestamp: 1 };
	const leading = appendSystemText({ messages: [{ role: "system", content: "Base", toolsAdded: tools, timestamp: 0 }, user] }, "NOTE");
	assert.deepEqual(leading.messages[0], { role: "system", content: "Base\n\nNOTE", toolsAdded: tools, timestamp: 0 });
	assert.equal(leading.messages[1], user);

	const parts = appendSystemText({ messages: [{ role: "system", content: [{ type: "text", text: "Base" }], timestamp: 0 }] }, "NOTE");
	assert.deepEqual(parts.messages[0]!.content, [{ type: "text", text: "Base" }, { type: "text", text: "\n\nNOTE" }]);

	const bare = appendSystemText({ messages: [user] }, "NOTE");
	assert.deepEqual(bare.messages, [{ role: "system", content: "NOTE", timestamp: 0 }, user]);

	const context = { messages: [user] };
	assert.equal(withTutorLanguage(context, DEFAULT_LANGUAGE), context, "English leaves requests untouched");
	assert.match(String(withTutorLanguage(context, { ui: "pt-BR", tutor: "app" }).messages[0]!.content), /<learner_language>/);
});

test("settings file and endpoint: same-origin writes only", async () => {
	assert.deepEqual(languageSettings(), DEFAULT_LANGUAGE, "no file means English");
	const origin = "http://127.0.0.1:4100";
	const put = (body: unknown, headers: Record<string, string> = {}) => languageResponse(new Request(`${origin}/api/language`, {
		method: "PUT",
		headers: { host: "127.0.0.1:4100", origin, "content-type": "application/json", "x-learnharness-language": "1", ...headers },
		body: JSON.stringify(body),
	}));
	assert.equal((await put({ ui: "pt-BR" }, { origin: "http://evil.test" })).status, 403);
	assert.equal((await put({ ui: "pt-BR" }, { "x-learnharness-language": "0" })).status, 403);
	assert.equal((await put({ ui: "fr" })).status, 400);
	const saved = await put({ ui: "pt-BR" });
	assert.equal(saved.status, 200);
	assert.match(saved.headers.get("set-cookie") ?? "", /^lh-locale=pt-BR; Path=\/; Max-Age=31536000/, "the next launch reads the cookie before first paint");
	assert.deepEqual(((await saved.json()) as { settings: unknown }).settings, { ui: "pt-BR", tutor: "app" });
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(scratch, "language.json"), "utf8")), { ui: "pt-BR", tutor: "app" });
	const read = await languageResponse(new Request(`${origin}/api/language`, { headers: { host: "127.0.0.1:4100" } }));
	assert.deepEqual(((await read.json()) as { settings: unknown }).settings, { ui: "pt-BR", tutor: "app" });
	assert.match((await put({ ui: "en" })).headers.get("set-cookie") ?? "", /^lh-locale=; Path=\/; Max-Age=0/, "English clears it");
	saveLanguageSettings({ ui: "en", tutor: "pt-BR" });
	assert.deepEqual(languageSettings(), { ui: "en", tutor: "pt-BR" });
});

function dom(body: string) {
	const { window, document } = parseHTML(`<!doctype html><html><body>${body}</body></html>`);
	(globalThis as { MutationObserver?: unknown }).MutationObserver = (window as unknown as { MutationObserver: unknown }).MutationObserver;
	return document;
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test("page translation: interface text and labels, never content", () => {
	const document = dom(`
		<h2 id="title">Settings</h2>
		<button id="close" title="Check again" aria-label="Settings">x</button>
		<p id="group">Used <!-- -->3<!-- --> times</p>
		<div class="lh-prose"><p id="prose">Settings</p><div data-streamdown="code-block-actions"><span id="chrome">Settings</span></div></div>
		<textarea id="typed">Settings</textarea>
		<div data-lh-i18n="off"><span id="off" title="Settings">Settings</span></div>
		<input id="field" placeholder="Check again">
		<span id="label">Strong thinking</span>
		<button data-testid="session-row"><span class="font-prose" id="named">Critical thinking</span><span class="font-prose" id="named-exact">Settings</span></button>
		<span class="font-prose" id="row-label">Strong thinking</span>
	`);
	const stop = startDomTranslation(translate, document.body);
	const text = (id: string) => document.getElementById(id)!.textContent;
	assert.equal(text("label"), "Raciocínio Strong", "patterns apply to interface text");
	assert.equal(text("named"), "Critical thinking", "patterns never rewrite the learner's own words");
	assert.equal(text("named-exact"), "Configurações", "whole known phrases still translate there");
	assert.equal(text("row-label"), "Raciocínio Strong", "settings labels share the font, not the rule");
	assert.equal(text("title"), "Configurações");
	assert.equal(document.getElementById("close")!.getAttribute("title"), "Verificar novamente");
	assert.equal(document.getElementById("close")!.getAttribute("aria-label"), "Configurações");
	assert.equal(text("group"), "Usado 3 vezes", "text split around a value is matched whole");
	assert.equal(text("prose"), "Settings", "markdown prose is content");
	assert.equal(text("chrome"), "Configurações", "controls inside content are interface");
	assert.equal(text("typed"), "Settings");
	assert.equal(text("off"), "Settings");
	assert.equal(document.getElementById("off")!.getAttribute("title"), "Settings");
	assert.equal(document.getElementById("field")!.getAttribute("placeholder"), "Verificar novamente");

	stop();
	assert.equal(text("title"), "Settings");
	assert.equal(text("group"), "Used 3 times");
	assert.equal(document.getElementById("close")!.getAttribute("title"), "Check again");
});

test("page translation: follows what the page renders next", async () => {
	const document = dom(`<div id="root"><span id="count">1 steps</span></div>`);
	const stop = startDomTranslation(translate, document.body);
	const count = document.getElementById("count")!;
	assert.equal(count.textContent, "1 passos");

	(count.firstChild as Text).data = "2 steps";
	await flush();
	assert.equal(count.textContent, "2 passos", "a re-rendered value is translated again");

	const added = document.createElement("button");
	added.setAttribute("title", "Settings");
	added.textContent = "Check again";
	document.getElementById("root")!.appendChild(added);
	await flush();
	assert.equal(added.textContent, "Verificar novamente");
	assert.equal(added.getAttribute("title"), "Configurações");

	added.setAttribute("title", "Check again");
	await flush();
	assert.equal(added.getAttribute("title"), "Verificar novamente");
	stop();
	assert.equal(count.textContent, "2 steps");
	assert.equal(added.textContent, "Check again");
});
