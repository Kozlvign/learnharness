/** Plugins use the documented per-server initialization hook. A plugin failure
 * must not prevent access to existing learning data or teaching/practice. */
export async function register() {
	if (process.env.NEXT_RUNTIME === "nodejs") {
		const { initializePlugins } = await import("./src/server/plugins.ts");
		try { await initializePlugins(); }
		catch (error) { console.error("[plugins] Initialization failed; plugin management will report the error:", error); }
		await registerAnki();
	}
}

// Fork: Anki cards (docs/anki.md).
/**
 * The fork starts the Anki card pipeline's light trigger when a server
 * instance starts: it listens to the server event bus and loads the
 * pipeline itself only on the first chat event while the feature is on, so
 * the server start never waits for the model stack. Node runtime only;
 * never under tests.
 */
async function registerAnki(): Promise<void> {
	if (process.env.NODE_ENV === "test") return;
	try {
		const { registerAnkiTrigger } = await import("./src/server/anki/trigger.ts");
		registerAnkiTrigger();
	} catch (err) {
		// A broken fork feature must never keep the server from starting.
		console.error("[anki] the card trigger could not start:", err);
	}
}
