import { describe, expect, test } from "bun:test";
import { EMPTY_INPUT, InputBuffer } from "../src/input";
import type { InputFrame } from "../src/input";
import { createEditorSession } from "../src/editor/session";
import { createHistory } from "../src/editor/history";
import { emptySelection } from "../src/editor/selection";
import { setObjectProperties, setTiles } from "../src/editor/commands";
import { snapshot } from "../src/game/state";
import { serializeCourse } from "../src/level/serialize";
import type { CourseV1, ValidationResult } from "../src/level/types";
import { createLinkedAreasFixture, AREA_IDS } from "./fixtures/areas";
import { createNewCourseFixture } from "./fixtures/factory";
import { createMovementFixture } from "./fixtures/movement";
import { PIPE_TRANSITION_TICKS } from "../src/game/transitions";

const idle = EMPTY_INPUT;
const down: InputFrame = { ...EMPTY_INPUT, down: { held: true, pressed: true, released: false } };
const downHold: InputFrame = { ...EMPTY_INPUT, down: { held: true, pressed: false, released: false } };

function ok<T>(result: ValidationResult<T>): T {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`${result.error.code} ${result.error.path}: ${result.error.message}`);
  return result.value;
}
function canonical(course: CourseV1): string {
  return ok(serializeCourse(course));
}
function isolationCourse(): CourseV1 {
  const origin = createNewCourseFixture();
  return ok(setTiles(origin, origin.mainAreaId, [
    { x: 2, y: 10, kind: "brick", content: "none" },
    { x: 3, y: 12, kind: "coin" },
  ]));
}
function flagId(course: CourseV1): string {
  const object = course.areas[0]?.objects.find(item => item.kind === "flagGoal");
  if (!object) throw new Error("expected flag");
  return object.id;
}
function ticks(session: ReturnType<typeof createEditorSession>, count: number, input = idle) {
  const events = [];
  for (let i = 0; i < count; i++) events.push(...session.step(input));
  return events;
}

describe("play source isolation", () => {
  test("breaking a brick and collecting a coin leave the authored document and history byte-identical", () => {
    const course = isolationCourse();
    const frozen = canonical(course);
    const history = createHistory(course);
    const generation = history.snapshot().generation;
    const undoCount = history.snapshot().undoCount;
    const session = createEditorSession({ history });
    expect(session.enterPlay().ok).toBe(true);
    expect(session.mode()).toBe("PLAYING");
    const run = session.run();
    expect(run).not.toBeNull();
    if (!run) throw new Error("expected run");
    const source = session.playSource();
    expect(source).not.toBeNull();
    if (!source) throw new Error("expected play source");
    expect(canonical(source)).toBe(frozen);
    expect(canonical(run.authored)).toBe(frozen);

    run.runtime.player.form = "super";
    run.runtime.player.x = 40;
    run.runtime.player.y = 208;
    run.runtime.player.vx = 0;
    run.runtime.player.vy = -5;
    run.runtime.player.grounded = false;
    const broken = session.step(idle);
    expect(broken.some(event => event.type === "blockBreak")).toBe(true);
    expect(run.runtime.areas.get(course.mainAreaId)?.tiles.get(10 * 256 + 2)).toBeUndefined();

    run.runtime.player.x = 56;
    run.runtime.player.y = 208;
    run.runtime.player.vx = 0;
    run.runtime.player.vy = 0;
    const collected = session.step(idle);
    expect(collected.some(event => event.type === "coin")).toBe(true);
    expect(run.runtime.progress.coins).toBe(1);

    expect(canonical(history.document())).toBe(frozen);
    expect(canonical(session.document())).toBe(frozen);
    expect(canonical(source)).toBe(frozen);
    expect(canonical(run.authored)).toBe(frozen);
    expect(history.snapshot().generation).toBe(generation);
    expect(history.snapshot().undoCount).toBe(undoCount);
    expect(history.snapshot().redoCount).toBe(0);
    session.returnToEdit();
    expect(session.mode()).toBe("EDIT");
    expect(session.playSource()).toBeNull();
    expect(canonical(history.document())).toBe(frozen);
    expect(history.snapshot().generation).toBe(generation);
  });
});

describe("identical restart initial state", () => {
  test("restarting yields structurally equal initial snapshots every time", () => {
    const history = createHistory(createNewCourseFixture());
    const session = createEditorSession({ history });
    expect(session.enterPlay().ok).toBe(true);
    const first = snapshot(session.run()!.runtime);
    ticks(session, 40, { ...EMPTY_INPUT, right: { held: true, pressed: false, released: false } });
    expect(snapshot(session.run()!.runtime)).not.toEqual(first);
    session.restart();
    expect(session.mode()).toBe("PLAYING");
    const second = snapshot(session.run()!.runtime);
    expect(second).toEqual(first);
    ticks(session, 12);
    session.restart();
    expect(snapshot(session.run()!.runtime)).toEqual(first);
    expect(snapshot(session.run()!.runtime)).toEqual(second);
  });
});

describe("invalid property and spawn guard", () => {
  test("invalid in-progress property blocks play and does not start a run", () => {
    const course = createNewCourseFixture();
    const history = createHistory(course);
    const session = createEditorSession({ history });
    const pending = setObjectProperties(course, course.mainAreaId, flagId(course), { height: 3 });
    expect(pending.ok).toBe(false);
    const result = session.enterPlay({ pending });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected guard");
    expect(result.error.code).toBe("invalid_value");
    expect(result.mode).toBe("EDIT");
    expect(session.mode()).toBe("EDIT");
    expect(session.run()).toBeNull();
    expect(canonical(history.document())).toBe(canonical(course));
  });

  test("blocked cursor spawn stays in edit and does not write start", () => {
    const course = createNewCourseFixture();
    const history = createHistory(course);
    const session = createEditorSession({ history });
    const result = session.enterPlay({ spawnOverride: { areaId: course.start.areaId, x: 40, y: 216 } });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected spawn guard");
    expect(result.error.code).toBe("start_blocked");
    expect(session.mode()).toBe("EDIT");
    expect(session.run()).toBeNull();
    expect(session.document().start).toEqual(course.start);
  });

  test("goal-free course requires explicit sandbox; valid cursor spawn is transient", () => {
    const course = createMovementFixture();
    const history = createHistory(course);
    const session = createEditorSession({ history });
    const blocked = session.enterPlay();
    expect(blocked.ok).toBe(false);
    if (blocked.ok) throw new Error("expected goal guard");
    expect(blocked.error.code).toBe("goal_required");
    expect(session.mode()).toBe("EDIT");
    const sandbox = session.enterPlay({ allowNoGoal: true, spawnOverride: { areaId: course.start.areaId, x: 72, y: 208 } });
    expect(sandbox.ok).toBe(true);
    expect(session.mode()).toBe("PLAYING");
    expect(session.run()?.runtime.player.x).toBe(72);
    expect(session.document().start).toEqual(course.start);
    expect(session.playSource()?.start).toEqual(course.start);
    session.returnToEdit();
    expect(session.document().start).toEqual(course.start);
  });

  test("valid pending property commits before play", () => {
    const course = createNewCourseFixture();
    const history = createHistory(course);
    const session = createEditorSession({ history });
    const pending = setObjectProperties(course, course.mainAreaId, flagId(course), { height: 8 });
    expect(session.enterPlay({ pending }).ok).toBe(true);
    const object = session.document().areas[0]?.objects.find(item => item.kind === "flagGoal");
    expect(object?.kind).toBe("flagGoal");
    if (object?.kind === "flagGoal") expect(object.props.height).toBe(8);
    expect(history.snapshot().undoCount).toBe(1);
  });
});

describe("selection and viewport restoration", () => {
  test("returning to edit restores the editor selection and viewport", () => {
    const course = createNewCourseFixture();
    const history = createHistory(course);
    const session = createEditorSession({ history });
    const selected = { areaId: course.mainAreaId, objectIds: [flagId(course)] as const };
    const view = { x: 128, y: 16, zoom: 2 as const };
    session.setSelection(selected);
    session.setViewport(view);
    expect(session.enterPlay().ok).toBe(true);
    session.setSelection(emptySelection(course.mainAreaId));
    session.setViewport({ x: 0, y: 0, zoom: 4 });
    expect(session.selection()).toEqual(selected);
    expect(session.viewport()).toEqual(view);
    ticks(session, 8, { ...EMPTY_INPUT, right: { held: true, pressed: false, released: false } });
    session.pause("button");
    expect(session.mode()).toBe("PAUSED");
    session.returnToEdit();
    expect(session.mode()).toBe("EDIT");
    expect(session.selection()).toEqual(selected);
    expect(session.viewport()).toEqual(view);
    expect(session.run()).toBeNull();
  });
});

describe("no stale held-key edges", () => {
  test("entering or leaving play clears latched keys so consume is empty", () => {
    const input = new InputBuffer();
    const session = createEditorSession({ history: createHistory(createNewCourseFixture()), input });
    input.key("ArrowRight", true);
    input.key("Space", true);
    expect(session.enterPlay().ok).toBe(true);
    expect(input.consume()).toEqual(EMPTY_INPUT);
    expect(session.lastInput()).toEqual(EMPTY_INPUT);
    input.key("ArrowRight", true);
    input.key("KeyZ", true);
    session.pause("escape");
    expect(session.mode()).toBe("PAUSED");
    expect(input.consume()).toEqual(EMPTY_INPUT);
    input.key("ShiftLeft", true);
    session.resume();
    expect(input.consume()).toEqual(EMPTY_INPUT);
    input.key("ArrowLeft", true);
    session.returnToEdit();
    expect(input.consume()).toEqual(EMPTY_INPUT);
    expect(session.lastInput()).toEqual(EMPTY_INPUT);
    input.key("Space", true);
    expect(session.enterPlay().ok).toBe(true);
    expect(input.consume()).toEqual(EMPTY_INPUT);
  });
});

describe("per-area runtime lifecycle", () => {
  test("one run retains per-area actor state across pipes and a new play resets it", () => {
    const course = createLinkedAreasFixture();
    const history = createHistory(course);
    const frozen = canonical(course);
    const session = createEditorSession({ history });
    expect(session.enterPlay().ok).toBe(true);
    const run = session.run();
    expect(run).not.toBeNull();
    if (!run) throw new Error("expected run");
    expect(run.runtime.areas.size).toBe(course.areas.length);
    ticks(session, 20);
    const goomba = run.runtime.ground.actors.get(AREA_IDS.goomba);
    expect(goomba).toBeDefined();
    const walked = goomba?.x;
    expect(walked).not.toBe(320);
    session.step(down);
    ticks(session, PIPE_TRANSITION_TICKS - 1, downHold);
    expect(run.runtime.areaId).toBe(AREA_IDS.dest);
    expect(run.runtime.ground.actors.get(AREA_IDS.goomba)?.x).toBe(walked);
    session.step(down);
    ticks(session, PIPE_TRANSITION_TICKS - 1, downHold);
    expect(run.runtime.areaId).toBe(AREA_IDS.main);
    expect(run.runtime.ground.actors.get(AREA_IDS.goomba)?.x).toBe(walked);
    expect(canonical(history.document())).toBe(frozen);
    session.returnToEdit();
    expect(session.enterPlay().ok).toBe(true);
    expect(session.run()?.runtime.ground.actors.get(AREA_IDS.goomba)?.x).toBe(320);
    expect(canonical(history.document())).toBe(frozen);
  });
});
