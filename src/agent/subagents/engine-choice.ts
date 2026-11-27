import type { ModelRole } from "../../../config.ts";
import { ROLE_SLOT, type ModelSlotName, type ProviderKeyMissing } from "../../core/settings.ts";
import type { PiEngine } from "../models.ts";

/**
 * The engine a helper role runs on, as the composition root resolves it
 * (owner, 2026-11-27: helpers follow the session's teacher model; the
 * vision roles fall back to the vision slot only for a text-only one).
 * The job runner and the extraction pipeline share this seam, so both
 * refuse the same way.
 */

/** Why a resolved role has no engine to run. */
export type SubagentEngineRefusal =
	/** No model on the role's chain for `tier`. */
	| { kind: "models"; tier: ModelSlotName }
	/** The model's provider key or connection is gone. */
	| { kind: "key"; envelope: ProviderKeyMissing }
	/** The provider's catalog cannot build the model right now. */
	| { kind: "unavailable"; tier: ModelSlotName; error: string };

/** A resolved role: the engine with the tier it counts against, or why not. */
export type SubagentEngineChoice = { engine: PiEngine; tier: ModelSlotName } | { refusal: SubagentEngineRefusal };

/** What an injected engineFor may return. A bare engine (or undefined)
 *  keeps the older seam: the tier is the role's ROLE_SLOT. */
export type SubagentEngineResolution = PiEngine | undefined | SubagentEngineChoice;

/** The injected resolver. `chatId` names the session whose model the
 *  helper follows; absent outside a session (notes import). */
export type SubagentEngineFor = (role: ModelRole, chatId?: string) => SubagentEngineResolution | Promise<SubagentEngineResolution>;

function isChoice(value: PiEngine | SubagentEngineChoice): value is SubagentEngineChoice {
	return "refusal" in value || ("engine" in value && "tier" in value);
}

/** Run the injected resolver and normalize what it returns. A throw or a
 *  rejection (a catalog that cannot build the model) becomes an honest
 *  refusal instead of an unhandled rejection. A synchronous resolver gets
 *  a synchronous answer, so callers whose start is observable without an
 *  await (the extraction registry) keep that property. */
export function chooseSubagentEngine(
	engineFor: SubagentEngineFor | undefined,
	role: ModelRole,
	chatId?: string,
): SubagentEngineChoice | Promise<SubagentEngineChoice> {
	const tier = ROLE_SLOT[role];
	const fail = (err: unknown): SubagentEngineChoice =>
		({ refusal: { kind: "unavailable", tier, error: err instanceof Error ? err.message : String(err) } });
	const settle = (resolved: SubagentEngineResolution): SubagentEngineChoice =>
		!resolved ? { refusal: { kind: "models", tier } } : isChoice(resolved) ? resolved : { engine: resolved, tier };
	let resolved: SubagentEngineResolution | Promise<SubagentEngineResolution>;
	try {
		resolved = engineFor?.(role, chatId);
	} catch (err) {
		return fail(err);
	}
	return resolved instanceof Promise ? resolved.then(settle, fail) : settle(resolved);
}
