/**
 * The proposed-course cards (fork, docs/rigor.md rule R7): what they show,
 * and that every interface text in them has a pt-BR entry.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { CourseCreatedCard, CourseSeedCard, CourseSeedEmptyState } from "../components/course-cards.tsx";
import { CATALOGS } from "../src/core/i18n/catalog.ts";
import { createTranslator } from "../src/core/i18n/translator.ts";

const seed = {
	title: "Análise real",
	goal: "Provar os teoremas de limite",
	reason: "Surgiu na 2.4",
	timing: "after" as const,
	background: "Domina limites informais",
	books: [
		{ title: "Calculus", author: "Michael Spivak", edition: "4th", level: "advanced", why: "Provas limpas", path: "D:\\Livros\\spivak.pdf" },
		{ title: "Understanding Analysis", author: "Stephen Abbott", level: "intermediate", why: "Motivação" },
	],
	origin: { chatId: "chat_x", title: "Calculus - Limits" },
};

/** Interface text as the DOM translator meets it, skipping names/content. */
function interfaceTexts(html: string): string[] {
	const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
	const out = new Set<string>();
	for (const element of [...document.body.querySelectorAll("*")]) {
		if (element.closest("[data-lh-i18n='off']")) continue;
		for (const node of [...element.childNodes]) {
			if (node.nodeType !== 3) continue;
			const text = (node.textContent ?? "").replace(/\s+/g, " ").trim();
			if (text && /[A-Za-z]/.test(text)) out.add(text);
		}
	}
	return [...out];
}

describe("proposed-course cards", () => {
	const pt = createTranslator(CATALOGS["pt-BR"]);
	const known = (text: string) => Object.hasOwn(CATALOGS["pt-BR"], text) || pt(text) !== null;

	it("the created card names the course and its folder and links to it", () => {
		const html = renderToStaticMarkup(
			<CourseCreatedCard part={{ state: "output-available", output: { ok: true, chatId: "chat_new", title: "Análise real", folder: "Cadeiras sugeridas", withFiles: [], withoutFiles: [] } }} />,
		);
		assert.match(html, /New course created/);
		assert.match(html, /Análise real/);
		assert.match(html, /Cadeiras sugeridas/);
		assert.match(html, /href="\/chat\/chat_new"/);
		const refused = renderToStaticMarkup(<CourseCreatedCard part={{ state: "output-error", errorText: "create_course refused: x." }} />);
		assert.match(refused, /The course was not created\./);
		for (const view of [html, refused, renderToStaticMarkup(<CourseCreatedCard part={{ state: "input-available" }} />)]) {
			assert.deepEqual(interfaceTexts(view).filter((t) => !known(t)), []);
		}
	});

	it("the seed card is collapsed by default, links back to the origin course, and supports defaultOpen", () => {
		const html = renderToStaticMarkup(<CourseSeedCard data={seed} />);
		assert.match(html, /Proposed course/);
		assert.match(html, /From/);
		assert.match(html, /Calculus - Limits/);
		assert.match(html, /href="\/chat\/chat_x"/);
		assert.match(html, /Open origin/);
		assert.doesNotMatch(html, /course-seed-body/);
		assert.deepEqual(interfaceTexts(html).filter((t) => !known(t)), []);

		const expanded = renderToStaticMarkup(<CourseSeedCard data={seed} defaultOpen />);
		assert.match(expanded, /course-seed-body/);
		assert.match(expanded, /Provar os teoremas de limite/);
		assert.deepEqual(interfaceTexts(expanded).filter((t) => !known(t)), []);

		const emptyState = renderToStaticMarkup(<CourseSeedEmptyState onStart={() => {}} />);
		assert.match(emptyState, /Ready to start this course/);
		assert.match(emptyState, /Start course/);
		assert.deepEqual(interfaceTexts(emptyState).filter((t) => !known(t)), []);
	});

	it("its labels translate", () => {
		for (const text of [
			"Proposed course",
			"From",
			"Open origin",
			"Proposed in",
			"Goal",
			"Why",
			"What you already hold",
			"When",
			"It can start now",
			"Better after the course it came from",
			"Books",
			"No file yet",
			"New course created",
			"Creating the course…",
			"The course was not created.",
			"Suggested courses",
			"Ready to start this course",
			"Start course",
			"The tutor already has the goal, your background, and the book list. Start whenever you are ready, or write below to adjust anything first.",
		]) {
			assert.ok(known(text), text);
		}
		assert.equal(pt("New class · 13 h since the last activity"), "Nova aula · 13 h desde a última atividade");
		assert.equal(pt("Mixed"), "Misto");
		assert.equal(pt("Suggested courses"), "Cadeiras sugeridas");
		assert.equal(pt("Open origin"), "Abrir origem");
		assert.equal(pt("Start course"), "Começar cadeira");
	});
});
