import { createObject, TILE_CATALOG, type ObjectRequest, validateObjectProperties } from "../level/catalog";
import type {
  AreaV1, BlockContent, CourseV1, PlacedObject, TileCell, TileKind, ValidationResult,
} from "../level/types";
import { validateCourse } from "../level/validate";

export type Cell = Readonly<{ x: number; y: number }>;
export type Rect = Readonly<{ x0: number; y0: number; x1: number; y1: number }>;
export type TileStamp = Readonly<{ kind: TileKind; content?: BlockContent }>;
export type PixelDelta = Readonly<{ dx: number; dy: number }>;
export type PasteOptions = Readonly<{ idFor: (id: string) => string; dx: number; dy: number }>;
export type PasteResult = Readonly<{ course: CourseV1; omittedIds: readonly string[] }>;

const missingArea: ValidationResult<never> = { ok: false, error: { code: "invalid_reference", path: "$.areaId", message: "Placement area does not exist" } };
const outOfBounds: ValidationResult<never> = { ok: false, error: { code: "out_of_bounds", path: "$.cells", message: "Edit must fit the area" } };
const invalidCell: ValidationResult<never> = { ok: false, error: { code: "invalid_value", path: "$.cells", message: "Cells must use integer coordinates" } };

function assertNever(value: never): never { throw new Error(`Unsupported command variant: ${String(value)}`); }
function areaById(course: CourseV1, areaId: string): AreaV1 | undefined {
  return course.areas.find((area) => area.id === areaId);
}
function replaceArea(course: CourseV1, areaId: string, area: AreaV1): CourseV1 {
  return { ...course, areas: course.areas.map((item) => item.id === areaId ? area : item) };
}
function integers(values: readonly number[]): boolean {
  return values.every((value) => Number.isSafeInteger(value));
}
function bounds(area: AreaV1, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < area.width && y < area.height;
}
function keyOf(x: number, y: number): string { return `${x},${y}`; }
function sortedRect(rect: Rect): Readonly<{ x0: number; y0: number; x1: number; y1: number }> {
  return {
    x0: Math.min(rect.x0, rect.x1), x1: Math.max(rect.x0, rect.x1),
    y0: Math.min(rect.y0, rect.y1), y1: Math.max(rect.y0, rect.y1),
  };
}

function stampTile(x: number, y: number, stamp: TileStamp): TileCell {
  switch (stamp.kind) {
    case "brick": case "question": case "hidden": {
      const content = Object.hasOwn(stamp, "content") ? stamp.content : TILE_CATALOG[stamp.kind].defaults.content;
      return content === undefined ? { x, y, kind: stamp.kind } : { x, y, kind: stamp.kind, content };
    }
    case "ground": case "used": case "hard": case "coin":
      return { x, y, kind: stamp.kind };
    default: return assertNever(stamp.kind);
  }
}

/** Inclusive rectangle clipped to area cells. Empty when the clipped range is inverted. */
export function previewFill(area: AreaV1, rect: Rect): readonly Cell[] {
  if (!integers([rect.x0, rect.y0, rect.x1, rect.y1])) return [];
  const range = sortedRect(rect);
  const x0 = Math.max(0, range.x0), x1 = Math.min(area.width - 1, range.x1);
  const y0 = Math.max(0, range.y0), y1 = Math.min(area.height - 1, range.y1);
  if (x0 > x1 || y0 > y1) return [];
  const cells: Cell[] = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) cells.push({ x, y });
  return cells;
}

export function setTiles(course: CourseV1, areaId: string, cells: readonly TileCell[]): ValidationResult<CourseV1> {
  const area = areaById(course, areaId);
  if (!area) return missingArea;
  const overlay = new Map<string, TileCell>();
  for (const cell of cells) {
    if (!integers([cell.x, cell.y])) return invalidCell;
    if (!bounds(area, cell.x, cell.y)) return outOfBounds;
    overlay.set(keyOf(cell.x, cell.y), cell);
  }
  const keys = new Set(overlay.keys());
  return validateCourse(replaceArea(course, areaId, {
    ...area, tiles: [...area.tiles.filter((tile) => !keys.has(keyOf(tile.x, tile.y))), ...overlay.values()],
  }));
}

export function eraseTiles(course: CourseV1, areaId: string, cells: readonly Cell[]): ValidationResult<CourseV1> {
  const area = areaById(course, areaId);
  if (!area) return missingArea;
  const keys = new Set<string>();
  for (const cell of cells) {
    if (!integers([cell.x, cell.y])) return invalidCell;
    if (bounds(area, cell.x, cell.y)) keys.add(keyOf(cell.x, cell.y));
  }
  return validateCourse(replaceArea(course, areaId, {
    ...area, tiles: area.tiles.filter((tile) => !keys.has(keyOf(tile.x, tile.y))),
  }));
}

export function fillTiles(course: CourseV1, areaId: string, rect: Rect, stamp: TileStamp): ValidationResult<CourseV1> {
  const area = areaById(course, areaId);
  if (!area) return missingArea;
  if (!integers([rect.x0, rect.y0, rect.x1, rect.y1])) return invalidCell;
  const range = sortedRect(rect);
  if (!bounds(area, range.x0, range.y0) || !bounds(area, range.x1, range.y1)) return outOfBounds;
  const cells: TileCell[] = [];
  for (let y = range.y0; y <= range.y1; y++) for (let x = range.x0; x <= range.x1; x++) cells.push(stampTile(x, y, stamp));
  return setTiles(course, areaId, cells);
}

export function placeObject(course: CourseV1, areaId: string, request: ObjectRequest): ValidationResult<CourseV1> {
  const created = createObject({ course, areaId }, request);
  if (!created.ok) return created;
  const area = areaById(course, areaId);
  if (!area) return missingArea;
  return validateCourse(replaceArea(course, areaId, { ...area, objects: [...area.objects, created.value] }));
}

export function setObjectProperties(course: CourseV1, areaId: string, objectId: string, props: unknown): ValidationResult<CourseV1> {
  const checked = validateObjectProperties({ course, areaId }, objectId, props);
  if (!checked.ok) return checked;
  const area = areaById(course, areaId);
  if (!area) return missingArea;
  return validateCourse(replaceArea(course, areaId, {
    ...area, objects: area.objects.map((object) => object.id === objectId ? checked.value : object),
  }));
}

export function setCourseFields(course: CourseV1, patch: Readonly<{ title?: string; timerSeconds?: number }>): ValidationResult<CourseV1> {
  return validateCourse({
    ...course,
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.timerSeconds !== undefined ? { timerSeconds: patch.timerSeconds } : {}),
  });
}

function derivePiranhas(objects: readonly PlacedObject[]): PlacedObject[] {
  const pipes = new Map<string, Extract<PlacedObject, { kind: "pipe" }>>();
  for (const object of objects) if (object.kind === "pipe") pipes.set(object.id, object);
  return objects.map((object) => {
    if (object.kind !== "piranha") return object;
    const pipe = pipes.get(object.props.pipeId);
    if (!pipe) return object;
    return { id: object.id, kind: "piranha", x: pipe.x, y: pipe.y - pipe.props.height * 16, props: { pipeId: object.props.pipeId } };
  });
}

function withoutPairId(object: Extract<PlacedObject, { kind: "platform" }>): PlacedObject {
  return { id: object.id, kind: "platform", x: object.x, y: object.y, props: { motion: "balance", length: object.props.length, travel: object.props.travel, speed: object.props.speed } };
}

function cleanObject(object: PlacedObject, removed: ReadonlySet<string>): PlacedObject {
  switch (object.kind) {
    case "pipe":
      return object.props.destination && removed.has(object.props.destination.pipeId)
        ? { ...object, props: { height: object.props.height, entrance: object.props.entrance } } : object;
    case "platform":
      return object.props.motion === "balance" && object.props.pairId && removed.has(object.props.pairId)
        ? withoutPairId(object) : object;
    case "castleGoal":
      return object.props.bowserId && removed.has(object.props.bowserId)
        ? { ...object, props: { bridge: object.props.bridge } } : object;
    case "warpZone": {
      const pipeIds = object.props.pipeIds.map((slot) => slot !== null && removed.has(slot) ? null : slot);
      const first = pipeIds[0], second = pipeIds[1], third = pipeIds[2];
      if (first === undefined || second === undefined || third === undefined) return object;
      return { ...object, props: { pipeIds: [first, second, third] } };
    }
    case "spring": case "flagGoal": case "goomba": case "koopa": case "paratroopa": case "piranha":
    case "buzzy": case "billCannon": case "hammerBro": case "lakitu": case "cheep": case "blooper":
    case "podoboo": case "firebar": case "bowser":
      return object;
    default: return assertNever(object);
  }
}

function expandRemoved(course: CourseV1, ids: readonly string[]): Set<string> {
  const removed = new Set(ids);
  let grew = true;
  while (grew) {
    grew = false;
    for (const area of course.areas) {
      for (const object of area.objects) {
        if (removed.has(object.id)) continue;
        if (object.kind === "piranha" && removed.has(object.props.pipeId)) { removed.add(object.id); grew = true; }
      }
    }
  }
  return removed;
}

/** Deletes ids plus attached Piranhas and clears surviving references in the same draft. */
export function deleteObjects(course: CourseV1, ids: readonly string[]): ValidationResult<CourseV1> {
  const removed = expandRemoved(course, ids);
  return validateCourse({
    ...course,
    areas: course.areas.map((area) => ({
      ...area,
      objects: area.objects.flatMap((object) => removed.has(object.id) ? [] : [cleanObject(object, removed)]),
    })),
  });
}

function translateObject(object: PlacedObject, delta: PixelDelta): PlacedObject {
  const x = object.x + delta.dx, y = object.y + delta.dy;
  if (object.kind !== "castleGoal") return { ...object, x, y };
  return {
    ...object, x, y,
    props: {
      bridge: {
        x: object.props.bridge.x + delta.dx / 16, y: object.props.bridge.y + delta.dy / 16,
        width: object.props.bridge.width, height: 1,
      },
      ...(object.props.bowserId !== undefined ? { bowserId: object.props.bowserId } : {}),
    },
  };
}

export function moveObjects(course: CourseV1, ids: readonly string[], delta: PixelDelta): ValidationResult<CourseV1> {
  const moving = new Set(ids);
  for (const area of course.areas) {
    for (const object of area.objects) {
      if (object.kind === "piranha" && moving.has(object.props.pipeId)) moving.add(object.id);
    }
  }
  return validateCourse({
    ...course,
    areas: course.areas.map((area) => ({
      ...area,
      objects: derivePiranhas(area.objects.map((object) => moving.has(object.id) ? translateObject(object, delta) : object)),
    })),
  });
}

function remapObject(object: PlacedObject, id: string, areaId: string, idMap: ReadonlyMap<string, string>, delta: PixelDelta): PlacedObject {
  const x = object.x + delta.dx, y = object.y + delta.dy;
  switch (object.kind) {
    case "pipe": {
      const pipeId = object.props.destination ? idMap.get(object.props.destination.pipeId) : undefined;
      return {
        id, kind: "pipe", x, y,
        props: { height: object.props.height, entrance: object.props.entrance, ...(pipeId ? { destination: { areaId, pipeId } } : {}) },
      };
    }
    case "platform": {
      if (object.props.motion !== "balance") {
        return { id, kind: "platform", x, y, props: { motion: object.props.motion, length: object.props.length, travel: object.props.travel, speed: object.props.speed } };
      }
      const pairId = object.props.pairId ? idMap.get(object.props.pairId) : undefined;
      return { id, kind: "platform", x, y, props: { motion: "balance", length: object.props.length, travel: object.props.travel, speed: object.props.speed, ...(pairId ? { pairId } : {}) } };
    }
    case "spring": case "goomba": case "buzzy": case "billCannon": case "hammerBro":
    case "lakitu": case "blooper": case "podoboo": case "bowser":
      return { id, kind: object.kind, x, y, props: {} };
    case "flagGoal":
      return { id, kind: "flagGoal", x, y, props: { height: object.props.height } };
    case "castleGoal": {
      const bowserId = object.props.bowserId ? idMap.get(object.props.bowserId) : undefined;
      return {
        id, kind: "castleGoal", x, y,
        props: {
          bridge: { x: object.props.bridge.x + delta.dx / 16, y: object.props.bridge.y + delta.dy / 16, width: object.props.bridge.width, height: 1 },
          ...(bowserId ? { bowserId } : {}),
        },
      };
    }
    case "koopa":
      return { id, kind: "koopa", x, y, props: { color: object.props.color } };
    case "paratroopa":
      return { id, kind: "paratroopa", x, y, props: { color: object.props.color, motion: object.props.motion } };
    case "piranha": {
      const pipeId = idMap.get(object.props.pipeId) ?? object.props.pipeId;
      return { id, kind: "piranha", x, y, props: { pipeId } };
    }
    case "cheep":
      return { id, kind: "cheep", x, y, props: { color: object.props.color, mode: object.props.mode } };
    case "firebar":
      return { id, kind: "firebar", x, y, props: { length: object.props.length, direction: object.props.direction, speed: object.props.speed } };
    case "warpZone": {
      const pipeIds = object.props.pipeIds.map((slot) => slot === null ? null : idMap.get(slot) ?? null);
      const first = pipeIds[0], second = pipeIds[1], third = pipeIds[2];
      if (first === undefined || second === undefined || third === undefined) {
        return { id, kind: "warpZone", x, y, props: { pipeIds: [null, null, null] } };
      }
      return { id, kind: "warpZone", x, y, props: { pipeIds: [first, second, third] } };
    }
    default: return assertNever(object);
  }
}

export function pasteObjects(
  course: CourseV1, areaId: string, objects: readonly PlacedObject[], options: PasteOptions,
): ValidationResult<PasteResult> {
  const area = areaById(course, areaId);
  if (!area) return missingArea;
  const copied = new Set(objects.map((object) => object.id));
  const omittedIds: string[] = [];
  const selected: PlacedObject[] = [];
  for (const object of objects) {
    if (object.kind === "piranha" && !copied.has(object.props.pipeId)) omittedIds.push(object.id);
    else selected.push(object);
  }
  if (selected.length === 0) return { ok: true, value: { course, omittedIds } };
  const idMap = new Map(selected.map((object) => [object.id, options.idFor(object.id)]));
  const pasted = derivePiranhas(selected.map((object) => {
    const id = idMap.get(object.id);
    if (!id) return object;
    return remapObject(object, id, areaId, idMap, { dx: options.dx, dy: options.dy });
  }));
  const result = validateCourse(replaceArea(course, areaId, { ...area, objects: [...area.objects, ...pasted] }));
  if (!result.ok) return result;
  return { ok: true, value: { course: result.value, omittedIds } };
}

export function stampCells(cells: readonly Cell[], stamp: TileStamp): readonly TileCell[] {
  return cells.map((cell) => stampTile(cell.x, cell.y, stamp));
}
