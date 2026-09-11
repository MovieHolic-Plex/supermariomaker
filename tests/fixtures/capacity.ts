import { SPAWN_ENEMY_CAP, SPAWN_PROJECTILE_CAP } from "../../src/game/enemies-special";
import { COURSE_LIMITS, THEMES, type AreaV1, type CourseV1, type PlacedObject, type TileCell } from "../../src/level/types";
import { validateCourse } from "../../src/level/validate";
import { fixtureId, fixtureValue } from "./factory";

export const CAPACITY_BUDGETS = {
  importMs: 3000,
  tickP95Ms: 8,
  playTicks: 600,
} as const;

export const CAPACITY_IDS = {
  course: fixtureId(23_000),
  spawnCourse: fixtureId(23_100),
  activeCourse: fixtureId(23_200),
} as const;

export function capacityAreaId(index: number): string {
  return fixtureId(23_001 + index);
}

export function capacityObjectId(index: number): string {
  return fixtureId(24_000 + index);
}

const MAX_AREA_COUNT = COURSE_LIMITS.areas;
export const PACKED_TILE_ORIGIN_Y = 64;

function packTiles(count: number, width: number, originY: number): TileCell[] {
  const tiles = new Array<TileCell>(count);
  for (let i = 0; i < count; i++) tiles[i] = { x: i % width, y: originY + ((i / width) | 0), kind: "ground" };
  return tiles;
}

function goombas(startIndex: number, count: number, originX = 16, y = 2048): PlacedObject[] {
  const objects = new Array<PlacedObject>(count);
  for (let i = 0; i < count; i++) {
    objects[i] = { id: capacityObjectId(startIndex + i), kind: "goomba", x: originX + i * 16, y, props: {} };
  }
  return objects;
}

let cachedMax: CourseV1 | undefined;

/** 16 max-size areas, 262144 cells, 4096 objects, start clear of the packed terrain. */
export function createMaxCourse(): CourseV1 {
  if (cachedMax) return cachedMax;
  const objectsPerArea = COURSE_LIMITS.objects / MAX_AREA_COUNT;
  const areas: AreaV1[] = [];
  let objectIndex = 0;
  for (let i = 0; i < MAX_AREA_COUNT; i++) {
    const id = capacityAreaId(i);
    const packed = i === 0
      ? [({ id: capacityObjectId(objectIndex), kind: "flagGoal", x: 80, y: 208, props: { height: 9 } } satisfies PlacedObject),
        ...goombas(objectIndex + 1, objectsPerArea - 1)]
      : goombas(objectIndex, objectsPerArea);
    objectIndex += objectsPerArea;
    areas.push({
      id, name: `영역 ${i + 1}`, theme: THEMES[i % THEMES.length]!,
      width: COURSE_LIMITS.maxWidth, height: COURSE_LIMITS.maxHeight,
      tiles: i === 0 ? packTiles(COURSE_LIMITS.tiles, COURSE_LIMITS.maxWidth, PACKED_TILE_ORIGIN_Y) : [],
      objects: packed,
    });
  }
  cachedMax = fixtureValue(validateCourse({
    format: "smb1-maker", version: 1, id: CAPACITY_IDS.course, title: "용량 최대", revision: 0,
    mainAreaId: capacityAreaId(0), start: { areaId: capacityAreaId(0), x: 40, y: 208 }, timerSeconds: 0,
    areas,
  }));
  return cachedMax;
}

export function createMinAreaCourse(): CourseV1 {
  const id = capacityAreaId(0);
  return fixtureValue(validateCourse({
    format: "smb1-maker", version: 1, id: CAPACITY_IDS.course, title: "용량 최소 영역", revision: 0,
    mainAreaId: id, start: { areaId: id, x: 40, y: 208 }, timerSeconds: 0,
    areas: [{
      id, name: "영역 1", theme: "overworld", width: COURSE_LIMITS.minWidth, height: COURSE_LIMITS.minHeight,
      tiles: [], objects: [{ id: capacityObjectId(0), kind: "flagGoal", x: 80, y: 208, props: { height: 9 } }],
    }],
  }));
}

export function createOverAreaDocument(): unknown {
  const max = createMaxCourse();
  const extra: AreaV1 = {
    ...max.areas[0]!, id: fixtureId(23_017), tiles: [], objects: [],
  };
  return { ...max, areas: [...max.areas, extra] };
}

export function createOverTileDocument(): unknown {
  const max = createMaxCourse();
  const [first, ...rest] = max.areas;
  return { ...max, areas: [{ ...first!, tiles: [...first!.tiles, { x: 0, y: 0, kind: "coin" }] }, ...rest] };
}

export function createOverObjectDocument(): unknown {
  const max = createMaxCourse();
  const [first, ...rest] = max.areas;
  const extra: PlacedObject = { id: fixtureId(29_000), kind: "goomba", x: 16, y: 32, props: {} };
  return { ...max, areas: [{ ...first!, objects: [...first!.objects, extra] }, ...rest] };
}

export function createOverWidthDocument(): unknown {
  const max = createMaxCourse();
  const [first, ...rest] = max.areas;
  return { ...max, areas: [{ ...first!, width: COURSE_LIMITS.maxWidth + 1 }, ...rest] };
}

export function createOverHeightDocument(): unknown {
  const max = createMaxCourse();
  const [first, ...rest] = max.areas;
  return { ...max, areas: [{ ...first!, height: COURSE_LIMITS.maxHeight + 1 }, ...rest] };
}

export function createOversizeFileBytes(): Uint8Array {
  return new Uint8Array(COURSE_LIMITS.fileBytes + 1);
}

export const SPAWN_CAP_IDS = {
  lakitu: fixtureId(23_102),
  hammerBro: fixtureId(23_103),
  cannon: fixtureId(23_104),
} as const;

const spawnCache = new Map<string, CourseV1>();

function spawnGround(): TileCell[] {
  return [
    ...Array.from({ length: 64 }, (_, x): TileCell => ({ x, y: 13, kind: "ground" })),
    ...Array.from({ length: 64 }, (_, x): TileCell => ({ x, y: 14, kind: "ground" })),
  ];
}

/** Isolated spawner so the player is not killed before the cap is exercised. */
export function createSpawnCapCourse(which: "enemy" | "projectile"): CourseV1 {
  const cached = spawnCache.get(which);
  if (cached) return cached;
  const areaId = fixtureId(which === "enemy" ? 23_101 : 23_111);
  const objects: PlacedObject[] = which === "enemy"
    ? [
      { id: SPAWN_CAP_IDS.lakitu, kind: "lakitu", x: 160, y: 144, props: {} },
      { id: SPAWN_CAP_IDS.cannon, kind: "billCannon", x: 320, y: 208, props: {} },
      { id: fixtureId(23_105), kind: "flagGoal", x: 480, y: 208, props: { height: 9 } },
    ]
    : [
      { id: SPAWN_CAP_IDS.hammerBro, kind: "hammerBro", x: 192, y: 208, props: {} },
      { id: fixtureId(23_115), kind: "flagGoal", x: 480, y: 208, props: { height: 9 } },
    ];
  const course = fixtureValue(validateCourse({
    format: "smb1-maker", version: 1, id: fixtureId(which === "enemy" ? 23_100 : 23_110),
    title: which === "enemy" ? "용량 적 스폰" : "용량 발사체 스폰", revision: 0,
    mainAreaId: areaId, start: { areaId, x: 40, y: 208 }, timerSeconds: 0,
    areas: [{
      id: areaId, name: "스폰", theme: "overworld", width: 64, height: COURSE_LIMITS.minHeight,
      tiles: spawnGround(), objects,
    }],
  }));
  spawnCache.set(which, course);
  return course;
}

export const ACTIVE_ZONE_COUNTS = { actors: 128, projectiles: 32 } as const;

let cachedActive: CourseV1 | undefined;

/** 128 stationary firebars and 32 cannons packed into the start viewport. */
export function createActiveZoneCourse(): CourseV1 {
  if (cachedActive) return cachedActive;
  const areaId = fixtureId(23_201);
  const objects: PlacedObject[] = [];
  for (let i = 0; i < ACTIVE_ZONE_COUNTS.actors; i++) {
    const col = i % 16, row = (i / 16) | 0;
    objects.push({
      id: fixtureId(23_300 + i), kind: "firebar",
      x: 16 + col * 16, y: 48 + row * 16,
      props: { length: 3, direction: "cw", speed: "slow" },
    });
  }
  for (let i = 0; i < ACTIVE_ZONE_COUNTS.projectiles; i++) {
    objects.push({
      id: fixtureId(23_500 + i), kind: "billCannon",
      x: 16 + (i % 16) * 16, y: 16 + ((i / 16) | 0) * 16, props: {},
    });
  }
  objects.push({ id: fixtureId(23_202), kind: "flagGoal", x: 480, y: 208, props: { height: 9 } });
  cachedActive = fixtureValue(validateCourse({
    format: "smb1-maker", version: 1, id: CAPACITY_IDS.activeCourse, title: "용량 활성 구역", revision: 0,
    mainAreaId: areaId, start: { areaId, x: 40, y: 208 }, timerSeconds: 0,
    areas: [{
      id: areaId, name: "활성", theme: "castle", width: 64, height: COURSE_LIMITS.minHeight,
      tiles: spawnGround(), objects,
    }],
  }));
  return cachedActive;
}

export const SPAWN_CAPS = { enemies: SPAWN_ENEMY_CAP, projectiles: SPAWN_PROJECTILE_CAP } as const;
