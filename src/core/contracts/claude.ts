/** The Claude connection (fork feature): LearnHarness drives the user's own,
 * unmodified Claude Code CLI through Anthropic's Agent SDK, the same way
 * T3 Code does. Claude Code owns sign-in and credentials; LearnHarness never
 * reads, stores or forwards Claude tokens. Browser-safe: types and constants only. */

/** Persisted route id for models served through Claude Code. Distinct from
 *  the "anthropic" API-key provider, which bills an API key. */
export const CLAUDE_PROVIDER = "claude";
export const CLAUDE_LABEL = "Claude";
/** The pi `api` value of Claude Code models. No pi provider handles it; the
 *  app's own stream function does. */
export const CLAUDE_API = "claude";

/** Before fork 0.4.001 this connection used the id `claude-code`, which
 *  upstream's own Claude Code option has now. Saved models move to
 *  `claude` when they are read (src/store/claude-migration.ts). The fork's
 *  model ids all start with `claude-` and upstream's (`opus`, `sonnet`,
 *  `haiku`) don't, so old entries are told apart by their id. Recorded
 *  responses also carry the old api value, which upstream never used. */
export const LEGACY_CLAUDE_PROVIDER = "claude-code";
export const LEGACY_CLAUDE_API = "claude-code";

/** The coordinates with the fork's id, or null when they are not an old entry of this connection. */
export function migratedClaudeModel(model: { provider: string; id: string }): { provider: string; id: string } | null {
	return model.provider === LEGACY_CLAUDE_PROVIDER && model.id.startsWith("claude-") ? { provider: CLAUDE_PROVIDER, id: model.id } : null;
}

/** The same for a provider-qualified key, as usage records keep it ("claude-code:claude-opus"). */
export function migratedClaudeModelKey(key: string): string | null {
	return key.startsWith(`${LEGACY_CLAUDE_PROVIDER}:claude-`) ? `${CLAUDE_PROVIDER}:${key.slice(LEGACY_CLAUDE_PROVIDER.length + 1)}` : null;
}

export type ClaudeState =
	/** First probe has not finished yet. */
	| "checking"
	/** No Claude Code executable was found. */
	| "missing"
	/** Claude Code is installed but not signed in. */
	| "signed-out"
	/** Signed in and usable. */
	| "connected"
	/** The probe failed; `error` says why. */
	| "error";

export interface ClaudeAccount {
	email?: string;
	organization?: string;
	/** e.g. "Claude Max", or "API usage billing" for a Console login. */
	plan?: string;
	/** True when Claude Code bills an API key instead of a subscription. */
	apiBilling?: boolean;
}

/** One plan usage window, as last reported by Claude Code. */
export interface ClaudeUsageWindow {
	/** "five_hour", "seven_day", … */
	kind: string;
	/** 0–1, when reported. */
	utilization: number | null;
	/** Epoch milliseconds, when reported. */
	resetsAt: number | null;
	status: "allowed" | "allowed_warning" | "rejected";
}

export interface ClaudeModelSummary {
	id: string;
	name: string;
	description: string;
}

export interface ClaudeStatus {
	state: ClaudeState;
	/** Signed in and ready for model calls. */
	connected: boolean;
	version: string | null;
	/** Local path of the CLI in use (shown to the user, never a secret). */
	executable: string | null;
	account: ClaudeAccount | null;
	models: ClaudeModelSummary[];
	allowBackgroundUse: boolean;
	usage: ClaudeUsageWindow[];
	/** A sign-in terminal was opened and the app is waiting for it. */
	loginPending: boolean;
	error?: string;
	checkedAt: number | null;
	revision: number;
}

export type ClaudeControl =
	| { op: "refresh" }
	| { op: "login" }
	| { op: "consent"; enabled: boolean };

export const CLAUDE_INSTALL_URL = "https://code.claude.com/docs/en/setup";
