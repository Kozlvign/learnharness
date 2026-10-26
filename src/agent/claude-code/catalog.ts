/** Claude models offered by the signed-in Claude Code account, as pi models.
 * Ids carry the "claude-" prefix (aliases become claude-opus, claude-sonnet…)
 * so Claude-specific app behavior keyed on the id applies. Aliases follow
 * Claude Code to the newest model of each family. */
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { CLAUDE_CODE_API, CLAUDE_CODE_PROVIDER } from "../../core/contracts/claude-code.ts";
import { piModels } from "../models.ts";
import { claudeCodeContextWindow, claudeCodeModelInfos, claudeCodeStatus } from "./connection.ts";

const LEVELS: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
/** Claude Code's default context for subscription sessions. Raised once a
 * response reports the real window. */
const DEFAULT_CONTEXT = 200_000;
/** Used only until the first probe answers, so saved model choices resolve. */
const FALLBACK: ModelInfo[] = ["fable", "opus", "sonnet", "haiku"].map((value) => ({
	value, displayName: value.charAt(0).toUpperCase() + value.slice(1), description: "",
	supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
}));

/** App model id → the value Claude Code expects. */
export function claudeCodeModelValue(id: string): string {
	const infos = claudeCodeModelInfos().length ? claudeCodeModelInfos() : FALLBACK;
	const match = infos.find((info) => appModelId(info.value) === id);
	return match?.value ?? id.replace(/^claude-(?=(fable|opus|sonnet|haiku)$)/, "");
}

function appModelId(value: string): string { return value.startsWith("claude-") ? value : `claude-${value}`; }

function toModel(info: ModelInfo): Model<Api> {
	const resolved = info.resolvedModel ?? info.value;
	const reference = piModels().getModel("anthropic", resolved) as Model<Api> | undefined;
	const efforts = new Set<string>(info.supportsEffort ? info.supportedEffortLevels ?? ["low", "medium", "high"] : []);
	const thinkingOff = (info as { supportsThinkingOff?: boolean }).supportsThinkingOff === true;
	// Without effort levels a model offers thinking on ("default") or off.
	const thinkingLevelMap = Object.fromEntries(LEVELS.map((level) => [
		level,
		level === "off" ? (thinkingOff ? "off" : null)
			: level === "minimal" ? null
				: efforts.size ? (efforts.has(level) ? level : null)
					: level === "medium" ? "default" : null,
	]));
	const name = info.displayName.toLowerCase().startsWith("claude") ? info.displayName : `Claude ${info.displayName}`;
	return {
		id: appModelId(info.value),
		name,
		api: CLAUDE_CODE_API,
		provider: CLAUDE_CODE_PROVIDER,
		baseUrl: "",
		input: reference?.input ?? ["text", "image"],
		reasoning: true,
		thinkingLevelMap,
		contextWindow: claudeCodeContextWindow(info.value) ?? Math.min(reference?.contextWindow ?? DEFAULT_CONTEXT, DEFAULT_CONTEXT),
		maxTokens: reference?.maxTokens ?? 64_000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	} as Model<Api>;
}

export function claudeCodeModels(): Model<Api>[] {
	const status = claudeCodeStatus();
	const infos = claudeCodeModelInfos();
	if (status.state === "checking" && infos.length === 0) return FALLBACK.map(toModel);
	if (!status.connected) return [];
	// An explicit row duplicating an alias's current model would list it twice.
	const aliased = new Set(infos.filter((info) => !info.value.startsWith("claude-")).map((info) => info.resolvedModel));
	return infos.filter((info) => !info.value.startsWith("claude-") || !aliased.has(info.value)).map(toModel);
}

export function claudeCodeModel(id: string): Model<Api> | undefined {
	return claudeCodeModels().find((model) => model.id === id);
}
