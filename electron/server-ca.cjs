"use strict";

// Electron's Windows Node runtime can fail to open NODE_EXTRA_CA_CERTS when
// its path contains non-ASCII characters. Read that same explicitly configured
// bundle through Node's Unicode-aware filesystem API before the server starts.
// Keep the default roots and normal TLS certificate/hostname verification.
if (process.platform === "win32" && process.env.ELECTRON_RUN_AS_NODE === "1" && process.env.LH_DESKTOP_SERVER === "1" && process.env.NODE_EXTRA_CA_CERTS) {
	try {
		const fs = require("node:fs");
		const tls = require("node:tls");
		const pem = fs.readFileSync(process.env.NODE_EXTRA_CA_CERTS, "utf8");
		const certificates = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
		if (!certificates?.length) throw new Error("No certificates in configured CA bundle");
		tls.setDefaultCACertificates([...tls.getCACertificates("default"), ...certificates]);
	} catch {
		// Match Node's startup behavior: retain normal trust when a configured
		// extra bundle cannot be read or parsed, and leave a useful diagnostic.
		console.warn("LearnHarness could not load the configured extra CA certificates; default TLS verification remains enabled.");
	}
}
