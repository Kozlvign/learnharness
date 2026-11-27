import type { ModelRole } from "../../config.ts";
import { piEngineForSpec } from "../agent/models.ts";
import type { SubagentEngineChoice } from "../agent/subagents/engine-choice.ts";
import { isSubscriptionProvider } from "../agent/subscription-connections.ts";
import { nativeSubscriptionError } from "../agent/subscription-stream.ts";
import { chatGPTStreamError } from "../agent/chatgpt-stream.ts";
import { resolveSessionSubagentSpec, type EffectiveModelSpec } from "../core/settings-resolution.ts";
import { providerKeyMissing, type ModelSlotName } from "../core/settings.ts";
import { providerKeyPresent } from "./keys.ts";
import { refreshConnectionCatalog } from "./model-catalog.ts";
import { stores } from "./stores.ts";

/**
 * The helpers' engines (owner, 2026-11-27): the researcher, demo builder,
 * visual maker, PDF reader, extractor, auditor and the Anki writer run on
 * the SESSION'S OWN teacher model — chat.model → strong slot, the
 * session's thinking level included. Outside a session (notes import) they
 * run the strong slot.
 *
 * The session's connection is checked BEFORE any fallback is considered: a
 * missing key, a signed-out subscription or a model its catalog no longer
 * has refuses on the strong tier — never a silent switch to another
 * provider. Only a session model that is genuinely text-only sends the
 * visual maker and the PDF reader to the vision slot.
 *
 * Read FRESH per call, so a settings PUT or a model switch in the chat
 * between dispatch and spawn lands. Engines run as background work.
 */
export async function sessionSubagentEngine(role: ModelRole, chatId?: string): Promise<SubagentEngineChoice> {
	const record = stores.settingsStore.readSettings();
	const chat = chatId ? stores.chatStore.getChat(chatId)?.settings : undefined;
	const session = resolveSessionSubagentSpec(role, chat, record);
	if (!session.spec) return { refusal: { kind: "models", tier: session.tier } };
	const primary = await tierEngine(session.spec, session.tier);
	if ("refusal" in primary) return primary;
	const choice = resolveSessionSubagentSpec(role, chat, record, { acceptsImages: () => primary.engine.model.input.includes("image") });
	if (choice.tier === session.tier) return primary;
	if (!choice.spec) return { refusal: { kind: "models", tier: choice.tier } };
	return tierEngine(choice.spec, choice.tier);
}

/** One tier's engine, after the same connection checks a turn makes. */
async function tierEngine(spec: EffectiveModelSpec, tier: ModelSlotName): Promise<SubagentEngineChoice> {
	// A subscription's status is unknown after a restart until something
	// asks; the helper may run before any turn has (the turn gate's order).
	if (isSubscriptionProvider(spec.provider)) await refreshConnectionCatalog(spec.provider);
	if (!providerKeyPresent(spec.provider)) return { refusal: { kind: "key", envelope: providerKeyMissing(spec.provider, [tier]) } };
	try {
		return { engine: piEngineForSpec(spec, true, undefined, () => stores.settingsStore.readSettings()?.models?.[tier]?.cacheRetention), tier };
	} catch {
		// The turn gate's own wording for a model the catalog cannot build.
		const error = spec.provider === "chatgpt"
			? chatGPTStreamError("model catalog")
			: isSubscriptionProvider(spec.provider) ? nativeSubscriptionError(spec.provider, "model catalog") : "The selected model is unavailable.";
		return { refusal: { kind: "unavailable", tier, error } };
	}
}
