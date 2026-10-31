/**
 * The local engine behind the WebSocket interface the dictation hook
 * speaks to Deepgram (fork feature, docs/dictation.md), so the hook's run
 * logic stays as upstream wrote it.
 *
 *   open           a session is open on the server
 *   send(frame)    16 kHz 16-bit PCM; posted every half second
 *   send(CloseStream)  post what is left, transcribe the rest, then close 1000
 *   message        each transcribed stretch, shaped like a Deepgram final
 *   close()        discard the session (Esc, teardown)
 *
 * Any failed request closes with 1011, which the hook treats like a lost
 * Deepgram connection (one reconnect, then an error).
 */
import { DICTATION_API, DICTATION_HEADER, MAX_DICTATION_AUDIO_BYTES } from "@/src/core";

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;
/** Audio is batched for this long: short enough that the text keeps up,
 *  long enough to keep requests few. */
export const LOCAL_FLUSH_MS = 500;

export interface LocalSocketHooks {
	onOpen?: () => void;
	onClose?: () => void;
	fetch?: typeof fetch;
}

export class LocalDictationSocket extends EventTarget {
	readyState = CONNECTING;
	private id: string | null = null;
	private queue: ArrayBuffer[] = [];
	private timer: ReturnType<typeof setTimeout> | null = null;
	private sending: Promise<void> = Promise.resolve();
	private ending = false;
	private readonly fetch: typeof fetch;

	constructor(private readonly hooks: LocalSocketHooks = {}) {
		super();
		this.fetch = hooks.fetch ?? ((input, init) => fetch(input, init));
		void this.connect();
	}

	private async request(path: string, init: RequestInit = {}): Promise<Response> {
		const response = await this.fetch(`${DICTATION_API}${path}`, {
			method: "POST",
			...init,
			headers: { ...init.headers, [DICTATION_HEADER]: "1" },
		});
		if (!response.ok) throw new Error(`dictation ${response.status}`);
		return response;
	}

	private async connect(): Promise<void> {
		try {
			const { id } = (await (await this.request("/sessions")).json()) as { id: string };
			if (this.readyState === CLOSED) {
				// Closed while the session opened: discard it.
				void this.request(`/sessions/${id}`, { method: "DELETE" }).catch(() => {});
				return;
			}
			this.id = id;
			this.readyState = OPEN;
			this.hooks.onOpen?.();
			this.dispatchEvent(new Event("open"));
		} catch {
			this.finish(1011);
		}
	}

	send(data: ArrayBuffer | ArrayBufferView | string): void {
		if (this.readyState !== OPEN) throw new Error("The dictation session is not open.");
		// A frame that slips in after the stop is dropped: the run is ending.
		if (this.ending) return;
		if (typeof data === "string") {
			if ((JSON.parse(data) as { type?: string }).type === "CloseStream") this.end();
			return;
		}
		const view = ArrayBuffer.isView(data) ? data : new Uint8Array(data);
		this.queue.push(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer);
		this.timer ??= setTimeout(() => {
			this.timer = null;
			this.flush();
		}, LOCAL_FLUSH_MS);
	}

	/** Discard: no more events, the server forgets the session. */
	close(): void {
		if (this.readyState === CLOSED) return;
		const id = this.id;
		this.stop();
		if (id) void this.request(`/sessions/${id}`, { method: "DELETE" }).catch(() => {});
	}

	/** Posts everything queued, one request at a time, in order. */
	private flush(): Promise<void> {
		this.sending = this.sending.then(async () => {
			while (this.queue.length > 0 && this.readyState === OPEN) {
				const response = await this.request(`/sessions/${this.id}`, {
					headers: { "content-type": "application/octet-stream" },
					body: this.takeBatch(),
				});
				this.deliver(((await response.json()) as { texts?: string[] }).texts);
			}
		}).catch(() => this.finish(1011));
		return this.sending;
	}

	private takeBatch(): ArrayBuffer {
		let bytes = 0;
		let count = 0;
		for (const frame of this.queue) {
			if (bytes + frame.byteLength > MAX_DICTATION_AUDIO_BYTES) break;
			bytes += frame.byteLength;
			count++;
		}
		count = Math.max(count, 1);
		const parts = this.queue.splice(0, count);
		const batch = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
		let offset = 0;
		for (const part of parts) {
			batch.set(new Uint8Array(part), offset);
			offset += part.byteLength;
		}
		return batch.buffer;
	}

	private end(): void {
		this.ending = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		void this.flush().then(async () => {
			if (this.readyState !== OPEN) return;
			try {
				const response = await this.request(`/sessions/${this.id}/end`);
				this.deliver(((await response.json()) as { texts?: string[] }).texts);
				this.finish(1000);
			} catch {
				this.finish(1011);
			}
		});
	}

	private deliver(texts: string[] | undefined): void {
		for (const text of texts ?? []) {
			if (this.readyState !== OPEN) return;
			const data = JSON.stringify({ type: "Results", is_final: true, channel: { alternatives: [{ transcript: text }] } });
			this.dispatchEvent(new MessageEvent("message", { data }));
		}
	}

	private stop(): void {
		const wasOpen = this.readyState === OPEN;
		this.readyState = CLOSED;
		this.queue = [];
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		if (wasOpen) this.hooks.onClose?.();
	}

	private finish(code: number): void {
		if (this.readyState === CLOSED) return;
		this.stop();
		this.dispatchEvent(Object.assign(new Event("close"), { code, reason: "", wasClean: code === 1000 }));
	}
}
