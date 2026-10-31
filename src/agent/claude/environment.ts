/** The environment the Claude Code process gets. The SDK's `env` option
 * replaces the child environment, so this decides exactly what it sees. */
import { AUTH_PROVIDER_ENV_VARS } from "../../core/auth-keys.ts";

/** Removed so Claude Code uses its own sign-in (the user's subscription)
 * instead of an API key LearnHarness reflected into its environment. */
const REMOVED = new Set([
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"CLAUDECODE",
	"CLAUDE_CODE_ENTRYPOINT",
	"CLAUDE_CODE_SSE_PORT",
	"ELECTRON_RUN_AS_NODE",
	"NODE_OPTIONS",
]);
const PROVIDER_KEYS = new Set([...AUTH_PROVIDER_ENV_VARS].map((name) => name.toUpperCase()));

export function claudeCodeEnv(source: Record<string, string | undefined> = process.env): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [name, value] of Object.entries(source)) {
		if (value === undefined) continue;
		const upper = name.toUpperCase();
		// LH_* includes the desktop API secret; provider keys are LearnHarness's.
		if (upper.startsWith("LH_") || REMOVED.has(upper) || PROVIDER_KEYS.has(upper)) continue;
		env[name] = value;
	}
	// Keep sessions to what LearnHarness sends: no claude.ai connectors, no IDE
	// attachment, and room for large tool results such as research reports.
	env.ENABLE_CLAUDEAI_MCP_SERVERS = "false";
	env.CLAUDE_CODE_AUTO_CONNECT_IDE = "0";
	env.CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL = "1";
	env.MAX_MCP_OUTPUT_TOKENS = "200000";
	return env;
}
