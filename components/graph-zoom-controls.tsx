"use client";

import { MaximizeIcon, MinusIcon, PlusIcon } from "lucide-react";
import { Hint } from "@/components/ui/hint";

/** Same look as the diagram and plan viewers' zoom buttons. */
const BUTTON =
	"pointer-events-auto flex size-7 items-center justify-center rounded-md border border-border/70 bg-card/80 text-muted-foreground backdrop-blur transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40";

/**
 * Fork: the graph's zoom buttons (−, fit, +). GraphView portals them into
 * the slot home.tsx keeps beside the composer (above it in narrow
 * windows); the camera math is graph-zoom.ts. Fit is disabled while the
 * filter leaves no node to frame.
 */
export function GraphZoomControls({
	onZoomOut,
	onFit,
	onZoomIn,
	canFit,
}: {
	onZoomOut: () => void;
	onFit: () => void;
	onZoomIn: () => void;
	canFit: boolean;
}) {
	return (
		<div data-testid="graph-zoom-controls" className="flex gap-1">
			<Hint label="Zoom out">
				<button type="button" aria-label="Zoom out" data-testid="graph-zoom-out" onClick={onZoomOut} className={BUTTON}>
					<MinusIcon className="size-3.5" />
				</button>
			</Hint>
			<Hint label="Fit graph to view">
				<button
					type="button"
					aria-label="Fit graph to view"
					data-testid="graph-zoom-fit"
					onClick={onFit}
					disabled={!canFit}
					className={BUTTON}
				>
					<MaximizeIcon className="size-3.5" />
				</button>
			</Hint>
			<Hint label="Zoom in">
				<button type="button" aria-label="Zoom in" data-testid="graph-zoom-in" onClick={onZoomIn} className={BUTTON}>
					<PlusIcon className="size-3.5" />
				</button>
			</Hint>
		</div>
	);
}
