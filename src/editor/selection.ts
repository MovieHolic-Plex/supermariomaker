import { deleteObjects, moveObjects, setCourseFields, type PixelDelta } from "./commands";
import { type CommitOutcome, type EditorHistory } from "./history";
import type { CourseV1, PlacedObject } from "../level/types";
import { objectBounds } from "../level/validate";

export type WorldPoint = Readonly<{ x: number; y: number }>;
export type WorldRect = Readonly<{ x0: number; y0: number; x1: number; y1: number }>;
export type EditorSelection = Readonly<{ areaId: string; objectIds: readonly string[] }>;
export type GestureCommit = CommitOutcome | Readonly<{ status: "cancelled" }>;
export type MovePreview = Readonly<{ dx: number; dy: number; valid: boolean }>;

export type MarqueeGesture = {
  extend(point: WorldPoint): void;
  preview(): WorldRect;
  commit(course: CourseV1): EditorSelection;
  cancel(): void;
};

export type MoveGesture = {
  extend(point: WorldPoint): void;
  preview(course: CourseV1): MovePreview;
  commit(history: EditorHistory): GestureCommit;
  cancel(): void;
};

export function emptySelection(areaId: string): EditorSelection {
  return { areaId, objectIds: [] };
}

function normalize(rect: WorldRect): Readonly<{ x: number; y: number; width: number; height: number }> {
  const x0 = Math.min(rect.x0, rect.x1), x1 = Math.max(rect.x0, rect.x1);
  const y0 = Math.min(rect.y0, rect.y1), y1 = Math.max(rect.y0, rect.y1);
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function intersects(
  a: Readonly<{ x: number; y: number; width: number; height: number }>,
  b: Readonly<{ x: number; y: number; width: number; height: number }>,
): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function containsPoint(
  box: Readonly<{ x: number; y: number; width: number; height: number }>,
  point: WorldPoint,
): boolean {
  return point.x >= box.x && point.x < box.x + box.width && point.y >= box.y && point.y < box.y + box.height;
}

function areaObjects(course: CourseV1, areaId: string): readonly PlacedObject[] {
  return course.areas.find((area) => area.id === areaId)?.objects ?? [];
}

/** Inclusive pixel marquee. A degenerate click hits objects that contain the origin. */
export function objectsInRect(course: CourseV1, areaId: string, rect: WorldRect): readonly PlacedObject[] {
  const box = normalize(rect);
  const objects = areaObjects(course, areaId);
  if (box.width === 0 && box.height === 0) {
    return objects.filter((object) => containsPoint(objectBounds(object), { x: box.x, y: box.y }));
  }
  return objects.filter((object) => intersects(objectBounds(object), box));
}

export function selectRect(course: CourseV1, areaId: string, rect: WorldRect): EditorSelection {
  return { areaId, objectIds: objectsInRect(course, areaId, rect).map((object) => object.id) };
}

/** Drop IDs that no longer exist in the selection's area. Never invent replacements. */
export function sanitizeSelection(selection: EditorSelection, course: CourseV1): EditorSelection {
  const live = new Set(areaObjects(course, selection.areaId).map((object) => object.id));
  return { areaId: selection.areaId, objectIds: selection.objectIds.filter((id) => live.has(id)) };
}

export function beginMarqueeGesture(input: Readonly<{ areaId: string; origin: WorldPoint }>): MarqueeGesture {
  let corner = input.origin, cancelled = false;
  return {
    extend(point) { if (!cancelled) corner = point; },
    preview() { return { x0: input.origin.x, y0: input.origin.y, x1: corner.x, y1: corner.y }; },
    commit(course) {
      if (cancelled) return emptySelection(input.areaId);
      return selectRect(course, input.areaId, { x0: input.origin.x, y0: input.origin.y, x1: corner.x, y1: corner.y });
    },
    cancel() { cancelled = true; },
  };
}

function snapGrid(delta: number): number {
  return Math.round(delta / 16) * 16;
}

function pixelDelta(origin: WorldPoint, corner: WorldPoint): PixelDelta {
  return { dx: snapGrid(corner.x - origin.x), dy: snapGrid(corner.y - origin.y) };
}

/** Drag translation is one history command. Out-of-area drafts are rejected, never partial. */
export function beginMoveGesture(input: Readonly<{ objectIds: readonly string[]; origin: WorldPoint }>): MoveGesture {
  let corner = input.origin, cancelled = false, finished = false;
  return {
    extend(point) { if (!cancelled && !finished) corner = point; },
    preview(course) {
      const delta = pixelDelta(input.origin, corner);
      const result = moveObjects(course, input.objectIds, delta);
      return { dx: delta.dx, dy: delta.dy, valid: result.ok };
    },
    commit(history) {
      if (cancelled) return { status: "cancelled" };
      if (finished) return { status: "noop", document: history.document() };
      const outcome = history.commit(moveObjects(history.document(), input.objectIds, pixelDelta(input.origin, corner)));
      if (outcome.status === "committed") finished = true;
      return outcome;
    },
    cancel() { cancelled = true; },
  };
}

export function deleteSelection(history: EditorHistory, selection: EditorSelection): CommitOutcome {
  if (selection.objectIds.length === 0) return { status: "noop", document: history.document() };
  return history.commit(deleteObjects(history.document(), selection.objectIds));
}

/** Inspector wiring: `history.commit(setCourseFields(...))` via this helper, values 0 or 30-999 only. */
export function commitCourseProperties(
  history: EditorHistory,
  patch: Readonly<{ title?: string; timerSeconds?: number }>,
): CommitOutcome {
  return history.commit(setCourseFields(history.document(), patch));
}
