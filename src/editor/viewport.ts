export const EDITOR_ZOOMS = [1, 2, 4, 8] as const;
export type EditorZoom = typeof EDITOR_ZOOMS[number];
export interface Point { readonly x: number; readonly y: number }
/** Camera is the world point at the canvas's top-left CSS content edge. */
export interface Viewport extends Point { readonly zoom: EditorZoom }
export interface CanvasBounds { readonly left: number; readonly top: number }
export function screenToWorld(point: Point, view: Viewport, bounds: CanvasBounds): Point {
  return { x: (point.x - bounds.left) / view.zoom + view.x, y: (point.y - bounds.top) / view.zoom + view.y };
}
export function worldToScreen(point: Point, view: Viewport, bounds: CanvasBounds): Point {
  return { x: (point.x - view.x) * view.zoom + bounds.left, y: (point.y - view.y) * view.zoom + bounds.top };
}
export function worldToCell(point: Point): Point { return { x: Math.floor(point.x / 16), y: Math.floor(point.y / 16) }; }
export function panViewport(view: Viewport, delta: Point): Viewport {
  return { ...view, x: view.x - delta.x / view.zoom, y: view.y - delta.y / view.zoom };
}
export function zoomViewport(view: Viewport, zoom: EditorZoom, pointer: Point, bounds: CanvasBounds): Viewport {
  const anchor = screenToWorld(pointer, view, bounds);
  return { x: anchor.x - (pointer.x - bounds.left) / zoom, y: anchor.y - (pointer.y - bounds.top) / zoom, zoom };
}
export function canvasSize(size: Readonly<{ width: number; height: number }>, dpr: number) {
  return { width: Math.round(size.width * dpr), height: Math.round(size.height * dpr) };
}
/** The sole world -> device transform. Pointer events never contain device pixels. */
export function backingTransform(view: Viewport, dpr: number): [number, number, number, number, number, number] {
  const scale = view.zoom * dpr;
  return [scale, 0, 0, scale, -view.x * scale, -view.y * scale];
}
