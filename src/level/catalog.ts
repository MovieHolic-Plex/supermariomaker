// allow: SIZE_OK - the complete v1 catalog is one typed data table plus its pure construction boundary.
import { getFrame, type AssetKey } from "../assets/manifest";
import { BLOCK_CONTENTS, COURSE_LIMITS } from "./types";
import type { AreaV1, Bounds, CourseV1, EmptyProps, ObjectKind, ObjectProps, PlacedObject, TileCell, TileKind, ValidationResult } from "./types";
import { objectBounds, validateCourse } from "./validate";

export const CATALOG_CATEGORIES = {
  terrain: "지형", items: "아이템", devices: "장치", goals: "목표", enemies: "적", projectiles: "발사체",
} as const;
export type CatalogCategory = keyof typeof CATALOG_CATEGORIES;
type Keys<T> = T extends unknown ? keyof T : never;
type Value<T, K extends PropertyKey> = T extends unknown ? K extends keyof T ? T[K] : never : never;
type Reference = Readonly<{ type: "reference"; target: ObjectKind | "area"; scope: "same-area" | "course"; reciprocal?: true; distinct?: true }>;
export type PropertyField<T> = Readonly<{ label: string; optional?: true; when?: Readonly<{ property: "motion"; equals: "balance" }> }> & (
  [NonNullable<T>] extends [number] ? Readonly<{ type: "integer"; min: number; max: number; unit: "cells"; maximumFrom?: "area.width-1" | "area.height-1" }> | Readonly<{ type: "choice"; values: readonly NonNullable<T>[] }>
  : [NonNullable<T>] extends [string] ? Readonly<{ type: "choice"; values: readonly NonNullable<T>[] }> | Reference
  : [NonNullable<T>] extends [readonly (string | null)[]] ? Readonly<{ type: "pipe-slots"; length: 3; nullable: true; distinct: true; scope: "same-area" }>
  : Readonly<{ type: "record"; fields: PropertySchema<NonNullable<T>> }>
);
export type PropertySchema<T> = { readonly [K in Keys<T>]-?: PropertyField<Value<T, K>> };
type Position = Readonly<{ x: number; y: number }>;
type PipeObject = Extract<PlacedObject, { kind: "pipe" }>;
type ObjectEntry<K extends ObjectKind> = Readonly<{
  kind: K; placeable: true; category: CatalogCategory; label: string;
  assetKey: AssetKey; frames: readonly [AssetKey, ...AssetKey[]];
  defaults: K extends "piranha" ? (pipe: PipeObject) => ObjectProps[K]
    : K extends "castleGoal" ? (position: Position) => ObjectProps[K] : ObjectProps[K];
  properties: PropertySchema<ObjectProps[K]>;
  bounds: typeof objectBounds;
}>;
const color = { label: "색상", type: "choice", values: ["green", "red"] } as const;
const content = { label: "내용물", type: "choice", values: BLOCK_CONTENTS, optional: true } as const;
type TileProps<K extends TileKind> = K extends "brick" | "question" | "hidden" ? Readonly<{ content?: typeof BLOCK_CONTENTS[number] }> : EmptyProps;
type TileEntry<K extends TileKind> = Readonly<{
  kind: K; placeable: true; category: CatalogCategory; label: string; assetKey: AssetKey;
  frames: readonly [AssetKey, ...AssetKey[]]; defaults: TileProps<K>; properties: PropertySchema<TileProps<K>>;
  bounds: (position: Position) => Bounds;
}>;
/** Tile input coordinates and bridge fields are cells; object coordinates are bottom-center pixels. */
const tileBounds = ({ x, y }: Position): Bounds => ({ x: x * 16, y: y * 16, width: 16, height: 16 });
export const TILE_CATALOG = {
  ground: { kind: "ground", placeable: true, category: "terrain", label: "땅", assetKey: "tile.ground", frames: ["tile.ground"], defaults: {}, properties: {}, bounds: tileBounds },
  brick: { kind: "brick", placeable: true, category: "terrain", label: "벽돌", assetKey: "tile.brick", frames: ["tile.brick"], defaults: { content: "none" }, properties: { content }, bounds: tileBounds },
  question: { kind: "question", placeable: true, category: "terrain", label: "물음표 블록", assetKey: "tile.question", frames: ["tile.question"], defaults: { content: "coin" }, properties: { content }, bounds: tileBounds },
  hidden: { kind: "hidden", placeable: true, category: "terrain", label: "숨은 블록", assetKey: "tile.hidden", frames: ["tile.hidden"], defaults: { content: "coin" }, properties: { content }, bounds: tileBounds },
  used: { kind: "used", placeable: true, category: "terrain", label: "사용한 블록", assetKey: "tile.used", frames: ["tile.used"], defaults: {}, properties: {}, bounds: tileBounds },
  hard: { kind: "hard", placeable: true, category: "terrain", label: "단단한 블록", assetKey: "tile.hard", frames: ["tile.hard"], defaults: {}, properties: {}, bounds: tileBounds },
  coin: { kind: "coin", placeable: true, category: "items", label: "코인", assetKey: "tile.coin", frames: ["tile.coin"], defaults: {}, properties: {}, bounds: tileBounds },
} as const satisfies { [K in TileKind]: TileEntry<K> };

export const OBJECT_CATALOG = {
  pipe: { kind: "pipe", placeable: true, category: "devices", label: "토관", assetKey: "decor.pipeCap", frames: ["decor.pipeCap", "decor.pipeBody"], defaults: { height: 3, entrance: "down" }, properties: {
    height: { label: "높이", type: "integer", min: 2, max: 16, unit: "cells" }, entrance: { label: "입구", type: "choice", values: ["none", "down", "up"] },
    destination: { label: "연결 토관", type: "record", optional: true, fields: {
      areaId: { label: "영역", type: "reference", target: "area", scope: "course" },
      pipeId: { label: "토관", type: "reference", target: "pipe", scope: "course", reciprocal: true, distinct: true },
    } },
  }, bounds: objectBounds },
  platform: { kind: "platform", placeable: true, category: "devices", label: "발판", assetKey: "decor.platform", frames: ["decor.platform"], defaults: { motion: "horizontal", length: 3, travel: 8, speed: 1 }, properties: {
    motion: { label: "이동", type: "choice", values: ["horizontal", "vertical", "falling", "balance"] },
    length: { label: "길이", type: "integer", min: 2, max: 8, unit: "cells" }, travel: { label: "이동 거리", type: "integer", min: 1, max: 32, unit: "cells" },
    speed: { label: "속도", type: "choice", values: [0.5, 1, 2] },
    pairId: { label: "균형 짝", type: "reference", target: "platform", scope: "same-area", reciprocal: true, distinct: true, optional: true, when: { property: "motion", equals: "balance" } },
  }, bounds: objectBounds },
  spring: { kind: "spring", placeable: true, category: "devices", label: "스프링", assetKey: "decor.springExtended", frames: ["decor.springExtended", "decor.springCompressed"], defaults: {}, properties: {}, bounds: objectBounds },
  flagGoal: { kind: "flagGoal", placeable: true, category: "goals", label: "깃발 목표", assetKey: "decor.flag", frames: ["decor.flag", "decor.pole", "decor.smallCastle"], defaults: { height: 9 }, properties: {
    height: { label: "깃대 높이", type: "integer", min: 4, max: 12, unit: "cells" },
  }, bounds: objectBounds },
  castleGoal: { kind: "castleGoal", placeable: true, category: "goals", label: "성 목표", assetKey: "decor.axe", frames: ["decor.axe", "decor.bridge", "decor.chain"],
    // Axe occupies cell x/16; the eight bridge cells end at x/16 - 1. Never clamp a negative start.
    defaults: ({ x, y }: Position) => ({ bridge: { x: x / 16 - 8, y: y / 16, width: 8, height: 1 } }), properties: {
      bridge: { label: "다리", type: "record", fields: {
        x: { label: "가로 위치", type: "integer", min: 0, max: COURSE_LIMITS.maxWidth - 1, unit: "cells", maximumFrom: "area.width-1" },
        y: { label: "세로 위치", type: "integer", min: 0, max: COURSE_LIMITS.maxHeight - 1, unit: "cells", maximumFrom: "area.height-1" },
        width: { label: "너비", type: "integer", min: 1, max: 64, unit: "cells" }, height: { label: "높이", type: "choice", values: [1] },
      } }, bowserId: { label: "쿠파", type: "reference", target: "bowser", scope: "same-area", optional: true },
    }, bounds: objectBounds },
  goomba: { kind: "goomba", placeable: true, category: "enemies", label: "굼바", assetKey: "enemy.goomba.walk1", frames: ["enemy.goomba.walk1", "enemy.goomba.walk2", "enemy.goomba.squashed"], defaults: {}, properties: {}, bounds: objectBounds },
  koopa: { kind: "koopa", placeable: true, category: "enemies", label: "엉금엉금", assetKey: "enemy.koopa.green.walk1", frames: ["enemy.koopa.green.walk1", "enemy.koopa.green.walk2", "enemy.koopa.red.walk1", "enemy.koopa.red.walk2"], defaults: { color: "green" }, properties: { color }, bounds: objectBounds },
  paratroopa: { kind: "paratroopa", placeable: true, category: "enemies", label: "펄럭펄럭", assetKey: "enemy.koopa.green.wings1", frames: ["enemy.koopa.green.wings1", "enemy.koopa.green.wings2", "enemy.koopa.red.wings1", "enemy.koopa.red.wings2"], defaults: { color: "green", motion: "hop" }, properties: { color, motion: { label: "이동", type: "choice", values: ["hop", "vertical"] } }, bounds: objectBounds },
  piranha: { kind: "piranha", placeable: true, category: "enemies", label: "뻐끔플라워", assetKey: "enemy.piranha.open", frames: ["enemy.piranha.open", "enemy.piranha.closed"], defaults: (pipe: PipeObject) => ({ pipeId: pipe.id }), properties: { pipeId: { label: "붙일 토관", type: "reference", target: "pipe", scope: "same-area" } }, bounds: objectBounds },
  buzzy: { kind: "buzzy", placeable: true, category: "enemies", label: "하잉바", assetKey: "enemy.buzzy.walk1", frames: ["enemy.buzzy.walk1", "enemy.buzzy.walk2"], defaults: {}, properties: {}, bounds: objectBounds },
  billCannon: { kind: "billCannon", placeable: true, category: "devices", label: "킬러 대포", assetKey: "enemy.cannon", frames: ["enemy.cannon"], defaults: {}, properties: {}, bounds: objectBounds },
  hammerBro: { kind: "hammerBro", placeable: true, category: "enemies", label: "해머브러스", assetKey: "enemy.hammerBro.walk1", frames: ["enemy.hammerBro.walk1", "enemy.hammerBro.walk2", "enemy.hammerBro.throw"], defaults: {}, properties: {}, bounds: objectBounds },
  lakitu: { kind: "lakitu", placeable: true, category: "enemies", label: "김수한무", assetKey: "enemy.lakitu.ride", frames: ["enemy.lakitu.ride", "enemy.lakitu.throw"], defaults: {}, properties: {}, bounds: objectBounds },
  cheep: { kind: "cheep", placeable: true, category: "enemies", label: "뽀꾸뽀꾸", assetKey: "enemy.cheep.red.swim1", frames: ["enemy.cheep.red.swim1", "enemy.cheep.red.swim2", "enemy.cheep.green.swim1", "enemy.cheep.green.swim2"], defaults: { color: "red", mode: "swim" }, properties: { color, mode: { label: "이동", type: "choice", values: ["swim", "leap"] } }, bounds: objectBounds },
  blooper: { kind: "blooper", placeable: true, category: "enemies", label: "징오징오", assetKey: "enemy.blooper.open", frames: ["enemy.blooper.open", "enemy.blooper.closed"], defaults: {}, properties: {}, bounds: objectBounds },
  podoboo: { kind: "podoboo", placeable: true, category: "enemies", label: "버블", assetKey: "enemy.podoboo.rise", frames: ["enemy.podoboo.rise", "enemy.podoboo.fall"], defaults: {}, properties: {}, bounds: objectBounds },
  firebar: { kind: "firebar", placeable: true, category: "devices", label: "파이어바", assetKey: "enemy.firebar", frames: ["enemy.firebar"], defaults: { length: 6, direction: "cw", speed: "normal" }, properties: {
    length: { label: "길이", type: "integer", min: 3, max: 12, unit: "cells" }, direction: { label: "회전 방향", type: "choice", values: ["cw", "ccw"] }, speed: { label: "회전 속도", type: "choice", values: ["slow", "normal", "fast"] },
  }, bounds: objectBounds },
  bowser: { kind: "bowser", placeable: true, category: "enemies", label: "쿠파", assetKey: "enemy.bowser.walk1", frames: ["enemy.bowser.walk1", "enemy.bowser.walk2", "enemy.bowser.openMouth"], defaults: {}, properties: {}, bounds: objectBounds },
  warpZone: { kind: "warpZone", placeable: true, category: "devices", label: "워프 존", assetKey: "decor.pipeCap", frames: ["decor.pipeCap"], defaults: { pipeIds: [null, null, null] }, properties: { pipeIds: { label: "목적지 토관", type: "pipe-slots", length: 3, nullable: true, distinct: true, scope: "same-area" } }, bounds: objectBounds },
} as const satisfies { [K in ObjectKind]: ObjectEntry<K> };

// These are runtime-spawned vocabulary, never PlacedObject kinds or palette placement requests.
export const SPAWNED_KINDS = ["shell", "bulletBill", "spiny", "spinyEgg", "hammer", "fireball", "mushroom", "flower", "star", "oneUp", "vine", "bowserFlame"] as const;
export type SpawnedKind = typeof SPAWNED_KINDS[number];
type SpawnedEntry = Readonly<{ placeable: false; category: CatalogCategory; label: string; assetKey: AssetKey; frames: readonly [AssetKey, ...AssetKey[]]; defaults: EmptyProps; properties: PropertySchema<EmptyProps>; bounds: (position: Position) => Bounds }>;
/** Spawned bounds describe catalog preview artwork only, not a runtime collision/physics profile. */
const previewBounds = (key: AssetKey) => ({ x, y }: Position): Bounds => {
  const frame = getFrame(key);
  return { x: x - frame.anchor.x, y: y - frame.anchor.y, width: frame.width, height: frame.height };
};
export const SPAWNED_CATALOG = {
  shell: { placeable: false, category: "enemies", label: "등껍질", assetKey: "enemy.koopa.green.shell", frames: ["enemy.koopa.green.shell", "enemy.koopa.red.shell", "enemy.buzzy.shell"], defaults: {}, properties: {}, bounds: previewBounds("enemy.koopa.green.shell") },
  bulletBill: { placeable: false, category: "projectiles", label: "킬러", assetKey: "enemy.bullet", frames: ["enemy.bullet"], defaults: {}, properties: {}, bounds: previewBounds("enemy.bullet") },
  spiny: { placeable: false, category: "enemies", label: "가시돌이", assetKey: "enemy.spiny.walk1", frames: ["enemy.spiny.walk1", "enemy.spiny.walk2"], defaults: {}, properties: {}, bounds: previewBounds("enemy.spiny.walk1") },
  spinyEgg: { placeable: false, category: "enemies", label: "가시돌이 알", assetKey: "enemy.spiny.egg", frames: ["enemy.spiny.egg"], defaults: {}, properties: {}, bounds: previewBounds("enemy.spiny.egg") },
  hammer: { placeable: false, category: "projectiles", label: "해머", assetKey: "item.hammer", frames: ["item.hammer"], defaults: {}, properties: {}, bounds: previewBounds("item.hammer") },
  fireball: { placeable: false, category: "projectiles", label: "파이어볼", assetKey: "item.fireball", frames: ["item.fireball"], defaults: {}, properties: {}, bounds: previewBounds("item.fireball") },
  mushroom: { placeable: false, category: "items", label: "슈퍼버섯", assetKey: "item.mushroom", frames: ["item.mushroom"], defaults: {}, properties: {}, bounds: previewBounds("item.mushroom") },
  flower: { placeable: false, category: "items", label: "파이어플라워", assetKey: "item.flower", frames: ["item.flower"], defaults: {}, properties: {}, bounds: previewBounds("item.flower") },
  star: { placeable: false, category: "items", label: "슈퍼스타", assetKey: "item.star1", frames: ["item.star1", "item.star2"], defaults: {}, properties: {}, bounds: previewBounds("item.star1") },
  oneUp: { placeable: false, category: "items", label: "1UP 버섯", assetKey: "item.oneUp", frames: ["item.oneUp"], defaults: {}, properties: {}, bounds: previewBounds("item.oneUp") },
  vine: { placeable: false, category: "devices", label: "덩굴", assetKey: "decor.vineTop", frames: ["decor.vineTop", "decor.vineSegment"], defaults: {}, properties: {}, bounds: previewBounds("decor.vineTop") },
  bowserFlame: { placeable: false, category: "projectiles", label: "쿠파 불꽃", assetKey: "enemy.bowser.flame", frames: ["enemy.bowser.flame"], defaults: {}, properties: {}, bounds: previewBounds("enemy.bowser.flame") },
} as const satisfies Record<SpawnedKind, SpawnedEntry>;

export type PlacementContext = Readonly<{ course: CourseV1; areaId: string }>;
export type ObjectRequest = { [K in ObjectKind]: K extends "piranha"
  ? Readonly<{ id: string; kind: K; pipeId: string }>
  : Readonly<{ id: string; kind: K; x: number; y: number; props?: ObjectProps[K] }>
}[ObjectKind];
const missingReference = (path: string, message: string) => ({ ok: false, error: { code: "invalid_reference", path, message } }) as const;
function checkedObject(context: PlacementContext, candidate: unknown, id: string, replacing = false): ValidationResult<PlacedObject> {
  if (!context.course.areas.some((area) => area.id === context.areaId)) return missingReference("$.areaId", "Placement area does not exist");
  const result = validateCourse({ ...context.course, areas: context.course.areas.map((area) => area.id === context.areaId
    ? { ...area, objects: replacing ? area.objects.map((object) => object.id === id ? candidate : object) : [...area.objects, candidate] } : area) });
  if (!result.ok) return result;
  const object = result.value.areas.find((area) => area.id === context.areaId.toLowerCase())?.objects.find((item) => item.id === id.toLowerCase());
  return object ? { ok: true, value: object } : missingReference("$.objectId", "Object does not exist in the placement area");
}
/** Pure preview constructor: requires real IDs/parent, validates the prospective whole draft, never inserts it. */
export function createObject(context: PlacementContext, request: ObjectRequest): ValidationResult<PlacedObject> {
  switch (request.kind) {
    case "piranha": {
      const pipe = context.course.areas.find((area) => area.id === context.areaId)?.objects.find((object) => object.id === request.pipeId);
      if (pipe?.kind !== "pipe") return missingReference("$.pipeId", "Choose a pipe in this area");
      return checkedObject(context, { id: request.id, kind: request.kind, x: pipe.x, y: pipe.y - pipe.props.height * 16, props: OBJECT_CATALOG.piranha.defaults(pipe) }, request.id);
    }
    case "castleGoal": return checkedObject(context, { ...request, props: Object.hasOwn(request, "props") ? request.props : OBJECT_CATALOG.castleGoal.defaults(request) }, request.id);
    case "pipe": case "platform": case "spring": case "flagGoal": case "goomba": case "koopa": case "paratroopa": case "buzzy":
    case "billCannon": case "hammerBro": case "lakitu": case "cheep": case "blooper": case "podoboo": case "firebar": case "bowser": case "warpZone":
      return checkedObject(context, { ...request, props: Object.hasOwn(request, "props") ? request.props : OBJECT_CATALOG[request.kind].defaults }, request.id);
    default: return assertNever(request);
  }
}
/** Inspector boundary for untrusted property input; callers commit only after a successful complete-draft check. */
export function validateObjectProperties(context: PlacementContext, objectId: string, props: unknown): ValidationResult<PlacedObject> {
  const object = context.course.areas.find((area) => area.id === context.areaId)?.objects.find((item) => item.id === objectId);
  if (!object) return missingReference("$.objectId", "Choose an object in this area");
  return checkedObject(context, { ...object, props }, objectId, true);
}
/** Tile previews also use the real document validator (including duplicate/bridge occupancy rules). */
export function createTile(context: PlacementContext, tile: TileCell): ValidationResult<TileCell> {
  const area = context.course.areas.find((item) => item.id === context.areaId);
  if (!area) return missingReference("$.areaId", "Placement area does not exist");
  const candidate = { ...TILE_CATALOG[tile.kind].defaults, ...tile };
  const result = validateCourse({ ...context.course, areas: context.course.areas.map((item) => item.id === area.id ? { ...item, tiles: [...item.tiles, candidate] } : item) });
  if (!result.ok) return result;
  const parsed = result.value.areas.find((item) => item.id === area.id.toLowerCase())?.tiles.at(-1);
  return parsed ? { ok: true, value: parsed } : missingReference("$.areaId", "Placement area does not exist");
}
export type CatalogWarning = Readonly<{ code: "unlinked_pipe" | "unpaired_balance" | "unlinked_warp"; objectId: string }>;
/** Authoring warnings, not failures or runtime behavior. In particular, keep an unpaired balance unchanged. */
export function catalogWarnings(area: AreaV1): readonly CatalogWarning[] {
  return area.objects.flatMap((object): CatalogWarning[] => {
    switch (object.kind) {
      case "pipe": return object.props.entrance !== "none" && !object.props.destination ? [{ code: "unlinked_pipe", objectId: object.id }] : [];
      case "platform": return object.props.motion === "balance" && !object.props.pairId ? [{ code: "unpaired_balance", objectId: object.id }] : [];
      case "warpZone": return object.props.pipeIds.some((id) => id === null || !area.objects.some((pipe) => pipe.id === id && pipe.kind === "pipe" && pipe.props.destination)) ? [{ code: "unlinked_warp", objectId: object.id }] : [];
      case "spring": case "flagGoal": case "castleGoal": case "goomba": case "koopa": case "paratroopa": case "piranha": case "buzzy":
      case "billCannon": case "hammerBro": case "lakitu": case "cheep": case "blooper": case "podoboo": case "firebar": case "bowser": return [];
      default: return assertNever(object);
    }
  });
}
export function createNewCourse(ids: Readonly<{ courseId: string; areaId: string; goalId: string }>): ValidationResult<CourseV1> {
  return validateCourse({ format: "smb1-maker", version: 1, id: ids.courseId, title: "새 코스", revision: 0,
    mainAreaId: ids.areaId, start: { areaId: ids.areaId, x: 40, y: 208 }, timerSeconds: 400,
    areas: [{ id: ids.areaId, name: "지상", theme: "overworld", width: 256, height: 15,
      tiles: Array.from({ length: 512 }, (_, i) => ({ x: i % 256, y: 13 + Math.floor(i / 256), kind: "ground" })),
      objects: [{ id: ids.goalId, kind: "flagGoal", x: 3840, y: 208, props: OBJECT_CATALOG.flagGoal.defaults }],
    }],
  });
}
function assertNever(value: never): never { throw new Error(`Unsupported catalog variant: ${String(value)}`); }
