/**
 * Fork: the graph's zoom buttons (−, fit, +) — the pure camera math the
 * renderer (components/graph-canvas.ts) runs for them. The buttons live in
 * components/graph-zoom-controls.tsx.
 *
 * Camera convention (d3-zoom's): screen = world × k + (x, y). A glide
 * target is stored as a WORLD point to put at the viewport center plus a
 * zoom, so a resize mid-glide still lands on the same framing.
 */

/** One click of − or +: the same step as the diagram and plan viewers,
 *  about one wheel notch on the graph. */
export const ZOOM_STEP = 1.25;

export interface Camera {
	k: number;
	x: number;
	y: number;
}

/** Where a glide ends: this world point at the viewport center, at zoom k. */
export interface CameraTarget {
	k: number;
	cx: number;
	cy: number;
}

export interface BBox {
	minX: number;
	maxX: number;
	minY: number;
	maxY: number;
}

/** Bounds of the nodes the fit frames (the caller's predicate: the ones
 *  drawn under the current filter). Null when none qualify. */
export function framedBBox(
	nodes: readonly { id: string; x: number; y: number }[],
	isFramed: (id: string) => boolean,
): BBox | null {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const n of nodes) {
		if (!isFramed(n.id)) continue;
		if (n.x < minX) minX = n.x;
		if (n.y < minY) minY = n.y;
		if (n.x > maxX) maxX = n.x;
		if (n.y > maxY) maxY = n.y;
	}
	return minX === Infinity ? null : { minX, maxX, minY, maxY };
}

/** The most the fit zooms in: where node labels become fully visible
 *  (camera ratio kFit / k at the labelZoom setting), never below the
 *  whole-graph framing (kFit) — with labelZoom ≥ 1 labels are already
 *  fully shown there. */
export function fitZoomCap(kFit: number, labelZoom: number): number {
	if (!(labelZoom > 0) || !Number.isFinite(labelZoom)) return kFit;
	return kFit / Math.min(labelZoom, 1);
}

/** The fit's target: the bbox center at the bbox's framing zoom (`fitK`,
 *  from fitTransform), capped by fitZoomCap and kept inside the camera's
 *  zoom range. */
export function fitTarget(
	bbox: BBox,
	fitK: number,
	kFit: number,
	labelZoom: number,
	extent: readonly [number, number],
): CameraTarget {
	const k = Math.min(Math.max(Math.min(fitK, fitZoomCap(kFit, labelZoom)), extent[0]), extent[1]);
	return { k, cx: (bbox.minX + bbox.maxX) / 2, cy: (bbox.minY + bbox.maxY) / 2 };
}

/** One glide frame toward `target` in a w × h viewport. `blend` (0–1) is
 *  the share of the remaining way to cover this frame. The world point at
 *  the viewport center moves in a straight line and the zoom moves in log
 *  space, so zoom and pan arrive together. Snaps exactly onto the target
 *  once within 0.2% zoom and half a pixel. */
export function glideCamera(
	current: Camera,
	target: CameraTarget,
	blend: number,
	w: number,
	h: number,
): { camera: Camera; done: boolean } {
	const cx0 = (w / 2 - current.x) / current.k;
	const cy0 = (h / 2 - current.y) / current.k;
	const k = Math.exp(Math.log(current.k) + (Math.log(target.k) - Math.log(current.k)) * blend);
	const cx = cx0 + (target.cx - cx0) * blend;
	const cy = cy0 + (target.cy - cy0) * blend;
	const done =
		Math.abs(target.k - k) / target.k < 0.002 && Math.hypot(target.cx - cx, target.cy - cy) * k < 0.5;
	const end = done ? { k: target.k, cx: target.cx, cy: target.cy } : { k, cx, cy };
	return { camera: { k: end.k, x: w / 2 - end.cx * end.k, y: h / 2 - end.cy * end.k }, done };
}
