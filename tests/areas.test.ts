import { describe, expect, test } from "bun:test";
import { EMPTY_INPUT } from "../src/input";
import type { InputFrame } from "../src/input";
import { createRuntime, snapshot } from "../src/game/state";
import { step } from "../src/game/step";
import { PIPE_TRANSITION_TICKS } from "../src/game/transitions";
import {
  createArea, deleteArea, linkPipes, placePipe, previewResize, renameArea, resizeArea, setAreaTheme, warpLabels,
} from "../src/editor/areas";
import { createHistory } from "../src/editor/history";
import { setObjectProperties } from "../src/editor/commands";
import { authoredContentEqual, serializeCourse } from "../src/level/serialize";
import { COURSE_LIMITS } from "../src/level/types";
import type { CourseV1, ValidationResult } from "../src/level/types";
import { playView } from "../src/ui/play-view";
import { AREA_IDS, createBlockedExitFixture, createLinkedAreasFixture } from "./fixtures/areas";
import { createNewCourseFixture, fixtureId } from "./fixtures/factory";

const idle = EMPTY_INPUT;
const down: InputFrame = { ...EMPTY_INPUT, down: { held: true, pressed: true, released: false } };
const downHold: InputFrame = { ...EMPTY_INPUT, down: { held: true, pressed: false, released: false } };
const up: InputFrame = { ...EMPTY_INPUT, up: { held: true, pressed: true, released: false } };
const right: InputFrame = { ...EMPTY_INPUT, right: { held: true, pressed: false, released: false } };

function ok<T>(result: ValidationResult<T>): T {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`${result.error.code} ${result.error.path}: ${result.error.message}`);
  return result.value;
}
function canonical(course: CourseV1): string {
  const result = serializeCourse(course);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
function ticks(runtime: ReturnType<typeof createRuntime>, count: number, input = idle) {
  const events = [];
  for (let i = 0; i < count; i++) events.push(...step(runtime, input));
  return events;
}

describe("reciprocal pipe links and warp labels", () => {
  test("linkPipes writes both destinations; a one-sided property edit is rejected", () => {
    const origin = createNewCourseFixture();
    const areaId = origin.mainAreaId;
    const a = fixtureId(1401), b = fixtureId(1402);
    let course = ok(placePipe(origin, areaId, { id: a, x: 80, y: 208 }));
    course = ok(placePipe(course, areaId, { id: b, x: 144, y: 208, entrance: "up" }));
    const history = createHistory(course);
    const linked = ok(linkPipes(course, { areaId, pipeId: a }, { areaId, pipeId: b }));
    expect(history.commit(linked).status).toBe("committed");
    const pipes = history.document().areas[0]?.objects.filter(object => object.kind === "pipe") ?? [];
    const left = pipes.find(object => object.id === a);
    const right = pipes.find(object => object.id === b);
    expect(left?.kind).toBe("pipe");
    expect(right?.kind).toBe("pipe");
    if (left?.kind === "pipe") expect(left.props.destination).toEqual({ areaId, pipeId: b });
    if (right?.kind === "pipe") expect(right.props.destination).toEqual({ areaId, pipeId: a });
    const onesided = setObjectProperties(history.document(), areaId, a, { height: 3, entrance: "down", destination: { areaId, pipeId: fixtureId(1499) } });
    expect(onesided.ok).toBe(false);
    if (!onesided.ok) expect(onesided.error.code).toBe("invalid_reference");
    expect(history.snapshot().undoCount).toBe(1);
  });

  test("warp labels use destination area names and '-' for unlinked slots", () => {
    const course = createLinkedAreasFixture();
    const warp = course.areas[0]?.objects.find(object => object.kind === "warpZone");
    expect(warp?.kind).toBe("warpZone");
    if (warp?.kind !== "warpZone") throw new Error("warp missing");
    expect(warpLabels(course, warp)).toEqual(["지하", "지하", "-"]);
  });
});

describe("pipe entry, lock, return and invalid exit", () => {
  test("down entry locks input for 30 ticks then exits at the paired mouth", () => {
    const runtime = createRuntime(createLinkedAreasFixture());
    expect(PIPE_TRANSITION_TICKS).toBe(30);
    expect(runtime.areaId).toBe(AREA_IDS.main);
    expect(runtime.player).toMatchObject({ x: 80, y: 160, grounded: true });
    const first = step(runtime, down);
    expect(first).toContainEqual({ type: "pipe-enter", tick: 1, pipeId: AREA_IDS.pipeMain, areaId: AREA_IDS.main });
    expect(runtime.areaId).toBe(AREA_IDS.main);
    expect(runtime.transition.kind).toBe("pipe");
    const locked = ticks(runtime, 28, right);
    expect(locked.some(event => event.type === "pipe-exit")).toBe(false);
    expect(runtime.areaId).toBe(AREA_IDS.main);
    expect(runtime.player.x).toBe(80);
    const last = step(runtime, right);
    expect(runtime.tick).toBe(30);
    expect(last).toContainEqual({ type: "pipe-exit", tick: 30, pipeId: AREA_IDS.pipeDest, areaId: AREA_IDS.dest });
    expect(runtime.areaId).toBe(AREA_IDS.dest);
    expect(runtime.transition.kind).toBe("idle");
    expect(runtime.player).toMatchObject({ x: 80, y: 160, vx: 0, vy: 0 });
    expect(snapshot(runtime).areaId).toBe(AREA_IDS.dest);
    expect(playView(runtime).theme).toBe("underground");
  });

  test("return traversal uses the reciprocal pipe and restores the source area", () => {
    const runtime = createRuntime(createLinkedAreasFixture());
    step(runtime, down);
    ticks(runtime, 29, downHold);
    expect(runtime.areaId).toBe(AREA_IDS.dest);
    const back = step(runtime, down);
    expect(back).toContainEqual({ type: "pipe-enter", tick: 31, pipeId: AREA_IDS.pipeDest, areaId: AREA_IDS.dest });
    ticks(runtime, 29, downHold);
    expect(runtime.areaId).toBe(AREA_IDS.main);
    expect(runtime.player).toMatchObject({ x: 80, y: 160 });
  });

  test("wrong direction, unlinked pipe and off-center do not move the player", () => {
    const runtime = createRuntime(createLinkedAreasFixture());
    const origin = { x: runtime.player.x, y: runtime.player.y, areaId: runtime.areaId };
    expect(step(runtime, up).some(event => event.type === "pipe-enter" || event.type === "pipe-reject")).toBe(false);
    expect(runtime.player).toMatchObject({ x: origin.x, y: origin.y });
    expect(runtime.areaId).toBe(origin.areaId);
    runtime.player.x = 224;
    const none = step(runtime, down);
    expect(none.some(event => event.type === "pipe-enter")).toBe(false);
    expect(runtime.areaId).toBe(origin.areaId);
  });

  test("invalid exit clearance rejects entry without moving the player", () => {
    const runtime = createRuntime(createBlockedExitFixture());
    const before = { x: runtime.player.x, y: runtime.player.y, areaId: runtime.areaId };
    const events = step(runtime, down);
    expect(events).toContainEqual({ type: "pipe-reject", tick: 1, pipeId: AREA_IDS.pipeMain, reason: "exit" });
    expect(runtime.areaId).toBe(before.areaId);
    expect(runtime.player.x).toBe(before.x);
    expect(runtime.player.y).toBe(before.y);
    expect(runtime.transition.kind).toBe("idle");
  });

  test("runtime tile and enemy state is retained on revisit and reset on a new run", () => {
    const course = createLinkedAreasFixture();
    const runtime = createRuntime(course);
    ticks(runtime, 20);
    const goomba = runtime.ground.actors.get(AREA_IDS.goomba);
    expect(goomba).toBeDefined();
    if (!goomba) throw new Error("goomba missing");
    const walked = goomba.x;
    expect(walked).not.toBe(320);
    step(runtime, down);
    ticks(runtime, 29, downHold);
    expect(runtime.areaId).toBe(AREA_IDS.dest);
    const during = runtime.ground.actors.get(AREA_IDS.goomba)?.x;
    expect(during).toBe(walked);
    ticks(runtime, 40);
    expect(runtime.ground.actors.get(AREA_IDS.goomba)?.x).toBe(walked);
    step(runtime, down);
    ticks(runtime, 29, downHold);
    expect(runtime.areaId).toBe(AREA_IDS.main);
    expect(runtime.ground.actors.get(AREA_IDS.goomba)?.x).toBe(walked);
    const retry = createRuntime(course);
    expect(retry.ground.actors.get(AREA_IDS.goomba)?.x).toBe(320);
    expect(retry.areaId).toBe(AREA_IDS.main);
  });
});

describe("area create rename theme resize delete", () => {
  test("create rename and theme are one undoable command each", () => {
    const origin = createNewCourseFixture();
    const history = createHistory(origin);
    const created = ok(createArea(origin, { id: fixtureId(1500) }));
    expect(history.commit(created).status).toBe("committed");
    expect(history.document().areas).toHaveLength(2);
    const extra = history.document().areas.find(area => area.id === fixtureId(1500));
    expect(extra).toMatchObject({ id: fixtureId(1500), theme: "overworld", width: 32, height: 15 });
    expect(extra?.tiles.some(tile => tile.kind === "ground")).toBe(true);
    expect(history.commit(renameArea(history.document(), fixtureId(1500), "지하 창고")).status).toBe("committed");
    expect(history.document().areas.find(area => area.id === fixtureId(1500))?.name).toBe("지하 창고");
    expect(history.commit(setAreaTheme(history.document(), fixtureId(1500), "underground")).status).toBe("committed");
    expect(history.document().areas.find(area => area.id === fixtureId(1500))?.theme).toBe("underground");
    expect(history.snapshot().undoCount).toBe(3);
    expect(history.undo()).toBe(true);
    expect(history.document().areas.find(area => area.id === fixtureId(1500))?.theme).toBe("overworld");
  });

  test("shrinking previews cropped content then crops as one undoable command", () => {
    const origin = createNewCourseFixture();
    const history = createHistory(origin);
    const preview = previewResize(origin, origin.mainAreaId, 32, 15);
    expect(preview.ok).toBe(true);
    if (!preview.ok) throw new Error("preview");
    expect(preview.blocked).toBe(false);
    expect(preview.objects.some(object => object.kind === "flagGoal")).toBe(true);
    expect(preview.tiles.length).toBeGreaterThan(0);
    const cropped = ok(resizeArea(origin, origin.mainAreaId, 32, 15));
    expect(history.commit(cropped).status).toBe("committed");
    expect(history.document().areas[0]?.width).toBe(32);
    expect(history.document().areas[0]?.objects.some(object => object.kind === "flagGoal")).toBe(false);
    expect(history.snapshot().undoCount).toBe(1);
    expect(history.undo()).toBe(true);
    expect(canonical(history.document())).toBe(canonical(origin));
    expect(history.redo()).toBe(true);
    expect(history.document().areas[0]?.width).toBe(32);
  });

  test("cropping a pipe deletes its piranha and clears reciprocal plus warp slots in one command", () => {
    const origin = createLinkedAreasFixture();
    const history = createHistory(origin);
    const before = canonical(origin);
    const cropped = ok(resizeArea(origin, origin.mainAreaId, 32, 15));
    expect(history.commit(cropped).status).toBe("committed");
    const main = history.document().areas.find(area => area.id === origin.mainAreaId);
    expect(main?.objects.some(object => object.id === AREA_IDS.pipeFar)).toBe(false);
    expect(main?.objects.some(object => object.id === AREA_IDS.piranhaFar)).toBe(false);
    const dest = history.document().areas.find(area => area.id === AREA_IDS.dest)?.objects.find(object => object.id === AREA_IDS.pipeFarDest);
    expect(dest?.kind).toBe("pipe");
    if (dest?.kind === "pipe") expect(dest.props.destination).toBeUndefined();
    const warp = main?.objects.find(object => object.kind === "warpZone");
    expect(warp?.kind).toBe("warpZone");
    if (warp?.kind === "warpZone") expect(warp.props.pipeIds).toEqual([AREA_IDS.pipeMain, null, null]);
    expect(history.undo()).toBe(true);
    expect(canonical(history.document())).toBe(before);
  });

  test("sole-area deletion is blocked; start area requires another start; content delete confirms via one command", () => {
    const origin = createNewCourseFixture();
    const only = deleteArea(origin, origin.mainAreaId);
    expect(only.ok).toBe(false);
    if (!only.ok) expect(only.error.code).toBe("limit_exceeded");
    const withExtra = ok(createArea(origin, { id: fixtureId(1501), name: "별관" }));
    const blockedStart = deleteArea(withExtra, withExtra.mainAreaId);
    expect(blockedStart.ok).toBe(false);
    if (!blockedStart.ok) expect(blockedStart.error.code).toBe("invalid_reference");
    const history = createHistory(withExtra);
    const removed = ok(deleteArea(withExtra, fixtureId(1501)));
    expect(history.commit(removed).status).toBe("committed");
    expect(history.document().areas).toHaveLength(1);
    expect(history.document().areas[0]?.id).toBe(origin.mainAreaId);
    expect(history.undo()).toBe(true);
    expect(authoredContentEqual(history.document(), withExtra)).toBe(true);
  });

  test("area count cannot exceed 16 and sizes stay in 32-4096 x 15-128", () => {
    let course = createNewCourseFixture();
    for (let i = 0; i < COURSE_LIMITS.areas - 1; i++) {
      course = ok(createArea(course, { id: fixtureId(1600 + i) }));
    }
    expect(course.areas).toHaveLength(16);
    const overflow = createArea(course, { id: fixtureId(1699) });
    expect(overflow.ok).toBe(false);
    if (!overflow.ok) expect(overflow.error.code).toBe("limit_exceeded");
    const tooNarrow = resizeArea(createNewCourseFixture(), createNewCourseFixture().mainAreaId, 31, 15);
    expect(tooNarrow.ok).toBe(false);
  });
});
