// Finds the English UI text in the source: JSX text, user-facing JSX
// attributes and sentence-like string literals. Templates and string
// concatenations become patterns with numbered placeholders
// ("{0} lessons"), the form the runtime translator matches against.
//
// The extraction is a heuristic. It is used to report which texts the
// Portuguese catalog lacks, so an extra candidate costs nothing and a
// missed one only stays in English.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOTS = ["components", "app", "src"];
const SKIP_DIRS = new Set(["node_modules", "api", "subagents", "tools", "prompts", "fixtures"]);
// The catalog machinery itself (language names stay in their own language).
const SKIP_PATHS = /(^|\/)src\/core\/i18n\//;
// Agent prompts, tool descriptions and transcript notes are read by the
// model, not the learner.
const SKIP_FILES = /(\.test\.|\.d\.ts$|prompt|instructions|teacher-agent|grader|probe|tool-execute|native-messages|compaction\.ts$|coverage\.ts$|plan-tree\.ts$|question-core\.ts$|input-events\.ts$|session-markdown\.ts$|\/tools\.ts$|contracts\/(chat|jobs)\.ts$|transcript\.ts$|events-stream\.ts$|turn-runs\.ts$|agent\/attachments\.ts$)/i;

const UI_ATTRIBUTES = new Set([
	"title", "placeholder", "aria-label", "aria-description", "aria-valuetext", "alt", "label", "hint",
	"description", "tooltip", "heading", "text", "caption", "emptyText", "emptyLabel", "confirmLabel",
	"cancelLabel", "subtitle", "message", "summary", "detail", "note", "children", "name",
]);
const CODE_ATTRIBUTES = /^(className|class|id|key|href|src|type|role|data-.*|testid|variant|size|side|align|method|viewBox|d|fill|stroke.*|xmlns|rel|target|autoComplete|inputMode|mode|dir|lang|htmlFor|form|accept|pattern|sizes|as|value|binding|section|kind|tone|icon|style|transform|points|x|y|cx|cy|r|width|height|preserveAspectRatio|clipPath|mask|filter|shape|axis|orientation|direction|layout|position|state|status|phase|placement|tabIndex|enterKeyHint|spellCheck|autoCapitalize|draggable|scope)$/;
const SKIP_CALLS = /^(error|fetch|addEventListener|removeEventListener|querySelector|querySelectorAll|closest|matches|getElementById|getItem|setItem|removeItem|require|matchMedia|startsWith|endsWith|includes|indexOf|split|join|replace|replaceAll|test|exec|match|createElement|createElementNS|getAttribute|setAttribute|removeAttribute|hasAttribute|toggleAttribute|add|remove|toggle|contains|dispatchEvent|CustomEvent|Event|for|emit|on|off|once|cn|clsx|cva|twMerge|log|warn|info|debug|trace|parse|stringify|get|set|has|delete|append|send|postMessage|invoke|handle|setProperty|getPropertyValue|mark|measure|now|keys|URL|URLSearchParams|RegExp|Symbol|localeCompare|padStart|padEnd|toFixed|structuredClone|track|observe|span|metric|hash|update|digest|createHash|join|resolve|relative|dirname|basename|extname|existsSync|readFileSync|writeFileSync|mkdirSync|spawn|execFile|env|header|cookie|redirect|json)$/;
const KEY_NAMES = /^(Escape|Enter|Tab|Backspace|Space|Shift|Control|Alt|Meta|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|PageUp|PageDown|Esc|Del|Ins|F\d+)$/;

/** Collapse whitespace the way JSX and the DOM translator do. */
export function normalize(text) {
	return text.replace(/\s+/g, " ").trim();
}

function walkFiles(dir, out) {
	for (const name of readdirSync(dir)) {
		const full = path.join(dir, name);
		if (statSync(full).isDirectory()) {
			if (!SKIP_DIRS.has(name)) walkFiles(full, out);
		} else if (/\.(tsx?|mts)$/.test(name) && !SKIP_FILES.test(full.replaceAll("\\", "/")) && !SKIP_PATHS.test(full.replaceAll("\\", "/"))) out.push(full);
	}
}

function hasWords(text) {
	return /[A-Za-z]{2,}/.test(text);
}

/** Tailwind classes, ids, paths, keys and similar never reach the learner. */
function looksTechnical(text) {
	const t = text.trim();
	if (!hasWords(t)) return true;
	if (/^\[/.test(t)) return true; // log prefix or transcript marker
	if (/\[[\w-]+([~^$*|]?=|\])|^\.[a-z][\w-]*([ ,.:]|$)/.test(t)) return true; // CSS selector
	if (/(^|[^A-Za-z])[a-z]+[A-Z][A-Za-z]*|`/.test(t)) return true; // mentions a code identifier
	if (/^(use client|use server|use strict)$/.test(t)) return true;
	if (/^[a-z][a-zA-Z0-9]*$/.test(t)) return true; // single lowercase identifier
	if (/^[A-Z0-9_]+$/.test(t)) return true; // CONSTANT or env var
	if (/^[A-Z][a-z]+[A-Z]\w*$/.test(t)) return true; // PascalCase identifier
	if (/^[\w.-]+\.[a-z]{2,5}$/i.test(t) && !/\s/.test(t)) return true; // file name or host
	if (/^(https?:|mailto:|data:|blob:|file:|wss?:|\/|\.\/|\.\.\/|@\/|#)/.test(t)) return true;
	if (/^[\w-]+\/[\w.+-]+$/.test(t)) return true; // mime type or path
	if (/[{}<>]|=>|\$\{|^\w+=|&\w+=|\\[nrt]/.test(t)) return true;
	if (/^(var|rgba?|hsla?|calc|url|translate\w*|scale|rotate|cubic-bezier|oklch|color-mix)\(/.test(t)) return true;
	if (KEY_NAMES.test(t)) return true;
	const tokens = t.split(/\s+/);
	if (tokens.every((token) => /^[!a-z0-9[\]:./%#()_&>~+=*,'"-]+$/.test(token)) && tokens.some((token) => /[-:[\]/]/.test(token))) return true;
	if (tokens.length === 1 && /[_:/\\]/.test(t)) return true;
	if (/^[a-z]+(-[a-z0-9]+)+$/.test(t)) return true; // kebab-case
	return false;
}

/** A literal that should be checked as learner-visible text. */
function looksLikeText(text) {
	const t = text.trim();
	if (t.length < 2 || t.length > 400 || looksTechnical(t)) return false;
	if (/^[A-Z][a-z]/.test(t) || /\s/.test(t) || /[.!?…:]$/.test(t)) return true;
	return false;
}

function attributeName(node) {
	return node.name.getText();
}

/** Climb through conditionals and logical operators to see where a value lands. */
function landing(node) {
	let current = node;
	while (current.parent) {
		const parent = current.parent;
		if (ts.isParenthesizedExpression(parent) || ts.isConditionalExpression(parent) || ts.isAsExpression(parent) || ts.isSatisfiesExpression?.(parent)) {
			if (ts.isConditionalExpression(parent) && parent.condition === current) return { kind: "code" };
			current = parent;
			continue;
		}
		if (ts.isBinaryExpression(parent)) {
			const op = parent.operatorToken.kind;
			if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken || (op === ts.SyntaxKind.AmpersandAmpersandToken && parent.right === current)) {
				current = parent;
				continue;
			}
			if (op === ts.SyntaxKind.PlusToken) {
				current = parent;
				continue;
			}
			return { kind: "compare" };
		}
		if (ts.isJsxExpression(parent)) {
			const owner = parent.parent;
			if (ts.isJsxAttribute(owner)) return { kind: "attribute", name: attributeName(owner) };
			return { kind: "jsx" };
		}
		if (ts.isJsxAttribute(parent)) return { kind: "attribute", name: attributeName(parent) };
		if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) {
			const callee = parent.expression;
			const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : "";
			return { kind: "call", name };
		}
		if (ts.isCaseClause(parent) || ts.isLiteralTypeNode(parent) || ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent) || ts.isExternalModuleReference(parent) || ts.isElementAccessExpression(parent)) return { kind: "skip" };
		if (ts.isPropertyAssignment(parent) && parent.name === current) return { kind: "skip" };
		if (ts.isPropertyAssignment(parent)) return { kind: "property", name: parent.name.getText().replace(/["']/g, "") };
		return { kind: "code" };
	}
	return { kind: "code" };
}

const CODE_PROPERTIES = /^(id|key|kind|type|role|className|class|testid|href|src|path|url|route|channel|op|event|provider|api|model|icon|tone|variant|status|state|phase|section|name|value|code|binding|accelerator|shortcut|method|mime|format|encoding|unit|field|slot|source|target|mode|level|effort|plan|category|tag|sort|order)$/i;

function accept(text, where, node) {
	if (where.kind === "skip" || where.kind === "compare") return false;
	if (where.kind === "attribute") {
		if (CODE_ATTRIBUTES.test(where.name)) return false;
		if (UI_ATTRIBUTES.has(where.name) || where.name.startsWith("aria-")) return hasWords(text) && !looksTechnical(text) || /^[A-Z]/.test(text.trim()) && hasWords(text);
		return looksLikeText(text);
	}
	if (where.kind === "jsx") return hasWords(text) && !looksTechnical(text) || /^[a-z]+$/.test(text.trim());
	if (where.kind === "call" && SKIP_CALLS.test(where.name)) return false;
	if (where.kind === "property" && CODE_PROPERTIES.test(where.name)) return false;
	return looksLikeText(text);
}

/** Pattern text for a template or a + chain: literals kept, values numbered. */
function patternOf(node) {
	const parts = [];
	const visit = (n) => {
		if (ts.isParenthesizedExpression(n)) return visit(n.expression);
		if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
			visit(n.left);
			visit(n.right);
			return;
		}
		if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
			parts.push({ text: n.text });
			return;
		}
		if (ts.isTemplateExpression(n)) {
			parts.push({ text: n.head.text });
			for (const span of n.templateSpans) {
				parts.push({ value: true });
				parts.push({ text: span.literal.text });
			}
			return;
		}
		parts.push({ value: true });
	};
	visit(node);
	let index = 0;
	let out = "";
	for (const part of parts) out += part.value ? `{${index++}}` : part.text.replace(/[{}]/g, "");
	return { text: out, values: index };
}

function isPlusChain(node) {
	return ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken;
}

const VALUE = Symbol("value");
/** What one JSX child can render as text: literals, VALUE for a runtime value, or null for markup. */
function childChoices(child) {
	if (ts.isJsxText(child)) return [child.text.replace(/[{}]/g, "")];
	if (!ts.isJsxExpression(child) || !child.expression) return null;
	const options = (expression) => {
		if (ts.isParenthesizedExpression(expression)) return options(expression.expression);
		if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return [expression.text];
		if (ts.isConditionalExpression(expression)) {
			const yes = options(expression.whenTrue);
			const no = options(expression.whenFalse);
			return yes && no ? [...yes, ...no] : null;
		}
		if (ts.isBinaryExpression(expression) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(expression.operatorToken.kind)) {
			const fallback = options(expression.right);
			return fallback ? [VALUE, ...fallback] : null;
		}
		if (ts.isJsxElement(expression) || ts.isJsxSelfClosingElement(expression) || ts.isJsxFragment(expression) || ts.isBinaryExpression(expression) || ts.isCallExpression(expression) || ts.isArrowFunction(expression)) return null;
		return [VALUE];
	};
	return options(child.expression);
}

/** Every candidate in one file. */
export function extractFile(file, root) {
	const source = readFileSync(file, "utf8");
	const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
	const found = [];
	const relative = path.relative(root, file).replaceAll("\\", "/");
	const add = (text, node, kind) => {
		const value = normalize(text);
		if (!value) return;
		const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
		found.push({ text: value, file: relative, line: line + 1, kind });
	};
	const visit = (node) => {
		if (ts.isJsxText(node)) {
			const value = normalize(node.text);
			if (value && hasWords(value)) add(value, node, "jsx");
		} else if (ts.isJsxElement(node) || ts.isJsxFragment(node)) {
			// Text interleaved with values in one element ("Used {n} times") is
			// matched as a whole by the translator. A value chosen between
			// literals (`n === 1 ? "" : "s"`, `version ?? "update"`) yields one
			// pattern per choice, since languages inflect differently.
			const children = node.children.filter((child) => !(ts.isJsxText(child) && child.containsOnlyTriviaWhiteSpaces));
			const choices = children.map(childChoices);
			if (children.length > 1 && choices.every(Boolean)) {
				let variants = [""];
				let values = 0;
				for (const options of choices) {
					const next = [];
					for (const variant of variants) for (const option of options) next.push(variant + (option === VALUE ? `\u0000` : option));
					variants = next.slice(0, 8);
				}
				for (const variant of variants) {
					let index = 0;
					const value = normalize(variant.replace(/\u0000/g, () => `{${index++}}`));
					values = Math.max(values, index);
					if (index > 0 && hasWords(value.replace(/\{\d+\}/g, ""))) add(value, node, "jsx-group");
				}
			}
		} else if ((ts.isTemplateExpression(node) || isPlusChain(node)) && !(node.parent && isPlusChain(node.parent))) {
			const where = landing(node);
			const pattern = patternOf(node);
			// Values stand in as "N" for the text checks ("Nm ago").
			const probe = pattern.text.replace(/\{\d+\}/g, "N");
			const literal = pattern.text.replace(/\{\d+\}/g, " ").trim();
			if (pattern.values > 0 && /[A-Za-z]{2,}/.test(literal) && accept(probe, where, node) && !/[/\\#&;]|\w=|px\b|\(|^-/.test(literal)) {
				add(pattern.text, node, "pattern");
			}
			if (ts.isTemplateExpression(node)) {
				for (const span of node.templateSpans) visit(span.expression);
				return;
			}
		} else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
			if (!(node.parent && isPlusChain(node.parent))) {
				const where = landing(node);
				if (accept(node.text, where, node)) add(node.text, node, where.kind === "jsx" ? "jsx" : where.kind === "attribute" ? "attribute" : "code");
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(sf);
	return found;
}

/** Every candidate in the app, merged by text. */
export function extractAll(root) {
	const files = [];
	for (const dir of ROOTS) walkFiles(path.join(root, dir), files);
	const byText = new Map();
	for (const file of files) {
		for (const item of extractFile(file, root)) {
			const entry = byText.get(item.text) ?? { text: item.text, kind: item.kind, where: [] };
			if (entry.where.length < 3) entry.where.push(`${item.file}:${item.line}`);
			byText.set(item.text, entry);
		}
	}
	return [...byText.values()].sort((a, b) => a.text.localeCompare(b.text));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
	process.stdout.write(`${JSON.stringify(extractAll(root), null, "\t")}\n`);
}
