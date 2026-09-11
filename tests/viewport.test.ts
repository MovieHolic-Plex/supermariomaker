import { describe, expect, test } from "bun:test";
import { backingTransform, canvasSize, panViewport, screenToWorld, worldToScreen, worldToCell, zoomViewport } from "../src/editor/viewport";

const bounds = { left: 237.5, top: 146.25, width: 731, height: 503 };
const point = { x: 417.25, y: -12.5 };

describe("editor viewport: client CSS coordinates, logical world, backing pixels", () => {
  for (const dpr of [1, 2]) for (const zoom of [1, 2, 4, 8] as const) {
    test(`roundtrip and actual drawing matrix at DPR ${dpr}, zoom ${zoom}`, () => {
      const view = { x: 113.5, y: -23.25, zoom };
      const screen = worldToScreen(point, view, bounds);
      expect(screenToWorld(screen, view, bounds)).toEqual(point);
      const [a, b, c, d, e, f] = backingTransform(view, dpr);
      expect(b).toBe(0); expect(c).toBe(0);
      expect(a * point.x + e).toBeCloseTo((screen.x - bounds.left) * dpr, 10);
      expect(d * point.y + f).toBeCloseTo((screen.y - bounds.top) * dpr, 10);
      expect(canvasSize(bounds, dpr)).toEqual({ width: bounds.width * dpr, height: bounds.height * dpr });
    });
  }
  for (const from of [1, 2, 4, 8] as const) for (const to of [1, 2, 4, 8] as const) {
    test(`pointer anchored zoom ${from} -> ${to}`, () => {
      const view = { x: -16.5, y: 127.25, zoom: from };
      const pointer = { x: 654.25, y: 349.5 };
      const anchor = screenToWorld(pointer, view, bounds);
      const next = zoomViewport(view, to, pointer, bounds);
      expect(next.zoom).toBe(to);
      expect(screenToWorld(pointer, next, bounds)).toEqual(anchor);
      expect(view).toEqual({ x: -16.5, y: 127.25, zoom: from });
    });
  }
  test("pan uses CSS delta exactly once and does not round fractional camera positions", () => {
    expect(panViewport({ x: 20, y: -10, zoom: 4 }, { x: 31, y: -19 })).toEqual({ x: 12.25, y: -5.25, zoom: 4 });
  });
  test("hit cells floor correctly on both sides of world origin", () => {
    expect(worldToCell({ x: 31.99, y: 16 })).toEqual({ x: 1, y: 1 });
    expect(worldToCell({ x: -0.1, y: -16.1 })).toEqual({ x: -1, y: -2 });
  });
  test("fractional CSS bounds allocate whole backing pixels", () => {
    expect(canvasSize({ width: 333.25, height: 197.75 }, 2)).toEqual({ width: 667, height: 396 });
  });
});
