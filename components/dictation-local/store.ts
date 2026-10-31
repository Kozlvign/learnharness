/**
 * Local dictation in the window (fork feature, docs/dictation.md): the
 * engine choice and the model's status, loaded from /api/dictation and
 * shared by the dictation bar and the settings rows, plus the seams
 * components/dictation.tsx calls to mint a "token" and open a socket for
 * the chosen engine.
 */
import { useSyncExternalStore } from "react";
import {
	DICTATION_API,
	DICTATION_HEADER,
	type DictationEngine,
	type DictationStatus,
} from "@/src/core";
import { LocalDictationSocket } from "./local-socket";

/** The error the dictation hook holds while the local model is missing:
 *  the bar shows the download prompt instead of an error line. */
export const DICTATION_MODEL_MISSING = "Dictation needs the local model";
/** Stands in for a Deepgram token when the local engine was chosen. */
export const LOCAL_DICTATION_TOKEN = "lh-local-dictation";
export const LOCAL_DICTATION_NAME = "Local dictation";

type Snapshot = {
	/** null until the first load. */
	status: DictationStatus | null;
	/** The last failed control (download, remove, engine change). */
	error: string | null;
	/** Local dictation sessions open in this window. */
	sessions: number;
};

let snapshot: Snapshot = { status: null, error: null, sessions: 0 };
const SERVER_SNAPSHOT: Snapshot = snapshot;
const listeners = new Set<() => void>();
const engineListeners = new Set<() => void>();

function publish(next: Partial<Snapshot>): void {
	snapshot = { ...snapshot, ...next };
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function useLocalDictation(): Snapshot {
	return useSyncExternalStore(subscribe, () => snapshot, () => SERVER_SNAPSHOT);
}

/** Called when the engine choice changes (the warm token is engine-specific). */
export function onDictationEngineChange(listener: () => void): () => void {
	engineListeners.add(listener);
	return () => engineListeners.delete(listener);
}

let poll: ReturnType<typeof setTimeout> | null = null;

function accept(status: DictationStatus): DictationStatus {
	const before = snapshot.status?.settings.engine;
	publish({ status });
	if (before && before !== status.settings.engine) for (const listener of engineListeners) listener();
	// While a download runs, follow its progress.
	if (status.model.state === "downloading" && !poll) {
		poll = setTimeout(() => {
			poll = null;
			void loadDictationStatus().catch(() => {});
		}, 500);
	}
	return status;
}

async function read(response: Response): Promise<DictationStatus> {
	const body = (await response.json().catch(() => ({}))) as Partial<DictationStatus> & { error?: string };
	if (!response.ok || !body.settings || !body.model) throw new Error(body.error ?? `Dictation request failed (${response.status})`);
	return body as DictationStatus;
}

export async function loadDictationStatus(): Promise<DictationStatus> {
	return accept(await read(await fetch(DICTATION_API, { cache: "no-store" })));
}

async function control(path: string, init: RequestInit): Promise<void> {
	publish({ error: null });
	try {
		const response = await fetch(`${DICTATION_API}${path}`, {
			...init,
			headers: { ...init.headers, [DICTATION_HEADER]: "1" },
		});
		accept(await read(response));
	} catch (error) {
		publish({ error: error instanceof Error ? error.message : "Dictation request failed" });
		void loadDictationStatus().catch(() => {});
	}
}

export function setDictationEngine(engine: DictationEngine): Promise<void> {
	return control("", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ engine }) });
}

export function downloadDictationModel(): Promise<void> {
	return control("/model", { method: "POST" });
}

/** Cancels a running download, or removes the downloaded model. */
export function deleteDictationModel(): Promise<void> {
	return control("/model", { method: "DELETE" });
}

export function dictationEngine(): DictationEngine {
	return snapshot.status?.settings.engine ?? "local";
}

/** The server's current choice, or the last known one when it can't be read. */
export async function currentDictationEngine(): Promise<DictationEngine> {
	try {
		return (await loadDictationStatus()).settings.engine;
	} catch {
		return dictationEngine();
	}
}

/** The service named in dictation errors. */
export function dictationServiceName(): string {
	return dictationEngine() === "deepgram" ? "Deepgram" : LOCAL_DICTATION_NAME;
}

/** How long a stopped run waits for its last text before giving up: the
 *  local engine may still be loading the model or transcribing. */
export function dictationStopTimeoutMs(): number {
	return dictationEngine() === "deepgram" ? 3000 : 20_000;
}

/** Known synchronously at the click, so the microphone never turns on for
 *  a run that cannot start: the local engine without its model. */
export function dictationBlocked(): string | null {
	const status = snapshot.status;
	if (!status || status.settings.engine !== "local") return null;
	return status.model.state === "ready" ? null : DICTATION_MODEL_MISSING;
}

/** The start of every run: the engine's "token", read from the server's
 *  current choice. Deepgram mints a real one. */
export async function mintDictationToken(mintDeepgram: () => Promise<string>): Promise<string> {
	const status = await loadDictationStatus();
	if (status.settings.engine === "deepgram") return mintDeepgram();
	if (status.model.state !== "ready") throw new Error(DICTATION_MODEL_MISSING);
	return LOCAL_DICTATION_TOKEN;
}

/** Deepgram's WebSocket, or the local engine behind the same interface. */
export function openDictationSocket(url: string, token: string): WebSocket {
	if (token === LOCAL_DICTATION_TOKEN) {
		return new LocalDictationSocket({
			onOpen: () => publish({ sessions: snapshot.sessions + 1 }),
			onClose: () => publish({ sessions: Math.max(0, snapshot.sessions - 1) }),
		}) as unknown as WebSocket;
	}
	// Minted JWTs authenticate via the "bearer" subprotocol.
	return new WebSocket(url, ["bearer", token]);
}
