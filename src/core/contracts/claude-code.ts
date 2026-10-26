/** The Claude connection (fork feature): LearnHarness drives the user's own,
 * unmodified Claude Code CLI through Anthropic's Agent SDK, the same way
 * T3 Code does. Claude Code owns sign-in and credentials; LearnHarness never
 * reads, stores or forwards Claude tokens. Browser-safe: types and constants only. */

/** Persisted route id for models served through Claude Code. Distinct from
 *  the "anthropic" API-key provider, which bills an API key. */
export const CLAUDE_CODE_PROVIDER = "claude-code";
export const CLAUDE_CODE_LABEL = "Claude";
/** The pi `api` value of Claude Code models. No pi provider handles it; the
 *  app's own stream function does. */
export const CLAUDE_CODE_API = "claude-code";

export type ClaudeCodeState =
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

export interface ClaudeCodeAccount {
	email?: string;
	organization?: string;
	/** e.g. "Claude Max", or "API usage billing" for a Console login. */
	plan?: string;
	/** True when Claude Code bills an API key instead of a subscription. */
	apiBilling?: boolean;
}

/** One plan usage window, as last reported by Claude Code. */
export interface ClaudeCodeUsageWindow {
	/** "five_hour", "seven_day", … */
	kind: string;
	/** 0–1, when reported. */
	utilization: number | null;
	/** Epoch milliseconds, when reported. */
	resetsAt: number | null;
	status: "allowed" | "allowed_warning" | "rejected";
}

export interface ClaudeCodeModelSummary {
	id: string;
	name: string;
	description: string;
}

export interface ClaudeCodeStatus {
	state: ClaudeCodeState;
	/** Signed in and ready for model calls. */
	connected: boolean;
	version: string | null;
	/** Local path of the CLI in use (shown to the user, never a secret). */
	executable: string | null;
	account: ClaudeCodeAccount | null;
	models: ClaudeCodeModelSummary[];
	allowBackgroundUse: boolean;
	usage: ClaudeCodeUsageWindow[];
	/** A sign-in terminal was opened and the app is waiting for it. */
	loginPending: boolean;
	error?: string;
	checkedAt: number | null;
	revision: number;
}

export type ClaudeCodeControl =
	| { op: "refresh" }
	| { op: "login" }
	| { op: "consent"; enabled: boolean };

export const CLAUDE_CODE_INSTALL_URL = "https://code.claude.com/docs/en/setup";
