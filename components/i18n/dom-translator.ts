/**
 * Runtime translation of the interface (fork feature, docs/language.md).
 *
 * The components render English. This observer swaps displayed interface
 * text and labelling attributes for their catalog entries as React writes
 * them, before the browser paints (mutation callbacks run as microtasks).
 * Upstream components stay untouched, so daily upstream merges never
 * conflict with translations.
 *
 * What the learner and the tutor wrote is never translated: prose rendered
 * as markdown, inputs, code, math and diagrams. `data-lh-i18n="off"` opts
 * any other subtree out, `data-lh-i18n="on"` opts a piece of interface
 * inside such content back in.
 */
import type { Translator } from "@/src/core";

const ATTRIBUTES = ["title", "placeholder", "aria-label", "aria-description", "aria-valuetext", "alt"];
const ATTRIBUTE_SELECTOR = ATTRIBUTES.map((name) => `[${name}]`).join(",");

/** Text inside these is content, not interface. */
const CONTENT = [
	"script", "style", "noscript", "template", "textarea", "input", "pre", "code", "kbd", "samp",
	"[contenteditable]:not([contenteditable='false'])", ".katex", ".katex-display", "math", "svg",
	".lh-prose", "[data-lh-i18n='off']",
].join(",");

/** Interface inside content: Streamdown's own code and table controls. */
const CHROME = [
	"[data-streamdown$='-actions']", "[data-streamdown='code-block-header']", "[data-streamdown='link-safety-modal']",
	"[data-streamdown='table-fullscreen']", "[data-lh-i18n='on']",
].join(",");

/** Where the interface shows names the learner or the tutor gave (session
 * titles, knowledge-graph nodes): only whole known phrases are translated
 * there, never patterns. */
const WORDS = [
	"[data-testid^='session-row'] .font-prose", ".font-title.text-3xl", "[data-testid^='prop-chip-']",
	"[data-testid^='prop-row-']", "[data-testid^='graph-context-prop-']", "[data-lh-i18n='names']",
].join(",");

type Shown = { source: string; shown: string };

function isContent(element: Element): boolean {
	const content = element.closest(CONTENT);
	if (!content) return false;
	const chrome = element.closest(CHROME);
	return !chrome || !content.contains(chrome) || chrome === content;
}

function isText(node: Node): node is Text {
	return node.nodeType === 3;
}

/** Start translating `root` and everything added under it. The returned
 * function stops and puts the English text back. */
export function startDomTranslation(translate: Translator, root: Element): () => void {
	const texts = new WeakMap<Text, Shown>();
	const attributes = new WeakMap<Element, Map<string, Shown>>();
	// Strong references only for what was changed, so stop() can restore it.
	const changedTexts = new Set<Text>();
	const changedElements = new Set<Element>();
	let pruneAt = 512;

	const prune = () => {
		if (changedTexts.size + changedElements.size < pruneAt) return;
		for (const node of changedTexts) if (!node.isConnected) changedTexts.delete(node);
		for (const element of changedElements) if (!element.isConnected) changedElements.delete(element);
		pruneAt = Math.max(512, (changedTexts.size + changedElements.size) * 2);
	};

	/** The English behind a node: ours if we wrote what it shows now. */
	const sourceOf = (node: Text): string => {
		const known = texts.get(node);
		return known && node.data === known.shown ? known.source : node.data;
	};

	const show = (node: Text, source: string, shown: string) => {
		texts.set(node, { source, shown });
		if (shown !== source) changedTexts.add(node);
		if (node.data !== shown) node.data = shown;
	};

	/** An element's own text. Text split around values ("Used ", "3", " times")
	 * is matched as a whole first, so word order can change. */
	const translateChildren = (element: Element) => {
		if (isContent(element)) return;
		const nodes = Array.from(element.childNodes);
		const textNodes = nodes.filter(isText);
		if (textNodes.length === 0) return;
		const exactOnly = element.closest(WORDS) !== null;
		if (textNodes.length > 1 && nodes.every((node) => isText(node) || node.nodeType === 8)) {
			const sources = textNodes.map(sourceOf);
			const whole = translate(sources.join(""), exactOnly);
			if (whole !== null) {
				textNodes.forEach((node, index) => show(node, sources[index]!, index === 0 ? whole : ""));
				return;
			}
		}
		for (const node of textNodes) {
			const source = sourceOf(node);
			show(node, source, translate(source, exactOnly) ?? source);
		}
	};

	const translateAttribute = (element: Element, name: string) => {
		if (!ATTRIBUTES.includes(name) || element.closest("[data-lh-i18n='off']")) return;
		const value = element.getAttribute(name);
		const record = attributes.get(element) ?? new Map<string, Shown>();
		if (value === null) {
			record.delete(name);
			return;
		}
		// Image descriptions inside content describe the content.
		if (name === "alt" && isContent(element)) return;
		const known = record.get(name);
		const source = known && value === known.shown ? known.source : value;
		const shown = translate(source) ?? source;
		record.set(name, { source, shown });
		attributes.set(element, record);
		if (shown !== source) changedElements.add(element);
		if (value !== shown) element.setAttribute(name, shown);
	};

	const translateAttributes = (element: Element) => {
		for (const name of ATTRIBUTES) if (element.hasAttribute(name)) translateAttribute(element, name);
	};

	/** Everything under `start`: interface text, then labelling attributes anywhere. */
	const walk = (start: Element) => {
		const document = start.ownerDocument;
		const visit = (from: Element) => {
			const walker = document.createTreeWalker(from, 1 /* SHOW_ELEMENT */, {
				acceptNode: (node) => ((node as Element).matches(CONTENT) && !(node as Element).matches(CHROME) ? 2 /* REJECT */ : 1 /* ACCEPT */),
			});
			if (!isContent(from)) translateChildren(from);
			for (let node = walker.nextNode(); node; node = walker.nextNode()) translateChildren(node as Element);
		};
		visit(start);
		for (const chrome of Array.from(start.querySelectorAll(CHROME))) visit(chrome);
		if (start.matches(ATTRIBUTE_SELECTOR)) translateAttributes(start);
		for (const element of Array.from(start.querySelectorAll(ATTRIBUTE_SELECTOR))) translateAttributes(element);
	};

	const observer = new MutationObserver((records) => {
		const parents = new Set<Element>();
		const added = new Set<Element>();
		for (const record of records) {
			if (record.type === "characterData") {
				const parent = record.target.parentElement;
				if (parent) parents.add(parent);
			} else if (record.type === "childList") {
				if (record.target.nodeType === 1) parents.add(record.target as Element);
				for (const node of Array.from(record.addedNodes)) if (node.nodeType === 1) added.add(node as Element);
				// Some DOMs report a text change as a replaced text node.
				for (const node of [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)]) {
					if (isText(node) && node.parentElement) parents.add(node.parentElement);
				}
			} else if (record.type === "attributes" && record.attributeName) {
				translateAttribute(record.target as Element, record.attributeName);
			}
		}
		for (const element of added) if (element.isConnected) walk(element);
		for (const parent of parents) if (parent.isConnected) translateChildren(parent);
		prune();
	});

	walk(root);
	observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRIBUTES });

	return () => {
		observer.disconnect();
		for (const node of changedTexts) {
			const known = texts.get(node);
			if (known && node.isConnected && node.data === known.shown) node.data = known.source;
		}
		for (const element of changedElements) {
			if (!element.isConnected) continue;
			for (const [name, known] of attributes.get(element) ?? []) {
				if (element.getAttribute(name) === known.shown) element.setAttribute(name, known.source);
			}
		}
		changedTexts.clear();
		changedElements.clear();
	};
}
