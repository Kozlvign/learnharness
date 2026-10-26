"use client";
/** The Claude connection (fork feature): Claude models run through the
 * user's own Claude Code, which handles sign-in and keeps the credentials. */
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { CLAUDE_CODE_INSTALL_URL, CLAUDE_CODE_LABEL, CLAUDE_CODE_PROVIDER, type ClaudeCodeStatus, type ClaudeCodeUsageWindow } from "@/src/core";
import { Button } from "@/components/ui/button";
import { useNotifyHub } from "@/components/server-events";
import { notifySettingsSaved } from "@/components/settings-signal";
import { ConnectionDialog, ConnectionFooter, ConnectionRow } from "./connection-controls";
import { Toggle } from "./controls";

export const CLAUDE_CODE_NOTICE = "LearnHarness runs Claude through Claude Code, Anthropic's official app on this computer. Claude Code handles sign-in and keeps your credentials; LearnHarness never reads or stores them. Your prompts, tool results, and relevant session context go to Anthropic through Claude Code, and use counts toward your Claude plan limits. This connection never falls back to an API key.";
export const CLAUDE_CODE_BACKGROUND_HINT = "Allow LearnHarness helper agents and automatic follow-ups to use your Claude plan.";
const PATH = "/api/claude-code";
const HEADERS = { "Content-Type": "application/json", "x-learnharness-claude": "1" };
const CONTROL_ERROR = "The Claude connection could not be changed. Try again.";
const INSTALL_COMMAND = typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent)
	? "irm https://claude.ai/install.ps1 | iex"
	: "curl -fsSL https://claude.ai/install.sh | bash";

const EMPTY: ClaudeCodeStatus = { state: "checking", connected: false, version: null, executable: null, account: null, models: [], allowBackgroundUse: true, usage: [], loginPending: false, checkedAt: null, revision: 0 };

async function request(method: "GET" | "POST", body?: Record<string, unknown>, refresh = false): Promise<ClaudeCodeStatus> {
	const response = await fetch(refresh ? `${PATH}?refresh=1` : PATH, { method, headers: HEADERS, cache: "no-store", ...(body ? { body: JSON.stringify(body) } : {}) });
	const value = await response.json().catch(() => null) as ClaudeCodeStatus | { error?: string } | null;
	if (!response.ok || !value || !("state" in value)) throw new Error(value && "error" in value && value.error ? value.error : CONTROL_ERROR);
	return value;
}

const Context = createContext({ status: EMPTY, busy: false, open: () => {} });

const WINDOW_NAMES: Record<string, string> = { five_hour: "5-hour", seven_day: "Weekly", seven_day_opus: "Weekly (Opus)", seven_day_sonnet: "Weekly (Sonnet)", seven_day_overage_included: "Weekly", overage: "Extra usage" };
function usageLine(window: ClaudeCodeUsageWindow): string {
	const name = WINDOW_NAMES[window.kind] ?? window.kind;
	const used = window.utilization === null ? (window.status === "rejected" ? "limit reached" : "in use") : `${Math.round(window.utilization * 100)}% used`;
	const reset = window.resetsAt ? ` · resets ${new Date(window.resetsAt).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}` : "";
	return `${name}: ${used}${reset}`;
}
function summary(status: ClaudeCodeStatus): string {
	switch (status.state) {
		case "checking": return "Checking…";
		case "missing": return "Claude Code not installed";
		case "signed-out": return status.loginPending ? "Waiting for sign-in…" : "Not signed in";
		case "error": return "Unavailable";
		case "connected": return [status.account?.plan, status.account?.email].filter(Boolean).join(" · ") || "Connected";
	}
}

export function ClaudeCodeUIProvider({ children }: { children: React.ReactNode }) {
	const hub = useNotifyHub();
	const [status, setStatus] = useState<ClaudeCodeStatus>(EMPTY);
	const [dialog, setDialog] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const mounted = useRef(false), revision = useRef(-1);
	const accept = useCallback((next: ClaudeCodeStatus) => {
		if (!mounted.current || next.revision < revision.current) return;
		const changed = next.connected !== status.connected;
		revision.current = next.revision;
		setStatus(next);
		if (changed) notifySettingsSaved("keys");
	}, [status.connected]);
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
	async function control(body: Record<string, unknown>) {
		if (busy) return;
		setBusy(true); setError(null);
		try { accept(await request("POST", body)); }
		catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : CONTROL_ERROR); }
		finally { if (mounted.current) setBusy(false); }
	}
	const open = () => { setError(null); setDialog(true); void refresh(true); };
	const close = () => { if (!busy) setDialog(false); };
	const account = status.account;
	return <Context.Provider value={{ status, busy, open }}>
		{children}
		{dialog && <ConnectionDialog label={`${CLAUDE_CODE_LABEL} connection`} testid="claude-code-dialog" backdropTestid="claude-code-dialog-backdrop" busy={busy} onClose={close}>
			<h2 className="text-sm font-semibold text-foreground">{CLAUDE_CODE_LABEL} <span className="font-normal text-muted-foreground">via Claude Code</span></h2>
			<p className="mt-3 text-xs leading-relaxed text-muted-foreground" data-testid="claude-code-notice">{CLAUDE_CODE_NOTICE}</p>
			<div className="mt-4 space-y-2 text-xs text-foreground" data-testid="claude-code-state">
				{status.state === "checking" && <p role="status" className="text-muted-foreground">Checking Claude Code…</p>}
				{status.state === "missing" && <>
					<p>Claude Code is not installed on this computer. Install it, then select Check again:</p>
					<code className="block select-text rounded-sm border border-border bg-background px-2 py-1.5 font-mono">{INSTALL_COMMAND}</code>
					<p className="text-muted-foreground">Instructions: <a className="underline underline-offset-2" href={CLAUDE_CODE_INSTALL_URL} target="_blank" rel="noreferrer">{CLAUDE_CODE_INSTALL_URL}</a></p>
				</>}
				{status.state === "signed-out" && <p>{status.loginPending
					? "A terminal window opened with Claude Code's sign-in. Finish it in your browser; this updates on its own."
					: `Claude Code ${status.version ?? ""} is installed but not signed in. Sign in with your Claude account to use your plan here.`}</p>}
				{status.state === "error" && <p role="alert" className="text-red-400">{status.error}</p>}
				{status.state === "connected" && <>
					<p>Signed in{account?.email ? <> as <span className="select-text">{account.email}</span></> : null}{account?.plan ? ` · ${account.plan}` : ""}</p>
					{account?.apiBilling && <p className="text-amber-400">Claude Code is signed in with an Anthropic Console account, so use is billed to that API account rather than a Claude plan.</p>}
					{status.usage.length > 0 && <ul className="space-y-0.5 text-muted-foreground" data-testid="claude-code-usage">{status.usage.map((window) => <li key={window.kind}>{usageLine(window)}</li>)}</ul>}
					<p className="text-muted-foreground">Claude Code {status.version} · {status.models.length} models</p>
					<div className="mt-3 flex items-center gap-3">
						<Toggle label="Allow background use" checked={status.allowBackgroundUse} disabled={busy} onChange={(enabled) => void control({ op: "consent", enabled })} />
						<span>Allow background use<span className="mt-1 block leading-relaxed text-muted-foreground">{CLAUDE_CODE_BACKGROUND_HINT}</span></span>
					</div>
				</>}
			</div>
			{error && <p role="alert" className="mt-3 text-xs text-red-400">{error}</p>}
			<ConnectionFooter testid="claude-code-footer" leading={status.state === "connected" && <Button variant="ghost" size="sm" disabled={busy} onClick={() => void control({ op: "login" })}>Switch account</Button>}>
				<Button variant="ghost" size="sm" disabled={busy} onClick={() => void control({ op: "refresh" })}>Check again</Button>
				{status.state === "signed-out" && <Button variant="outline" size="sm" disabled={busy || status.loginPending} onClick={() => void control({ op: "login" })}>Sign in</Button>}
				<Button variant="outline" size="sm" disabled={busy} onClick={close}>Close</Button>
			</ConnectionFooter>
		</ConnectionDialog>}
	</Context.Provider>;
}

export function ClaudeCodeConnection() {
	const ui = useContext(Context);
	return <div className="flex flex-col gap-2" data-testid="claude-code-connection">
		<ConnectionRow label={CLAUDE_CODE_LABEL} action={ui.status.connected ? "Manage…" : "Connect"} disabled={ui.busy} onAction={ui.open}>
			<span className="text-xs text-muted-foreground" data-testid="claude-code-summary">{summary(ui.status)}</span>
		</ConnectionRow>
	</div>;
}

/** Beside background model choices, like the other subscriptions. */
export function ClaudeCodeBackgroundAccess({ provider }: { provider: string | undefined }) {
	const ui = useContext(Context);
	if (provider !== CLAUDE_CODE_PROVIDER || !ui.status.connected || ui.status.allowBackgroundUse) return null;
	return <Button type="button" size="xs" variant="ghost" disabled={ui.busy} onClick={ui.open}>Enable background use</Button>;
}
