/**
 * Fork: the Claude connection's saved models move from `claude-code`, the
 * id upstream's own Claude Code option has now, to `claude` (docs/claude.md).
 * The store adapters run these on every read, upstream's place for lazy
 * migrations. Each returns true when it changed the record; the adapter then
 * writes it back once, so later reads find nothing to do.
 */

import {
	CLAUDE_API,
	CLAUDE_PROVIDER,
	LEGACY_CLAUDE_API,
	LEGACY_CLAUDE_PROVIDER,
	migratedClaudeModel,
	migratedClaudeModelKey,
} from "../core/contracts/claude.ts";
import type { ChatRecord, JobRecord } from "../core/contracts.ts";
import type { UserSettings } from "../core/settings.ts";

function moveModel(holder: { model?: { provider: string; id: string } } | undefined): boolean {
	const next = holder?.model ? migratedClaudeModel(holder.model) : null;
	if (!next || !holder) return false;
	holder.model = next;
	return true;
}

function moveModelKey(holder: { model: string } | undefined): boolean {
	const next = typeof holder?.model === "string" ? migratedClaudeModelKey(holder.model) : null;
	if (!next || !holder) return false;
	holder.model = next;
	return true;
}

/** The model slots and the background-role overrides. */
export function migrateClaudeSettings(record: UserSettings): boolean {
	let changed = false;
	for (const slot of Object.values(record.models ?? {})) changed = moveModel(slot) || changed;
	for (const role of Object.values(record.agent?.models ?? {})) changed = moveModel(role) || changed;
	return changed;
}

/** The chat's model, its recorded responses and its usage logs. */
export function migrateClaudeChat(record: ChatRecord): boolean {
	let changed = moveModel(record.settings);
	for (const message of record.messages ?? []) {
		if (message.role !== "assistant" || message.api !== LEGACY_CLAUDE_API || message.provider !== LEGACY_CLAUDE_PROVIDER) continue;
		message.api = CLAUDE_API;
		message.provider = CLAUDE_PROVIDER;
		changed = true;
	}
	for (const turn of record.turns ?? []) changed = moveModelKey(turn) || changed;
	for (const run of record.extractions ?? []) {
		for (const stage of Object.values(run.stages ?? {})) changed = moveModelKey(stage) || changed;
	}
	return changed;
}

/** A background job's usage. */
export function migrateClaudeJob(record: JobRecord): boolean {
	return moveModelKey(record.usage);
}
