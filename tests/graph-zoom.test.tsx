/**
 * Fork: the graph's zoom buttons. The camera math (components/graph-zoom.ts)
 * is pinned here; the renderer's glide loop is DOM-bound and verified live.
 * The buttons render through the same SSR seam as the graph chrome pins.
 */

import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { parseHTML } from "linkedom";
import { renderWithInteractionLayers as renderToStaticMarkup } from "./interaction-layer-render.tsx";
import { fitTarget, fitZoomCap, framedBBox, glideCamera, ZOOM_STEP, type Camera } from "../components/graph-zoom.ts";
import { GraphZoomControls } from "../components/graph-zoom-controls.tsx";

const EXTENT = [0.02, 40] as const;
const near = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

describe("framedBBox", () => {
	const nodes = [
		{ id: "a", x: -10, y: 5 },
		{ id: "b", x: 30, y: -20 },
		{ id: "arg_1", x: 100, y: 100 },
	];

	it("bounds only the nodes the predicate keeps", () => {
		assert.deepEqual(framedBBox(nodes, (id) => !id.startsWith("arg_")), { minX: -10, maxX: 30, minY: -20, maxY: 5 });
		assert.deepEqual(framedBBox(nodes, (id) => id === "b"), { minX: 30, maxX: 30, minY: -20, maxY: -20 });
	});

	it("is null when no node qualifies", () => {
		assert.equal(framedBBox(nodes, () => false), null);
		assert.equal(framedBBox([], () => true), null);
	});
});

describe("fitZoomCap", () => {
	it("stops where labels become fully visible (ratio kFit / k = labelZoom)", () => {
		near(fitZoomCap(2, 0.5), 4);
		near(fitZoomCap(2, 0.25), 8);
	});

	it("never zooms out past the whole-graph framing", () => {
		near(fitZoomCap(2, 1), 2);
		near(fitZoomCap(2, 3), 2);
	});

	it("falls back to the whole-graph framing on a bad setting", () => {
		near(fitZoomCap(2, 0), 2);
		near(fitZoomCap(2, Number.NaN), 2);
	});
});

describe("fitTarget", () => {
	const bbox = { minX: 0, maxX: 100, minY: -50, maxY: 50 };

	it("centers the bbox at its own framing zoom when under the cap", () => {
		assert.deepEqual(fitTarget(bbox, 3, 2, 0.5, EXTENT), { k: 3, cx: 50, cy: 0 });
	});

	it("caps a tight group (one node frames at a huge zoom)", () => {
		assert.equal(fitTarget(bbox, 1e6, 2, 0.5, EXTENT).k, 4);
	});

	it("stays inside the camera's zoom range", () => {
		assert.equal(fitTarget(bbox, 0.001, 0.001, 0.5, EXTENT).k, 0.02);
		assert.equal(fitTarget(bbox, 1e6, 30, 0.5, EXTENT).k, 40);
	});
});

describe("glideCamera", () => {
	const W = 800;
	const H = 600;
	const centerOf = (c: Camera) => ({ x: (W / 2 - c.x) / c.k, y: (H / 2 - c.y) / c.k });

	it("moves zoom (log space) and center (linear) by the same share", () => {
		const start: Camera = { k: 1, x: W / 2, y: H / 2 }; // world origin at the center
		const { camera, done } = glideCamera(start, { k: 4, cx: 100, cy: -40 }, 0.5, W, H);
		assert.equal(done, false);
		near(camera.k, 2); // halfway between 1 and 4 in log space
		const c = centerOf(camera);
		near(c.x, 50);
		near(c.y, -20);
	});

	it("blend 0 keeps the camera, blend 1 lands exactly", () => {
		const start: Camera = { k: 1.5, x: 10, y: -30 };
		const target = { k: 0.5, cx: 7, cy: 9 };
		const still = glideCamera(start, target, 0, W, H).camera;
		near(still.k, start.k);
		near(still.x, start.x);
		near(still.y, start.y);
		const landed = glideCamera(start, target, 1, W, H);
		assert.equal(landed.done, true);
		assert.equal(landed.camera.k, 0.5);
		near(landed.camera.x, W / 2 - 7 * 0.5);
		near(landed.camera.y, H / 2 - 9 * 0.5);
	});

	it("snaps onto the target once within half a pixel", () => {
		const target = { k: 2, cx: 0, cy: 0 };
		const almost: Camera = { k: 2.001, x: W / 2 + 0.2, y: H / 2 };
		const { camera, done } = glideCamera(almost, target, 0.1, W, H);
		assert.equal(done, true);
		assert.deepEqual(camera, { k: 2, x: W / 2, y: H / 2 });
	});

	it("converges under repeated frames", () => {
		let camera: Camera = { k: 0.3, x: -200, y: 500 };
		const target = { k: 5, cx: 12, cy: -8 };
		let done = false;
		for (let i = 0; i < 200 && !done; i++) ({ camera, done } = glideCamera(camera, target, 0.2, W, H));
		assert.equal(done, true);
		assert.equal(camera.k, 5);
	});
});

describe("GraphZoomControls", () => {
	const noop = () => {};
	const render = (canFit: boolean) =>
		parseHTML(renderToStaticMarkup(createElement(GraphZoomControls, { onZoomOut: noop, onFit: noop, onZoomIn: noop, canFit }))).document;

	it("renders −, fit, + in that order with their labels", () => {
		const labels = [...render(true).querySelectorAll("button")].map((b) => b.getAttribute("aria-label"));
		assert.deepEqual(labels, ["Zoom out", "Fit graph to view", "Zoom in"]);
	});

	it("disables only fit when no node is left to frame", () => {
		const enabled = render(true);
		assert.equal(enabled.querySelector('[data-testid="graph-zoom-fit"]')?.hasAttribute("disabled"), false);
		const disabled = render(false);
		assert.equal(disabled.querySelector('[data-testid="graph-zoom-fit"]')?.hasAttribute("disabled"), true);
		assert.equal(disabled.querySelector('[data-testid="graph-zoom-in"]')?.hasAttribute("disabled"), false);
		assert.equal(disabled.querySelector('[data-testid="graph-zoom-out"]')?.hasAttribute("disabled"), false);
	});

	it("steps by the viewers' 1.25", () => {
		assert.equal(ZOOM_STEP, 1.25);
	});
});
