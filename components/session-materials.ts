import {
	isSubagentFailure,
	type DemoResult,
	type LhViewMessage,
	type PdfResult,
	type ResearchResult,
	type ShowImageDetails,
	type SubagentArtifactData,
	type VisualResult,
} from "@/src/core";
import { isSubagentSteer } from "./transcript-rows";

/**
 * Fork: side panel (docs/side-panel.md). The Materials tab's list: what the
 * session produced that the learner may want back — interactive demos,
 * figures, images (shown by the teacher or attached by the learner), the
 * teacher's Mermaid diagrams, the plan and the PDF/research readings — in
 * transcript order, each with a stable id. Pure: tests read it without a DOM.
 */

export type MaterialKind = "demo" | "figure" | "image" | "learner-image" | "diagram" | "plan" | "reading";

/** A learner image as the transcript carries it: a stored attachment name,
 *  or inline bytes (older records). */
export type LearnerImage = { attachment: string } | { data: string; mimeType: string };

interface MaterialBase {
	/** Stable across renders and reloads: the selection and the keep-alive
	 *  set key on it, and it is persisted per session. */
	id: string;
	/** The item's own name when it has one (demo title, figure <title>,
	 *  image caption, PDF file name, research question). */
	title?: string;
	/** 1-based position among the items of the same label kind — the name
	 *  of an untitled item ("Figure 2"). */
	number: number;
}

export type SessionMaterial =
	| (MaterialBase & { kind: "demo"; messageId: string; result: DemoResult; inverted: boolean })
	| (MaterialBase & { kind: "figure"; messageId: string; result: VisualResult; inverted: boolean })
	| (MaterialBase & { kind: "image"; toolCallId: string; details: ShowImageDetails })
	| (MaterialBase & { kind: "learner-image"; messageId: string; index: number; image: LearnerImage })
	| (MaterialBase & { kind: "diagram"; textPartId: string; index: number; chart: string })
	| (MaterialBase & { kind: "plan" })
	| (MaterialBase & { kind: "reading"; messageId: string; source: "pdf"; result: PdfResult })
	| (MaterialBase & { kind: "reading"; messageId: string; source: "research"; result: ResearchResult });

/** What opens an item from the transcript ("Open in side panel"). */
export type MaterialTarget = { messageId: string } | { toolCallId: string } | { chart: string };

export const PLAN_MATERIAL_ID = "plan";

// The ids double as the transcript's anchors: chat.tsx stamps them on the
// rendered cards (data-material-id / data-material-ids) for "Show in chat".
export const steerMaterialId = (messageId: string) => `material:${messageId}`;
export const showImageMaterialId = (toolCallId: string) => `material:tool:${toolCallId}`;
export const learnerImageMaterialId = (messageId: string, index: number) => `material:${messageId}:image:${index}`;
export const diagramMaterialId = (textPartKey: string, index: number) => `material:diagram:${textPartKey}:${index}`;

/** The kinds a new arrival switches an open panel to: artifacts delivered as
 *  their own card. Diagrams inside prose, readings and the plan never do. */
export function switchesOnArrival(item: SessionMaterial): boolean {
	return item.kind === "demo" || item.kind === "figure" || item.kind === "image";
}

/** The id of a text part's wrapper in the transcript: the part's own id
 *  when it has one, else its position. chat.tsx stamps the same value. */
export function textPartKey(messageId: string, part: { id?: string }, partIndex: number): string {
	return part.id || `${messageId}:${partIndex}`;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };

function decodeEntities(text: string): string {
	return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
		if (code[0] === "#") {
			const value = code[1] === "x" || code[1] === "X" ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
			return Number.isFinite(value) && value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : match;
		}
		return ENTITIES[code.toLowerCase()] ?? match;
	});
}

function cleanTitle(text: string | undefined): string | undefined {
	const title = text?.replace(/\s+/g, " ").trim();
	return title ? title : undefined;
}

/** A figure's name: the SVG's first <title>, when it declares one. Pure. */
export function svgTitle(svg: string): string | undefined {
	const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(svg);
	return match ? cleanTitle(decodeEntities(match[1]!.replace(/<[^>]*>/g, ""))) : undefined;
}

/** A Mermaid diagram's name: its front-matter title, when it has one. Pure. */
export function mermaidTitle(chart: string): string | undefined {
	const front = /^\s*---\r?\n([\s\S]*?)\r?\n---/.exec(chart);
	const title = front ? /^title:\s*(.+)$/m.exec(front[1]!)?.[1] : undefined;
	return cleanTitle(title?.replace(/^(["'])(.*)\1$/, "$2"));
}

/** The complete ```mermaid (or ~~~mermaid) fences of a markdown text, in
 *  order — the same blocks the transcript renders as diagrams. A fence still
 *  streaming (no closing line yet) is not a diagram yet. Pure. */
export function mermaidFences(markdown: string): string[] {
	const charts: string[] = [];
	// Every fence is tracked, mermaid or not, so a "```mermaid" line inside
	// another language's block is never read as a diagram.
	let open: { fence: string; mermaid: boolean; body: string[] } | null = null;
	for (const line of markdown.split(/\r?\n/)) {
		if (open) {
			const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
			if (close && close[1]![0] === open.fence[0] && close[1]!.length >= open.fence.length) {
				if (open.mermaid) charts.push(open.body.join("\n"));
				open = null;
			} else open.body.push(line);
			continue;
		}
		const start = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)/.exec(line);
		if (start) open = { fence: start[1]!, mermaid: start[2]!.toLowerCase() === "mermaid", body: [] };
	}
	return charts;
}

function baseName(path: string): string {
	return path.split(/[\\/]/).pop() || path;
}

function isShowImage(value: unknown): value is ShowImageDetails {
	const v = value as Partial<ShowImageDetails> | null | undefined;
	return typeof v?.snapshotId === "string" && typeof v.path === "string";
}

/** The session's materials, in transcript order. `plan` is the chat's own
 *  plan presence (planExists); the item sits where the first plan block is. */
export function sessionMaterials(messages: readonly LhViewMessage[], options: { plan: boolean }): SessionMaterial[] {
	const items: SessionMaterial[] = [];
	const counts = new Map<string, number>();
	const next = (kind: string) => {
		const n = (counts.get(kind) ?? 0) + 1;
		counts.set(kind, n);
		return n;
	};
	let planPlaced = false;
	// A research result carries no question; the dispatching call does.
	const researchQuestions = new Map<string, string>();
	for (const message of messages) {
		for (const part of message.parts) {
			const question = (part.input as { question?: unknown } | undefined)?.question;
			if (part.type === "tool-research" && part.toolCallId && typeof question === "string") researchQuestions.set(part.toolCallId, question);
		}
	}
	for (const message of messages) {
		if (message.role === "user" && isSubagentSteer(message)) {
			const data = message.parts.find((part) => part.type === "data-subagent-artifact")?.data as SubagentArtifactData | undefined;
			if (!data) continue;
			const inverted = data.ui?.inverted ?? false;
			if (data.kind === "demo") {
				const result = data.result as DemoResult;
				if (typeof result?.html !== "string" || result.html.length === 0 || typeof result.title !== "string") continue;
				items.push({ id: steerMaterialId(message.id), kind: "demo", messageId: message.id, result, inverted, title: cleanTitle(result.title), number: next("demo") });
			} else if (data.kind === "visual") {
				const result = data.result as VisualResult;
				if (typeof result?.svg !== "string" || result.svg.length === 0) continue;
				items.push({ id: steerMaterialId(message.id), kind: "figure", messageId: message.id, result, inverted, title: svgTitle(result.svg), number: next("figure") });
			} else if (data.kind === "pdf") {
				const result = data.result as PdfResult;
				if (typeof result?.brief !== "string" || isSubagentFailure("pdf", result)) continue;
				items.push({ id: steerMaterialId(message.id), kind: "reading", source: "pdf", messageId: message.id, result, title: cleanTitle(baseName(result.path ?? "")), number: next("reading") });
			} else if (data.kind === "research") {
				const result = data.result as ResearchResult;
				if (typeof result?.brief !== "string" || isSubagentFailure("research", result)) continue;
				const toolCallId = (message.metadata as { subagentResult?: { toolCallId?: string } } | undefined)?.subagentResult?.toolCallId;
				const question = toolCallId ? researchQuestions.get(toolCallId) : undefined;
				items.push({ id: steerMaterialId(message.id), kind: "reading", source: "research", messageId: message.id, result, title: cleanTitle(question), number: next("reading") });
			}
			continue;
		}
		if (message.role === "user") {
			let index = 0;
			for (const part of message.parts) {
				if (part.type !== "image") continue;
				const attachment = part.attachment;
				const image: LearnerImage | null = typeof attachment === "string" ? { attachment }
					: typeof part.data === "string" && typeof part.mimeType === "string" ? { data: part.data, mimeType: part.mimeType } : null;
				if (image) items.push({ id: learnerImageMaterialId(message.id, index), kind: "learner-image", messageId: message.id, index, image, number: next("learner-image") });
				index += 1;
			}
			continue;
		}
		message.parts.forEach((part, partIndex) => {
			if (part.type === "data-plan-block") {
				if (options.plan && !planPlaced) {
					planPlaced = true;
					items.push({ id: PLAN_MATERIAL_ID, kind: "plan", number: 1 });
				}
			} else if (part.type === "tool-show_image") {
				if (part.state === "output-available" && part.toolCallId && isShowImage(part.output)) {
					items.push({ id: showImageMaterialId(part.toolCallId), kind: "image", toolCallId: part.toolCallId, details: part.output, title: cleanTitle(part.output.caption), number: next("image") });
				}
			} else if (part.type === "text" && typeof part.text === "string" && /mermaid/i.test(part.text)) {
				const key = textPartKey(message.id, part, partIndex);
				mermaidFences(part.text).forEach((chart, index) => {
					items.push({ id: diagramMaterialId(key, index), kind: "diagram", textPartId: key, index, chart, title: mermaidTitle(chart), number: next("diagram") });
				});
			}
		});
	}
	// A plan with no block in the view (never expected) still gets its entry.
	if (options.plan && !planPlaced) items.push({ id: PLAN_MATERIAL_ID, kind: "plan", number: 1 });
	return items;
}

/** A learner message's image anchors, space-separated (the user row's
 *  data-material-ids), or "" when it has no image. Pure. */
export function learnerImageAnchorIds(message: LhViewMessage): string {
	const ids: string[] = [];
	for (const part of message.parts) if (part.type === "image") ids.push(learnerImageMaterialId(message.id, ids.length));
	return ids.join(" ");
}

/** The item an "Open in side panel" control means, or undefined. */
export function findMaterial(items: readonly SessionMaterial[], target: MaterialTarget): SessionMaterial | undefined {
	if ("messageId" in target) return items.find((item) => (item.kind === "demo" || item.kind === "figure") && item.messageId === target.messageId);
	if ("toolCallId" in target) return items.find((item) => item.kind === "image" && item.toolCallId === target.toolCallId);
	const chart = target.chart.trim();
	return items.find((item) => item.kind === "diagram" && item.chart.trim() === chart);
}

/** The English kind word (catalog-translated at runtime). */
export function materialKindLabel(item: SessionMaterial): string {
	switch (item.kind) {
		case "demo": return "Interactive demo";
		case "figure": return "Figure";
		case "image": return "Image";
		case "learner-image": return "Your image";
		case "diagram": return "Diagram";
		case "plan": return "Plan";
		case "reading": return item.source === "pdf" ? "PDF reading" : "Research";
	}
}

/** The name shown for an untitled item: its kind and number. */
export function materialFallbackLabel(item: SessionMaterial): string {
	switch (item.kind) {
		case "demo": return `Interactive demo ${item.number}`;
		case "figure": return `Figure ${item.number}`;
		case "image": return `Image ${item.number}`;
		case "learner-image": return `Your image ${item.number}`;
		case "diagram": return `Diagram ${item.number}`;
		case "plan": return "Plan";
		case "reading": return item.source === "pdf" ? `PDF reading ${item.number}` : `Research ${item.number}`;
	}
}
