/** Finds the user's installed Claude Code CLI. The Agent SDK spawns it without
 * a shell, so a bare "claude" or an npm .cmd shim cannot be used directly
 * (T3 Code resolves shims the same way). */
import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ClaudeExecutable {
	path: string;
	/** A .js entry point needs Node to run it. */
	script: boolean;
}

function isFile(candidate: string): boolean {
	try { return statSync(candidate).isFile(); } catch { return false; }
}

/** An npm global install puts claude.cmd next to node_modules/@anthropic-ai/claude-code. */
function resolveShim(shim: string): string | undefined {
	const pkg = path.join(path.dirname(shim), "node_modules", "@anthropic-ai", "claude-code");
	for (const entry of [path.join(pkg, "bin", "claude.exe"), path.join(pkg, "bin", "claude"), path.join(pkg, "cli.js")]) {
		if (isFile(entry)) return entry;
	}
	return undefined;
}

function described(file: string): ClaudeExecutable {
	return { path: file, script: file.toLowerCase().endsWith(".js") };
}

export function findClaudeExecutable(
	env: Record<string, string | undefined> = process.env,
	platform: NodeJS.Platform = process.platform,
	home: string = os.homedir(),
): ClaudeExecutable | undefined {
	const override = env.LH_CLAUDE_CODE_PATH?.trim();
	if (override) return isFile(override) ? described(override) : undefined;
	const windows = platform === "win32";
	const name = windows ? "claude.exe" : "claude";
	// GUI-launched apps often get a short PATH, so check the installer's
	// locations before PATH.
	const known = windows
		? [path.join(home, ".local", "bin", name)]
		: [path.join(home, ".local", "bin", name), path.join(home, ".claude", "local", name), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"];
	for (const candidate of known) if (isFile(candidate)) return described(candidate);
	const dirs = (env.PATH ?? env.Path ?? "").split(windows ? ";" : ":").filter(Boolean);
	for (const dir of dirs) {
		const direct = path.join(dir, name);
		if (isFile(direct)) return described(direct);
		if (!windows) continue;
		for (const shim of ["claude.cmd", "claude.bat", "claude.ps1"]) {
			const file = path.join(dir, shim);
			if (!isFile(file)) continue;
			const target = resolveShim(file);
			if (target) return described(target);
		}
	}
	return undefined;
}

/** Runs the CLI with arguments and returns stdout. Never uses a shell. */
export function runClaude(executable: ClaudeExecutable, args: string[], env: Record<string, string>, timeoutMs = 15_000): Promise<string> {
	const [file, argv] = executable.script ? [process.platform === "win32" ? "node.exe" : "node", [executable.path, ...args]] : [executable.path, args];
	return new Promise((resolve, reject) => {
		execFile(file, argv, { env: env as NodeJS.ProcessEnv, timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024, encoding: "utf8" }, (error: Error | null, stdout: string) => {
			if (error) reject(error);
			else resolve(String(stdout));
		});
	});
}
