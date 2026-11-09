import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { rootCertificates } from "node:tls";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../electron/server-ca.cjs", import.meta.url), "utf8");
const backend = { ELECTRON_RUN_AS_NODE: "1", LH_DESKTOP_SERVER: "1" };

function load(platform: string, env: Record<string, string>) {
	const defaults = [rootCertificates[0]!];
	let trusted = defaults;
	const warnings: string[] = [];
	runInNewContext(source, {
		process: { platform, env },
		console: { warn: (message: string) => warnings.push(message) },
		require: (id: string) => {
			if (id === "node:fs") return { readFileSync };
			assert.equal(id, "node:tls");
			return {
				getCACertificates: (type: string) => { assert.equal(type, "default"); return defaults; },
				setDefaultCACertificates: (certificates: string[]) => {
					for (const pem of certificates) new X509Certificate(pem);
					trusted = Array.from(certificates);
				},
			};
		},
	});
	return { defaults, trusted, warnings };
}

test("Windows backend loads configured certificates from a Unicode path and preserves default trust", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "lh-ca-Usuário-"));
	try {
		const file = path.join(dir, "certificados extras.pem");
		writeFileSync(file, `# configured bundle\n${rootCertificates[1]}\n${rootCertificates[2]}\n`);
		const result = load("win32", { ...backend, NODE_EXTRA_CA_CERTS: file });
		assert.deepEqual(result.trusted, [...result.defaults, rootCertificates[1], rootCertificates[2]]);
		assert.deepEqual(result.warnings, []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("missing or malformed extra CA bundles retain default trust", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "lh-ca-invalid-"));
	try {
		for (const contents of [null, "empty bundle", "-----BEGIN CERTIFICATE-----\ninvalid\n-----END CERTIFICATE-----"]) {
			const file = path.join(dir, contents === null ? "missing.pem" : "invalid.pem");
			if (contents !== null) writeFileSync(file, contents);
			const result = load("win32", { ...backend, NODE_EXTRA_CA_CERTS: file });
			assert.deepEqual(result.trusted, result.defaults);
			assert.equal(result.warnings.length, 1);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("CA recovery only applies to the Windows desktop backend with an explicitly configured bundle", () => {
	for (const [platform, env] of [
		["darwin", { ...backend, NODE_EXTRA_CA_CERTS: "missing.pem" }],
		["linux", { ...backend, NODE_EXTRA_CA_CERTS: "missing.pem" }],
		["win32", { NODE_EXTRA_CA_CERTS: "missing.pem" }],
		["win32", { LH_DESKTOP_SERVER: "1", NODE_EXTRA_CA_CERTS: "missing.pem" }],
		["win32", { ELECTRON_RUN_AS_NODE: "1", NODE_EXTRA_CA_CERTS: "missing.pem" }],
		["win32", backend],
	] as [string, Record<string, string>][]) {
		const result = load(platform, env);
		assert.deepEqual(result.trusted, result.defaults);
		assert.deepEqual(result.warnings, []);
	}
});
