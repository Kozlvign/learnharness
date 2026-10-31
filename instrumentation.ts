// Fork: Anki cards (docs/anki.md).
/**
 * Next.js calls `register` once when a server instance starts, before it
 * handles requests. The fork starts the Anki card pipeline's light trigger
 * here: it listens to the server event bus and loads the pipeline itself
 * only on the first chat event while the feature is on, so the server
 * start never waits for the model stack. Node runtime only; never under
 * tests.
 */
export async function register(): Promise<void> {
	if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NODE_ENV === "test") return;
	try {
		const { registerAnkiTrigger } = await import("./src/server/anki/trigger.ts");
		registerAnkiTrigger();
	} catch (err) {
		// A broken fork feature must never keep the server from starting.
		console.error("[anki] the card trigger could not start:", err);
	}
}
