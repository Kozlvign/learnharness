"use strict";

// Use Windows' configured trust store, like the Electron network stack, while
// preserving Node's defaults and normal certificate/hostname verification.
// A desktop shortcut need not inherit the terminal's NODE_EXTRA_CA_CERTS.
if (process.platform === "win32" && process.env.ELECTRON_RUN_AS_NODE === "1" && process.env.LH_DESKTOP_SERVER === "1") {
	const tls = require("node:tls");
	try {
		tls.setDefaultCACertificates([...tls.getCACertificates("default"), ...tls.getCACertificates("system")]);
	} catch {
		console.warn("LearnHarness could not load Windows CA certificates; default TLS verification remains enabled.");
	}
	// Electron's Node runtime can fail to open extra CA paths containing
	// non-ASCII characters. Node's filesystem API reads the same bundle safely.
	if (process.env.NODE_EXTRA_CA_CERTS) {
		try {
			const fs = require("node:fs");
			const pem = fs.readFileSync(process.env.NODE_EXTRA_CA_CERTS, "utf8");
			const certificates = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
			if (!certificates?.length) throw new Error("No certificates in configured CA bundle");
			tls.setDefaultCACertificates([...tls.getCACertificates("default"), ...certificates]);
		} catch {
			console.warn("LearnHarness could not load the configured extra CA certificates; default TLS verification remains enabled.");
		}
	}
}
