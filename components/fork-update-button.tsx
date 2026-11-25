"use client";

/**
 * Fork (update button, docs/claude.md): the icon beside Settings. Opening the
 * app checks the fork's main for changes the installed build lacks
 * (electron/fork-update.cjs); the icon then shows a dot and its panel lists
 * them. Update rebuilds the app with the release script while the learner
 * keeps studying; the new version installs on Restart now or when the app
 * closes. Builds that cannot update themselves show nothing.
 */

import { useEffect, useRef, useState } from "react";
import { CircleArrowUpIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Hint } from "@/components/ui/hint";
import { BrailleSpinner } from "@/components/braille-spinner";
import { MenuShell } from "@/components/menu-shell";
import { useInteractionLayers } from "@/components/interaction-layers";
import { cn } from "@/lib/utils";

export type ForkUpdateCommit = { sha: string; date: string | null; subject?: string };

/** Mirrors the snapshot in electron/fork-update.cjs. */
export type ForkUpdateState = {
	status: "unsupported" | "idle" | "checking" | "up-to-date" | "available" | "check-failed" | "building" | "ready" | "build-failed";
	installed?: ForkUpdateCommit | null;
	latest?: ForkUpdateCommit | null;
	changes?: (ForkUpdateCommit & { subject: string })[];
	changeCount?: number;
	/** The release script's current step, as it names it. */
	step?: string | null;
	version?: string | null;
	error?: "git-missing" | "timeout" | "fetch" | "git" | "start" | "interrupted" | "script" | "install" | null;
	/** The release script's own message when it failed. */
	message?: string | null;
	log?: string | null;
	revision: number;
};

export type ForkUpdateBridge = {
	get: () => Promise<ForkUpdateState>;
	check: () => Promise<ForkUpdateState | undefined>;
	start: () => Promise<ForkUpdateState | undefined>;
	restart: () => void;
	onStatus: (cb: (state: ForkUpdateState) => void) => () => void;
};

const ERRORS: Record<NonNullable<ForkUpdateState["error"]>, string> = {
	"git-missing": "Git wasn't found. Install it to update LearnHarness.",
	timeout: "Git took too long to answer. Try again later.",
	fetch: "Couldn't reach the fork's main on GitHub. Check your connection.",
	git: "Git couldn't compare your version with the fork's main.",
	start: "The release script didn't start.",
	interrupted: "The update stopped before it finished.",
	script: "The release script stopped with an error.",
	install: "The new version's installer is missing. Update again to build it.",
};

const STEPS: Record<string, string> = {
	"Syncing with the fork": "Downloading the changes from the fork's main…",
	"Installing dependencies": "Installing dependencies…",
	"Translating new interface text": "Translating new interface text…",
	Checking: "Checking the new version…",
	Building: "Building the new version. This takes a few minutes.",
	Publishing: "Publishing the release on GitHub…",
};

/** "fix(audio): keep …" → a "Fix" labelled "Keep …". */
export function changeLabel(subject: string): { kind: string; text: string } {
	const match = /^([A-Za-z]+)(\([^)]*\))?!?:\s*(\S.*)$/.exec(subject);
	if (!match) return { kind: "Change", text: subject };
	const type = match[1]!.toLowerCase();
	const kind = type === "feat" ? "New feature" : type === "fix" ? "Fix" : type === "perf" ? "Performance" : "Tweak";
	const text = match[3]!;
	return { kind, text: text.charAt(0).toUpperCase() + text.slice(1) };
}

function describe(commit: ForkUpdateCommit | null | undefined): string {
	if (!commit) return "";
	const sha = commit.sha.slice(0, 7);
	const date = commit.date ? new Date(commit.date) : null;
	return date && !Number.isNaN(date.getTime())
		? `${sha} (${date.toLocaleDateString(undefined, { day: "2-digit", month: "2-digit", year: "numeric" })})`
		: sha;
}

/** Everything the icon and panel show for one snapshot. */
export function forkUpdateView(state: ForkUpdateState) {
	const count = state.changeCount ?? 0;
	switch (state.status) {
		case "checking":
			return { tooltip: "Checking for updates…", title: "Checking for updates…", description: "Comparing your version with the fork's main on GitHub.", busy: true };
		case "up-to-date":
			return { tooltip: "LearnHarness is up to date", title: "You're on the latest version", description: "There are no new changes on the fork's main.", version: `Version ${describe(state.installed)}`, check: true };
		case "available":
			return {
				tooltip: "Update available", title: "New version available", badge: true, update: true,
				description: count === 0 ? "The fork's main has a newer version than yours." : count === 1 ? "1 change since your version." : `${count} changes since your version.`,
				version: `${describe(state.installed)} → ${describe(state.latest)}`,
			};
		case "check-failed":
			return { tooltip: "Updates: something went wrong", title: "Couldn't check for updates", description: ERRORS[state.error ?? "git"], check: true };
		case "building":
			return {
				tooltip: "Preparing the update…", title: "Preparing the update…", busy: true,
				description: (state.step && STEPS[state.step]) || "Starting the release script…",
				note: "You can keep studying. It goes on even if you close LearnHarness.",
			};
		case "ready":
			return {
				tooltip: "Update ready: restart to install", title: "Update ready", badge: true, restart: true,
				description: "Restart to use the new version. Or keep studying: it installs when you close LearnHarness.",
				version: state.version ? `New version ${state.version}` : undefined,
			};
		case "build-failed":
			return {
				tooltip: "Updates: something went wrong", title: "The update didn't finish", badge: true, update: true,
				description: ERRORS[state.error ?? "script"], note: "Your installed version didn't change.",
			};
		default:
			return { tooltip: "Updates", title: "Updates", description: "See whether the fork's main has a newer version than yours.", check: true };
	}
}

/** Subscribe before asking for the snapshot; the revision keeps an older
 * reply from hiding a newer push. */
export function useForkUpdate(bridge: ForkUpdateBridge | undefined) {
	const [state, setState] = useState<ForkUpdateState | null>(null);
	const revisionRef = useRef(-1);
	const accept = useRef((next: ForkUpdateState | undefined) => {
		if (!next || next.revision < revisionRef.current) return;
		revisionRef.current = next.revision;
		setState(next);
	});
	useEffect(() => {
		if (!bridge) return;
		let live = true;
		const take = (next: ForkUpdateState | undefined) => { if (live) accept.current(next); };
		const off = bridge.onStatus(take);
		void bridge.get().then(take).catch(() => {});
		return () => { live = false; off(); };
	}, [bridge]);
	return { state, accept: (next: ForkUpdateState | undefined) => accept.current(next) };
}

export function ForkUpdateButton({ bridge = typeof window === "undefined" ? undefined : window.lh?.forkUpdate }: { bridge?: ForkUpdateBridge }) {
	const { state, accept } = useForkUpdate(bridge);
	const [open, setOpen] = useState(false);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const interactions = useInteractionLayers();

	useEffect(() => {
		if (!open) return;
		const onPointerDown = (event: PointerEvent) => {
			const popup = interactions.getTopLayer();
			if (popup?.kind !== "popup" || popup.anchorRef?.current !== triggerRef.current || !interactions.isElementEligible(popup.rootRef.current)) return;
			const target = event.target as Element;
			if (target instanceof Element && target.closest('[data-testid="fork-update-panel"]')) return;
			if (!triggerRef.current?.contains(target)) setOpen(false);
		};
		document.addEventListener("pointerdown", onPointerDown);
		return () => document.removeEventListener("pointerdown", onPointerDown);
	}, [open, interactions]);

	if (!bridge || !state || state.status === "unsupported") return null;
	const view = forkUpdateView(state);
	const changes = state.status === "available" ? state.changes ?? [] : [];
	const hidden = (state.changeCount ?? 0) - changes.length;
	const run = (action: () => Promise<ForkUpdateState | undefined>) => { void action().then(accept).catch(() => {}); };

	return <>
		<Hint label={view.tooltip} side="top">
			<button
				ref={triggerRef}
				type="button"
				data-testid="fork-update-button"
				aria-label={view.tooltip}
				aria-expanded={open}
				onClick={() => setOpen((value) => !value)}
				className="relative flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
			>
				<CircleArrowUpIcon className={cn("size-3.5", view.badge && "text-primary")} aria-hidden="true" />
				{view.badge && <span data-testid="fork-update-badge" aria-hidden="true" className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-primary" />}
			</button>
		</Hint>
		{open && <MenuShell
			anchorRef={triggerRef}
			testid="fork-update-panel"
			preferredSide="up"
			align="left"
			onClose={(reason) => { setOpen(false); if (reason === "escape") triggerRef.current?.focus(); return "closed"; }}
			menuClass="flex w-80 max-w-[calc(100vw-1rem)] flex-col gap-2.5 rounded-xl border border-border bg-card p-3 text-xs shadow-xl"
		>
			<div className="flex items-center gap-2">
				{view.busy && <BrailleSpinner label={view.title} />}
				<span className="text-sm font-medium" data-testid="fork-update-title">{view.title}</span>
			</div>
			<p className="text-muted-foreground" role="status" data-testid="fork-update-description">{view.description}</p>
			{view.note && <p className="text-muted-foreground">{view.note}</p>}
			{changes.length > 0 && <ul className="flex max-h-60 flex-col gap-1.5 overflow-y-auto" data-testid="fork-update-changes">
				{changes.map((change) => {
					const label = changeLabel(change.subject);
					return <li key={change.sha} className="flex items-start gap-2">
						<span className="shrink-0 rounded bg-accent px-1.5 py-px text-[11px]">{label.kind}</span>
						<span data-lh-i18n="off">{label.text}</span>
					</li>;
				})}
			</ul>}
			{hidden > 0 && <p className="text-muted-foreground" data-testid="fork-update-more">{hidden === 1 ? "and 1 more change" : `and ${hidden} more changes`}</p>}
			{state.status === "build-failed" && (state.message || state.log) && (
				<div className="max-h-40 overflow-y-auto rounded-md border border-border bg-background px-2 py-1.5 font-mono text-[11px] break-words select-text" data-lh-i18n="off" data-testid="fork-update-details">
					{state.message && <p>{state.message}</p>}
					{state.log && <p className="text-muted-foreground">{state.log}</p>}
				</div>
			)}
			<div className="flex items-center justify-between gap-2">
				<span className="text-muted-foreground" data-testid="fork-update-version">{view.version}</span>
				<div className="flex shrink-0 gap-2">
					{view.check && <Button type="button" size="xs" variant="outline" className="cursor-pointer" data-testid="fork-update-check" onClick={() => run(bridge.check)}>Check now</Button>}
					{view.update && <Button type="button" size="xs" className="cursor-pointer" data-testid="fork-update-start" onClick={() => run(bridge.start)}>Update</Button>}
					{view.restart && <Button type="button" size="xs" className="cursor-pointer" data-testid="fork-update-restart" onClick={() => bridge.restart()}>Restart now</Button>}
				</div>
			</div>
		</MenuShell>}
	</>;
}
