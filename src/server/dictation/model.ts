/**
 * The local dictation model on disk (fork feature, docs/dictation.md):
 * status, a verified download, cancel and removal.
 *
 * Each file downloads to `<name>.part`, is checked against the manifest's
 * size and SHA-256, and only then takes its real name. So a file with its
 * real name and expected size was verified when it landed, and the status
 * check stays a cheap `stat`. Progress lives in memory; the settings rows
 * and the dictation bar poll it.
 */
import { createHash } from "node:crypto";
import { createWriteStream, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { PATHS } from "../../../config.ts";
import { LOCAL_DICTATION_MODEL, modelBytes, type LocalModel, type LocalModelStatus, type ModelFile } from "../../core/dictation.ts";

type Download = { controller: AbortController; received: number; total: number; done: Promise<void> };
type ModelState = { download: Download | null; error: string | null };

const STATE = Symbol.for("lh.dictation.model");
const globalState = globalThis as typeof globalThis & { [STATE]?: Map<string, ModelState> };

function stateOf(model: LocalModel): ModelState {
	const states = (globalState[STATE] ??= new Map());
	let state = states.get(model.id);
	if (!state) states.set(model.id, (state = { download: null, error: null }));
	return state;
}

export function modelDir(model: LocalModel = LOCAL_DICTATION_MODEL): string {
	return path.join(PATHS.data, "models", model.id);
}

function fileReady(dir: string, file: ModelFile): boolean {
	try {
		return statSync(path.join(dir, file.name)).size === file.bytes;
	} catch {
		return false;
	}
}

export function modelReady(model: LocalModel = LOCAL_DICTATION_MODEL): boolean {
	const dir = modelDir(model);
	return model.files.every((file) => fileReady(dir, file));
}

export function modelStatus(model: LocalModel = LOCAL_DICTATION_MODEL): LocalModelStatus {
	const state = stateOf(model);
	if (state.download) return { state: "downloading", received: state.download.received, total: state.download.total };
	if (modelReady(model)) return { state: "ready" };
	if (state.error) return { state: "error", error: state.error };
	return { state: "missing" };
}

/** Starts the download unless it is running or done. Returns at once. */
export function startModelDownload(model: LocalModel = LOCAL_DICTATION_MODEL, fetchImpl: typeof fetch = fetch): LocalModelStatus {
	const state = stateOf(model);
	if (state.download || modelReady(model)) return modelStatus(model);
	state.error = null;
	const download: Download = { controller: new AbortController(), received: 0, total: modelBytes(model), done: Promise.resolve() };
	state.download = download;
	download.done = runDownload(model, download, fetchImpl)
		.then(
			() => { state.error = null; },
			(error: unknown) => { state.error = download.controller.signal.aborted ? null : downloadError(error); },
		)
		.finally(() => { if (state.download === download) state.download = null; });
	return modelStatus(model);
}

/** Stops a running download and waits until its partial file is gone. */
export async function cancelModelDownload(model: LocalModel = LOCAL_DICTATION_MODEL): Promise<void> {
	const download = stateOf(model).download;
	if (!download) return;
	download.controller.abort();
	await download.done;
}

/** Deletes the model's files. The caller stops the engine first. */
export async function removeModel(model: LocalModel = LOCAL_DICTATION_MODEL): Promise<void> {
	await cancelModelDownload(model);
	rmSync(modelDir(model), { recursive: true, force: true });
	stateOf(model).error = null;
}

async function runDownload(model: LocalModel, download: Download, fetchImpl: typeof fetch): Promise<void> {
	const dir = modelDir(model);
	mkdirSync(dir, { recursive: true });
	for (const file of model.files) {
		if (fileReady(dir, file)) {
			download.received += file.bytes;
			continue;
		}
		await downloadFile(dir, file, download, fetchImpl);
	}
}

class DownloadError extends Error {}

async function downloadFile(dir: string, file: ModelFile, download: Download, fetchImpl: typeof fetch): Promise<void> {
	const target = path.join(dir, file.name);
	const partial = `${target}.part`;
	const start = download.received;
	const signal = download.controller.signal;
	try {
		const response = await fetchImpl(file.url, { signal, redirect: "follow" });
		if (!response.ok || !response.body) throw new DownloadError(`The download server answered ${response.status}.`);
		const hash = createHash("sha256");
		let written = 0;
		const meter = new Transform({
			transform(chunk: Buffer, _encoding, callback) {
				written += chunk.length;
				if (written > file.bytes) {
					callback(new DownloadError("A downloaded file was damaged. Try again."));
					return;
				}
				hash.update(chunk);
				download.received = start + written;
				callback(null, chunk);
			},
		});
		await pipeline(Readable.fromWeb(response.body as unknown as WebReadableStream<Uint8Array>), meter, createWriteStream(partial), { signal });
		if (written !== file.bytes || hash.digest("hex") !== file.sha256) throw new DownloadError("A downloaded file was damaged. Try again.");
		renameSync(partial, target);
	} catch (error) {
		download.received = start;
		try { rmSync(partial, { force: true }); } catch { /* removed on the next attempt */ }
		throw error;
	}
}

/** A short reason the interface can show. */
function downloadError(error: unknown): string {
	if (error instanceof DownloadError) return error.message;
	const code = (error as { code?: unknown } | null)?.code;
	if (code === "ENOSPC") return "Not enough disk space.";
	// fetch reports network failures as a TypeError; file system errors carry a code.
	if (!(error instanceof TypeError) && typeof code === "string" && code.startsWith("E")) return `Could not save the model (${code}).`;
	return "Could not reach the download server. Check your connection and try again.";
}
