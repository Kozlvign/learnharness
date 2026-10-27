/**
 * Local dictation (fork feature, docs/dictation.md): the shared vocabulary
 * of the dictation engine choice, the local model and its HTTP API.
 * Browser-safe: types, constants and pure parsing only.
 */

export const DICTATION_ENGINES = ["local", "deepgram"] as const;
export type DictationEngine = (typeof DICTATION_ENGINES)[number];

export interface DictationSettings {
	engine: DictationEngine;
}

/** Local is the default: it needs no key and no subscription. */
export const DEFAULT_DICTATION_SETTINGS: DictationSettings = Object.freeze({ engine: "local" });

export function isDictationEngine(value: unknown): value is DictationEngine {
	return typeof value === "string" && (DICTATION_ENGINES as readonly string[]).includes(value);
}

/** Lenient read of a stored record: unknown values fall back to defaults. */
export function parseDictationSettings(value: unknown): DictationSettings {
	const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
	return { engine: isDictationEngine(record.engine) ? record.engine : DEFAULT_DICTATION_SETTINGS.engine };
}

export interface ModelFile {
	name: string;
	url: string;
	bytes: number;
	sha256: string;
}

export interface LocalModel {
	/** Folder name under `<data>/models`. */
	id: string;
	label: string;
	attribution: string;
	files: readonly ModelFile[];
}

const PARAKEET_REPO =
	"https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/2bda32ec70b097a55adaa07d9a7173915b43cc78";

/**
 * NVIDIA Parakeet TDT 0.6B v3 (CC BY 4.0), int8 ONNX export by the
 * sherpa-onnx project, pinned to one revision. It transcribes 25 European
 * languages, Portuguese and English among them, detects the language on
 * its own and writes punctuation and capitals. Silero VAD (MIT) splits the
 * speech at pauses. Every file is checked against its SHA-256 on download.
 */
export const LOCAL_DICTATION_MODEL: LocalModel = Object.freeze({
	id: "parakeet-tdt-0.6b-v3-int8",
	label: "Parakeet v3",
	attribution: "NVIDIA · CC BY 4.0",
	files: Object.freeze([
		{ name: "encoder.int8.onnx", url: `${PARAKEET_REPO}/encoder.int8.onnx`, bytes: 652184281, sha256: "acfc2b4456377e15d04f0243af540b7fe7c992f8d898d751cf134c3a55fd2247" },
		{ name: "decoder.int8.onnx", url: `${PARAKEET_REPO}/decoder.int8.onnx`, bytes: 11845275, sha256: "179e50c43d1a9de79c8a24149a2f9bac6eb5981823f2a2ed88d655b24248db4e" },
		{ name: "joiner.int8.onnx", url: `${PARAKEET_REPO}/joiner.int8.onnx`, bytes: 6355277, sha256: "3164c13fc2821009440d20fcb5fdc78bff28b4db2f8d0f0b329101719c0948b3" },
		{ name: "tokens.txt", url: `${PARAKEET_REPO}/tokens.txt`, bytes: 93939, sha256: "d58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d" },
		{ name: "silero_vad.onnx", url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx", bytes: 643854, sha256: "9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6" },
	]),
});

export function modelBytes(model: LocalModel = LOCAL_DICTATION_MODEL): number {
	return model.files.reduce((sum, file) => sum + file.bytes, 0);
}

/** The download size as the interface shows it, e.g. "670 MB". */
export function modelSizeLabel(model: LocalModel = LOCAL_DICTATION_MODEL): string {
	const mb = modelBytes(model) / 1e6;
	return `${mb >= 100 ? Math.round(mb / 10) * 10 : Math.max(1, Math.round(mb))} MB`;
}

export type LocalModelStatus =
	| { state: "missing" }
	| { state: "downloading"; received: number; total: number }
	| { state: "ready" }
	/** The last download failed; the model is not on disk. */
	| { state: "error"; error: string };

export interface DictationStatus {
	settings: DictationSettings;
	model: LocalModelStatus;
}

/** Whole percent of a download, 0–100. */
export function downloadPercent(status: LocalModelStatus): number {
	if (status.state !== "downloading" || status.total <= 0) return 0;
	return Math.min(100, Math.floor((status.received / status.total) * 100));
}

export const DICTATION_API = "/api/dictation";
/** Writes carry this header, which a cross-site form cannot send. */
export const DICTATION_HEADER = "x-learnharness-dictation";
/** Audio is posted as 16 kHz mono 16-bit little-endian PCM. */
export const DICTATION_SAMPLE_RATE = 16000;
/** The largest audio body one request may carry (about 32 s of audio). */
export const MAX_DICTATION_AUDIO_BYTES = 1_048_576;
/** The error a session request gets while the local model is not on disk. */
export const MODEL_MISSING_CODE = "model_missing";
