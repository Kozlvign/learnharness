/** The managed Antigravity runtime: Google's official CLI release, downloaded
 * by LearnHarness into its own folder. Google's update manifest names the
 * version, the download and its SHA-512; the download must come from Google's
 * public bucket and match the hash before it is activated. */
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { once } from "node:events";
import path from "node:path";
import { createGunzip } from "node:zlib";

export const ANTIGRAVITY_MANIFEST_BASE = "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests";
const DOWNLOAD_PREFIX = "https://storage.googleapis.com/antigravity-public/antigravity-cli/";

export interface ReleaseAsset {
	version: string;
	url: string;
	sha512: string;
	format: "executable" | "tar.gz";
	executableName: string;
}

export function releaseTarget(platform: NodeJS.Platform, arch: string, musl = false): string | null {
	if (!["darwin", "linux", "win32"].includes(platform) || !["x64", "arm64"].includes(arch)) return null;
	const os = platform === "win32" ? "windows" : platform;
	return `${os}_${arch === "x64" ? "amd64" : arch}${platform === "linux" && musl ? "_musl" : ""}`;
}

export function isMusl(platform: NodeJS.Platform = process.platform, arch: string = process.arch): boolean {
	return platform === "linux" && existsSync(arch === "arm64" ? "/lib/libc.musl-aarch64.so.1" : "/lib/libc.musl-x86_64.so.1");
}

/** Validates a manifest the way T3 Code does: the download must be Google's
 * file for this exact platform. Anything else is rejected. */
export function parseRelease(value: unknown, platform: NodeJS.Platform, arch: string, musl = false): ReleaseAsset | null {
	if (!value || typeof value !== "object" || releaseTarget(platform, arch, musl) === null) return null;
	const { version, url, sha512 } = value as Record<string, unknown>;
	if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) return null;
	if (typeof url !== "string" || typeof sha512 !== "string" || !/^[a-fA-F0-9]{128}$/.test(sha512)) return null;
	const os = platform === "darwin" ? "mac" : platform === "win32" ? "windows" : "linux";
	const cpu = arch === "x64" ? "x64" : "arm64";
	const suffix = platform === "linux" && musl ? "_musl" : "";
	const extension = platform === "win32" ? "exe" : "tar.gz";
	const folder = `${platform === "win32" ? "windows" : platform}-${arch === "arm64" ? "arm" : "x64"}${suffix ? "-musl" : ""}`;
	const prefix = `${DOWNLOAD_PREFIX}${version}-`;
	const rest = url.startsWith(prefix) ? url.slice(prefix.length) : "";
	if (!/^\d+\//.test(rest) || rest.replace(/^\d+\//, "") !== `${folder}/cli_${os}_${cpu}${suffix}.${extension}`) return null;
	return { version, url, sha512: sha512.toLowerCase(), format: platform === "win32" ? "executable" : "tar.gz", executableName: platform === "win32" ? "agy.exe" : "antigravity" };
}

export type FetchLike = (input: string, init?: { signal?: AbortSignal }) => Promise<Response>;

/** The newest release for this computer, or null when unknown or unsupported. */
export async function fetchLatestRelease(options: { fetch?: FetchLike; base?: string; signal?: AbortSignal; platform?: NodeJS.Platform; arch?: string } = {}): Promise<ReleaseAsset | null> {
	const platform = options.platform ?? process.platform, arch = options.arch ?? process.arch, musl = isMusl(platform, arch);
	const target = releaseTarget(platform, arch, musl);
	if (!target) return null;
	const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000);
	try {
		const response = await (options.fetch ?? fetch)(`${options.base ?? ANTIGRAVITY_MANIFEST_BASE}/${target}.json`, { signal });
		if (!response.ok) return null;
		return parseRelease(await response.json(), platform, arch, musl);
	} catch { return null; }
}

export interface ManagedRuntime { version: string; path: string }

interface CurrentRecord { version: string; executable: string }

function inside(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return !!relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/** The activated managed runtime, when its files are intact. */
export function managedRuntime(root: string): ManagedRuntime | undefined {
	try {
		const record = JSON.parse(readFileSync(path.join(root, "current.json"), "utf8")) as CurrentRecord;
		if (typeof record.version !== "string" || typeof record.executable !== "string") return undefined;
		const file = path.resolve(root, record.executable);
		if (!inside(root, file) || !statSync(file).isFile()) return undefined;
		return { version: record.version, path: file };
	} catch { return undefined; }
}

export interface InstallProgress { phase: "downloading" | "verifying" | "installing"; downloadedBytes: number; totalBytes: number | null }

/** Downloads, verifies and activates a release. The previous runtime stays
 * active until the new one is complete; a failure leaves it unchanged. */
export async function installRelease(asset: ReleaseAsset, options: { root: string; fetch?: FetchLike; signal?: AbortSignal; onProgress?: (progress: InstallProgress) => void }): Promise<ManagedRuntime> {
	const { root } = options;
	const staging = path.join(root, `staging-${randomUUID()}`);
	mkdirSync(staging, { recursive: true, mode: 0o700 });
	try {
		const response = await (options.fetch ?? fetch)(asset.url, { signal: options.signal });
		if (!response.ok || !response.body) throw new Error(`The download failed (HTTP ${response.status}).`);
		const total = Number(response.headers.get("content-length")) || null;
		const download = path.join(staging, "download");
		const hash = createHash("sha512");
		const file = createWriteStream(download, { mode: 0o600 });
		let received = 0, reported = 0;
		options.onProgress?.({ phase: "downloading", downloadedBytes: 0, totalBytes: total });
		try {
			for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
				if (options.signal?.aborted) throw new DOMException("cancelled", "AbortError");
				hash.update(chunk);
				received += chunk.byteLength;
				if (!file.write(chunk)) await once(file, "drain");
				if (received - reported > 256 * 1024) { reported = received; options.onProgress?.({ phase: "downloading", downloadedBytes: received, totalBytes: total }); }
			}
		} finally {
			file.end();
			await once(file, "close").catch(() => {});
		}
		options.onProgress?.({ phase: "verifying", downloadedBytes: received, totalBytes: total });
		if (hash.digest("hex") !== asset.sha512) throw new Error("The download does not match Google's published checksum.");
		options.onProgress?.({ phase: "installing", downloadedBytes: received, totalBytes: total });
		const release = path.join(staging, "release");
		mkdirSync(release, { recursive: true });
		let executable: string;
		if (asset.format === "executable") {
			executable = path.join(release, asset.executableName);
			renameSync(download, executable);
		} else {
			await extractTarGz(download, release);
			rmSync(download, { force: true });
			const found = findFile(release, asset.executableName, 3);
			if (!found) throw new Error("The download does not contain the Antigravity executable.");
			executable = found;
		}
		if (process.platform !== "win32") chmodSync(executable, 0o755);
		const versionsDir = path.join(root, "versions");
		mkdirSync(versionsDir, { recursive: true });
		const destination = path.join(versionsDir, `${asset.version}-${randomUUID().slice(0, 8)}`);
		renameSync(release, destination);
		const relative = path.relative(root, path.join(destination, path.relative(release, executable)));
		const current = path.join(root, "current.json"), temp = `${current}.${process.pid}.tmp`;
		writeFileSync(temp, `${JSON.stringify({ version: asset.version, executable: relative } satisfies CurrentRecord, null, "\t")}\n`, { mode: 0o600 });
		renameSync(temp, current);
		pruneVersions(root, destination);
		return { version: asset.version, path: path.join(root, relative) };
	} finally {
		rmSync(staging, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
	}
}

/** Older versions are removed once a new one is active. A file still open
 * by a running session stays until the next install. */
function pruneVersions(root: string, keep: string): void {
	const versionsDir = path.join(root, "versions");
	for (const name of safeList(versionsDir)) {
		const dir = path.join(versionsDir, name);
		if (dir !== keep) try { rmSync(dir, { recursive: true, force: true }); } catch { /* in use */ }
	}
	for (const name of safeList(root)) if (name.startsWith("staging-")) try { rmSync(path.join(root, name), { recursive: true, force: true }); } catch { /* in use */ }
}

/** Deletes the managed runtime. The caller stops sessions first. */
export function removeManagedRuntime(root: string): void {
	rmSync(path.join(root, "current.json"), { force: true });
	rmSync(path.join(root, "versions"), { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
}

function safeList(dir: string): string[] { try { return readdirSync(dir); } catch { return []; } }

function findFile(dir: string, name: string, depth: number): string | undefined {
	for (const entry of safeList(dir)) {
		const full = path.join(dir, entry);
		let stat; try { stat = statSync(full); } catch { continue; }
		if (stat.isFile() && entry === name) return full;
		if (stat.isDirectory() && depth > 0) { const found = findFile(full, name, depth - 1); if (found) return found; }
	}
	return undefined;
}

/** Minimal streaming reader for the release archive: regular files and
 * folders only, every path kept inside the destination. */
export async function extractTarGz(archive: string, destination: string): Promise<void> {
	const { createReadStream } = await import("node:fs");
	const root = path.resolve(destination);
	let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
	let entry: { remaining: number; padding: number; out?: ReturnType<typeof createWriteStream> } | undefined;
	let longName: string | undefined, paxPath: string | undefined, meta: { kind: "L" | "x"; remaining: number; padding: number; chunks: Buffer[] } | undefined;
	let ended = false;
	const target = (name: string): string => {
		const clean = name.replace(/^\.\/+/, "");
		const full = path.resolve(root, clean);
		if (!clean || path.isAbsolute(clean) || (full !== root && !inside(root, full))) throw new Error("The archive contains an unsafe path.");
		return full;
	};
	const stream = createReadStream(archive).pipe(createGunzip());
	for await (const chunk of stream as AsyncIterable<Buffer>) {
		buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
		for (;;) {
			if (ended) break;
			if (meta) {
				const take = Math.min(meta.remaining, buffer.length);
				meta.chunks.push(buffer.subarray(0, take)); buffer = buffer.subarray(take); meta.remaining -= take;
				if (meta.remaining > 0) break;
				if (buffer.length < meta.padding) { meta.remaining = 0; break; }
				buffer = buffer.subarray(meta.padding);
				const text = Buffer.concat(meta.chunks).toString("utf8");
				if (meta.kind === "L") longName = text.replace(/\0+$/, "");
				else paxPath = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(text)?.[1];
				meta = undefined;
				continue;
			}
			if (entry) {
				const take = Math.min(entry.remaining, buffer.length);
				if (take && entry.out && !entry.out.write(buffer.subarray(0, take))) await once(entry.out, "drain");
				buffer = buffer.subarray(take); entry.remaining -= take;
				if (entry.remaining > 0) break;
				if (buffer.length < entry.padding) break;
				buffer = buffer.subarray(entry.padding);
				if (entry.out) { entry.out.end(); await once(entry.out, "close"); }
				entry = undefined;
				continue;
			}
			if (buffer.length < 512) break;
			const header = buffer.subarray(0, 512);
			buffer = buffer.subarray(512);
			if (header.every((byte) => byte === 0)) { ended = true; break; }
			const field = (start: number, length: number) => header.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "");
			const size = parseInt(field(124, 12).trim() || "0", 8);
			const type = String.fromCharCode(header[156] || 48);
			const padding = (512 - (size % 512)) % 512;
			if (type === "L" || type === "x") { meta = { kind: type, remaining: size, padding, chunks: [] }; continue; }
			const prefix = field(345, 155);
			const name = paxPath ?? longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
			paxPath = undefined; longName = undefined;
			if (type === "5") { mkdirSync(target(name), { recursive: true }); entry = { remaining: 0, padding: 0 }; continue; }
			if (type === "0" || type === "7") {
				const file = target(name);
				mkdirSync(path.dirname(file), { recursive: true });
				const mode = parseInt(field(100, 8).trim() || "644", 8) & 0o777;
				entry = { remaining: size, padding, out: createWriteStream(file, { mode: mode || 0o644 }) };
				if (size === 0) { entry.out!.end(); await once(entry.out!, "close"); entry = undefined; }
				continue;
			}
			// Links and special files are skipped.
			entry = { remaining: size, padding };
		}
	}
	if (entry?.out) { entry.out.end(); await once(entry.out, "close").catch(() => {}); }
}
