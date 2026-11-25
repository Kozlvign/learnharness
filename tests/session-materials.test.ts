import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LhViewMessage, LhViewPart } from "../src/core/index.ts";
import {
	findMaterial,
	learnerImageAnchorIds,
	materialFallbackLabel,
	materialKindLabel,
	mermaidFences,
	mermaidTitle,
	PLAN_MATERIAL_ID,
	sessionMaterials,
	svgTitle,
	switchesOnArrival,
	textPartKey,
} from "../components/session-materials.ts";

/** Fork: side panel (docs/side-panel.md). A lesson shaped like a real
 *  calculus session: a PDF reading, the plan, two demos, a figure, plus the
 *  other kinds the Materials tab lists. */

function steer(id: string, kind: string, result: unknown, extra: { ui?: { inverted?: boolean }; toolCallId?: string } = {}): LhViewMessage {
	return {
		id,
		role: "user",
		metadata: { subagentResult: { jobId: `job_${id}`, kind, toolCallId: extra.toolCallId ?? `call_${id}` } },
		parts: [
			{ type: "text", text: "model-facing delivery note" },
			{ type: "data-subagent-artifact", data: { kind, result, ...(extra.ui ? { ui: extra.ui } : {}) } },
		],
	};
}

function assistant(id: string, parts: LhViewPart[]): LhViewMessage {
	return { id, role: "assistant", parts };
}

const FIGURE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="700" height="1030">
  <title>A reta: sobe 2 a cada avan&#231;o de 1 &amp; mais</title>
  <desc>Reta y = 2x</desc>
</svg>`;

const LESSON: LhViewMessage[] = [
	{ id: "u0", role: "user", parts: [{ type: "text", text: "Quero estudar o capítulo 2." }] },
	assistant("a0", [{ type: "tool-pdf", state: "output-available", toolCallId: "call_pdf", input: { path: "D:\\Livros\\Calculus.pdf" } }]),
	steer("steer_pdf", "pdf", { path: "D:\\Livros\\Calculus.pdf", question: "Cap. 2", brief: "Limites e derivadas (p. 77).", pagesRead: [77], pagesConsulted: [77] }),
	assistant("a1", [
		{ type: "text", id: "a1:0", text: "## Abordagem" },
		{ type: "data-plan-block", data: { kind: "full", nodes: [] } },
		{ type: "tool-research", state: "output-available", toolCallId: "call_research", input: { question: "Who first defined the limit?" } },
	]),
	steer("steer_demo1", "demo", { title: "Dois pontos e a inclinação da secante", html: "<html><body>demo 1</body></html>", tested: true }, { ui: { inverted: true } }),
	steer("steer_failed_demo", "demo", { title: "Broken", html: "", tested: true, notes: "could not build" }),
	steer("steer_research", "research", { brief: "Cauchy and Weierstrass.", sources: [] }, { toolCallId: "call_research" }),
	steer("steer_figure", "visual", { svg: FIGURE_SVG }),
	assistant("a2", [
		{ type: "text", id: "a2:0", text: [
			"Veja o diagrama:",
			"```mermaid",
			"---",
			"title: \"Secante para tangente\"",
			"---",
			"graph TD",
			"A --> B",
			"```",
			"E este código, que só cita um diagrama:",
			"````md",
			"```mermaid",
			"graph LR",
			"```",
			"````",
			"~~~mermaid",
			"graph LR",
			"X --> Y",
			"~~~",
		].join("\n") },
		{ type: "tool-show_image", state: "output-available", toolCallId: "call_img", output: { path: "D:\\fotos\\caderno.jpg", caption: "Seu caderno", mimeType: "image/jpeg", snapshotId: "a".repeat(64), width: 10, height: 10 } },
		{ type: "tool-show_image", state: "input-available", toolCallId: "call_img_running" },
	]),
	{ id: "u1", role: "user", parts: [
		{ type: "text", text: "Minha resolução:" },
		{ type: "image", attachment: "img_1.png" },
		{ type: "image", data: "AAAA", mimeType: "image/png" },
	] },
	steer("steer_demo2", "demo", { title: "Valor no ponto e valores próximos", html: "<html><body>demo 2</body></html>", tested: true }),
	assistant("a3", [{ type: "text", id: "a3:0", text: "```mermaid\ngraph TD\nstill --> streaming" }]),
];

describe("sessionMaterials — the Materials list", () => {
	const items = sessionMaterials(LESSON, { plan: true });

	it("lists the session's materials in transcript order, skipping failures and unfinished work", () => {
		assert.deepEqual(items.map((item) => item.kind), [
			"reading", "plan", "demo", "reading", "figure", "diagram", "diagram", "image", "learner-image", "learner-image", "demo",
		]);
		assert.equal(items.some((item) => item.kind === "demo" && item.messageId === "steer_failed_demo"), false);
		assert.equal(items.some((item) => item.kind === "image" && item.toolCallId === "call_img_running"), false);
	});

	it("names each item by its own title when it has one", () => {
		const titles = items.map((item) => item.title);
		assert.deepEqual(titles, [
			"Calculus.pdf",
			undefined,
			"Dois pontos e a inclinação da secante",
			"Who first defined the limit?",
			"A reta: sobe 2 a cada avanço de 1 & mais",
			"Secante para tangente",
			undefined,
			"Seu caderno",
			undefined,
			undefined,
			"Valor no ponto e valores próximos",
		]);
	});

	it("numbers untitled items within their kind", () => {
		const diagram = items.filter((item) => item.kind === "diagram")[1]!;
		assert.equal(materialFallbackLabel(diagram), "Diagram 2");
		const images = items.filter((item) => item.kind === "learner-image");
		assert.deepEqual(images.map(materialFallbackLabel), ["Your image 1", "Your image 2"]);
		assert.equal(materialKindLabel(items[0]!), "PDF reading");
		assert.equal(materialKindLabel(items[3]!), "Research");
		assert.equal(materialFallbackLabel(items[1]!), "Plan");
	});

	it("keeps stable ids that double as transcript anchors", () => {
		assert.equal(items[1]!.id, PLAN_MATERIAL_ID);
		assert.equal(items[2]!.id, "material:steer_demo1");
		assert.equal(items[7]!.id, "material:tool:call_img");
		assert.equal(items[8]!.id, "material:u1:image:0");
		assert.equal(items[5]!.id, "material:diagram:a2:0:0");
		assert.equal(learnerImageAnchorIds(LESSON.find((m) => m.id === "u1")!), "material:u1:image:0 material:u1:image:1");
		assert.equal(learnerImageAnchorIds(LESSON[0]!), "");
		assert.deepEqual(sessionMaterials(LESSON, { plan: true }).map((item) => item.id), items.map((item) => item.id));
	});

	it("carries the demo's persisted invert state", () => {
		const demo = items[2]!;
		assert.equal(demo.kind === "demo" && demo.inverted, true);
	});

	it("leaves the plan out when the chat has no plan", () => {
		assert.equal(sessionMaterials(LESSON, { plan: false }).some((item) => item.kind === "plan"), false);
	});

	it("resolves what an Open in side panel control targets", () => {
		assert.equal(findMaterial(items, { messageId: "steer_figure" })?.kind, "figure");
		assert.equal(findMaterial(items, { messageId: "steer_pdf" }), undefined, "readings open from the selector only");
		assert.equal(findMaterial(items, { toolCallId: "call_img" })?.kind, "image");
		assert.equal(findMaterial(items, { chart: "\ngraph LR\nX --> Y\n" })?.id, "material:diagram:a2:0:1");
		assert.equal(findMaterial(items, { chart: "graph TD\nunknown" }), undefined);
	});

	it("switches an open panel only for demos, figures and shown images", () => {
		assert.deepEqual(items.filter(switchesOnArrival).map((item) => item.kind), ["demo", "figure", "image", "demo"]);
	});
});

describe("material parsing helpers", () => {
	it("reads only complete mermaid fences, never one quoted inside another block", () => {
		assert.deepEqual(mermaidFences("```mermaid\ngraph TD\nA-->B\n```\n````md\n```mermaid\nnope\n```\n````"), ["graph TD\nA-->B"]);
		assert.deepEqual(mermaidFences("```mermaid\ngraph TD"), []);
		assert.deepEqual(mermaidFences("```js\nconst a = 1;\n```"), []);
	});

	it("takes a figure's title from its SVG", () => {
		assert.equal(svgTitle("<svg><title>  A &lt;b&gt;\n title </title></svg>"), "A <b> title");
		assert.equal(svgTitle("<svg><text>no title</text></svg>"), undefined);
	});

	it("takes a diagram's title from its front matter", () => {
		assert.equal(mermaidTitle("---\ntitle: 'Plano'\n---\ngraph TD"), "Plano");
		assert.equal(mermaidTitle("graph TD\nA-->B"), undefined);
	});

	it("keys a text part by its id, else by its position", () => {
		assert.equal(textPartKey("m1", { id: "m1:3" }, 3), "m1:3");
		assert.equal(textPartKey("m1", {}, 3), "m1:3");
		assert.equal(textPartKey("m1", { id: "" }, 2), "m1:2");
	});
});
