/**
 * Fork (local dictation, docs/dictation.md): checks that the packaged
 * server loads sherpa-onnx-node from its own folder with Electron's Node,
 * inside a worker thread, the way src/server/dictation/engine.ts does.
 * Run after scripts/build-server.mjs. The repo's own node_modules sits
 * above .next/standalone, so the check also makes sure the module did not
 * resolve from there.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const STANDALONE = path.join(ROOT, ".next", "standalone");
const ELECTRON = createRequire(import.meta.url)("electron");

const platform = `${os.platform() === "win32" ? "win" : os.platform()}-${os.arch()}`;
const binding = path.join(STANDALONE, "node_modules", `sherpa-onnx-${platform}`, "sherpa-onnx.node");
if (!existsSync(binding)) {
	console.error(`[dictation-runtime] missing from the server payload: ${path.relative(ROOT, binding)}`);
	process.exit(1);
}

const probe = String.raw`
const { Worker } = require("node:worker_threads");
const path = require("node:path");
const source = 'const { parentPort, workerData } = require("node:worker_threads");'
	+ 'const load = require("node:module").createRequire(workerData);'
	+ 'const sherpa = load("sherpa-onnx-node");'
	+ 'parentPort.postMessage({ resolved: load.resolve("sherpa-onnx-node"), api: typeof sherpa.OfflineRecognizer + "/" + typeof sherpa.Vad });';
const worker = new Worker(source, { eval: true, workerData: path.join(process.cwd(), "package.json") });
worker.on("message", (message) => { console.log(JSON.stringify(message)); process.exit(0); });
worker.on("error", (error) => { console.error(String((error && error.stack) || error)); process.exit(1); });
`;

const result = spawnSync(ELECTRON, ["-e", probe], {
	cwd: STANDALONE,
	env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
	encoding: "utf8",
	timeout: 60_000,
});
if (result.status !== 0) {
	console.error("[dictation-runtime] the packaged server could not load sherpa-onnx-node with Electron's Node:");
	console.error(result.stderr || result.error || `exit ${result.status}`);
	process.exit(1);
}
const report = JSON.parse(result.stdout.trim().split("\n").pop());
if (report.api !== "function/function") {
	console.error(`[dictation-runtime] unexpected sherpa-onnx-node API: ${report.api}`);
	process.exit(1);
}
if (!path.resolve(report.resolved).startsWith(STANDALONE + path.sep)) {
	console.error(`[dictation-runtime] sherpa-onnx-node resolved outside the server payload: ${report.resolved}`);
	process.exit(1);
}
console.log(`[dictation-runtime] ok: ${path.relative(ROOT, report.resolved)} (${platform})`);
