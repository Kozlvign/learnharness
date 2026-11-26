/** The Antigravity connection (fork feature): LearnHarness drives Google's
 * official, unmodified Antigravity CLI (`agy acp`) with the user's own Google
 * account, the way T3 Code does. agy signs in through Google's own flow and
 * keeps the credentials in a profile only LearnHarness uses; LearnHarness never
 * reads, stores or forwards Google tokens. Browser-safe: types and constants only. */

/** Persisted route id for models served through Antigravity. */
export const ANTIGRAVITY_PROVIDER = "antigravity";
export const ANTIGRAVITY_LABEL = "Antigravity";
/** The pi `api` value of Antigravity models. No pi provider handles it; the
 *  app's own stream function does. */
export const ANTIGRAVITY_API = "antigravity";
/** agy 1.5.1 serves every ACP client; older runtimes only allowlisted editors. */
export const ANTIGRAVITY_MINIMUM_VERSION = "1.5.1";
export const ANTIGRAVITY_INSTALL_URL = "https://antigravity.google/docs/getting-started";

export type AntigravityState =
	/** First probe has not finished yet. */
	| "checking"
	/** No agy executable was found. */
	| "missing"
	/** agy is older than ANTIGRAVITY_MINIMUM_VERSION. */
	| "outdated"
	/** agy is installed but its LearnHarness profile is not signed in. */
	| "signed-out"
	/** Signed in and usable. */
	| "connected"
	/** The probe failed; `error` says why. */
	| "error";

/** Where the executable in use came from. */
export type AntigravityExecutableSource = "override" | "managed" | "installer" | "path";

export interface AntigravityAccount {
	/** Reported by agy when the sign-in ran in LearnHarness. */
	email?: string;
	/** e.g. "Google AI Pro". */
	plan?: string;
}

export interface AntigravityModelSummary {
	id: string;
	name: string;
	/** agy thinking levels, e.g. ["low", "medium", "high", "xhigh"]. Empty when fixed. */
	levels: string[];
}

export type AntigravityInstallPhase = "downloading" | "verifying" | "installing" | "succeeded" | "failed" | "cancelled";

export interface AntigravityInstall {
	phase: AntigravityInstallPhase;
	version: string | null;
	downloadedBytes: number;
	totalBytes: number | null;
	message: string | null;
}

export type AntigravityLoginPhase = "starting" | "waiting" | "verifying" | "failed" | "cancelled";

export interface AntigravityLogin {
	phase: AntigravityLoginPhase;
	/** Google's sign-in page for this attempt (no secret: the code comes back to the user). */
	url: string | null;
	message: string | null;
}

export interface AntigravityManaged {
	/** Google publishes a runtime for this platform. */
	supported: boolean;
	/** Version of the runtime LearnHarness downloaded, if any. */
	installed: string | null;
	/** Newest version Google publishes, when known. */
	latest: string | null;
}

export interface AntigravityStatus {
	state: AntigravityState;
	/** Signed in and ready for model calls. */
	connected: boolean;
	version: string | null;
	/** Local path of the CLI in use (shown to the user, never a secret). */
	executable: string | null;
	source: AntigravityExecutableSource | null;
	account: AntigravityAccount | null;
	models: AntigravityModelSummary[];
	allowBackgroundUse: boolean;
	managed: AntigravityManaged;
	install: AntigravityInstall | null;
	login: AntigravityLogin | null;
	error?: string;
	checkedAt: number | null;
	revision: number;
}

export type AntigravityControl =
	| { op: "refresh" }
	| { op: "install" }
	| { op: "cancel-install" }
	| { op: "remove-runtime" }
	| { op: "login-start" }
	| { op: "login-submit"; code: string }
	| { op: "login-cancel" }
	| { op: "logout" }
	| { op: "consent"; enabled: boolean };
