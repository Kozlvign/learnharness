/**
 * Fork: side panel (docs/side-panel.md). The panel's state machine, pure.
 *
 * One panel on the session's right with two tabs: Materials (always) and
 * Side question (only while a side question is pinned). The rules:
 *  - Pinning a side question opens the panel on its tab. Releasing it
 *    (closed, or floating again) returns the panel to how it was: closed
 *    when it opened only for the side question, else on Materials.
 *  - Closing the panel while a side question is pinned floats it again
 *    (the caller does that; the machine just closes).
 *  - A new demo, figure or shown image switches an OPEN panel to it; a
 *    closed panel stays closed. The Side question tab is never taken away
 *    from the learner — the Materials selection changes behind it.
 *  - Demos opened while the panel is open stay mounted (hidden) so their
 *    controls survive switching items; closing the panel drops them.
 */

export type SidePanelTab = "materials" | "side-question";

export interface SidePanelState {
	open: boolean;
	tab: SidePanelTab;
	/** The Materials item shown; null → the newest item. */
	selectedId: string | null;
	/** Items opened since the panel opened, kept mounted while it stays open. */
	alive: string[];
	/** The panel opened only because a side question was pinned. */
	openedBySideQuestion: boolean;
}

export type SidePanelAction =
	| { type: "open"; fallbackId: string | null }
	| { type: "close" }
	| { type: "select"; id: string }
	| { type: "tab"; tab: SidePanelTab }
	| { type: "side-pinned" }
	| { type: "side-released" }
	| { type: "arrived"; id: string }
	| { type: "restore"; persisted: PersistedSidePanel };

export const CLOSED_SIDE_PANEL: SidePanelState = { open: false, tab: "materials", selectedId: null, alive: [], openedBySideQuestion: false };

function keepAlive(alive: readonly string[], id: string | null): string[] {
	return id === null || alive.includes(id) ? [...alive] : [...alive, id];
}

export function sidePanelReducer(state: SidePanelState, action: SidePanelAction): SidePanelState {
	switch (action.type) {
		case "open": {
			if (state.open) return { ...state, tab: "materials", openedBySideQuestion: false };
			const selectedId = state.selectedId ?? action.fallbackId;
			return { open: true, tab: "materials", selectedId, alive: keepAlive([], selectedId), openedBySideQuestion: false };
		}
		case "close":
			return { ...CLOSED_SIDE_PANEL, selectedId: state.selectedId };
		case "select":
			return { ...state, open: true, tab: "materials", selectedId: action.id, alive: keepAlive(state.open ? state.alive : [], action.id), openedBySideQuestion: false };
		case "tab":
			if (!state.open) return state;
			return { ...state, tab: action.tab, openedBySideQuestion: action.tab === "materials" ? false : state.openedBySideQuestion };
		case "side-pinned":
			if (state.open) return { ...state, tab: "side-question" };
			return { ...state, open: true, tab: "side-question", alive: [], openedBySideQuestion: true };
		case "side-released":
			if (!state.open) return state;
			if (state.openedBySideQuestion) return { ...CLOSED_SIDE_PANEL, selectedId: state.selectedId };
			return { ...state, tab: "materials" };
		case "arrived":
			if (!state.open) return state;
			return { ...state, selectedId: action.id, alive: keepAlive(state.alive, action.id) };
		case "restore":
			return action.persisted.open
				? { open: true, tab: "materials", selectedId: action.persisted.selectedId, alive: keepAlive([], action.persisted.selectedId), openedBySideQuestion: false }
				: { ...CLOSED_SIDE_PANEL, selectedId: action.persisted.selectedId };
	}
}

// ─── Persistence (this device's localStorage, like the sidebar and graph) ───

/** What each session remembers: open or closed, and the item shown. */
export interface PersistedSidePanel {
	open: boolean;
	selectedId: string | null;
}

export const SIDE_PANEL_WIDTH_KEY = "lh:side-panel-width";
export const SIDE_PANEL_DEFAULT_WIDTH = 480;
export const SIDE_PANEL_MIN_WIDTH = 320;
/** The panel never takes more than this share of the session area. */
export const SIDE_PANEL_MAX_SHARE = 0.6;

export function sidePanelStorageKey(chatId: string): string {
	return `lh:side-panel:${chatId}`;
}

/** The stored record, tolerant of absent or corrupt values. Pure. */
export function parsePersistedSidePanel(raw: string | null): PersistedSidePanel {
	if (!raw) return { open: false, selectedId: null };
	try {
		const value = JSON.parse(raw) as Partial<PersistedSidePanel> | null;
		return {
			open: value?.open === true,
			selectedId: typeof value?.selectedId === "string" ? value.selectedId : null,
		};
	} catch {
		return { open: false, selectedId: null };
	}
}

/** Only what the session should remember: a side-question-only panel is
 *  not remembered as open (the side question itself does not survive a
 *  reload). Pure. */
export function persistedSidePanel(state: SidePanelState): PersistedSidePanel {
	return { open: state.open && !state.openedBySideQuestion, selectedId: state.selectedId };
}

/** The stored width, or the default. Pure. */
export function parseSidePanelWidth(raw: string | null): number {
	const width = raw === null ? Number.NaN : Number(raw);
	return Number.isFinite(width) && width >= SIDE_PANEL_MIN_WIDTH ? Math.round(width) : SIDE_PANEL_DEFAULT_WIDTH;
}

/** A dragged width kept inside [min, 60% of the session area]. Pure. */
export function clampSidePanelWidth(width: number, areaWidth: number): number {
	const max = Math.max(SIDE_PANEL_MIN_WIDTH, Math.floor(areaWidth * SIDE_PANEL_MAX_SHARE));
	return Math.round(Math.min(max, Math.max(SIDE_PANEL_MIN_WIDTH, width)));
}
