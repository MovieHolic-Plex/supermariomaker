import { deleteObjects, placeObject } from "./commands";
import { COURSE_LIMITS } from "../level/types";
import type {
  AreaV1, CourseStart, CourseV1, PlacedObject, Theme, TileCell, ValidationResult,
} from "../level/types";
import { objectBounds, validateCourse } from "../level/validate";

export type PipeRef = Readonly<{ areaId: string; pipeId: string }>;
export type ResizePreview = Readonly<{
  ok: boolean;
  blocked: boolean;
  tiles: readonly TileCell[];
  objects: readonly PlacedObject[];
}>;

const missing = (path: string, message: string): ValidationResult<never> =>
  ({ ok: false, error: { code: "invalid_reference", path, message } });

function areaById(course: CourseV1, areaId: string): AreaV1 | undefined {
  return course.areas.find(area => area.id === areaId);
}

function asPipe(object: PlacedObject | undefined): Extract<PlacedObject, { kind: "pipe" }> | undefined {
  return object?.kind === "pipe" ? object : undefined;
}

function fitsPixels(bounds: Readonly<{ x: number; y: number; width: number; height: number }>, width: number, height: number): boolean {
  return bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= width * 16 && bounds.y + bounds.height <= height * 16;
}

function objectFits(object: PlacedObject, width: number, height: number): boolean {
  if (!fitsPixels(objectBounds(object), width, height)) return false;
  if (object.kind !== "castleGoal") return true;
  const bridge = object.props.bridge;
  return fitsPixels({ x: bridge.x * 16, y: bridge.y * 16, width: bridge.width * 16, height: 16 }, width, height);
}

function startFits(start: CourseStart, width: number, height: number): boolean {
  return fitsPixels({ x: start.x - 6, y: start.y - 15, width: 12, height: 15 }, width, height);
}

function groundTiles(width: number, height: number): TileCell[] {
  return Array.from({ length: width * 2 }, (_, i) => ({ x: i % width, y: height - 2 + Math.floor(i / width), kind: "ground" as const }));
}

export function placePipe(
  course: CourseV1, areaId: string,
  request: Readonly<{ id: string; x: number; y: number; height?: number; entrance?: "none" | "down" | "up" }>,
): ValidationResult<CourseV1> {
  return placeObject(course, areaId, {
    id: request.id, kind: "pipe", x: request.x, y: request.y,
    props: { height: request.height ?? 3, entrance: request.entrance ?? "down" },
  });
}

export function linkPipes(course: CourseV1, from: PipeRef, to: PipeRef): ValidationResult<CourseV1> {
  if (from.pipeId === to.pipeId) return missing("$.pipeId", "Pipe links must name distinct reciprocal pipes");
  const source = asPipe(areaById(course, from.areaId)?.objects.find(object => object.id === from.pipeId));
  const dest = asPipe(areaById(course, to.areaId)?.objects.find(object => object.id === to.pipeId));
  if (!source || !dest) return missing("$.pipeId", "Pipe links must name distinct reciprocal pipes");
  return validateCourse({
    ...course,
    areas: course.areas.map(area => ({
      ...area,
      objects: area.objects.map(object => {
        if (object.id === source.id && object.kind === "pipe") {
          return { ...object, props: { height: object.props.height, entrance: object.props.entrance, destination: { areaId: to.areaId, pipeId: to.pipeId } } };
        }
        if (object.id === dest.id && object.kind === "pipe") {
          return { ...object, props: { height: object.props.height, entrance: object.props.entrance, destination: { areaId: from.areaId, pipeId: from.pipeId } } };
        }
        return object;
      }),
    })),
  });
}

export function warpLabels(course: CourseV1, warp: Extract<PlacedObject, { kind: "warpZone" }>): readonly [string, string, string] {
  const owner = course.areas.find(area => area.objects.some(object => object.id === warp.id));
  const label = (slot: string | null): string => {
    if (!slot) return "-";
    const pipe = asPipe(owner?.objects.find(object => object.id === slot));
    const dest = pipe?.props.destination;
    if (!dest) return "-";
    return course.areas.find(area => area.id === dest.areaId)?.name ?? "-";
  };
  return [label(warp.props.pipeIds[0]), label(warp.props.pipeIds[1]), label(warp.props.pipeIds[2])];
}

export function createArea(course: CourseV1, request: Readonly<{ id: string; name?: string; theme?: Theme; width?: number; height?: number }>): ValidationResult<CourseV1> {
  if (course.areas.length >= COURSE_LIMITS.areas) {
    return { ok: false, error: { code: "limit_exceeded", path: "$.areas", message: "Course needs 1-16 areas" } };
  }
  const width = request.width ?? 32, height = request.height ?? 15;
  const area: AreaV1 = {
    id: request.id,
    name: request.name ?? `영역 ${course.areas.length + 1}`,
    theme: request.theme ?? "overworld",
    width, height,
    tiles: groundTiles(width, height),
    objects: [],
  };
  return validateCourse({ ...course, areas: [...course.areas, area] });
}

export function renameArea(course: CourseV1, areaId: string, name: string): ValidationResult<CourseV1> {
  const area = areaById(course, areaId);
  if (!area) return missing("$.areaId", "Area does not exist");
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 80) {
    return { ok: false, error: { code: "invalid_value", path: "$.name", message: "Area name must be trimmed and 1-80 characters" } };
  }
  return validateCourse({
    ...course,
    areas: course.areas.map(item => item.id === areaId ? { ...item, name: trimmed } : item),
  });
}

export function setAreaTheme(course: CourseV1, areaId: string, theme: Theme): ValidationResult<CourseV1> {
  const area = areaById(course, areaId);
  if (!area) return missing("$.areaId", "Area does not exist");
  return validateCourse({
    ...course,
    areas: course.areas.map(item => item.id === areaId ? { ...item, theme } : item),
  });
}

function cropLists(area: AreaV1, width: number, height: number): { tiles: TileCell[]; objects: PlacedObject[] } {
  return {
    tiles: area.tiles.filter(tile => tile.x >= width || tile.y >= height),
    objects: area.objects.filter(object => !objectFits(object, width, height)),
  };
}

export function previewResize(course: CourseV1, areaId: string, width: number, height: number): ResizePreview {
  const area = areaById(course, areaId);
  if (!area) return { ok: false, blocked: false, tiles: [], objects: [] };
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)
    || width < COURSE_LIMITS.minWidth || width > COURSE_LIMITS.maxWidth
    || height < COURSE_LIMITS.minHeight || height > COURSE_LIMITS.maxHeight) {
    return { ok: false, blocked: false, tiles: [], objects: [] };
  }
  const cropped = cropLists(area, width, height);
  const blocked = course.start.areaId === areaId && !startFits(course.start, width, height);
  return { ok: true, blocked, tiles: cropped.tiles, objects: cropped.objects };
}

export function resizeArea(course: CourseV1, areaId: string, width: number, height: number): ValidationResult<CourseV1> {
  const preview = previewResize(course, areaId, width, height);
  if (!preview.ok) {
    return { ok: false, error: { code: "invalid_value", path: "$.width", message: "Area size must be 32-4096 by 15-128" } };
  }
  if (preview.blocked) {
    return { ok: false, error: { code: "start_blocked", path: "$.start", message: "Move the start before shrinking this area" } };
  }
  const area = areaById(course, areaId);
  if (!area) return missing("$.areaId", "Area does not exist");
  const removed = preview.objects.map(object => object.id);
  const cleaned: ValidationResult<CourseV1> = removed.length ? deleteObjects(course, removed) : { ok: true, value: course };
  if (!cleaned.ok) return cleaned;
  return validateCourse({
    ...cleaned.value,
    areas: cleaned.value.areas.map(item => item.id === areaId ? {
      ...item, width, height,
      tiles: item.tiles.filter(tile => tile.x < width && tile.y < height),
    } : item),
  });
}

export function deleteArea(course: CourseV1, areaId: string, replacement?: Readonly<{ start: CourseStart }>): ValidationResult<CourseV1> {
  if (course.areas.length <= 1) {
    return { ok: false, error: { code: "limit_exceeded", path: "$.areas", message: "Course needs 1-16 areas" } };
  }
  const area = areaById(course, areaId);
  if (!area) return missing("$.areaId", "Area does not exist");
  if (course.start.areaId === areaId && (!replacement || replacement.start.areaId === areaId)) {
    return missing("$.start.areaId", "Choose another start area before deleting the start area");
  }
  const cleaned = deleteObjects(course, area.objects.map(object => object.id));
  if (!cleaned.ok) return cleaned;
  const start = course.start.areaId === areaId && replacement ? replacement.start : cleaned.value.start;
  const remaining = cleaned.value.areas.filter(item => item.id !== areaId);
  const mainAreaId = cleaned.value.mainAreaId === areaId ? start.areaId : cleaned.value.mainAreaId;
  return validateCourse({ ...cleaned.value, areas: remaining, start, mainAreaId });
}
