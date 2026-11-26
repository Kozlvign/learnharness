/** Clean shutdown for native CLI sessions (fork: Claude and Antigravity
 * connections). The desktop shell asks the server to stop on a channel each
 * connection announces; every registered task then runs before the server
 * exits, so one connection's pause cannot cut another's short. */

interface ShutdownState { tasks: Set<() => Promise<void>>; channels: Set<string>; installed: boolean; stopping: boolean }
const KEY = Symbol.for("lh.graceful-shutdown");
function state(): ShutdownState {
	const global = globalThis as typeof globalThis & { [KEY]?: ShutdownState };
	return global[KEY] ??= { tasks: new Set(), channels: new Set(), installed: false, stopping: false };
}

/** The longest the tasks may take before the server exits anyway. */
const LIMIT_MS = 2500;

export function onGracefulShutdown(channel: string, task: () => Promise<void>): void {
	if (typeof process.send !== "function") return;
	const s = state();
	s.tasks.add(task);
	if (!s.channels.has(channel)) {
		s.channels.add(channel);
		// Tell the shell to ask before stopping this server.
		try { process.send({ channel, op: "graceful" }); } catch { /* shell gone */ }
	}
	if (s.installed) return;
	s.installed = true;
	const stop = () => {
		if (s.stopping) return;
		s.stopping = true;
		const timer = setTimeout(() => process.exit(0), LIMIT_MS);
		void Promise.allSettled([...s.tasks].map((run) => run())).finally(() => { clearTimeout(timer); process.exit(0); });
	};
	process.on("message", (raw: unknown) => {
		const message = raw as { channel?: unknown; op?: unknown } | null;
		if (typeof message?.channel === "string" && s.channels.has(message.channel) && message.op === "shutdown") stop();
	});
	process.once("disconnect", stop);
}
