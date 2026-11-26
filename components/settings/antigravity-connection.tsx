"use client";
/** The Antigravity connection (fork feature): Google models (and the partner
 * models the plan includes) run through Google's official Antigravity CLI,
 * signed in with the learner's Google account in a profile only LearnHarness uses. */
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { ANTIGRAVITY_INSTALL_URL, ANTIGRAVITY_LABEL, ANTIGRAVITY_MINIMUM_VERSION, ANTIGRAVITY_PROVIDER, type AntigravityStatus } from "@/src/core";
import { Button } from "@/components/ui/button";
import { useNotifyHub } from "@/components/server-events";
import type { CloseOutcome } from "@/components/interaction-layers";
import { notifySettingsSaved } from "@/components/settings-signal";
import { ConnectionDialog, ConnectionFooter, ConnectionRow } from "./connection-controls";
import { Toggle } from "./controls";

export const ANTIGRAVITY_NOTICE = "LearnHarness runs these models through the Antigravity CLI, Google's official app, on this computer. It signs in with your Google account in a profile only LearnHarness uses and keeps your credentials there; LearnHarness never reads or stores them. Your prompts, tool results, and relevant session context go to Google through Antigravity, and use counts toward your Google plan's limits. This connection never falls back to an API key.";
export const ANTIGRAVITY_BACKGROUND_HINT = "Allow LearnHarness helper agents and automatic follow-ups to use your Google plan.";
const PATH = "/api/antigravity";
const HEADERS = { "Content-Type": "application/json", "x-learnharness-antigravity": "1" };
const CONTROL_ERROR = "The Antigravity connection could not be changed. Try again.";
const POLL_MS = 1500;

const EMPTY: AntigravityStatus = {
	state: "checking", connected: false, version: null, executable: null, source: null, account: null, models: [], allowBackgroundUse: true,
	managed: { supported: true, installed: null, latest: null }, install: null, login: null, checkedAt: null, revision: 0,
};

async function request(method: "GET" | "POST", body?: Record<string, unknown>, refresh = false): Promise<AntigravityStatus> {
	const response = await fetch(refresh ? `${PATH}?refresh=1` : PATH, { method, headers: HEADERS, cache: "no-store", ...(body ? { body: JSON.stringify(body) } : {}) });
	const value = await response.json().catch(() => null) as AntigravityStatus | { error?: string } | null;
	if (!response.ok || !value || !("state" in value)) throw new Error(value && "error" in value && value.error ? value.error : CONTROL_ERROR);
	return value;
}

const Context = createContext({ status: EMPTY, busy: false, open: () => {} });

const installing = (status: AntigravityStatus) => status.install !== null && ["downloading", "verifying", "installing"].includes(status.install.phase);
const signingIn = (status: AntigravityStatus) => status.login !== null && ["starting", "waiting", "verifying"].includes(status.login.phase);
function newer(candidate: string, current: string): boolean {
	const a = candidate.split(".").map(Number), b = current.split(".").map(Number);
	for (let index = 0; index < 3; index++) if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) > (b[index] ?? 0);
	return false;
}
const updateAvailable = (status: AntigravityStatus) => status.source === "managed" && !!status.managed.latest && !!status.managed.installed && newer(status.managed.latest, status.managed.installed);

function summary(status: AntigravityStatus): string {
	if (installing(status)) return "Installing…";
	if (signingIn(status)) return "Waiting for sign-in…";
	switch (status.state) {
		case "checking": return "Checking…";
		case "missing": return "Antigravity not installed";
		case "outdated": return "Update needed";
		case "signed-out": return "Not signed in";
		case "error": return "Unavailable";
		case "connected": return [status.account?.plan, status.account?.email].filter(Boolean).join(" · ") || "Connected";
	}
}

function megabytes(bytes: number): string { return `${Math.round(bytes / (1024 * 1024))} MB`; }

function InstallProgress({ status }: { status: AntigravityStatus }) {
	const install = status.install!;
	const percent = install.totalBytes ? Math.min(100, Math.round((install.downloadedBytes / install.totalBytes) * 100)) : null;
	return <div className="space-y-1.5" data-testid="antigravity-install-progress">
		<p role="status">{install.phase === "downloading"
			? `Downloading Antigravity${install.version ? ` ${install.version}` : ""}…${percent !== null ? ` ${percent}%` : install.downloadedBytes ? ` ${megabytes(install.downloadedBytes)}` : ""}`
			: install.phase === "verifying" ? "Checking the download against Google's checksum…" : "Installing…"}</p>
		{percent !== null && <div className="h-1 w-full overflow-hidden rounded-full bg-muted"><div className="h-full bg-foreground/60" style={{ width: `${percent}%` }} /></div>}
	</div>;
}

export function AntigravityUIProvider({ children }: { children: React.ReactNode }) {
	const hub = useNotifyHub();
	const [status, setStatus] = useState<AntigravityStatus>(EMPTY);
	const [dialog, setDialog] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [code, setCode] = useState("");
	const [confirmRemove, setConfirmRemove] = useState(false);
	const mounted = useRef(false), revision = useRef(-1), connected = useRef(false);
	const accept = useCallback((next: AntigravityStatus) => {
		if (!mounted.current || next.revision < revision.current) return;
		const changed = next.connected !== connected.current;
		revision.current = next.revision;
		connected.current = next.connected;
		setStatus(next);
		if (changed) notifySettingsSaved("keys");
	}, []);
	const refresh = useCallback(async (force = false) => {
		try { accept(await request("GET", undefined, force)); } catch { /* the row shows the last known state */ }
	}, [accept]);
	useEffect(() => {
		mounted.current = true;
		void refresh();
		const off = hub?.subscribe("subscriptions-changed", () => { void refresh(); });
		const offResync = hub?.onResync(() => { void refresh(); });
		return () => { mounted.current = false; off?.(); offResync?.(); };
	}, [hub, refresh]);
	// Downloads and sign-in move on their own; follow them while the dialog is open.
	const active = dialog && (installing(status) || signingIn(status));
	useEffect(() => {
		if (!active) return;
		const timer = setInterval(() => { void refresh(); }, POLL_MS);
		return () => clearInterval(timer);
	}, [active, refresh]);
	async function control(body: Record<string, unknown>): Promise<boolean> {
		if (busy) return false;
		setBusy(true); setError(null);
		try { accept(await request("POST", body)); return true; }
		catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : CONTROL_ERROR); return false; }
		finally { if (mounted.current) setBusy(false); }
	}
	const open = () => { setError(null); setCode(""); setConfirmRemove(false); setDialog(true); void refresh(true); };
	// A sign-in in progress survives closing the dialog; reopening shows it again.
	const close = (): CloseOutcome => {
		if (busy) return "blocked";
		setDialog(false);
		return "closed";
	};
	const submitCode = async () => { if (code.trim() && await control({ op: "login-submit", code: code.trim() })) setCode(""); };
	const account = status.account;
	const login = status.login;
	const installFailed = status.install && (status.install.phase === "failed" || status.install.phase === "cancelled") ? status.install.message : null;
	const loginFailed = login && (login.phase === "failed" || login.phase === "cancelled") ? login.message : null;
	return <Context.Provider value={{ status, busy, open }}>
		{children}
		{dialog && <ConnectionDialog label={`${ANTIGRAVITY_LABEL} connection`} testid="antigravity-dialog" backdropTestid="antigravity-dialog-backdrop" busy={busy} onClose={close}>
			<h2 className="text-sm font-semibold text-foreground">{ANTIGRAVITY_LABEL} <span className="font-normal text-muted-foreground">via the Antigravity CLI</span></h2>
			<p className="mt-3 text-xs leading-relaxed text-muted-foreground" data-testid="antigravity-notice">{ANTIGRAVITY_NOTICE}</p>
			<div className="mt-4 space-y-2 text-xs text-foreground" data-testid="antigravity-state">
				{installing(status) ? <InstallProgress status={status} /> : signingIn(status) ? <div className="space-y-2" data-testid="antigravity-login">
					{login!.phase === "starting" && <p role="status" className="text-muted-foreground">Starting Google sign-in…</p>}
					{login!.phase === "waiting" && login!.url && <>
						<p>1. Open Google's sign-in page and sign in with your Google account.</p>
						<a className="inline-block rounded-sm border border-border px-2 py-1 underline-offset-2 hover:underline" href={login!.url} target="_blank" rel="noreferrer" data-testid="antigravity-login-link">Open Google sign-in</a>
						<p>2. Paste the code Google's page shows, or that page's full address:</p>
						<div className="flex gap-2">
							<input type="text" value={code} aria-label="Code from Google's page" data-testid="antigravity-login-code" autoComplete="off" spellCheck={false}
								onChange={(event) => { setCode(event.target.value); setError(null); }}
								onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void submitCode(); } }}
								className="min-w-0 flex-1 rounded-sm border border-border bg-background px-2 py-1 font-mono text-xs" />
							<Button variant="outline" size="sm" disabled={busy || !code.trim()} onClick={() => void submitCode()}>Submit</Button>
						</div>
					</>}
					{login!.phase === "verifying" && <p role="status" className="text-muted-foreground">Finishing sign-in and loading your models…</p>}
				</div> : <>
					{status.state === "checking" && <p role="status" className="text-muted-foreground">Checking Antigravity…</p>}
					{status.state === "missing" && (status.managed.supported ? <>
						<p>The Antigravity CLI is not installed on this computer. LearnHarness can download Google's official runtime (about 250 MB) into its own folder.</p>
						<p className="text-muted-foreground">To use a copy you installed yourself, set LH_ANTIGRAVITY_PATH to its executable and select Check again.</p>
					</> : <>
						<p>Google does not publish an Antigravity runtime for this computer.</p>
						<p className="text-muted-foreground">Instructions: <a className="underline underline-offset-2" href={ANTIGRAVITY_INSTALL_URL} target="_blank" rel="noreferrer">{ANTIGRAVITY_INSTALL_URL}</a></p>
					</>)}
					{status.state === "outdated" && <p>{`Antigravity ${status.version ?? ""} is too old for LearnHarness (${ANTIGRAVITY_MINIMUM_VERSION} or newer is needed).`}{status.source === "managed" || status.managed.supported ? "" : " Update it, then select Check again."}</p>}
					{status.state === "signed-out" && <p>{`Antigravity ${status.version ?? ""} is installed but not signed in. Sign in with your Google account to use your plan here.`}</p>}
					{status.state === "error" && <p role="alert" className="text-error">{status.error}</p>}
					{status.state === "connected" && <>
						<p>Signed in{account?.email ? <> as <span className="select-text">{account.email}</span></> : null}{account?.plan ? ` · ${account.plan}` : ""}</p>
						<p className="text-muted-foreground">Antigravity {status.version} · {status.models.length} models</p>
						{status.models.length > 0 && <p className="leading-relaxed text-muted-foreground" data-testid="antigravity-models">{status.models.map((model) => model.name).join(", ")}</p>}
						<div className="mt-3 flex items-center gap-3">
							<Toggle label="Allow background use" checked={status.allowBackgroundUse} disabled={busy} onChange={(enabled) => void control({ op: "consent", enabled })} />
							<span>Allow background use<span className="mt-1 block leading-relaxed text-muted-foreground">{ANTIGRAVITY_BACKGROUND_HINT}</span></span>
						</div>
					</>}
					{updateAvailable(status) && <div className="flex flex-wrap items-center gap-2" data-testid="antigravity-update">
						<span>{`Antigravity ${status.managed.latest} is available.`}</span>
						<Button variant="outline" size="xs" disabled={busy} onClick={() => void control({ op: "install" })}>Update</Button>
					</div>}
					{status.source === "managed" && status.state !== "checking" && <div className="flex flex-wrap items-center gap-2 text-muted-foreground" data-testid="antigravity-runtime">
						{confirmRemove ? <>
							<span>Remove the downloaded runtime? Antigravity sessions stop; your sign-in stays.</span>
							<Button variant="outline" size="xs" disabled={busy} onClick={() => { setConfirmRemove(false); void control({ op: "remove-runtime" }); }}>Remove</Button>
							<Button variant="ghost" size="xs" disabled={busy} onClick={() => setConfirmRemove(false)}>Keep</Button>
						</> : <>
							<span>{`Runtime downloaded by LearnHarness · ${status.managed.installed ?? status.version ?? ""}`}</span>
							<Button variant="ghost" size="xs" disabled={busy} onClick={() => setConfirmRemove(true)}>Remove downloaded runtime</Button>
						</>}
					</div>}
				</>}
				{status.install?.phase === "succeeded" && !installing(status) && status.state !== "missing" && <p role="status" className="text-muted-foreground">{`Antigravity ${status.install.version ?? ""} installed.`}</p>}
				{installFailed && <p role="alert" className="text-error">{installFailed}</p>}
				{loginFailed && !signingIn(status) && <p role="alert" className="text-error">{loginFailed}</p>}
			</div>
			{error && <p role="alert" className="mt-3 text-xs text-error">{error}</p>}
			<ConnectionFooter testid="antigravity-footer" leading={status.state === "connected" && !signingIn(status) && <div className="flex gap-2">
				<Button variant="ghost" size="sm" disabled={busy} onClick={() => void control({ op: "login-start" })}>Switch account</Button>
				<Button variant="ghost" size="sm" disabled={busy} onClick={() => void control({ op: "logout" })}>Sign out</Button>
			</div>}>
				{installing(status) && <Button variant="outline" size="sm" disabled={busy} onClick={() => void control({ op: "cancel-install" })}>Cancel</Button>}
				{signingIn(status) && <Button variant="outline" size="sm" disabled={busy} onClick={() => void control({ op: "login-cancel" })}>Cancel</Button>}
				{!installing(status) && !signingIn(status) && <>
					<Button variant="ghost" size="sm" disabled={busy} onClick={() => void control({ op: "refresh" })}>Check again</Button>
					{(status.state === "missing" || status.state === "outdated") && status.managed.supported && <Button variant="outline" size="sm" disabled={busy} onClick={() => void control({ op: "install" })}>{status.state === "missing" ? "Install Antigravity" : "Update Antigravity"}</Button>}
					{status.state === "signed-out" && <Button variant="outline" size="sm" disabled={busy} onClick={() => void control({ op: "login-start" })}>Sign in with Google</Button>}
				</>}
				<Button variant="outline" size="sm" disabled={busy} onClick={close}>Close</Button>
			</ConnectionFooter>
		</ConnectionDialog>}
	</Context.Provider>;
}

export function AntigravityConnection({ labelClassName }: { labelClassName?: string } = {}) {
	const ui = useContext(Context);
	return <div className="flex flex-col gap-2" data-testid="antigravity-connection">
		<ConnectionRow label={ANTIGRAVITY_LABEL} labelClassName={labelClassName} action={ui.status.connected ? "Manage…" : "Connect"} disabled={ui.busy} onAction={ui.open}>
			<span className="text-xs text-muted-foreground" data-testid="antigravity-summary">{summary(ui.status)}</span>
		</ConnectionRow>
	</div>;
}

/** Beside background model choices, like the other subscriptions. */
export function AntigravityBackgroundAccess({ provider }: { provider: string | undefined }) {
	const ui = useContext(Context);
	if (provider !== ANTIGRAVITY_PROVIDER || !ui.status.connected || ui.status.allowBackgroundUse) return null;
	return <Button type="button" size="xs" variant="ghost" disabled={ui.busy} onClick={ui.open}>Enable background use</Button>;
}
