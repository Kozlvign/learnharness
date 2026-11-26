/** Finds the Antigravity CLI and checks its version. Order: `LH_ANTIGRAVITY_PATH`,
 * the runtime LearnHarness downloaded, the official installer's location, then
 * `PATH`. GUI-launched apps often get a short PATH, so known locations come first. */
import { statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ANTIGRAVITY_MINIMUM_VERSION, type AntigravityExecutableSource } from "../../core/contracts/antigravity.ts";
import { runtimeDir } from "./environment.ts";
import { managedRuntime } from "./release.ts";

export interface AntigravityExecutable {
	path: string;
	source: AntigravityExecutableSource;
	/** A .js/.mjs entry point (tests and development) runs with Node. */
	script: boolean;
	/** Known before start only for the managed runtime. */
	version?: string;
}

function isFile(candidate: string): boolean {
	try { return statSync(candidate).isFile(); } catch { return false; }
}

function described(file: string, source: AntigravityExecutableSource, version?: string): AntigravityExecutable {
	return { path: file, source, script: /\.(c|m)?js$/i.test(file), ...(version ? { version } : {}) };
}

export function findAntigravityExecutable(
	env: Record<string, string | undefined> = process.env,
	platform: NodeJS.Platform = process.platform,
	home: string = os.homedir(),
	managedRoot: string = runtimeDir(),
): AntigravityExecutable | undefined {
	const override = env.LH_ANTIGRAVITY_PATH?.trim();
	if (override) return isFile(override) ? described(override, "override") : undefined;
	const managed = managedRuntime(managedRoot);
	if (managed) return described(managed.path, "managed", managed.version);
	const windows = platform === "win32";
	const name = windows ? "agy.exe" : "agy";
	const localAppData = env.LOCALAPPDATA || path.join(home, "AppData", "Local");
	const known = windows ? [path.join(localAppData, "agy", "bin", name), path.join(home, ".local", "bin", name)] : [path.join(home, ".local", "bin", name)];
	for (const candidate of known) if (isFile(candidate)) return described(candidate, "installer");
	for (const dir of (env.PATH ?? env.Path ?? "").split(windows ? ";" : ":").filter(Boolean)) {
		const direct = path.join(dir, name);
		if (isFile(direct)) return described(direct, "path");
	}
	return undefined;
}

/** "1.5.18", "v1.5.18" or "agy_acp_server_1.1.1" → [1, 5, 18]. */
export function parseAntigravityVersion(version: string | null | undefined): [number, number, number] | undefined {
	const match = /^(?:v|agy_acp_server_)?(\d+)\.(\d+)\.(\d+)/.exec(version?.trim() ?? "");
	return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

export function compareVersions(left: string, right: string): number {
	const a = parseAntigravityVersion(left) ?? [0, 0, 0], b = parseAntigravityVersion(right) ?? [0, 0, 0];
	for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index]! - b[index]!;
	return 0;
}

/** A runtime that reports no parsable version is given the benefit of the doubt. */
export function versionSupported(version: string | null | undefined): boolean {
	return parseAntigravityVersion(version) === undefined || compareVersions(version!, ANTIGRAVITY_MINIMUM_VERSION) >= 0;
}

/** The plain version number ("1.5.18") from what `initialize` reports. */
export function displayVersion(version: string | null | undefined): string | null {
	const parsed = parseAntigravityVersion(version);
	return parsed ? parsed.join(".") : version?.trim() || null;
}
