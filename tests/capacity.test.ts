import { describe, expect, test } from "bun:test";
import { beginPaintGesture } from "../src/editor/paint";
import { placeObject } from "../src/editor/commands";
import { createHistory } from "../src/editor/history";
import { SPAWN_ENEMY_CAP, SPAWN_PROJECTILE_CAP, type SpecialActor } from "../src/game/enemies-special";
import { createRuntime, snapshot } from "../src/game/state";
import { step } from "../src/game/step";
import { EMPTY_INPUT } from "../src/input";
import { parseCourse, serializeCourse } from "../src/level/serialize";
import { COURSE_LIMITS, type CourseV1, type ValidationCode, type ValidationResult } from "../src/level/types";
import { validateCourse } from "../src/level/validate";
import { createMemoryDatabase } from "../src/storage/db";
import { importCourseFile, readCourseFile } from "../src/storage/files";
import { previewSprites } from "../src/ui/course-preview";
import {
  ACTIVE_ZONE_COUNTS, CAPACITY_BUDGETS, PACKED_TILE_ORIGIN_Y, SPAWN_CAP_IDS, SPAWN_CAPS,
  capacityAreaId, createActiveZoneCourse, createMaxCourse, createMinAreaCourse,
  createOverAreaDocument, createOverHeightDocument, createOverObjectDocument,
  createOversizeFileBytes, createOverTileDocument, createOverWidthDocument,
  createSpawnCapCourse,
} from "./fixtures/capacity";
import { fixtureId } from "./fixtures/factory";

const encoder = new TextEncoder();

function ok<T>(result: ValidationResult<T>): T {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`${result.error.code} ${result.error.path}: ${result.error.message}`);
  return result.value;
}

function rejection(result: ValidationResult<unknown>, code: ValidationCode): void {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.code).toBe(code);
}

function totals(course: CourseV1): { areas: number; tiles: number; objects: number } {
  let tiles = 0, objects = 0;
  for (const area of course.areas) { tiles += area.tiles.length; objects += area.objects.length; }
  return { areas: course.areas.length, tiles, objects };
}

function p95(samples: readonly number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.ceil(0.95 * sorted.length) - 1]!;
}

function fillSpawned(runtime: ReturnType<typeof createRuntime>, which: "enemy" | "projectile", count: number): void {
  const kind = which === "enemy" ? "spiny" : "hammer";
  for (let i = 0; i < count; i++) {
    const actor: SpecialActor = {
      id: `fill-${which}-${String(i).padStart(4, "0")}`, areaId: runtime.areaId, kind,
      x: 900, y: 100, vx: 0, vy: 0, facing: -1, active: true, bornTick: 0, grounded: true,
      originX: 900, originY: 100, sourceId: "fill",
    };
    runtime.special.actors.set(actor.id, actor);
  }
}

describe("maximum documents are accepted without truncation", () => {
  test("one 32x15 area is accepted", () => {
    const course = createMinAreaCourse();
    expect(course.areas).toHaveLength(1);
    expect(course.areas[0]!.width).toBe(COURSE_LIMITS.minWidth);
    expect(course.areas[0]!.height).toBe(COURSE_LIMITS.minHeight);
    expect(validateCourse(course).ok).toBe(true);
  });

  test("max areas, dimensions, cells and objects round-trip with exact counts", () => {
    const course = createMaxCourse();
    const counted = totals(course);
    expect(counted).toEqual({
      areas: COURSE_LIMITS.areas, tiles: COURSE_LIMITS.tiles, objects: COURSE_LIMITS.objects,
    });
    expect(course.areas[0]!.width).toBe(COURSE_LIMITS.maxWidth);
    expect(course.areas[0]!.height).toBe(COURSE_LIMITS.maxHeight);
    const json = ok(serializeCourse(course));
    const bytes = encoder.encode(json);
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(bytes.byteLength).toBeLessThanOrEqual(COURSE_LIMITS.fileBytes);
    const parsed = ok(parseCourse(bytes));
    expect(totals(parsed)).toEqual(counted);
    expect(parsed.areas.map((area) => area.id)).toEqual(course.areas.map((area) => area.id));
    expect(parsed.areas[0]!.tiles).toHaveLength(COURSE_LIMITS.tiles);
    expect(parsed.areas.reduce((n, area) => n + area.objects.length, 0)).toBe(COURSE_LIMITS.objects);
  }, 60_000);
});

describe("over-maximum documents are rejected with no dropped content", () => {
  test("17 areas rejected and the max document is unchanged", () => {
    const max = createMaxCourse();
    const before = totals(max);
    rejection(validateCourse(createOverAreaDocument()), "limit_exceeded");
    expect(totals(max)).toEqual(before);
    expect(before.areas).toBe(COURSE_LIMITS.areas);
  });

  test("262145 cells rejected and tiles are not truncated", () => {
    const max = createMaxCourse();
    const before = max.areas[0]!.tiles.length;
    const over = createOverTileDocument();
    rejection(validateCourse(over), "limit_exceeded");
    expect(max.areas[0]!.tiles.length).toBe(before);
    expect(before).toBe(COURSE_LIMITS.tiles);
    expect((over as CourseV1).areas[0]!.tiles.length).toBe(COURSE_LIMITS.tiles + 1);
  });

  test("4097 objects rejected and objects are not truncated", () => {
    const max = createMaxCourse();
    const before = totals(max).objects;
    const over = createOverObjectDocument();
    rejection(validateCourse(over), "limit_exceeded");
    expect(totals(max).objects).toBe(before);
    expect((over as CourseV1).areas.reduce((n, area) => n + area.objects.length, 0)).toBe(COURSE_LIMITS.objects + 1);
  });

  test("width 4097 and height 129 are rejected", () => {
    rejection(validateCourse(createOverWidthDocument()), "invalid_value");
    rejection(validateCourse(createOverHeightDocument()), "invalid_value");
    expect(createMaxCourse().areas[0]!.width).toBe(COURSE_LIMITS.maxWidth);
    expect(createMaxCourse().areas[0]!.height).toBe(COURSE_LIMITS.maxHeight);
  });

  test("32 MiB + 1 byte is rejected before parse and does not yield a course", () => {
    const oversized = createOversizeFileBytes();
    expect(oversized.byteLength).toBe(COURSE_LIMITS.fileBytes + 1);
    rejection(parseCourse(oversized), "file_too_large");
    rejection(readCourseFile(oversized), "file_too_large");
  });
});

describe("storage rejects over-limit files without writing", () => {
  test("over-tile JSON import is invalid and issues no put", async () => {
    const db = createMemoryDatabase();
    const bytes = encoder.encode(JSON.stringify(createOverTileDocument()));
    const imported = await importCourseFile(db, bytes, { newCourseId: fixtureId(23_800) });
    expect(imported.status).toBe("invalid");
    if (imported.status !== "invalid") throw new Error("expected invalid");
    expect(imported.error.code).toBe("limit_exceeded");
    expect(db.getCourse(fixtureId(23_800))).toEqual({ found: false });
    expect(db.events().some((event) => event.kind === "request" && event.op === "put")).toBe(false);
  }, 60_000);

  test("oversize bytes import is invalid and issues no put", async () => {
    const db = createMemoryDatabase();
    const imported = await importCourseFile(db, createOversizeFileBytes(), { newCourseId: fixtureId(23_801) });
    expect(imported.status).toBe("invalid");
    if (imported.status !== "invalid") throw new Error("expected invalid");
    expect(imported.error.code).toBe("file_too_large");
    expect(db.getCourse(fixtureId(23_801))).toEqual({ found: false });
    expect(db.events().some((event) => event.kind === "request" && event.op === "put")).toBe(false);
  });

  test("quota failure on a valid max insert leaves no record", async () => {
    const db = createMemoryDatabase();
    db.failNextPut("quota");
    const bytes = encoder.encode(ok(serializeCourse(createMaxCourse())));
    const imported = await importCourseFile(db, bytes, { newCourseId: fixtureId(23_802) });
    expect(imported.status).toBe("failed");
    if (imported.status !== "failed") throw new Error("expected failed");
    expect(imported.error.kind).toBe("quota");
    expect(db.getCourse(fixtureId(23_802))).toEqual({ found: false });
  }, 60_000);
});

describe("edit at capacity does not drop existing content", () => {
  test("painting a new cell at the tile cap is rejected and history is unchanged", () => {
    const max = createMaxCourse();
    const history = createHistory(max);
    const before = history.document().areas[0]!.tiles.length;
    const gesture = beginPaintGesture({
      areaId: capacityAreaId(0), tool: "paint", brush: { kind: "coin" }, origin: { x: 0, y: 0 },
    });
    const outcome = gesture.commit(history);
    expect(outcome.status).toBe("rejected");
    if (outcome.status !== "rejected") throw new Error("expected rejected paint");
    expect(outcome.error.code).toBe("limit_exceeded");
    expect(history.document().areas[0]!.tiles.length).toBe(before);
    expect(before).toBe(COURSE_LIMITS.tiles);
  });

  test("replacing an existing cell keeps the tile count", () => {
    const max = createMaxCourse();
    const history = createHistory(max);
    const existing = max.areas[0]!.tiles[0]!;
    const gesture = beginPaintGesture({
      areaId: capacityAreaId(0), tool: "paint", brush: { kind: "hard" }, origin: { x: existing.x, y: existing.y },
    });
    const outcome = gesture.commit(history);
    expect(outcome.status).toBe("committed");
    expect(history.document().areas[0]!.tiles.length).toBe(COURSE_LIMITS.tiles);
    const replaced = history.document().areas[0]!.tiles.find((tile) => tile.x === existing.x && tile.y === existing.y);
    expect(replaced?.kind).toBe("hard");
  });

  test("placing an object at the object cap is rejected", () => {
    const max = createMaxCourse();
    const before = totals(max).objects;
    const placed = placeObject(max, capacityAreaId(0), { kind: "goomba", id: fixtureId(29_001), x: 16, y: 32 });
    rejection(placed, "limit_exceeded");
    expect(totals(max).objects).toBe(before);
  });
});

describe("bounded spawn lifecycle", () => {
  test("enemy cap skips a new spawn, keeps placed objects, and sets the overload flag", () => {
    const course = createSpawnCapCourse("enemy");
    const placed = course.areas[0]!.objects.length;
    const runtime = createRuntime(course);
    fillSpawned(runtime, "enemy", SPAWN_ENEMY_CAP);
    expect(SPAWN_CAPS.enemies).toBe(128);
    const events = [];
    for (let i = 0; i < 180; i++) events.push(...step(runtime, EMPTY_INPUT));
    expect(events.some((event) => event.type === "spawn-overload" && event.kind === "enemy")).toBe(true);
    const eggs = [...runtime.special.actors.values(), ...runtime.special.pending].filter((actor) => actor.kind === "spinyEgg");
    expect(eggs).toHaveLength(0);
    expect(runtime.special.actors.get(SPAWN_CAP_IDS.lakitu)?.kind).toBe("lakitu");
    expect(runtime.special.actors.get(SPAWN_CAP_IDS.cannon)?.kind).toBe("billCannon");
    expect(runtime.special.overloadedEnemies).toBe(true);
    expect(snapshot(runtime).special.overloadedEnemies).toBe(true);
    expect(course.areas[0]!.objects.length).toBe(placed);
  });

  test("projectile cap skips a hammer and keeps the hammer bro", () => {
    const course = createSpawnCapCourse("projectile");
    const runtime = createRuntime(course);
    fillSpawned(runtime, "projectile", SPAWN_PROJECTILE_CAP);
    expect(SPAWN_CAPS.projectiles).toBe(128);
    const events = [];
    for (let i = 0; i < 60; i++) events.push(...step(runtime, EMPTY_INPUT));
    expect(events.some((event) => event.type === "spawn-overload" && event.kind === "projectile")).toBe(true);
    const hammersFromBro = [...runtime.special.actors.values(), ...runtime.special.pending]
      .filter((actor) => actor.kind === "hammer" && actor.sourceId === SPAWN_CAP_IDS.hammerBro);
    expect(hammersFromBro).toHaveLength(0);
    expect(runtime.special.actors.get(SPAWN_CAP_IDS.hammerBro)?.kind).toBe("hammerBro");
    expect(runtime.special.overloadedProjectiles).toBe(true);
    expect(snapshot(runtime).special.overloadedProjectiles).toBe(true);
  });
});

describe("full-size import, render, edit and play timings", () => {
  test("import, render, edit and 600-tick play meet stated budgets", () => {
    const course = createMaxCourse();
    const json = ok(serializeCourse(course));
    const bytes = encoder.encode(json);
    const importStarted = performance.now();
    const parsed = ok(parseCourse(bytes));
    const importMs = performance.now() - importStarted;
    expect(totals(parsed).tiles).toBe(COURSE_LIMITS.tiles);
    expect(importMs).toBeLessThanOrEqual(CAPACITY_BUDGETS.importMs);

    const area = parsed.areas[0]!;
    const camera = { x: 0, y: PACKED_TILE_ORIGIN_Y * 16 };
    const renderStarted = performance.now();
    const sprites = previewSprites(area, camera);
    const renderMs = performance.now() - renderStarted;
    expect(sprites.length).toBeGreaterThan(0);
    expect(sprites.length).toBeLessThan(area.tiles.length);

    const history = createHistory(parsed);
    const existing = area.tiles[0]!;
    const editStarted = performance.now();
    const gesture = beginPaintGesture({
      areaId: area.id, tool: "paint", brush: { kind: "hard" }, origin: { x: existing.x, y: existing.y },
    });
    for (let i = 1; i < 10; i++) gesture.extend({ x: existing.x + i, y: existing.y });
    const outcome = gesture.commit(history);
    const editMs = performance.now() - editStarted;
    expect(outcome.status).toBe("committed");
    expect(history.document().areas[0]!.tiles.length).toBe(COURSE_LIMITS.tiles);

    const runtime = createRuntime(parsed);
    const samples = new Array<number>(CAPACITY_BUDGETS.playTicks);
    for (let i = 0; i < CAPACITY_BUDGETS.playTicks; i++) {
      const tickStarted = performance.now();
      step(runtime, EMPTY_INPUT);
      samples[i] = performance.now() - tickStarted;
    }
    const tickP95Ms = p95(samples);
    expect(runtime.tick).toBe(CAPACITY_BUDGETS.playTicks);
    expect(tickP95Ms).toBeLessThanOrEqual(CAPACITY_BUDGETS.tickP95Ms);
    expect(runtime.ground.actors.size).toBeGreaterThan(0);
    console.log(JSON.stringify({ importMs, renderMs, editMs, tickP95Ms, byteLength: bytes.byteLength, spriteCount: sprites.length }));
  }, 120_000);

  test("active-zone 128 actors and 32 cannons stay bounded over 600 ticks", () => {
    const course = createActiveZoneCourse();
    const cannons = course.areas[0]!.objects.filter((object) => object.kind === "billCannon");
    expect(course.areas[0]!.objects.filter((object) => object.kind === "firebar")).toHaveLength(ACTIVE_ZONE_COUNTS.actors);
    expect(cannons).toHaveLength(ACTIVE_ZONE_COUNTS.projectiles);
    const runtime = createRuntime(course);
    const samples = new Array<number>(CAPACITY_BUDGETS.playTicks);
    for (let i = 0; i < CAPACITY_BUDGETS.playTicks; i++) {
      const tickStarted = performance.now();
      step(runtime, EMPTY_INPUT);
      samples[i] = performance.now() - tickStarted;
    }
    const spawnedEnemies = [...runtime.special.actors.values(), ...runtime.special.pending]
      .filter((actor) => actor.kind === "bulletBill" || actor.kind === "spiny" || actor.kind === "spinyEgg").length;
    expect(spawnedEnemies).toBeLessThanOrEqual(SPAWN_ENEMY_CAP);
    expect(runtime.hazards.actors.size).toBe(ACTIVE_ZONE_COUNTS.actors);
    expect(runtime.special.actors.get(cannons[0]!.id)?.kind).toBe("billCannon");
    expect(p95(samples)).toBeLessThanOrEqual(CAPACITY_BUDGETS.tickP95Ms);
    console.log(JSON.stringify({
      activeTickP95Ms: p95(samples), spawnedEnemies, firebars: runtime.hazards.actors.size,
      overloadedEnemies: runtime.special.overloadedEnemies,
    }));
  }, 60_000);
});
