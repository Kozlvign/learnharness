// Fork: local dictation (docs/dictation.md).
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-dictation-"));
process.env.LH_DATA_DIR = scratch;
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const core = await import("../src/core/index.ts");
const { DEFAULT_DICTATION_ENGINE_SETTINGS, DICTATION_HEADER, downloadPercent, LOCAL_DICTATION_MODEL, MODEL_MISSING_CODE, modelBytes, modelSizeLabel, parseDictationEngineSettings } = core;
type LocalModel = import("../src/core/dictation-local.ts").LocalModel;
const { dictationResponse, dictationSessionResponse, dictationSessionsResponse } = await import("../src/server/dictation-http.ts");
const { cancelModelDownload, modelDir, modelStatus, removeModel, startModelDownload } = await import("../src/server/dictation/model.ts");
const { dictationSettingsFile } = await import("../src/server/dictation/settings.ts");
const { LocalDictationSocket, LOCAL_FLUSH_MS } = await import("../components/dictation-local/local-socket.ts");
const store = await import("../components/dictation-local/store.ts");
const { DictationSettingsView, deepgramKeyRowVisible } = await import("../components/dictation-local/dictation-settings.tsx");
const { ModelPromptView } = await import("../components/dictation-local/model-prompt.tsx");

const ORIGIN = "http://127.0.0.1:3123";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function api(pathname: string, init: RequestInit & { headers?: Record<string, string> } = {}, trusted = true): Request {
	const method = init.method ?? "GET";
	const headers: Record<string, string> = { ...(init.headers ?? {}) };
	if (trusted && method !== "GET") Object.assign(headers, { origin: ORIGIN, [DICTATION_HEADER]: "1" });
	return new Request(`${ORIGIN}${pathname}`, { ...init, method, headers });
}

describe("dictation settings", () => {
	it("local is the default and unknown values fall back to it", () => {
		assert.deepEqual(parseDictationEngineSettings(undefined), DEFAULT_DICTATION_ENGINE_SETTINGS);
		assert.equal(parseDictationEngineSettings({ engine: "whisper" }).engine, "local");
		assert.equal(parseDictationEngineSettings({ engine: "deepgram" }).engine, "deepgram");
	});

	it("the model is about 670 MB and progress is a whole percent", () => {
		assert.equal(modelBytes(), 671_122_626);
		assert.equal(modelSizeLabel(), "670 MB");
		assert.equal(downloadPercent({ state: "downloading", received: 1, total: 3 }), 33);
		assert.equal(downloadPercent({ state: "ready" }), 0);
	});

	it("GET reports the engine and the model; PUT needs a same-origin request with the header", async () => {
		const status = await (await dictationResponse(api("/api/dictation"))).json();
		assert.deepEqual(status, { settings: { engine: "local" }, model: { state: "missing" } });

		const body = JSON.stringify({ engine: "deepgram" });
		const untrusted = await dictationResponse(api("/api/dictation", { method: "PUT", headers: { origin: ORIGIN, "content-type": "application/json" }, body }, false));
		assert.equal(untrusted.status, 403, "no header: refused");
		const wrong = await dictationResponse(api("/api/dictation", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ engine: "whisper" }) }));
		assert.equal(wrong.status, 400);

		const saved = await dictationResponse(api("/api/dictation", { method: "PUT", headers: { "content-type": "application/json" }, body }));
		assert.equal(saved.status, 200);
		assert.equal((await saved.json()).settings.engine, "deepgram");
		assert.deepEqual(JSON.parse(fs.readFileSync(dictationSettingsFile(), "utf8")), { engine: "deepgram" });

		await dictationResponse(api("/api/dictation", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ engine: "local" }) }));
	});

	it("a session cannot open without the model", async () => {
		const response = await dictationSessionsResponse(api("/api/dictation/sessions", { method: "POST" }));
		assert.equal(response.status, 409);
		assert.equal((await response.json()).code, MODEL_MISSING_CODE);
	});

	it("audio needs a known session id and 16-bit PCM", async () => {
		const bad = await dictationSessionResponse(api("/api/dictation/sessions/x", { method: "POST" }), "x");
		assert.equal(bad.status, 404);
		const id = "00000000-0000-4000-8000-000000000000";
		const odd = await dictationSessionResponse(api(`/api/dictation/sessions/${id}`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: new Uint8Array(3) }), id);
		assert.equal(odd.status, 400);
		const gone = await dictationSessionResponse(api(`/api/dictation/sessions/${id}`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: new Uint8Array(4) }), id);
		assert.equal(gone.status, 404, "unknown session");
	});
});

describe("model download", () => {
	const files: Record<string, Buffer> = { "a.onnx": Buffer.alloc(300_000, 7), "b.txt": Buffer.from("tokens\n") };
	let slow = false;
	const server = http.createServer((request, response) => {
		const name = request.url!.slice(1);
		const data = files[name];
		if (!data) {
			response.writeHead(404).end();
			return;
		}
		response.writeHead(200, { "content-length": data.length });
		if (!slow) {
			response.end(data);
			return;
		}
		// Trickle: lets the test see progress and cancel mid-file.
		let offset = 0;
		const timer = setInterval(() => {
			if (response.destroyed) return clearInterval(timer);
			response.write(data.subarray(offset, offset + 10_000));
			offset += 10_000;
			if (offset >= data.length) {
				clearInterval(timer);
				response.end();
			}
		}, 20);
	});
	after(() => server.close());
	// Unref: a filtered run (--test-name-pattern) skips the after() hook.
	const listening = new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
	server.unref();

	const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");
	async function model(id: string, damaged = false): Promise<LocalModel> {
		const port = await listening;
		return {
			id,
			label: "Test",
			attribution: "",
			files: Object.entries(files).map(([name, data]) => ({ name, url: `http://127.0.0.1:${port}/${name}`, bytes: data.length, sha256: damaged && name === "a.onnx" ? "0".repeat(64) : sha(data) })),
		};
	}
	async function settled(m: LocalModel) {
		for (let i = 0; i < 500 && modelStatus(m).state === "downloading"; i++) await sleep(10);
		return modelStatus(m);
	}

	it("downloads every file, checks it, and reports ready", async () => {
		slow = false;
		const m = await model("ok");
		assert.equal(modelStatus(m).state, "missing");
		assert.equal(startModelDownload(m).state, "downloading");
		assert.deepEqual(await settled(m), { state: "ready" });
		assert.deepEqual(fs.readdirSync(modelDir(m)).sort(), ["a.onnx", "b.txt"]);
		await removeModel(m);
		assert.equal(fs.existsSync(modelDir(m)), false);
		assert.equal(modelStatus(m).state, "missing");
	});

	it("a damaged file is rejected and leaves nothing behind", async () => {
		slow = false;
		const m = await model("damaged", true);
		startModelDownload(m);
		const status = await settled(m);
		assert.equal(status.state, "error");
		assert.match((status as { error: string }).error, /damaged/);
		assert.deepEqual(fs.readdirSync(modelDir(m)), [], "no partial or unverified file");
	});

	it("reports progress and can be cancelled", async () => {
		slow = true;
		const m = await model("cancel");
		startModelDownload(m);
		let status = modelStatus(m);
		for (let i = 0; i < 200 && !(status.state === "downloading" && status.received > 0); i++) {
			await sleep(10);
			status = modelStatus(m);
		}
		assert.equal(status.state, "downloading");
		assert.ok(status.state === "downloading" && status.received > 0 && status.received < status.total);
		await cancelModelDownload(m);
		assert.equal(modelStatus(m).state, "missing", "a cancel is not an error");
		assert.deepEqual(fs.readdirSync(modelDir(m)), []);
	});

	it("the real manifest pins revisions and hashes", () => {
		for (const file of LOCAL_DICTATION_MODEL.files) {
			assert.match(file.sha256, /^[0-9a-f]{64}$/);
			assert.ok(file.url.startsWith("https://"));
			assert.ok(!file.url.includes("/resolve/main/"), "a pinned revision, not main");
		}
	});
});

describe("the local socket", () => {
	type Call = { url: string; method: string; bytes: number };
	function fakeServer(options: { failAudio?: boolean; failOpen?: boolean } = {}) {
		const calls: Call[] = [];
		let posts = 0;
		const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			const method = init?.method ?? "GET";
			const bytes = init?.body instanceof ArrayBuffer ? init.body.byteLength : 0;
			calls.push({ url, method, bytes });
			const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
			if (url.endsWith("/sessions")) return options.failOpen ? new Response("{}", { status: 409 }) : ok({ id: "s1" });
			if (url.endsWith("/end")) return ok({ texts: ["last part."] });
			if (method === "DELETE") return new Response(null, { status: 204 });
			if (options.failAudio) return new Response("{}", { status: 500 });
			return ok({ texts: ++posts === 1 ? ["Olá, tudo bem?"] : [] });
		}) as typeof fetch;
		return { calls, fetchImpl };
	}
	function record(socket: EventTarget) {
		const events: string[] = [];
		socket.addEventListener("open", () => events.push("open"));
		socket.addEventListener("message", (e) => {
			const msg = JSON.parse((e as MessageEvent).data as string);
			events.push(`final:${msg.channel.alternatives[0].transcript}`);
		});
		socket.addEventListener("close", (e) => events.push(`close:${(e as Event & { code: number }).code}`));
		return events;
	}

	it("streams audio in batches, delivers Deepgram-shaped finals, and closes 1000 after CloseStream", async () => {
		const { calls, fetchImpl } = fakeServer();
		let open = 0;
		const socket = new LocalDictationSocket({ fetch: fetchImpl, onOpen: () => open++, onClose: () => open-- });
		const events = record(socket);
		await sleep(10);
		assert.equal(socket.readyState, 1);
		assert.equal(open, 1);
		socket.send(new Int16Array(2048).buffer);
		socket.send(new Int16Array(2048).buffer);
		await sleep(LOCAL_FLUSH_MS + 50);
		assert.deepEqual(calls.filter((c) => c.url.endsWith("/sessions/s1")).map((c) => c.bytes), [8192], "two frames, one request");
		socket.send(new Int16Array(1024).buffer);
		socket.send(JSON.stringify({ type: "CloseStream" }));
		socket.send(new Int16Array(1024).buffer); // after the stop: dropped
		await sleep(50);
		assert.deepEqual(events, ["open", "final:Olá, tudo bem?", "final:last part.", "close:1000"]);
		assert.deepEqual(calls.filter((c) => c.url.endsWith("/sessions/s1")).map((c) => c.bytes), [8192, 2048], "the rest is posted before the end");
		assert.equal(socket.readyState, 3);
		assert.equal(open, 0);
	});

	it("close() discards the session without events", async () => {
		const { calls, fetchImpl } = fakeServer();
		const socket = new LocalDictationSocket({ fetch: fetchImpl });
		const events = record(socket);
		await sleep(10);
		socket.send(new Int16Array(2048).buffer);
		socket.close();
		await sleep(LOCAL_FLUSH_MS + 50);
		assert.deepEqual(events, ["open"]);
		assert.deepEqual(calls.map((c) => c.method), ["POST", "DELETE"], "no audio after the discard");
	});

	it("a failed request closes abnormally, so the hook reconnects once", async () => {
		const audio = fakeServer({ failAudio: true });
		const socket = new LocalDictationSocket({ fetch: audio.fetchImpl });
		const events = record(socket);
		await sleep(10);
		socket.send(new Int16Array(2048).buffer);
		await sleep(LOCAL_FLUSH_MS + 50);
		assert.deepEqual(events, ["open", "close:1011"]);

		const open = fakeServer({ failOpen: true });
		const refused = record(new LocalDictationSocket({ fetch: open.fetchImpl }));
		await sleep(10);
		assert.deepEqual(refused, ["close:1011"]);
	});
});

describe("engine choice in the window", () => {
	const realFetch = globalThis.fetch;
	after(() => { globalThis.fetch = realFetch; });
	function serve(engine: "local" | "deepgram", state: "missing" | "ready") {
		globalThis.fetch = (async () => new Response(JSON.stringify({ settings: { engine }, model: { state } }), { status: 200 })) as typeof fetch;
	}

	it("the local engine without its model blocks the run before the microphone", async () => {
		serve("local", "missing");
		await assert.rejects(store.mintDictationToken(async () => "dg"), new RegExp(store.DICTATION_MODEL_MISSING));
		assert.equal(store.dictationBlocked(), store.DICTATION_MODEL_MISSING);
		assert.equal(store.dictationServiceName(), "Local dictation");
		assert.equal(store.dictationStopTimeoutMs(), 20_000);
	});

	it("with the model the token is the local stand-in; Deepgram mints its own", async () => {
		serve("local", "ready");
		assert.equal(await store.mintDictationToken(async () => "dg"), store.LOCAL_DICTATION_TOKEN);
		assert.equal(store.dictationBlocked(), null);
		let changed = 0;
		const off = store.onDictationEngineChange(() => changed++);
		serve("deepgram", "missing");
		assert.equal(await store.mintDictationToken(async () => "dg-token"), "dg-token");
		assert.equal(changed, 1, "the warm token is refreshed on an engine change");
		assert.equal(store.dictationBlocked(), null, "Deepgram never needs the model");
		assert.equal(store.dictationServiceName(), "Deepgram");
		off();
	});

	it("Deepgram connects with the language chosen in upstream's picker", () => {
		const realSocket = globalThis.WebSocket;
		const opened: { url: string; protocols: unknown }[] = [];
		globalThis.WebSocket = class { constructor(url: string, protocols: unknown) { opened.push({ url, protocols }); } } as unknown as typeof WebSocket;
		try {
			store.openDictationSocket(core.deepgramListenUrl("pt-BR"), "dg-token");
			store.openDictationSocket(core.deepgramListenUrl("multi"), "dg-token");
		} finally {
			globalThis.WebSocket = realSocket;
		}
		assert.match(opened[0]!.url, /[?&]language=pt-BR(&|$)/);
		assert.match(opened[1]!.url, /[?&]language=multi(&|$)/);
		assert.deepEqual(opened[0]!.protocols, ["bearer", "dg-token"]);
	});
});

describe("dictation interface", () => {
	const noop = () => {};
	const status = (engine: "local" | "deepgram", model: import("../src/core/dictation-local.ts").LocalModelStatus) => ({ settings: { engine }, model });

	it("settings: local shows the model row; Deepgram shows the key row instead", () => {
		const local = renderToStaticMarkup(<DictationSettingsView status={status("local", { state: "missing" })} error={null} sessions={0} onEngine={noop} onDownload={noop} onDelete={noop} />);
		assert.match(local, /Local \(Parakeet\)/);
		assert.match(local, /Download \(670 MB\)/);
		assert.match(local, /NVIDIA · CC BY 4\.0 · runs on this computer/);
		assert.equal(deepgramKeyRowVisible(status("local", { state: "missing" })), false);

		const deepgram = renderToStaticMarkup(<DictationSettingsView status={status("deepgram", { state: "ready" })} error={null} sessions={0} onEngine={noop} onDownload={noop} onDelete={noop} />);
		assert.doesNotMatch(deepgram, /dictation-model/);
		assert.equal(deepgramKeyRowVisible(status("deepgram", { state: "ready" })), true);
		assert.equal(deepgramKeyRowVisible(null), false, "hidden until the choice loads");
	});

	it("settings: progress, then Remove, locked while a dictation runs", () => {
		const downloading = renderToStaticMarkup(<DictationSettingsView status={status("local", { state: "downloading", received: 42, total: 100 })} error={null} sessions={0} onEngine={noop} onDownload={noop} onDelete={noop} />);
		assert.match(downloading, /Downloading… 42%/);
		const ready = renderToStaticMarkup(<DictationSettingsView status={status("local", { state: "ready" })} error={null} sessions={1} onEngine={noop} onDownload={noop} onDelete={noop} />);
		assert.match(ready, /Downloaded/);
		assert.match(ready, /disabled=""[^>]*data-testid="dictation-model-remove"|data-testid="dictation-model-remove"[^>]*disabled=""/);
	});

	it("bar: asks before downloading, then shows the progress", () => {
		const ask = renderToStaticMarkup(<ModelPromptView model={{ state: "missing" }} error={null} onDownload={noop} onCancelDownload={noop} onDismiss={noop} />);
		assert.match(ask, /Download the dictation model \(670 MB\)\?/);
		assert.match(ask, />Download</);
		const failed = renderToStaticMarkup(<ModelPromptView model={{ state: "error", error: "Not enough disk space." }} error={null} onDownload={noop} onCancelDownload={noop} onDismiss={noop} />);
		assert.match(failed, /Download failed: Not enough disk space\./);
		assert.match(failed, />Retry</);
		const progress = renderToStaticMarkup(<ModelPromptView model={{ state: "downloading", received: 1, total: 4 }} error={null} onDownload={noop} onCancelDownload={noop} onDismiss={noop} />);
		assert.match(progress, /Downloading dictation model… 25%/);
	});
});

// The real engine, only when a downloaded model is at hand:
// LH_TEST_DICTATION_MODEL_DIR=<model folder> LH_TEST_DICTATION_WAV=<16 kHz mono 16-bit wav>
const realModel = process.env.LH_TEST_DICTATION_MODEL_DIR;
const realWav = process.env.LH_TEST_DICTATION_WAV;
describe("the real engine", { skip: !realModel || !realWav ? "set LH_TEST_DICTATION_MODEL_DIR and LH_TEST_DICTATION_WAV" : false }, () => {
	it("transcribes in stretches and frees the model when idle", async () => {
		const engine = await import("../src/server/dictation/engine.ts");
		engine.configureDictationEngine({ idleUnloadMs: 200, sweepMs: 100 });
		const wav = fs.readFileSync(realWav!);
		const pcm = new Int16Array(wav.buffer.slice(wav.byteOffset + 44, wav.byteOffset + wav.length - ((wav.length - 44) % 2)));
		const sid = await engine.openDictationSession(realModel!);
		const texts: string[] = [];
		for (let i = 0; i < pcm.length; i += 8000) texts.push(...(await engine.appendDictationAudio(sid, pcm.slice(i, i + 8000).buffer)));
		texts.push(...(await engine.endDictationSession(sid)));
		assert.ok(texts.join(" ").trim().length > 0, "some text");
		assert.equal(engine.engineLoaded(), true);
		await sleep(600);
		assert.equal(engine.engineLoaded(), false, "unloaded after the idle time");
	});
});
