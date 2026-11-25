/**
 * Fork (update button, docs/claude.md): keeps the installed fork app in step
 * with the fork's main, the way BookApp's update button does.
 *
 * - scripts/fork/release-windows.ps1 records in the packaged package.json the
 *   commit a build was made from (lhForkCommit) and the checkout it was built
 *   in (lhForkSource). Builds without them (upstream, dev, CI) have no button.
 *   LH_FORK_COMMIT + LH_FORK_SOURCE stand in for them (a test seam to try the
 *   button from a development shell).
 * - Checking fetches origin/main in that checkout and lists the commits the
 *   installed build lacks. Only commits that change the app count: the fork's
 *   scripts, docs and README are left out, as the release script does. Patch-
 *   equivalent commits are left out too, so rebasing the fork onto upstream
 *   does not list again what is already installed. Checking never builds.
 * - Updating starts `release-windows.ps1 -ForkOnly` in that checkout, outside
 *   this process, so it keeps running when the app closes. The script reports its
 *   step and its outcome in files under the state folder: a later launch
 *   picks up a build in progress, a finished build or a failure.
 * - A finished build installs when the app quits, or at once on a restart
 *   (the installer's --force-run opens the new version).
 *
 * Nothing here can stop the app: every failure becomes a status.
 */
"use strict";

const { execFile, spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const MAX_LISTED = 30;
const FETCH_TIMEOUT_MS = 90_000;
const GIT_TIMEOUT_MS = 30_000;
const POLL_MS = 2_000;
// A build takes about 7 minutes. An older recorded run is treated as gone,
// even if its process id now belongs to another program.
const RUN_STALE_MS = 2 * 60 * 60 * 1000;
// The release script's rule for what changes the app.
const APP_PATHS = [".", ":(exclude)scripts/fork", ":(exclude)docs", ":(exclude)README.md"];
const FIELD = "\x1f";
const COMMIT_FORMAT = `--format=%H${FIELD}%cI${FIELD}%s`;
const SHA = /^[0-9a-f]{40}$/i;
// From these a check may run; otherwise the panel shows a build or its outcome.
const CHECKABLE = new Set(["idle", "up-to-date", "check-failed", "available"]);
const STARTABLE = new Set(["available", "build-failed"]);

/** Where this build came from, or null when it cannot update itself. */
function forkUpdateSource({ packageJsonPath, env = {}, platform, exists = fs.existsSync, readFile = fs.readFileSync }) {
	if (platform !== "win32") return null;
	let commit = env.LH_FORK_COMMIT;
	let checkout = env.LH_FORK_SOURCE;
	if (!commit || !checkout) {
		try {
			const pkg = JSON.parse(readFile(packageJsonPath, "utf8"));
			commit = pkg?.lhForkCommit;
			checkout = pkg?.lhForkSource;
		} catch {
			return null;
		}
	}
	if (typeof commit !== "string" || !SHA.test(commit) || typeof checkout !== "string" || !path.isAbsolute(checkout)) return null;
	if (!exists(path.join(checkout, ".git")) || !exists(path.join(checkout, "scripts", "fork", "release-windows.ps1"))) return null;
	return { commit: commit.toLowerCase(), checkout };
}

/** `git log` lines in COMMIT_FORMAT → { sha, date, subject }. */
function parseCommits(text) {
	const commits = [];
	for (const line of String(text).split("\n")) {
		const fields = line.trim().split(FIELD);
		if (fields.length !== 3 || !SHA.test(fields[0])) continue;
		commits.push({ sha: fields[0].toLowerCase(), date: fields[1] || null, subject: fields[2] });
	}
	return commits;
}

/** The environment for git and the release script, without Electron's own switches. */
function childEnv(env) {
	const out = {};
	for (const [key, value] of Object.entries(env)) {
		if (typeof value === "string" && !/^ELECTRON_/i.test(key)) out[key] = value;
	}
	return out;
}

/** Starts the release script outside this process and resolves its process
 * id. Not a detached spawn: a PowerShell started detached has no console and
 * exits without running anything. Not a plain child either: it would die with
 * the app. Start-Process gives the script its own hidden console, which its
 * git, npm and node children share, so no window opens. The values travel in
 * environment variables, so no quoting reaches -Command. */
function startHidden({ powershell, args, cwd, env }) {
	const command = "$p = Start-Process -FilePath $env:LH_RELEASE_FILE -ArgumentList $env:LH_RELEASE_ARGS -WorkingDirectory $env:LH_RELEASE_CWD -WindowStyle Hidden -PassThru; [Console]::Out.Write($p.Id)";
	return new Promise((resolve, reject) => {
		execFile(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command], {
			windowsHide: true,
			timeout: 30_000,
			// Paths never contain quotes or end in a backslash here.
			env: { ...env, LH_RELEASE_FILE: powershell, LH_RELEASE_ARGS: args.map((arg) => `"${arg}"`).join(" "), LH_RELEASE_CWD: cwd },
		}, (error, stdout, stderr) => {
			const pid = Number.parseInt(String(stdout).trim(), 10);
			if (!error && Number.isInteger(pid) && pid > 0) return resolve(pid);
			reject(error ?? new Error(`no process id (${String(stderr).trim() || String(stdout).trim()})`));
		});
	});
}

function processAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error?.code === "EPERM";
	}
}

function readJson(file) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
	} catch {
		return null;
	}
}

function remove(file) {
	try {
		fs.rmSync(file, { force: true });
	} catch {
		/* the next launch tries again */
	}
}

/** Why a git call failed, as a code the panel turns into a sentence. */
function gitError(error, fetching) {
	if (error?.code === "ENOENT") return "git-missing";
	if (error?.killed || error?.signal) return "timeout";
	return fetching ? "fetch" : "git";
}

function createForkUpdate({
	source,
	stateDir,
	notify = () => {},
	log = () => {},
	git = "git",
	env = process.env,
	spawnProcess = spawn,
	startScript = startHidden,
	isAlive = processAlive,
	now = Date.now,
	every = setInterval,
	stopEvery = clearInterval,
}) {
	const files = {
		run: path.join(stateDir, "run.json"),
		progress: path.join(stateDir, "progress.json"),
		result: path.join(stateDir, "result.json"),
	};
	let state = {
		status: "idle",
		installed: { sha: source.commit, date: null },
		latest: null,
		changes: [],
		changeCount: 0,
		step: null,
		version: null,
		error: null,
		message: null,
		log: null,
		revision: 0,
	};
	let checking = null;
	let poll = null;
	let installer = null;
	let installing = false;

	const snapshot = () => JSON.parse(JSON.stringify(state));

	function set(next) {
		state = { ...state, ...next, revision: state.revision + 1 };
		try {
			notify(snapshot());
		} catch {
			/* a window mid-teardown; the snapshot covers a later load */
		}
	}

	function runGit(args, timeout) {
		return new Promise((resolve, reject) => {
			execFile(git, ["-c", "credential.interactive=false", ...args], {
				cwd: source.checkout,
				timeout,
				windowsHide: true,
				maxBuffer: 4 * 1024 * 1024,
				// A sign-in window must never open from a background check.
				env: { ...childEnv(env), GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
			}, (error, stdout, stderr) => {
				if (error) {
					error.detail = String(stderr ?? "").trim();
					reject(error);
				} else resolve(String(stdout));
			});
		});
	}

	async function readCommit(revision) {
		try {
			return parseCommits(await runGit(["log", "-1", COMMIT_FORMAT, revision, "--"], GIT_TIMEOUT_MS))[0] ?? null;
		} catch {
			return null;
		}
	}

	async function compare() {
		try {
			await runGit(["fetch", "--quiet", "--no-tags", "origin", "main"], FETCH_TIMEOUT_MS);
		} catch (error) {
			log(`fork update: fetch failed: ${error?.detail || error?.message || error}`);
			return set({ status: "check-failed", error: gitError(error, true) });
		}
		const latest = await readCommit("origin/main");
		if (!latest) return set({ status: "check-failed", error: "git" });
		const installed = await readCommit(source.commit);
		const base = { latest, installed: installed ?? { sha: source.commit, date: null }, error: null, message: null };
		if (latest.sha === source.commit) return set({ ...base, status: "up-to-date", changes: [], changeCount: 0 });
		// The checkout no longer has the installed commit: only the difference is known.
		if (!installed) return set({ ...base, status: "available", changes: [], changeCount: 0 });
		let changes;
		try {
			changes = parseCommits(await runGit(
				["log", "--no-merges", "--cherry-pick", "--right-only", COMMIT_FORMAT, `${source.commit}...origin/main`, "--", ...APP_PATHS],
				GIT_TIMEOUT_MS,
			));
		} catch (error) {
			log(`fork update: comparing failed: ${error?.detail || error?.message || error}`);
			return set({ status: "check-failed", error: gitError(error, false) });
		}
		if (changes.length === 0) return set({ ...base, status: "up-to-date", changes: [], changeCount: 0 });
		set({ ...base, status: "available", changes: changes.slice(0, MAX_LISTED), changeCount: changes.length });
	}

	/** Compares the installed commit with the fork's main. Never builds. */
	function check() {
		if (checking) return checking;
		if (!CHECKABLE.has(state.status)) return Promise.resolve(snapshot());
		set({ status: "checking", error: null, message: null, log: null });
		checking = compare()
			.catch((error) => {
				log(`fork update: check failed: ${error?.message ?? error}`);
				set({ status: "check-failed", error: "git" });
			})
			.then(() => {
				checking = null;
				return snapshot();
			});
		return checking;
	}

	function runAlive(run) {
		const started = Date.parse(run?.started ?? "");
		return Number.isInteger(run?.pid) && Number.isFinite(started) && now() - started < RUN_STALE_MS && isAlive(run.pid);
	}

	function stopWatching() {
		if (poll) stopEvery(poll);
		poll = null;
	}

	/** A build ended: ready to install, nothing to install, or failed. */
	function finish(result, progress) {
		stopWatching();
		remove(files.run);
		remove(files.progress);
		if (!result) {
			log("fork update: the build stopped before it finished");
			return set({ status: "build-failed", step: null, error: "interrupted", message: null, log: progress?.log ?? null });
		}
		if (!result.ok) {
			remove(files.result);
			log(`fork update: the build failed: ${result.message ?? "no message"}`);
			return set({ status: "build-failed", step: null, error: "script", message: result.message ?? null, log: result.log ?? null });
		}
		const commit = typeof result.commit === "string" ? result.commit.toLowerCase() : null;
		if (!result.built || !commit || commit === source.commit || typeof result.installer !== "string" || !fs.existsSync(result.installer)) {
			// The script found nothing that changes the app since its last release.
			remove(files.result);
			return set({ status: "up-to-date", step: null, error: null, message: null, log: null, changes: [], changeCount: 0 });
		}
		installer = result.installer;
		log(`fork update: version ${result.version} (${commit.slice(0, 7)}) is ready`);
		set({ status: "ready", step: null, error: null, message: null, log: result.log ?? null, version: result.version ?? null, latest: { sha: commit, date: null } });
	}

	function refresh() {
		const result = readJson(files.result);
		if (result) return finish(result, null);
		const progress = readJson(files.progress);
		if (!runAlive(readJson(files.run))) return finish(readJson(files.result), progress);
		if (progress?.step && (progress.step !== state.step || (progress.log ?? null) !== state.log)) {
			set({ step: progress.step, log: progress.log ?? null });
		}
	}

	function watch() {
		if (poll) return;
		poll = every(() => {
			try {
				refresh();
			} catch (error) {
				log(`fork update: reading the build's progress failed: ${error?.message ?? error}`);
			}
		}, POLL_MS);
		poll?.unref?.();
	}

	/** Starts the release script; it outlives the app. */
	async function start() {
		if (!STARTABLE.has(state.status)) return snapshot();
		// Building at once, so a second click does not start a second run.
		set({ status: "building", step: null, error: null, message: null, log: null, version: null });
		try {
			fs.mkdirSync(stateDir, { recursive: true });
			for (const file of Object.values(files)) remove(file);
			const powershell = path.join(env.SystemRoot || env.SYSTEMROOT || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
			const pid = await startScript({
				powershell,
				args: [
					"-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden",
					"-File", path.join(source.checkout, "scripts", "fork", "release-windows.ps1"),
					"-ForkOnly", "-ResultFile", files.result, "-ProgressFile", files.progress,
				],
				cwd: source.checkout,
				env: childEnv(env),
			});
			fs.writeFileSync(files.run, JSON.stringify({ pid, started: new Date(now()).toISOString(), from: source.commit }));
			log(`fork update: release script started (pid ${pid})`);
			watch();
		} catch (error) {
			log(`fork update: the release script failed to start: ${error?.message ?? error}`);
			set({ status: "build-failed", step: null, error: "start", message: null, log: null });
		}
		return snapshot();
	}

	function launchInstaller(args) {
		if (state.status !== "ready" || !installer || installing) return false;
		try {
			if (!fs.existsSync(installer)) throw new Error(`${installer} is missing`);
			const child = spawnProcess(installer, args, { cwd: path.dirname(installer), detached: true, stdio: "ignore", env: childEnv(env) });
			child.on?.("error", (error) => log(`fork update: the installer failed to start: ${error?.message ?? error}`));
			if (!child.pid) throw new Error("no process id");
			child.unref?.();
			installing = true;
			log(`fork update: installing version ${state.version}`);
			return true;
		} catch (error) {
			log(`fork update: the installer failed to start: ${error?.message ?? error}`);
			remove(files.result);
			installer = null;
			set({ status: "build-failed", error: "install", message: null });
			return false;
		}
	}

	/** Restart now: the installer replaces the app and opens the new version. */
	const installNow = () => launchInstaller(["--updated", "/S", "--force-run"]);
	/** On quit: install without opening the app again. */
	const installOnQuit = () => launchInstaller(["--updated", "/S"]);

	// A previous launch may have left a build running, finished or failed.
	try {
		const result = readJson(files.result);
		const run = readJson(files.run);
		if (result?.ok && typeof result.commit === "string" && result.commit.toLowerCase() === source.commit) {
			// That build is the one running now.
			for (const file of Object.values(files)) remove(file);
		} else if (result) {
			finish(result, null);
		} else if (run) {
			if (runAlive(run)) {
				set({ status: "building", step: readJson(files.progress)?.step ?? null, log: readJson(files.progress)?.log ?? null });
				watch();
			} else finish(null, readJson(files.progress));
		}
	} catch (error) {
		log(`fork update: reading the last build failed: ${error?.message ?? error}`);
	}

	return { state: snapshot, check, start, installNow, installOnQuit, dispose: stopWatching };
}

module.exports = { createForkUpdate, forkUpdateSource, parseCommits, startHidden, MAX_LISTED };
