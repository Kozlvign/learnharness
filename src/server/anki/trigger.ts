/**
 * The Anki card pipeline's light trigger (fork feature, docs/anki.md).
 *
 * The pipeline module brings in the model stack, which takes seconds to
 * load; the server must not wait for it at start. This module is all that
 * starts with the server (root instrumentation.ts): it listens to the event
 * bus and, on the first `turn-settled` or `record-changed` while the
 * feature is on, loads ./pipeline.ts, hands the bus over to the pipeline
 * (`registerAnkiPipeline`, which takes every later event), runs it for the
 * chats seen so far and stops listening.
 *
 * Keep the imports light: the event bus (no imports) and the settings
 * store (config.ts, the Anki contract and its settings parse).
 */

import { subscribe as subscribeToBus, type ServerEventListener } from "../../core/events.ts";
import { ankiSettings } from "./store.ts";

export interface AnkiPipelineModule {
	registerAnkiPipeline(): void;
	runAnkiPipeline(chatId?: string): Promise<void>;
}

export interface AnkiTriggerDeps {
	enabled(): boolean;
	load(): Promise<AnkiPipelineModule>;
	subscribe(listener: ServerEventListener): () => void;
}

/** Listen until the pipeline takes over; returns the unsubscribe function. */
export function startAnkiTrigger(deps: AnkiTriggerDeps): () => void {
	let done = false;
	let loading = false;
	// Chats whose events arrived before the pipeline was in place.
	const pending = new Set<string>();

	const unsubscribe = deps.subscribe((event) => {
		if (done || (event.type !== "turn-settled" && event.type !== "record-changed")) return;
		const chatId = (event as { chatId?: unknown }).chatId;
		if (typeof chatId !== "string" || !chatId) return;
		try {
			if (!deps.enabled()) return;
		} catch {
			return;
		}
		pending.add(chatId);
		if (loading) return;
		loading = true;
		void deps.load().then(
			(pipeline) => {
				done = true;
				unsubscribe();
				pipeline.registerAnkiPipeline();
				const chats = [...pending];
				pending.clear();
				for (const id of chats) void pipeline.runAnkiPipeline(id).catch((err) => console.error(`[anki ${id}] run failed:`, err));
			},
			(err) => {
				// The next event tries again.
				loading = false;
				console.error("[anki] the card pipeline could not be loaded:", err);
			},
		);
	});
	return () => {
		done = true;
		unsubscribe();
	};
}

const STOP = Symbol.for("lh.anki.trigger");
const globalState = globalThis as typeof globalThis & { [STOP]?: () => void };

/** Start the trigger, once per process; never under tests. */
export function registerAnkiTrigger(): void {
	if (process.env.NODE_ENV === "test" || globalState[STOP]) return;
	globalState[STOP] = startAnkiTrigger({
		enabled: () => ankiSettings().enabled,
		load: () => import("./pipeline.ts"),
		subscribe: subscribeToBus,
	});
}
