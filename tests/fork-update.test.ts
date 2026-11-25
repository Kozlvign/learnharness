/** The fork's update button, main-process side (electron/fork-update.cjs):
 * real git against temporary repositories; the release script and the
 * installer are fakes, so nothing is built, published or installed. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

const require = createRequire(import.meta.url);
const { createForkUpdate, forkUpdateSource, parseCommits, startHidden, MAX_LISTED } = require("../electron/fork-update.cjs");

type State = {
	status: string; installed: { sha: string; date: string | null } | null; latest: { sha: string; date: string | null } | null;
	changes: { sha: string; date: string | null; subject: string }[]; changeCount: number;
	step: string | null; version: string | null; error: string | null; message: string | null; log: string | null; revision: number;
};

const temp = mkdtempSync(path.join(tmpdir(), "lh-fork-update-"));
after(() => rmSync(temp, { recursive: true, force: true }));
let counter = 0;
const fresh = (name: string) => { const dir = path.join(temp, `${name}-${++counter}`); mkdirSync(dir, { recursive: true }); return dir; };

const gitEnv = {
	...process.env,
	GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com",
	GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com",
	GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(temp, "no-global-gitconfig"),
};
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "core.autocrlf=false", ...args], { cwd, env: gitEnv, encoding: "utf8" }).trim();

/** A "GitHub" (bare), a clone to push from, and the build checkout. */
function repos() {
	const remote = fresh("remote");
	git(remote, "init", "--quiet", "--bare", "--initial-branch=main");
	const work = fresh("work");
	git(work, "init", "--quiet", "--initial-branch=main");
	git(work, "remote", "add", "origin", remote);
	const commit = (file: string, subject: string, content = subject) => {
		mkdirSync(path.dirname(path.join(work, file)), { recursive: true });
		writeFileSync(path.join(work, file), `${content}\n`);
		git(work, "add", "--", file);
		git(work, "commit", "--quiet", "-m", subject);
		return git(work, "rev-parse", "HEAD");
	};
	const push = (force = false) => git(work, "push", "--quiet", ...(force ? ["--force"] : []), "origin", "main");
	commit("scripts/fork/release-windows.ps1", "chore: release script", "# fake");
	const installed = commit("app.ts", "feat: first version");
	push();
	const checkout = fresh("checkout");
	git(checkout, "clone", "--quiet", remote, ".");
	return { remote, work, checkout, installed, commit, push };
}

function updater(checkout: string, installed: string, over: Record<string, unknown> = {}) {
	const states: State[] = [];
	const ticks: (() => void)[] = [];
	const spawned: { file: string; args: string[]; options: Record<string, unknown> }[] = [];
	const scripts: { powershell: string; args: string[]; cwd: string; env: Record<string, string> }[] = [];
	const logs: string[] = [];
	const stateDir = (over.stateDir as string) ?? fresh("state");
	const update = createForkUpdate({
		source: { commit: installed, checkout },
		stateDir,
		notify: (state: State) => states.push(state),
		log: (line: string) => logs.push(line),
		env: gitEnv,
		spawnProcess: (file: string, args: string[], options: Record<string, unknown>) => {
			spawned.push({ file, args, options });
			return { pid: 4343, on() {}, unref() {} };
		},
		startScript: async (call: { powershell: string; args: string[]; cwd: string; env: Record<string, string> }) => { scripts.push(call); return 4242; },
		isAlive: () => true,
		every: (callback: () => void) => { ticks.push(callback); return { unref() {} }; },
		stopEvery: () => { ticks.length = 0; },
		...over,
	});
	return {
		update, states, ticks, spawned, scripts, logs, stateDir,
		state: (): State => update.state(),
		tick: () => { for (const tick of [...ticks]) tick(); },
		file: (name: string) => path.join(stateDir, name),
	};
}

const writeJson = (file: string, value: unknown) => writeFileSync(file, JSON.stringify(value));

describe("which builds can update themselves", () => {
	const checkout = fresh("source");
	mkdirSync(path.join(checkout, ".git"));
	mkdirSync(path.join(checkout, "scripts", "fork"), { recursive: true });
	writeFileSync(path.join(checkout, "scripts", "fork", "release-windows.ps1"), "");
	const sha = "a".repeat(40);
	const pkg = (value: unknown) => { const file = path.join(fresh("pkg"), "package.json"); writeJson(file, value); return file; };

	it("reads the release script's metadata on Windows only", () => {
		const packageJsonPath = pkg({ lhForkCommit: sha.toUpperCase(), lhForkSource: checkout });
		assert.deepEqual(forkUpdateSource({ packageJsonPath, platform: "win32" }), { commit: sha, checkout });
		assert.equal(forkUpdateSource({ packageJsonPath, platform: "darwin" }), null);
		assert.equal(forkUpdateSource({ packageJsonPath, platform: "linux" }), null);
	});

	it("upstream and development builds (no metadata) have no button", () => {
		assert.equal(forkUpdateSource({ packageJsonPath: pkg({ version: "0.7.0" }), platform: "win32" }), null);
		assert.equal(forkUpdateSource({ packageJsonPath: path.join(temp, "missing.json"), platform: "win32" }), null);
	});

	it("rejects a malformed commit, a relative folder, and a folder without the checkout", () => {
		assert.equal(forkUpdateSource({ packageJsonPath: pkg({ lhForkCommit: "abc123", lhForkSource: checkout }), platform: "win32" }), null);
		assert.equal(forkUpdateSource({ packageJsonPath: pkg({ lhForkCommit: sha, lhForkSource: "relative/dir" }), platform: "win32" }), null);
		assert.equal(forkUpdateSource({ packageJsonPath: pkg({ lhForkCommit: sha, lhForkSource: fresh("empty") }), platform: "win32" }), null);
	});

	it("LH_FORK_COMMIT + LH_FORK_SOURCE stand in for the metadata (test seam)", () => {
		const env = { LH_FORK_COMMIT: sha, LH_FORK_SOURCE: checkout };
		assert.deepEqual(forkUpdateSource({ packageJsonPath: pkg({}), env, platform: "win32" }), { commit: sha, checkout });
		assert.equal(forkUpdateSource({ packageJsonPath: pkg({}), env: { LH_FORK_COMMIT: sha }, platform: "win32" }), null);
	});

	it("parses git log lines and skips anything else", () => {
		const line = `${sha}\x1f2026-11-25T10:00:00-03:00\x1ffeat: a | b`;
		assert.deepEqual(parseCommits(`${line}\nnoise\n\n`), [{ sha, date: "2026-11-25T10:00:00-03:00", subject: "feat: a | b" }]);
	});
});

describe("checking the fork's main", () => {
	it("is up to date when main is the installed commit", async () => {
		const r = repos();
		const u = updater(r.checkout, r.installed);
		assert.equal(u.state().status, "idle");
		const result = await u.update.check();
		assert.equal(result.status, "up-to-date");
		assert.equal(u.state().installed!.sha, r.installed);
		assert.ok(u.state().installed!.date, "the installed commit's date is known");
		assert.deepEqual(u.states.map(s => s.status), ["checking", "up-to-date"]);
		assert.ok(u.states[1]!.revision > u.states[0]!.revision);
	});

	it("lists what changes the app, newest first, without merges or the fork's scripts and docs", async () => {
		const r = repos();
		r.commit("scripts/fork/release-windows.ps1", "chore(fork): script only");
		const panel = r.commit("components/panel.tsx", "feat(chat): side panel");
		r.commit("docs/side-panel.md", "docs: side panel");
		r.commit("README.md", "docs: readme");
		const fix = r.commit("app.ts", "fix: keep the panel open", "v2");
		r.push();
		const u = updater(r.checkout, r.installed);
		const result = await u.update.check();
		assert.equal(result.status, "available");
		assert.equal(result.changeCount, 2);
		assert.deepEqual(result.changes.map((c: { sha: string; subject: string }) => [c.sha, c.subject]), [[fix, "fix: keep the panel open"], [panel, "feat(chat): side panel"]]);
		assert.equal(result.latest.sha, fix);
		assert.equal(result.installed.sha, r.installed);
	});

	it("only script and doc changes are not an update", async () => {
		const r = repos();
		r.commit("docs/a.md", "docs: a");
		r.commit("scripts/fork/auto-update.ps1", "chore: b");
		r.push();
		assert.equal((await updater(r.checkout, r.installed).update.check()).status, "up-to-date");
	});

	it("after a rebase onto upstream, lists only what the installed build lacks", async () => {
		const r = repos();
		const base = git(r.work, "rev-list", "--max-parents=0", "HEAD");
		// Upstream moved: a new commit below the fork's own, which is rewritten on top.
		git(r.work, "checkout", "--quiet", "-b", "upstream", base);
		r.commit("upstream.ts", "feat: upstream feature");
		git(r.work, "checkout", "--quiet", "main");
		git(r.work, "rebase", "--quiet", "upstream");
		const rewritten = git(r.work, "rev-parse", "HEAD");
		assert.notEqual(rewritten, r.installed);
		r.push(true);
		const result = await updater(r.checkout, r.installed).update.check();
		assert.equal(result.status, "available");
		assert.deepEqual(result.changes.map((c: { subject: string }) => c.subject), ["feat: upstream feature"]);
	});

	it("an installed commit the checkout no longer has is an update with no list", async () => {
		const r = repos();
		r.commit("app.ts", "fix: later", "v3");
		r.push();
		const result = await updater(r.checkout, "b".repeat(40)).update.check();
		assert.equal(result.status, "available");
		assert.equal(result.changeCount, 0);
		assert.deepEqual(result.changes, []);
	});

	it(`lists at most ${MAX_LISTED} changes and counts them all`, async () => {
		const r = repos();
		// One git process for all the commits (spawning git is slow on Windows).
		let stream = "";
		for (let i = 0; i <= MAX_LISTED; i++) {
			const message = `fix: change ${i}\n`, content = `v${i}\n`;
			stream += `commit refs/heads/main\nmark :${i + 1}\ncommitter Test <test@example.com> ${1_800_000_000 + i} +0000\n`
				+ `data ${message.length}\n${message}from ${i === 0 ? r.installed : `:${i}`}\nM 100644 inline app.ts\ndata ${content.length}\n${content}\n`;
		}
		execFileSync("git", ["fast-import", "--quiet"], { cwd: r.work, env: gitEnv, input: stream });
		r.push();
		const result = await updater(r.checkout, r.installed).update.check();
		assert.equal(result.changes.length, MAX_LISTED);
		assert.equal(result.changeCount, MAX_LISTED + 1);
		assert.equal(result.changes[0].subject, `fix: change ${MAX_LISTED}`);
	});

	it("an unreachable GitHub or a missing git is a failed check, not an exception", async () => {
		const r = repos();
		rmSync(r.remote, { recursive: true, force: true });
		const u = updater(r.checkout, r.installed);
		assert.equal((await u.update.check()).error, "fetch");
		assert.equal(u.state().status, "check-failed");
		const missing = updater(r.checkout, r.installed, { git: path.join(temp, "no-such-git") });
		assert.equal((await missing.update.check()).error, "git-missing");
	});

	it("concurrent checks share one run", async () => {
		const r = repos();
		const u = updater(r.checkout, r.installed);
		const [a, b] = await Promise.all([u.update.check(), u.update.check()]);
		assert.equal(a.status, "up-to-date");
		assert.deepEqual(a, b);
		assert.deepEqual(u.states.map(s => s.status), ["checking", "up-to-date"]);
	});
});

describe("updating", () => {
	async function available() {
		const r = repos();
		r.commit("app.ts", "feat: new", "v2");
		r.push();
		const u = updater(r.checkout, r.installed);
		await u.update.check();
		assert.equal(u.state().status, "available");
		return { r, u };
	}
	const installerIn = (dir: string) => { const file = path.join(dir, "LearnHarness-0.7.3-x64-setup.exe"); writeFileSync(file, ""); return file; };

	it("starts the release script detached, then follows its steps to a ready build", async () => {
		const { r, u } = await available();
		const started = await u.update.start();
		assert.equal(started.status, "building");
		assert.equal(u.scripts.length, 1);
		assert.equal(u.spawned.length, 0);
		const { powershell, args, cwd, env } = u.scripts[0]!;
		assert.match(powershell, /powershell\.exe$/i);
		assert.deepEqual(args.slice(0, 7), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File"]);
		assert.equal(args[7], path.join(r.checkout, "scripts", "fork", "release-windows.ps1"));
		assert.deepEqual(args.slice(8), ["-ForkOnly", "-ResultFile", u.file("result.json"), "-ProgressFile", u.file("progress.json")]);
		assert.equal(cwd, r.checkout);
		assert.ok(!Object.keys(env).some(key => /^ELECTRON_/i.test(key)), "Electron's switches stay out of the build");
		assert.equal(JSON.parse(readFileSync(u.file("run.json"), "utf8")).pid, 4242);

		writeJson(u.file("progress.json"), { step: "Building", log: "C:\\logs\\release.log" });
		u.tick();
		assert.equal(u.state().step, "Building");
		assert.equal(u.state().log, "C:\\logs\\release.log");

		const commit = git(r.checkout, "rev-parse", "origin/main");
		const installer = installerIn(fresh("dist"));
		writeJson(u.file("result.json"), { ok: true, built: true, version: "0.7.3", installer, commit, log: "C:\\logs\\release.log" });
		u.tick();
		assert.equal(u.state().status, "ready");
		assert.equal(u.state().version, "0.7.3");
		assert.equal(u.state().latest!.sha, commit);
		assert.equal(u.ticks.length, 0, "polling stopped");
		assert.ok(existsSync(u.file("result.json")), "the ready build survives a restart");
		assert.ok(!existsSync(u.file("run.json")));
		// A check would hide the ready build; it does nothing now.
		assert.equal((await u.update.check()).status, "ready");
	});

	it("does not start from a state without an update, nor twice", async () => {
		const r = repos();
		const u = updater(r.checkout, r.installed);
		assert.equal((await u.update.start()).status, "idle");
		await u.update.check();
		assert.equal((await u.update.start()).status, "up-to-date");
		assert.equal(u.scripts.length, 0);
		const { u: busy } = await available();
		const first = busy.update.start();
		assert.equal((await busy.update.start()).status, "building");
		await first;
		assert.equal(busy.scripts.length, 1);
	});

	it("a script that cannot start is a failure the panel can retry", async () => {
		const r = repos();
		r.commit("app.ts", "feat: x", "x"); r.push();
		const f = updater(r.checkout, r.installed, { startScript: async () => { throw new Error("blocked"); } });
		await f.update.check();
		assert.equal((await f.update.start()).status, "build-failed");
		assert.equal(f.state().error, "start");
		assert.ok(!existsSync(f.file("run.json")));
	});

	it("reports the script's own failure with its log, once", async () => {
		const { u } = await available();
		await u.update.start();
		writeJson(u.file("result.json"), { ok: false, built: false, message: "The working tree has uncommitted changes.", log: "C:\\logs\\r.log" });
		u.tick();
		assert.equal(u.state().status, "build-failed");
		assert.equal(u.state().error, "script");
		assert.equal(u.state().message, "The working tree has uncommitted changes.");
		assert.equal(u.state().log, "C:\\logs\\r.log");
		assert.ok(!existsSync(u.file("result.json")), "the failure is shown once");
		// Update again from the failure.
		assert.equal((await u.update.start()).status, "building");
	});

	it("a script that died without a result is an interrupted update", async () => {
		let alive = true;
		const r = repos();
		r.commit("app.ts", "feat: x", "x"); r.push();
		const u = updater(r.checkout, r.installed, { isAlive: () => alive });
		await u.update.check();
		await u.update.start();
		writeJson(u.file("progress.json"), { step: "Checking", log: "C:\\logs\\r.log" });
		alive = false;
		u.tick();
		assert.equal(u.state().status, "build-failed");
		assert.equal(u.state().error, "interrupted");
		assert.equal(u.state().log, "C:\\logs\\r.log");
	});

	it("nothing built (the app did not change since the last release) is up to date", async () => {
		const { u } = await available();
		await u.update.start();
		writeJson(u.file("result.json"), { ok: true, built: false, version: "0.7.2", installer: null, commit: null });
		u.tick();
		assert.equal(u.state().status, "up-to-date");
	});

	it("restart installs and reopens; quitting afterwards does not install twice", async () => {
		const { r, u } = await available();
		await u.update.start();
		const installer = installerIn(fresh("dist"));
		writeJson(u.file("result.json"), { ok: true, built: true, version: "0.7.3", installer, commit: git(r.checkout, "rev-parse", "origin/main") });
		u.tick();
		assert.equal(u.update.installNow(), true);
		assert.equal(u.spawned[0]!.file, installer);
		assert.deepEqual(u.spawned[0]!.args, ["--updated", "/S", "--force-run"]);
		assert.equal(u.spawned[0]!.options.detached, true);
		assert.equal(u.update.installOnQuit(), false);
		assert.equal(u.spawned.length, 1);
	});

	it("quitting with a ready build installs it without reopening", async () => {
		const { r, u } = await available();
		assert.equal(u.update.installOnQuit(), false, "nothing ready yet");
		await u.update.start();
		const installer = installerIn(fresh("dist"));
		writeJson(u.file("result.json"), { ok: true, built: true, version: "0.7.3", installer, commit: git(r.checkout, "rev-parse", "origin/main") });
		u.tick();
		assert.equal(u.update.installOnQuit(), true);
		assert.deepEqual(u.spawned[0]!.args, ["--updated", "/S"]);
	});

	it("a missing installer is a failure, not a quit", async () => {
		const { r, u } = await available();
		await u.update.start();
		const installer = installerIn(fresh("dist"));
		writeJson(u.file("result.json"), { ok: true, built: true, version: "0.7.3", installer, commit: git(r.checkout, "rev-parse", "origin/main") });
		u.tick();
		rmSync(installer);
		assert.equal(u.update.installNow(), false);
		assert.equal(u.state().status, "build-failed");
		assert.equal(u.state().error, "install");
	});
});

describe("starting the script on Windows", () => {
	it("runs it hidden, outside this process, and returns its process id", { skip: process.platform !== "win32" }, async () => {
		const dir = fresh("hidden");
		const out = path.join(dir, "out file.txt");
		const script = path.join(dir, "script.ps1");
		writeFileSync(script, 'param([string]$Out)\n"$PID" | Out-File -FilePath $Out -Encoding ascii\n');
		const powershell = path.join(process.env.SystemRoot ?? "C:\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
		const pid = await startHidden({ powershell, args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-Out", out], cwd: dir, env: process.env });
		let written = "";
		for (let i = 0; i < 150 && !written; i++) {
			await new Promise(resolve => setTimeout(resolve, 100));
			written = existsSync(out) ? readFileSync(out, "utf8").trim() : "";
		}
		assert.equal(written, String(pid), "the script ran, with an argument holding a space, as the returned process");
	});
});

describe("the next launch", () => {
	const sha = "c".repeat(40);
	const other = "d".repeat(40);
	const checkout = fresh("unused-checkout");

	it("offers a build that finished after the app closed", () => {
		const stateDir = fresh("state");
		const installer = path.join(fresh("dist"), "setup.exe"); writeFileSync(installer, "");
		writeJson(path.join(stateDir, "result.json"), { ok: true, built: true, version: "0.7.3", installer, commit: other });
		const u = updater(checkout, sha, { stateDir });
		assert.equal(u.state().status, "ready");
		assert.equal(u.state().version, "0.7.3");
	});

	it("forgets the build once it is the installed one", () => {
		const stateDir = fresh("state");
		writeJson(path.join(stateDir, "result.json"), { ok: true, built: true, version: "0.7.3", installer: "x", commit: sha.toUpperCase() });
		writeJson(path.join(stateDir, "progress.json"), { step: "Publishing" });
		const u = updater(checkout, sha, { stateDir });
		assert.equal(u.state().status, "idle");
		assert.ok(!existsSync(path.join(stateDir, "result.json")));
		assert.ok(!existsSync(path.join(stateDir, "progress.json")));
	});

	it("follows a build still running, and skips the automatic check", async () => {
		const stateDir = fresh("state");
		writeJson(path.join(stateDir, "run.json"), { pid: 99, started: new Date().toISOString(), from: sha });
		writeJson(path.join(stateDir, "progress.json"), { step: "Building", log: "C:\\l.log" });
		const u = updater(checkout, sha, { stateDir, isAlive: (pid: number) => pid === 99 });
		assert.equal(u.state().status, "building");
		assert.equal(u.state().step, "Building");
		assert.equal(u.ticks.length, 1, "polling");
		assert.equal((await u.update.check()).status, "building");
	});

	it("a recorded run that is gone or too old was interrupted, and that is shown", async () => {
		for (const [run, alive] of [
			// The process is gone.
			[{ pid: 99, started: new Date().toISOString() }, false],
			// Its id is in use, but by now a build would have finished long ago.
			[{ pid: 99, started: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString() }, true],
		] as const) {
			const stateDir = fresh("state");
			writeJson(path.join(stateDir, "run.json"), run);
			const u = updater(checkout, sha, { stateDir, isAlive: () => alive });
			assert.equal(u.state().status, "build-failed");
			assert.equal(u.state().error, "interrupted");
			assert.equal((await u.update.check()).status, "build-failed", "the automatic check does not hide it");
		}
	});

	it("shows a failure from the last launch once", () => {
		const stateDir = fresh("state");
		writeJson(path.join(stateDir, "result.json"), { ok: false, message: "boom", log: "C:\\r.log" });
		const u = updater(checkout, sha, { stateDir });
		assert.equal(u.state().status, "build-failed");
		assert.equal(u.state().message, "boom");
		assert.ok(!existsSync(path.join(stateDir, "result.json")));
	});

	it("unreadable state files are ignored", () => {
		const stateDir = fresh("state");
		writeFileSync(path.join(stateDir, "result.json"), "{not json");
		assert.equal(updater(checkout, sha, { stateDir }).state().status, "idle");
	});
});
