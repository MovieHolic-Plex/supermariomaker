import { eraseTiles, fillTiles, previewFill, setTiles, stampCells, type Cell, type TileStamp } from "./commands";
import { type CommitOutcome, type EditorHistory } from "./history";
import type { CourseV1 } from "../level/types";

export type PaintTool = "paint" | "erase" | "fill";
export type PaintBrush = TileStamp;
export type GestureCommit = CommitOutcome | Readonly<{ status: "cancelled" }>;
export type PaintPreview = Readonly<{ cells: readonly Cell[]; clipped: boolean; outOfBounds: boolean }>;

export type PaintGesture = {
  extend(cell: Cell): void;
  preview(course: CourseV1): PaintPreview;
  commit(history: EditorHistory): GestureCommit;
  cancel(): void;
};

function inArea(width: number, height: number, cell: Cell): boolean {
  return Number.isSafeInteger(cell.x) && Number.isSafeInteger(cell.y)
    && cell.x >= 0 && cell.y >= 0 && cell.x < width && cell.y < height;
}

/** One drag is one command. Fill previews clip; fill commits reject any out-of-bounds rectangle. */
export function beginPaintGesture(input: Readonly<{
  areaId: string;
  tool: PaintTool;
  brush: PaintBrush;
  origin: Cell;
}>): PaintGesture {
  let cancelled = false, finished = false, corner = input.origin;
  const visited = new Map<string, Cell>();
  visited.set(`${input.origin.x},${input.origin.y}`, input.origin);
  return {
    extend(cell) {
      if (cancelled || finished) return;
      if (input.tool === "fill") { corner = cell; return; }
      visited.set(`${cell.x},${cell.y}`, cell);
    },
    preview(course) {
      const area = course.areas.find((item) => item.id === input.areaId);
      if (!area) return { cells: [], clipped: false, outOfBounds: true };
      if (input.tool === "fill") {
        const rect = { x0: input.origin.x, y0: input.origin.y, x1: corner.x, y1: corner.y };
        const cells = previewFill(area, rect);
        const range = {
          x0: Math.min(rect.x0, rect.x1), x1: Math.max(rect.x0, rect.x1),
          y0: Math.min(rect.y0, rect.y1), y1: Math.max(rect.y0, rect.y1),
        };
        const outOfBounds = !inArea(area.width, area.height, { x: range.x0, y: range.y0 })
          || !inArea(area.width, area.height, { x: range.x1, y: range.y1 });
        return { cells, clipped: outOfBounds, outOfBounds };
      }
      const cells = [...visited.values()].filter((cell) => inArea(area.width, area.height, cell));
      const clipped = cells.length !== visited.size;
      return { cells, clipped, outOfBounds: clipped };
    },
    commit(history) {
      if (cancelled) return { status: "cancelled" };
      if (finished) return { status: "noop", document: history.document() };
      const course = history.document();
      const area = course.areas.find((item) => item.id === input.areaId);
      const result = input.tool === "fill"
        ? fillTiles(course, input.areaId, { x0: input.origin.x, y0: input.origin.y, x1: corner.x, y1: corner.y }, input.brush)
        : input.tool === "erase"
          ? eraseTiles(course, input.areaId, area
            ? [...visited.values()].filter((cell) => inArea(area.width, area.height, cell))
            : [...visited.values()])
          : setTiles(course, input.areaId, stampCells(area
            ? [...visited.values()].filter((cell) => inArea(area.width, area.height, cell))
            : [...visited.values()], input.brush));
      const outcome = history.commit(result);
      if (outcome.status === "committed") finished = true;
      return outcome;
    },
    cancel() { cancelled = true; },
  };
}
