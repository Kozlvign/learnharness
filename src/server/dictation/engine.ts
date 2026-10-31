/**
 * The local dictation engine (fork feature, docs/dictation.md).
 *
 * sherpa-onnx runs Parakeet in a worker thread. The worker starts with the
 * first dictation and is terminated after 10 idle minutes, which returns
 * the model's memory (about 1 GB) to the system at once; dropping the
 * native objects on the main thread would leave it to the garbage
 * collector. Loading takes about 2 s; audio that arrives meanwhile waits
 * in the queue.
 *
 * Each dictation is a session with its own Silero VAD: a pause of about a
 * second closes a stretch of speech, which is transcribed in the
 * background while the learner keeps talking, so the text is ready almost
 * as soon as they stop. Stretches longer than 25 s are cut. Transcriptions
 * run one at a time; texts come back in speaking order.
 */
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";

/**
 * The worker's code, evaluated as CommonJS. It loads sherpa-onnx-node by
 * path at run time, so bundlers never see the native module (the build
 * traces its files through next.config.ts instead).
 */
const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const { createRequire } = require("node:module");
const path = require("node:path");
const sherpa = createRequire(workerData.base)("sherpa-onnx-node");
const dir = workerData.modelDir;

const recognizer = sherpa.OfflineRecognizer.createAsync({
	featConfig: { sampleRate: 16000, featureDim: 80 },
	modelConfig: {
		transducer: {
			encoder: path.join(dir, "encoder.int8.onnx"),
			decoder: path.join(dir, "decoder.int8.onnx"),
			joiner: path.join(dir, "joiner.int8.onnx"),
		},
		tokens: path.join(dir, "tokens.txt"),
		numThreads: workerData.threads,
		provider: "cpu",
		modelType: "nemo_transducer",
		debug: 0,
	},
});
recognizer.catch(() => {});

function newVad() {
	return new sherpa.Vad({
		sileroVad: {
			model: path.join(dir, "silero_vad.onnx"),
			threshold: 0.5,
			minSpeechDuration: 0.25,
			minSilenceDuration: workerData.pauseSeconds,
			maxSpeechDuration: 25,
			windowSize: 512,
		},
		sampleRate: 16000,
		debug: false,
		numThreads: 1,
	}, 60);
}

class Fatal extends Error {}
let queue = Promise.resolve();
function transcribe(samples) {
	const job = queue.then(async () => {
		let rec;
		try { rec = await recognizer; } catch (error) { throw new Fatal(String((error && error.message) || error)); }
		const stream = rec.createStream();
		stream.acceptWaveform({ samples, sampleRate: 16000 });
		const result = await rec.decodeAsync(stream);
		return String((result && result.text) || "").trim();
	});
	queue = job.catch(() => {});
	return job;
}

const sessions = new Map();
function drain(session) {
	while (!session.vad.isEmpty()) {
		const segment = session.vad.front(false);
		session.vad.pop();
		const index = session.next++;
		session.jobs.push(transcribe(segment.samples).then(
			(text) => { session.done.set(index, text); },
			(error) => { if (!session.error) session.error = error; },
		));
	}
}
function collect(session) {
	const texts = [];
	while (session.done.has(session.delivered)) {
		const text = session.done.get(session.delivered);
		session.done.delete(session.delivered);
		session.delivered++;
		if (text) texts.push(text);
	}
	return texts;
}

parentPort.on("message", async (message) => {
	const reply = (body) => parentPort.postMessage({ id: message.id, ...body });
	try {
		if (message.op === "open") {
			sessions.set(message.sid, { vad: newVad(), next: 0, delivered: 0, done: new Map(), jobs: [], error: null });
			reply({ texts: [] });
			return;
		}
		const session = sessions.get(message.sid);
		if (!session) { reply({ error: "Unknown dictation session.", gone: true }); return; }
		if (message.op === "audio") {
			const pcm = new Int16Array(message.pcm);
			const samples = new Float32Array(pcm.length);
			for (let i = 0; i < pcm.length; i++) samples[i] = pcm[i] / 32768;
			// One VAD window at a time: given a longer chunk, the VAD dates the
			// start of speech from the chunk's end and clips the first words.
			for (let i = 0; i < samples.length; i += 512) {
				session.vad.acceptWaveform(samples.subarray(i, i + 512));
				drain(session);
			}
			if (session.error) throw session.error;
			reply({ texts: collect(session) });
		} else if (message.op === "end") {
			session.vad.flush();
			drain(session);
			await Promise.all(session.jobs);
			sessions.delete(message.sid);
			if (session.error) throw session.error;
			reply({ texts: collect(session) });
		} else {
			sessions.delete(message.sid);
			reply({ texts: [] });
		}
	} catch (error) {
		if (message.op !== "open") sessions.delete(message.sid);
		reply({ error: String((error && error.message) || error), fatal: error instanceof Fatal });
	}
});
`;

export class DictationSessionGone extends Error {}
export class DictationEngineError extends Error {}

type Pending = { resolve: (texts: string[]) => void; reject: (error: Error) => void };
type Reply = { id: number; texts?: string[]; error?: string; gone?: boolean; fatal?: boolean };
type Timing = { idleUnloadMs: number; sessionTimeoutMs: number; sweepMs: number; pauseSeconds: number };
type EngineState = {
	worker: Worker | null;
	modelDir: string | null;
	nextId: number;
	pending: Map<number, Pending>;
	sessions: Map<string, { touched: number }>;
	lastUse: number;
	sweeper: ReturnType<typeof setInterval> | null;
	timing: Timing;
};

/** Defaults: unload after 10 idle minutes; drop a session nobody has
 *  touched for 2 minutes (its window went away mid-dictation). */
export const DEFAULT_ENGINE_TIMING: Timing = Object.freeze({ idleUnloadMs: 10 * 60_000, sessionTimeoutMs: 2 * 60_000, sweepMs: 30_000, pauseSeconds: 1.0 });

const STATE = Symbol.for("lh.dictation.engine");
const globalState = globalThis as typeof globalThis & { [STATE]?: EngineState };
function engine(): EngineState {
	return (globalState[STATE] ??= {
		worker: null,
		modelDir: null,
		nextId: 0,
		pending: new Map(),
		sessions: new Map(),
		lastUse: 0,
		sweeper: null,
		timing: { ...DEFAULT_ENGINE_TIMING },
	});
}

/** Tests shorten the timers. */
export function configureDictationEngine(timing: Partial<Timing>): void {
	const state = engine();
	state.timing = { ...state.timing, ...timing };
}

/** Half the logical processors, between 1 and 4: more threads barely speed
 *  Parakeet up (measured: 4 threads ≈ 14× real time on a 12-core CPU). */
export function dictationThreads(): number {
	return Math.max(1, Math.min(4, Math.floor(os.availableParallelism() / 2)));
}

export function engineLoaded(): boolean {
	return engine().worker !== null;
}

export function activeDictationSessions(): number {
	return engine().sessions.size;
}

function fail(state: EngineState, worker: Worker, error: Error): void {
	if (state.worker !== worker) return;
	state.worker = null;
	state.modelDir = null;
	state.sessions.clear();
	for (const pending of state.pending.values()) pending.reject(error);
	state.pending.clear();
	stopSweeper(state);
	void worker.terminate().catch(() => {});
}

function startWorker(state: EngineState, modelDir: string): Worker {
	if (state.worker && state.modelDir === modelDir) return state.worker;
	if (state.worker) fail(state, state.worker, new DictationEngineError("The dictation model changed."));
	const worker = new Worker(WORKER_SOURCE, {
		eval: true,
		workerData: {
			// sherpa-onnx-node resolves from the server's own folder: the repo in
			// development, .next/standalone in the desktop app.
			base: path.join(process.cwd(), "package.json"),
			modelDir,
			threads: dictationThreads(),
			pauseSeconds: state.timing.pauseSeconds,
		},
	});
	worker.unref();
	worker.on("message", (reply: Reply) => {
		const pending = state.pending.get(reply.id);
		if (!pending) return;
		state.pending.delete(reply.id);
		if (reply.error === undefined) pending.resolve(reply.texts ?? []);
		else pending.reject(reply.gone ? new DictationSessionGone(reply.error) : new DictationEngineError(reply.error));
		if (reply.fatal) fail(state, worker, new DictationEngineError(reply.error ?? "The dictation model could not be loaded."));
	});
	worker.on("error", (error) => fail(state, worker, new DictationEngineError(error.message)));
	worker.on("exit", () => fail(state, worker, new DictationEngineError("The dictation engine stopped.")));
	state.worker = worker;
	state.modelDir = modelDir;
	startSweeper(state);
	return worker;
}

function request(state: EngineState, op: "open" | "audio" | "end" | "cancel", sid: string, pcm?: ArrayBuffer): Promise<string[]> {
	const worker = state.worker;
	if (!worker) return Promise.reject(new DictationSessionGone("The dictation engine stopped."));
	state.lastUse = Date.now();
	const id = ++state.nextId;
	return new Promise((resolve, reject) => {
		state.pending.set(id, { resolve, reject });
		worker.postMessage({ id, op, sid, pcm }, pcm ? [pcm] : []);
	});
}

function startSweeper(state: EngineState): void {
	stopSweeper(state);
	state.sweeper = setInterval(() => {
		const now = Date.now();
		for (const [sid, session] of state.sessions) {
			if (now - session.touched > state.timing.sessionTimeoutMs) void cancelDictationSession(sid);
		}
		if (state.sessions.size === 0 && state.pending.size === 0 && now - state.lastUse > state.timing.idleUnloadMs) void shutdownDictationEngine();
	}, state.timing.sweepMs);
	state.sweeper.unref?.();
}

function stopSweeper(state: EngineState): void {
	if (state.sweeper) clearInterval(state.sweeper);
	state.sweeper = null;
}

export async function openDictationSession(modelDir: string): Promise<string> {
	const state = engine();
	startWorker(state, modelDir);
	const sid = randomUUID();
	state.sessions.set(sid, { touched: Date.now() });
	try {
		await request(state, "open", sid);
	} catch (error) {
		state.sessions.delete(sid);
		throw error;
	}
	return sid;
}

function touch(state: EngineState, sid: string): void {
	const session = state.sessions.get(sid);
	if (!session) throw new DictationSessionGone("Unknown dictation session.");
	session.touched = Date.now();
}

/** Feeds 16 kHz 16-bit PCM; returns the stretches transcribed since the last call. */
export async function appendDictationAudio(sid: string, pcm: ArrayBuffer): Promise<string[]> {
	const state = engine();
	touch(state, sid);
	try {
		return await request(state, "audio", sid, pcm);
	} catch (error) {
		state.sessions.delete(sid);
		throw error;
	}
}

/** Transcribes what is left and closes the session. */
export async function endDictationSession(sid: string): Promise<string[]> {
	const state = engine();
	touch(state, sid);
	try {
		return await request(state, "end", sid);
	} finally {
		state.sessions.delete(sid);
	}
}

/** Discards a session and whatever it had not delivered. */
export async function cancelDictationSession(sid: string): Promise<void> {
	const state = engine();
	if (!state.sessions.delete(sid)) return;
	await request(state, "cancel", sid).catch(() => {});
}

/** Stops the worker and frees the model's memory. */
export async function shutdownDictationEngine(): Promise<void> {
	const state = engine();
	const worker = state.worker;
	if (!worker) return;
	fail(state, worker, new DictationSessionGone("The dictation engine stopped."));
	await worker.terminate().catch(() => {});
}
