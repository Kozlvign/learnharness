"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import {
	BookOpenTextIcon,
	CheckIcon,
	ChevronDownIcon,
	ChevronLeftIcon,
	ChevronRightIcon,
	GlobeIcon,
	ImageIcon,
	ImageUpIcon,
	LocateFixedIcon,
	ShapesIcon,
	SlidersHorizontalIcon,
	WaypointsIcon,
	WorkflowIcon,
	XIcon,
	type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { MessageResponse } from "@/components/ai-elements/message";
import { DemoOutputCard } from "@/components/artifacts/demo-card";
import { VisualOutputCard } from "@/components/artifacts/visual-card";
import { ImageCard } from "@/components/artifacts/image-card";
import { PdfBriefCard, ResearchBriefCard } from "@/components/artifacts/job-card";
import { attachmentUrl, ImageViewer } from "@/components/attachments/composer-images";
import { MenuShell } from "@/components/menu-shell";
import { useInteractionLayers } from "@/components/interaction-layers";
import { Button } from "@/components/ui/button";
import { Hint } from "@/components/ui/hint";
import { SidePanelContext } from "./side-panel-context";
import {
	materialFallbackLabel,
	materialKindLabel,
	switchesOnArrival,
	type LearnerImage,
	type SessionMaterial,
} from "./session-materials";
import {
	clampSidePanelWidth,
	parsePersistedSidePanel,
	parseSidePanelWidth,
	persistedSidePanel,
	SIDE_PANEL_WIDTH_KEY,
	sidePanelReducer,
	sidePanelStorageKey,
	CLOSED_SIDE_PANEL,
	type SidePanelState,
	type SidePanelTab,
} from "./side-panel-state";

/**
 * Fork: side panel (docs/side-panel.md). The session's right-hand panel:
 * a Materials tab (the session's demos, figures, images, diagrams and
 * readings, one at a time under a selector) and, while a side question is
 * pinned, a Side question tab. It sits beside the transcript inside the
 * session area, so the question dock stays open on the left while a demo
 * runs here.
 */

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

function readStorage(key: string): string | null {
	try {
		return window.localStorage.getItem(key);
	} catch {
		return null;
	}
}

function writeStorage(key: string, value: string): void {
	try {
		window.localStorage.setItem(key, value);
	} catch {
		/* storage full or denied: the panel still works, unremembered */
	}
}

export interface SidePanelHandle {
	/** False for the first client render (it must match the server's). */
	ready: boolean;
	state: SidePanelState;
	width: number;
	/** The Materials items the selector walks (the plan is a shortcut). */
	browsable: SessionMaterial[];
	/** The item shown: the selection, else the newest item. */
	current: SessionMaterial | null;
	toggle: () => void;
	close: () => void;
	select: (id: string) => void;
	setTab: (tab: SidePanelTab) => void;
	resize: (width: number) => void;
	commitWidth: (width: number) => void;
}

/** The panel's state for one session (Chat remounts per session). */
export function useSidePanel({ chatId, items, sideQuestionPinned, floatSideQuestion }: {
	chatId: string;
	items: readonly SessionMaterial[];
	sideQuestionPinned: boolean;
	floatSideQuestion: () => void;
}): SidePanelHandle {
	// Lazy reads: the server renders closed (no storage there), and `ready`
	// keeps the first client render identical; the layout effect below
	// flips it before the first paint.
	const [state, dispatch] = useReducer(sidePanelReducer, chatId, (id) =>
		typeof window === "undefined" ? CLOSED_SIDE_PANEL : sidePanelReducer(CLOSED_SIDE_PANEL, { type: "restore", persisted: parsePersistedSidePanel(readStorage(sidePanelStorageKey(id))) }));
	const [width, setWidth] = useState(() => typeof window === "undefined" ? parseSidePanelWidth(null) : parseSidePanelWidth(readStorage(SIDE_PANEL_WIDTH_KEY)));
	const [ready, setReady] = useState(false);
	useIsoLayoutEffect(() => setReady(true), []);

	const { open: rememberedOpen, selectedId: rememberedId } = persistedSidePanel(state);
	useEffect(() => {
		writeStorage(sidePanelStorageKey(chatId), JSON.stringify({ open: rememberedOpen, selectedId: rememberedId }));
	}, [chatId, rememberedOpen, rememberedId]);

	// The side question's pin drives its tab. A layout effect: the pinned
	// body must never miss a paint between leaving its floating window and
	// arriving in the panel.
	const pinnedRef = useRef(sideQuestionPinned);
	useIsoLayoutEffect(() => {
		if (pinnedRef.current === sideQuestionPinned) return;
		pinnedRef.current = sideQuestionPinned;
		dispatch({ type: sideQuestionPinned ? "side-pinned" : "side-released" });
	}, [sideQuestionPinned]);

	// A new demo, figure or shown image switches an open panel to it. What
	// the session already held at mount is not new.
	const seen = useRef<Set<string> | null>(null);
	useEffect(() => {
		const ids = items.filter(switchesOnArrival).map((item) => item.id);
		if (seen.current === null) {
			seen.current = new Set(ids);
			return;
		}
		const fresh = ids.filter((id) => !seen.current!.has(id));
		for (const id of fresh) seen.current.add(id);
		if (fresh.length > 0) dispatch({ type: "arrived", id: fresh.at(-1)! });
	}, [items]);

	const browsable = useMemo(() => items.filter((item) => item.kind !== "plan"), [items]);
	const current = browsable.find((item) => item.id === state.selectedId) ?? browsable.at(-1) ?? null;

	const pinnedNow = useRef(sideQuestionPinned);
	pinnedNow.current = sideQuestionPinned;
	const floatRef = useRef(floatSideQuestion);
	floatRef.current = floatSideQuestion;
	const close = useCallback(() => {
		// Closing the whole panel floats a pinned side question again.
		if (pinnedNow.current) floatRef.current();
		dispatch({ type: "close" });
	}, []);
	const latestId = browsable.at(-1)?.id ?? null;
	const toggle = useCallback(() => {
		if (state.open) close();
		else dispatch({ type: "open", fallbackId: latestId });
	}, [state.open, close, latestId]);

	return {
		ready,
		state,
		width,
		browsable,
		current,
		toggle,
		close,
		select: useCallback((id: string) => dispatch({ type: "select", id }), []),
		setTab: useCallback((tab: SidePanelTab) => dispatch({ type: "tab", tab }), []),
		resize: setWidth,
		commitWidth: useCallback((next: number) => {
			setWidth(next);
			writeStorage(SIDE_PANEL_WIDTH_KEY, String(next));
		}, []),
	};
}

/** The item's card in the transcript, for "Show in chat": the anchors
 *  chat.tsx stamps (data-material-id on demo, figure, reading and shown
 *  image cards; data-material-ids on the learner's message row; the text
 *  part's key plus the diagram's position inside it). */
export function materialElement(root: ParentNode, item: SessionMaterial): HTMLElement | null {
	const quote = (value: string) => typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(value) : value.replace(/["\\]/g, "\\$&");
	switch (item.kind) {
		case "plan":
			return null;
		case "learner-image":
			return root.querySelector<HTMLElement>(`[data-material-ids~="${quote(item.id)}"]`);
		case "diagram": {
			const part = root.querySelector<HTMLElement>(`[data-text-part-key="${quote(item.textPartId)}"]`);
			if (!part) return null;
			// Rendered, still rendering, or failed: each fence is one of these.
			const blocks = part.querySelectorAll<HTMLElement>('[data-testid="md-mermaid"], [data-streamdown="mermaid-error"]');
			return blocks[item.index] ?? part;
		}
		default:
			return root.querySelector<HTMLElement>(`[data-material-id="${quote(item.id)}"]`);
	}
}

// ─── Presentation ───────────────────────────────────────────────────────────

const KIND_ICONS: Record<SessionMaterial["kind"], LucideIcon> = {
	demo: SlidersHorizontalIcon,
	figure: ShapesIcon,
	image: ImageIcon,
	"learner-image": ImageUpIcon,
	diagram: WorkflowIcon,
	plan: WaypointsIcon,
	reading: BookOpenTextIcon,
};

function KindIcon({ item, className }: { item: SessionMaterial; className?: string }) {
	const Icon = item.kind === "reading" && item.source === "research" ? GlobeIcon : KIND_ICONS[item.kind];
	return <Icon aria-hidden className={cn("size-3.5 shrink-0 text-muted-foreground", className)} />;
}

/** The item's own title is content (never translated); an untitled item's
 *  kind + number is interface text. */
export function MaterialName({ item }: { item: SessionMaterial }) {
	return item.title
		? <span data-lh-i18n="off" className="min-w-0 truncate">{item.title}</span>
		: <span className="min-w-0 truncate">{materialFallbackLabel(item)}</span>;
}

function LearnerImageView({ image }: { image: LearnerImage }) {
	const [open, setOpen] = useState(false);
	const src = "attachment" in image ? attachmentUrl(image.attachment) : `data:${image.mimeType};base64,${image.data}`;
	return (
		<figure className="mx-auto w-fit max-w-full" data-testid="side-panel-learner-image">
			<button type="button" onClick={() => setOpen(true)} aria-label="View image" className="block cursor-zoom-in overflow-hidden rounded-lg border border-border bg-muted">
				{/* eslint-disable-next-line @next/next/no-img-element -- local attachment or inline bytes */}
				<img src={src} alt="Attached image" className="block h-auto max-h-[70vh] w-auto max-w-full object-contain" />
			</button>
			<figcaption className="mt-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Your image</figcaption>
			{open && <ImageViewer src={src} onClose={() => setOpen(false)} />}
		</figure>
	);
}

/** One non-demo item, rendered by the transcript's own components. Demos
 *  render through the keep-alive layer instead. */
function MaterialView({ item }: { item: SessionMaterial }) {
	switch (item.kind) {
		case "figure":
			return <VisualOutputCard output={item.result} messageId={item.messageId} initialInverted={item.inverted} />;
		case "image":
			return <ImageCard part={{ type: "tool-show_image", state: "output-available", toolCallId: item.toolCallId, output: item.details }} />;
		case "learner-image":
			return <LearnerImageView image={item.image} />;
		case "diagram":
			return <MessageResponse>{`\`\`\`mermaid\n${item.chart}\n\`\`\``}</MessageResponse>;
		case "reading":
			return item.source === "pdf" ? <PdfBriefCard output={item.result} /> : <ResearchBriefCard output={item.result} />;
		case "demo":
		case "plan":
			return null;
	}
}

function ItemMenu({ anchorRef, items, current, onPick, onClose }: {
	anchorRef: React.RefObject<HTMLButtonElement | null>;
	items: readonly SessionMaterial[];
	current: SessionMaterial | null;
	onPick: (item: SessionMaterial) => void;
	onClose: (focusTrigger: boolean) => void;
}) {
	const interactions = useInteractionLayers();
	useEffect(() => {
		const onPointerDown = (event: PointerEvent) => {
			const popup = interactions.getTopLayer();
			if (popup?.kind !== "popup" || popup.anchorRef?.current !== anchorRef.current || !interactions.isElementEligible(popup.rootRef.current)) return;
			const target = event.target as Element;
			if (target instanceof Element && target.closest('[data-testid="side-panel-menu"]')) return;
			if (!anchorRef.current?.contains(target)) onClose(false);
		};
		document.addEventListener("pointerdown", onPointerDown);
		return () => document.removeEventListener("pointerdown", onPointerDown);
	}, [interactions, anchorRef, onClose]);
	return (
		<MenuShell
			anchorRef={anchorRef}
			testid="side-panel-menu"
			preferredSide="down"
			align="left"
			onClose={(reason) => { onClose(reason === "escape"); return "closed"; }}
			menuClass="flex w-80 max-w-[calc(100vw-1rem)] flex-col rounded-xl border border-border bg-card p-1 text-sm shadow-xl"
		>
			{/* Enter activates the focused row natively; it must never reach
			    the session's window-level Enter (the practice move-on). */}
			<div role="menu" aria-label="Materials" onKeyDown={(event) => { if (event.key === "Enter") event.stopPropagation(); }}>
				{items.map((item, index) => {
					const selected = item.id === current?.id;
					return (
						<button
							key={item.id}
							type="button"
							role="menuitemradio"
							aria-checked={selected}
							data-testid={`side-panel-item-${index}`}
							title={materialKindLabel(item)}
							onClick={() => onPick(item)}
							className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-card-foreground transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none",
								selected && "bg-accent/60")}
						>
							<KindIcon item={item} />
							<MaterialName item={item} />
							<span className="ml-auto flex size-3.5 shrink-0 items-center">{selected && <CheckIcon aria-hidden className="size-3.5 text-muted-foreground" />}</span>
						</button>
					);
				})}
			</div>
		</MenuShell>
	);
}

function TabButton({ active, onClick, children, testId }: { active: boolean; onClick: () => void; children: ReactNode; testId: string }) {
	return (
		<button
			type="button"
			role="tab"
			aria-selected={active}
			data-testid={testId}
			onClick={onClick}
			className={cn("rounded-sm px-2 py-1 font-ui text-xs font-medium uppercase tracking-wide transition-colors",
				active ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground")}
		>
			{children}
		</button>
	);
}

function MaterialsTab({ panel, items, onShowInChat, onOpenPlan }: {
	panel: SidePanelHandle;
	items: readonly SessionMaterial[];
	onShowInChat: (item: SessionMaterial) => void;
	onOpenPlan: () => void;
}) {
	const [menuOpen, setMenuOpen] = useState(false);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const { browsable, current } = panel;
	const position = current ? browsable.findIndex((item) => item.id === current.id) : -1;
	const previous = position > 0 ? browsable[position - 1] : undefined;
	const following = position >= 0 && position < browsable.length - 1 ? browsable[position + 1] : undefined;
	const closeMenu = useCallback((focusTrigger: boolean) => {
		setMenuOpen(false);
		if (focusTrigger) triggerRef.current?.focus();
	}, []);
	// Demos opened since the panel opened stay mounted, hidden while another
	// item shows, so their controls survive switching.
	const aliveIds = new Set(panel.state.alive);
	if (current) aliveIds.add(current.id);
	const demos = browsable.filter((item) => item.kind === "demo" && aliveIds.has(item.id));

	if (items.length === 0) {
		return (
			<p data-testid="side-panel-empty" className="px-4 py-6 text-sm text-muted-foreground">
				Nothing here yet. The interactive demos, figures, images and diagrams of this session appear here.
			</p>
		);
	}
	return (
		<>
			<div className="flex shrink-0 items-center gap-0.5 border-b border-border px-2 py-1.5">
				<Hint label="Previous item" side="bottom">
					<Button type="button" size="icon-xs" variant="ghost" aria-label="Previous item" data-testid="side-panel-previous"
						disabled={!previous} onClick={() => previous && panel.select(previous.id)}>
						<ChevronLeftIcon aria-hidden />
					</Button>
				</Hint>
				<button
					ref={triggerRef}
					type="button"
					aria-haspopup="menu"
					aria-expanded={menuOpen}
					data-testid="side-panel-selector"
					title={current ? materialKindLabel(current) : undefined}
					onClick={() => setMenuOpen((open) => !open)}
					className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1 text-left text-sm text-foreground transition-colors hover:bg-accent"
				>
					{current ? <><KindIcon item={current} /><MaterialName item={current} /></> : <span className="min-w-0 truncate text-muted-foreground">Choose an item</span>}
					<ChevronDownIcon aria-hidden className="ml-auto size-3.5 shrink-0 text-muted-foreground" />
				</button>
				<Hint label="Next item" side="bottom">
					<Button type="button" size="icon-xs" variant="ghost" aria-label="Next item" data-testid="side-panel-next"
						disabled={!following} onClick={() => following && panel.select(following.id)}>
						<ChevronRightIcon aria-hidden />
					</Button>
				</Hint>
				<Hint label="Show in chat" side="bottom">
					<Button type="button" size="icon-xs" variant="ghost" aria-label="Show in chat" data-testid="side-panel-show-in-chat"
						disabled={!current} onClick={() => current && onShowInChat(current)}>
						<LocateFixedIcon aria-hidden />
					</Button>
				</Hint>
			</div>
			{menuOpen && (
				<ItemMenu
					anchorRef={triggerRef}
					items={items}
					current={current}
					onClose={closeMenu}
					onPick={(item) => {
						closeMenu(false);
						if (item.kind === "plan") onOpenPlan();
						else panel.select(item.id);
					}}
				/>
			)}
			<div data-testid="side-panel-body" className="relative min-h-0 flex-1 overflow-y-auto p-3">
				{demos.map((demo) => {
					const shown = demo.id === current?.id;
					return (
						<div key={demo.id} data-testid="side-panel-demo" aria-hidden={!shown || undefined}
							className={shown ? undefined : "pointer-events-none invisible absolute inset-x-3 top-3 h-0 overflow-hidden"}>
							{demo.kind === "demo" && <DemoOutputCard output={demo.result} messageId={demo.messageId} initialInverted={demo.inverted} />}
						</div>
					);
				})}
				{current && current.kind !== "demo" && <MaterialView key={current.id} item={current} />}
			</div>
		</>
	);
}

/** The panel. `sideQuestion` is the pinned side question's body, or
 *  undefined (no Side question tab). */
export function SidePanel({ panel, items, sideQuestion, onShowInChat, onOpenPlan }: {
	panel: SidePanelHandle;
	items: readonly SessionMaterial[];
	sideQuestion?: ReactNode;
	onShowInChat: (item: SessionMaterial) => void;
	onOpenPlan: () => void;
}) {
	const asideRef = useRef<HTMLElement>(null);
	const [dragging, setDragging] = useState(false);
	const tab: SidePanelTab = sideQuestion && panel.state.tab === "side-question" ? "side-question" : "materials";
	const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
		const aside = asideRef.current;
		const area = aside?.parentElement;
		if (event.button !== 0 || !aside || !area) return;
		event.preventDefault();
		const handle = event.currentTarget;
		const startX = event.clientX;
		const startWidth = aside.getBoundingClientRect().width;
		const areaWidth = area.getBoundingClientRect().width;
		let last = startWidth;
		handle.setPointerCapture(event.pointerId);
		setDragging(true);
		const move = (e: PointerEvent) => {
			last = clampSidePanelWidth(startWidth + (startX - e.clientX), areaWidth);
			panel.resize(last);
		};
		const end = () => {
			handle.removeEventListener("pointermove", move);
			handle.removeEventListener("pointerup", end);
			handle.removeEventListener("pointercancel", end);
			setDragging(false);
			panel.commitWidth(Math.round(last));
		};
		handle.addEventListener("pointermove", move);
		handle.addEventListener("pointerup", end);
		handle.addEventListener("pointercancel", end);
	};
	return (
		// Cards inside the panel show no "Open in side panel" control.
		<SidePanelContext.Provider value={null}>
			<aside
				ref={asideRef}
				aria-label="Side panel"
				data-testid="side-panel"
				style={{ width: panel.width }}
				className={cn("lh-no-drag relative flex min-w-[320px] max-w-[60%] shrink-0 flex-col border-l border-border bg-background", dragging && "select-none")}
			>
				<div aria-hidden="true" data-testid="side-panel-resize" onPointerDown={startResize}
					className="absolute inset-y-0 -left-1 z-20 w-2 cursor-ew-resize touch-none" />
				<div className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-2">
					<div role="tablist" aria-label="Side panel" className="flex min-w-0 flex-1 items-center gap-1">
						<TabButton testId="side-panel-tab-materials" active={tab === "materials"} onClick={() => panel.setTab("materials")}>Materials</TabButton>
						{sideQuestion && (
							<TabButton testId="side-panel-tab-side-question" active={tab === "side-question"} onClick={() => panel.setTab("side-question")}>Side question</TabButton>
						)}
					</div>
					<Hint label="Close side panel" action="toggle-side-panel" side="bottom">
						<Button type="button" size="icon-xs" variant="ghost" aria-label="Close side panel" data-testid="side-panel-close" onClick={panel.close}>
							<XIcon aria-hidden />
						</Button>
					</Hint>
				</div>
				{/* Both tabs stay mounted while they exist: a demo keeps its
				    controls and a side question its draft across tab switches. */}
				<div role="tabpanel" data-testid="side-panel-materials" className={cn("min-h-0 flex-1 flex-col", tab === "materials" ? "flex" : "hidden")}>
					<MaterialsTab panel={panel} items={items} onShowInChat={onShowInChat} onOpenPlan={onOpenPlan} />
				</div>
				{sideQuestion && (
					<div role="tabpanel" data-testid="side-panel-side-question" className={cn("min-h-0 flex-1 flex-col p-3", tab === "side-question" ? "flex" : "hidden")}>
						{sideQuestion}
					</div>
				)}
			</aside>
		</SidePanelContext.Provider>
	);
}
