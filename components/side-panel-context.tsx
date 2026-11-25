"use client";

import { createContext, useContext } from "react";
import { PanelRightOpenIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { MaterialTarget } from "./session-materials";

/**
 * Fork: side panel (docs/side-panel.md). The seam between the transcript's
 * cards and the session's side panel. The chat page provides it; the panel
 * itself provides null, so a card rendered inside the panel shows no
 * "Open in side panel" button. Without a chat page (tests, previews) there
 * is no provider and the button never renders.
 */
export interface SidePanelControls {
	/** True when the target is one of this session's Materials items. */
	canOpen: (target: MaterialTarget) => boolean;
	open: (target: MaterialTarget) => void;
}

export const SidePanelContext = createContext<SidePanelControls | null>(null);

export function useSidePanelControls(): SidePanelControls | null {
	return useContext(SidePanelContext);
}

/** The cards' "Open in side panel" control: the same quiet icon button as
 *  their download and fullscreen controls. */
export function OpenInSidePanelButton({ target, className }: { target: MaterialTarget; className?: string }) {
	const controls = useSidePanelControls();
	if (!controls?.canOpen(target)) return null;
	return (
		<button
			type="button"
			aria-label="Open in side panel"
			title="Open in side panel"
			data-testid="open-in-side-panel"
			onClick={() => controls.open(target)}
			className={cn("rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground", className)}
		>
			<PanelRightOpenIcon className="size-3.5" />
		</button>
	);
}
