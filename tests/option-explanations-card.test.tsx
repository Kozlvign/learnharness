/**
 * Each option's own explanation (owner, 2026-11-27): hidden while the
 * question is pending, revealed by the answered card's Why panel in the
 * order the options were shown, marked like the option rows (✓ correct,
 * ✗ the wrong pick), lettered on single-select, labelled on multi-select,
 * and absent on records from before the feature.
 */
import React, { act } from "react";
(globalThis as { React?: typeof React }).React = React;
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { QuestionDock } from "../components/question-dock.tsx";
import { AnsweredCard } from "../components/answered-card.tsx";
import {
	buildAnswer,
	extractOptionExplanations,
	newAnswerResult,
	normalizeOptions,
	questionDisplayOptions,
	resolveCorrect,
	type QuestionAnswerData,
	type QuestionData,
} from "../src/core/index.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });

const doubled = String.raw`$\\nabla f$`;
const probeInput = {
	question: "Which vector points toward the steepest ascent of $f$?",
	options: [
		{ label: String.raw`$\nabla f$`, value: "grad", explanation: `WHY-GRAD ${doubled} points uphill fastest.` },
		{ label: String.raw`$-\nabla f$`, value: "neg", explanation: "WHY-NEG That is the steepest descent." },
		{ label: "Any tangent vector", value: "tangent", explanation: "WHY-TANGENT Tangent directions keep $f$ constant." },
		{ label: "The zero vector", value: "zero", explanation: "WHY-ZERO It has no direction at all." },
	],
	correctAnswer: "grad",
	explanation: "The gradient is the direction of fastest increase.",
};

async function mounted(run: (host: HTMLElement, root: Root) => Promise<void>) {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	try {
		await run(host, root);
	} finally {
		await act(async () => root.unmount());
		host.remove();
	}
}

const buttonByText = (host: HTMLElement, text: string) =>
	[...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === text);

test("pending dock never shows an option's explanation", () => {
	const html = renderToStaticMarkup(<QuestionDock toolName="probe" toolCallId="whys_pending" input={probeInput} expanded onExpand={() => {}} onSubmit={() => {}} />);
	assert.doesNotMatch(html, /WHY-/);
});

test("single-select: submit → Why lists every option's explanation by letter, in display order, marked like the rows", async () => {
	const toolCallId = "whys_single";
	const displayed = questionDisplayOptions(probeInput.options, "quiz", false, toolCallId).options;
	const wrongIndex = displayed.findIndex((o) => o.value !== "grad");
	let answer: QuestionAnswerData | undefined;
	await mounted(async (host, root) => {
		await act(async () => root.render(<QuestionDock toolName="probe" toolCallId={toolCallId} input={probeInput} expanded
			dictationClaim={false} onExpand={() => {}} onSubmit={(a) => { answer = a; }} />));
		assert.doesNotMatch(host.textContent ?? "", /WHY-/, "nothing leaks into the live dock");
		const radios = [...host.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
		await act(async () => radios[wrongIndex]!.click());
		const form = host.querySelector("form")!;
		await act(async () => form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })));
		assert.ok(answer);
		assert.equal(answer.correct, false);
		assert.deepEqual(answer.options!.map((o) => o.label), displayed.map((o) => o.label), "the snapshot keeps display order");
		const byValue = new Map(probeInput.options.map((o) => [o.value, o.explanation]));
		assert.deepEqual(answer.options!.map((o) => o.explanation), displayed.map((o) => byValue.get(o.value)));

		const persisted = JSON.parse(JSON.stringify(newAnswerResult(toolCallId, "probe", answer))).details as QuestionAnswerData;
		await act(async () => root.render(<AnsweredCard answer={persisted} input={probeInput} />));
		assert.doesNotMatch(host.textContent ?? "", /WHY-/, "tucked until Why is opened");
		await act(async () => buttonByText(host, "Why")!.click());

		const rowLetters = [...host.querySelectorAll("[data-option-letter]")].map((el) => el.textContent);
		assert.deepEqual(rowLetters, ["A", "B", "C", "D"]);
		const items = [...host.querySelectorAll<HTMLElement>('[data-testid="option-explanations"] > li')];
		assert.deepEqual(items.map((li) => li.querySelector("[data-explanation-letter]")?.textContent), ["A", "B", "C", "D"]);
		for (const [i, li] of items.entries()) {
			const value = displayed[i]!.value;
			const tag = `WHY-${value.toUpperCase()}`;
			assert.ok(li.textContent?.includes(tag), `row ${i} explains ${value}`);
			const mark = li.querySelector("[data-mark]")?.getAttribute("data-mark");
			assert.equal(mark, value === "grad" ? "check" : i === wrongIndex ? "x" : undefined, `mark of ${value}`);
			assert.equal(li.classList.contains("text-foreground/75"), i === wrongIndex, `emphasis of ${value}`);
		}
		assert.ok(!host.querySelector('[data-testid="option-explanations"]')!.textContent!.includes("Any tangent vector"),
			"lettered rows name the option by its letter, not its label");
		const why = host.querySelector('[data-testid="tucked-explanation"]')!;
		assert.ok(why.textContent?.includes("Why: The gradient is the direction of fastest increase."), "the general why stays first");
		assert.ok(host.querySelector('[data-testid="option-explanations"]')!.classList.contains("border-t"), "divided from the general why");
		const gradItem = items[displayed.findIndex((o) => o.value === "grad")]!;
		assert.deepEqual([...gradItem.querySelectorAll(".katex[data-tex]")].map((n) => n.getAttribute("data-tex")), [String.raw`\nabla f`],
			"the explanation's LaTeX renders with presentation-only recovery");
		assert.equal(host.querySelectorAll(".katex-error").length, 0);

		await act(async () => buttonByText(host, "Hide why")!.click());
		assert.equal(host.querySelector('[data-testid="option-explanations"]'), null);
	});
	assert.ok(probeInput.options[0]!.explanation.includes(doubled), "the source call is never rewritten");
});

test("multi-select: Why names each option by its label (no letters) with the same marks", async () => {
	const input = {
		question: "Which are prime?",
		multiSelect: true,
		options: [
			{ label: "2", value: "two", explanation: "WHY-TWO Only divisors 1 and 2." },
			{ label: "4", value: "four", explanation: "WHY-FOUR Divisible by 2." },
			{ label: "5", value: "five", explanation: "WHY-FIVE Only divisors 1 and 5." },
		],
		correctAnswer: ["two", "five"],
		explanation: "Primes have exactly two divisors.",
	};
	const options = normalizeOptions(input.options);
	const qd: QuestionData = { id: "whys_multi", kind: "quiz", question: input.question, mode: "multi-select", options,
		correctIndices: resolveCorrect(input.correctAnswer, options).indices, explanation: input.explanation,
		optionExplanations: extractOptionExplanations(input.options), createdAt: "2026-11-27" };
	const answer = buildAnswer(qd, { values: ["two", "four"] }, "quiz");
	await mounted(async (host, root) => {
		await act(async () => root.render(<AnsweredCard answer={answer} input={input} />));
		await act(async () => buttonByText(host, "Why")!.click());
		const items = [...host.querySelectorAll<HTMLElement>('[data-testid="option-explanations"] > li')];
		assert.equal(host.querySelectorAll("[data-explanation-letter]").length, 0);
		assert.deepEqual(items.map((li) => li.querySelector("[data-mark]")?.getAttribute("data-mark")), ["check", "x", "check"]);
		for (const [i, option] of input.options.entries()) {
			assert.ok(items[i]!.textContent?.startsWith(option.label), `row ${i} leads with its label`);
			assert.ok(items[i]!.textContent?.includes(option.explanation.split(" ")[0]!));
		}
		assert.ok(items[1]!.classList.contains("text-foreground/75"), "the wrong pick reads a step stronger");
		assert.ok(!items[2]!.classList.contains("text-foreground/75"));
	});
});

test("older records without per-option explanations render the Why panel exactly as before", async () => {
	const input = { question: "Closest to the Sun?", options: [{ label: "Venus" }, { label: "Mercury" }], correctAnswer: "Mercury", explanation: "Mercury is innermost." };
	const answer: QuestionAnswerData = { kind: "quiz", questionText: input.question, options: [{ index: 1, label: "Venus" }, { index: 2, label: "Mercury" }],
		answers: [{ index: 1, label: "Venus", value: "Venus" }], correct: false, correctIndices: [2], dontKnow: false,
		explanation: input.explanation, answeredAt: "2026-01-01T00:00:00Z" };
	await mounted(async (host, root) => {
		await act(async () => root.render(<AnsweredCard answer={answer} input={input} />));
		await act(async () => buttonByText(host, "Why")!.click());
		assert.equal(host.querySelector('[data-testid="option-explanations"]'), null);
		assert.equal(host.querySelector('[data-testid="tucked-explanation"]')!.textContent, "Hide whyWhy: Mercury is innermost.");
	});
});
