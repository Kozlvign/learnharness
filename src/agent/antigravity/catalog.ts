/** Models offered by the signed-in Antigravity account, as pi models. Ids are
 * agy's own model values ("gemini-4-neon", "claude-opus-5-5", …); Orchestrator
 * is left out (the probe skips it). Thinking levels map one to one onto agy's
 * (low, medium, high, xhigh, max); a model without levels thinks at its own
 * fixed budget. Use counts toward the Google plan, so costs are zero. */
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { ANTIGRAVITY_API, ANTIGRAVITY_PROVIDER } from "../../core/contracts/antigravity.ts";
import { antigravityContextWindow, antigravityModelInfos, antigravityStatus, type AntigravityModelInfo } from "./connection.ts";

const LEVELS: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
/** Used until agy reports the model's window. */
const DEFAULT_CONTEXT = 200_000;
const MAX_TOKENS = 65_536;

function toModel(info: AntigravityModelInfo): Model<Api> {
	const levels = new Set(info.levels);
	// "default": thinking at the model's own budget, for models without levels.
	const thinkingLevelMap = Object.fromEntries(LEVELS.map((level) => [
		level,
		level === "off" || level === "minimal" ? null
			: levels.size ? (levels.has(level) ? level : null)
				: level === "medium" ? "default" : null,
	]));
	return {
		id: info.id,
		name: info.name,
		api: ANTIGRAVITY_API,
		provider: ANTIGRAVITY_PROVIDER,
		baseUrl: "",
		input: ["text", "image"],
		reasoning: true,
		thinkingLevelMap,
		contextWindow: antigravityContextWindow(info.id) ?? info.contextWindow ?? DEFAULT_CONTEXT,
		maxTokens: MAX_TOKENS,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	} as Model<Api>;
}

export function antigravityModels(): Model<Api>[] {
	if (!antigravityStatus().connected) return [];
	return antigravityModelInfos().map(toModel);
}

export function antigravityModel(id: string): Model<Api> | undefined {
	return antigravityModels().find((model) => model.id === id);
}

/** The agy thinking level for a pi reasoning level, or undefined to keep the model's own. */
export function antigravityLevel(model: Model<Api>, reasoning: string | undefined): string | undefined {
	if (!reasoning) return undefined;
	const mapped = model.thinkingLevelMap?.[reasoning as keyof NonNullable<Model<Api>["thinkingLevelMap"]>];
	return typeof mapped === "string" && mapped !== "default" && mapped !== "off" ? mapped : undefined;
}
