import { describe, expect, test } from "bun:test";
import { createClipboard } from "../src/editor/clipboard";
import { deleteObjects, placeObject, setCourseFields } from "../src/editor/commands";
import { createHistory } from "../src/editor/history";
import {
  beginMarqueeGesture, beginMoveGesture, commitCourseProperties, deleteSelection,
  sanitizeSelection, selectRect, type EditorSelection,
} from "../src/editor/selection";
import { authoredContentEqual, serializeCourse } from "../src/level/serialize";
import type { CourseV1, PlacedObject, ValidationResult } from "../src/level/types";
import { validateCourse } from "../src/level/validate";
import { createNewCourseFixture, fixtureId } from "./fixtures/factory";

function ok<T>(result: ValidationResult<T>): T {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`${result.error.code} ${result.error.path}: ${result.error.message}`);
  return result.value;
}
function canonical(course: CourseV1): string { return ok(serializeCourse(course)); }
function objectById(course: CourseV1, id: string): PlacedObject | undefined {
  for (const area of course.areas) {
    const found = area.objects.find((item) => item.id === id);
    if (found) return found;
  }
  return undefined;
}

function withLinkedPipes(): { course: CourseV1; a: string; b: string; areaId: string } {
  const origin = createNewCourseFixture();
  const id = origin.mainAreaId;
  const a = fixtureId(40), b = fixtureId(41);
  const course = ok(validateCourse({
    ...origin,
    areas: origin.areas.map((area) => area.id === id ? {
      ...area,
      objects: [
        ...area.objects,
        { id: a, kind: "pipe", x: 64, y: 208, props: { height: 3, entrance: "down", destination: { areaId: id, pipeId: b } } },
        { id: b, kind: "pipe", x: 96, y: 208, props: { height: 3, entrance: "up", destination: { areaId: id, pipeId: a } } },
      ],
    } : area),
  }));
  return { course, a, b, areaId: id };
}

describe("paste remaps internal links and clears external ones", () => {
  test("copy/paste of two linked pipes regenerates IDs and remaps only internal destinations", () => {
    const { course, a, b, areaId: id } = withLinkedPipes();
    const history = createHistory(course);
    const clipboard = createClipboard();
    const selection: EditorSelection = { areaId: id, objectIds: [a, b] };
    const copied = clipboard.copy(history.document(), selection);
    expect(copied.omittedIds).toEqual([]);
    expect(copied.objects.map((item) => item.id)).toEqual([a, b]);
    const ids = new Map([[a, fixtureId(80)], [b, fixtureId(81)]]);
    const pasted = clipboard.paste(history, id, { dx: 32, dy: 0 }, (old) => ids.get(old) ?? fixtureId(99));
    expect(pasted.outcome.status).toBe("committed");
    expect(pasted.omittedIds).toEqual([]);
    expect(pasted.pastedIds).toEqual([fixtureId(80), fixtureId(81)]);
    expect(history.snapshot().undoCount).toBe(1);
    expect(objectById(history.document(), a)).toEqual(objectById(course, a));
    expect(objectById(history.document(), b)).toEqual(objectById(course, b));
    const copyA = objectById(history.document(), fixtureId(80));
    const copyB = objectById(history.document(), fixtureId(81));
    expect(copyA).toMatchObject({ kind: "pipe", x: 96, y: 208, props: { destination: { areaId: id, pipeId: fixtureId(81) } } });
    expect(copyB).toMatchObject({ kind: "pipe", x: 128, y: 208, props: { destination: { areaId: id, pipeId: fixtureId(80) } } });
    expect(history.undo()).toBe(true);
    expect(canonical(history.document())).toBe(canonical(course));
    expect(objectById(history.document(), fixtureId(80))).toBeUndefined();
  });

  test("pasting one linked pipe clears the external destination", () => {
    const { course, a, b, areaId: id } = withLinkedPipes();
    const history = createHistory(course);
    const clipboard = createClipboard();
    clipboard.copy(history.document(), { areaId: id, objectIds: [a] });
    const pasted = clipboard.paste(history, id, { dx: 48, dy: 0 }, () => fixtureId(83));
    expect(pasted.outcome.status).toBe("committed");
    const copy = objectById(history.document(), fixtureId(83));
    expect(copy).toMatchObject({ kind: "pipe", x: 112, y: 208 });
    if (copy?.kind === "pipe") expect(copy.props.destination).toBeUndefined();
    expect(objectById(history.document(), a)).toEqual(objectById(course, a));
    expect(objectById(history.document(), b)).toEqual(objectById(course, b));
  });

  test("copying a Piranha without its pipe omits that dependent Piranha", () => {
    const origin = createNewCourseFixture();
    const id = origin.mainAreaId;
    const pipeId = fixtureId(50), piranhaId = fixtureId(51);
    let course = ok(placeObject(origin, id, { id: pipeId, kind: "pipe", x: 64, y: 208 }));
    course = ok(placeObject(course, id, { id: piranhaId, kind: "piranha", pipeId }));
    const history = createHistory(course);
    const clipboard = createClipboard();
    const copied = clipboard.copy(history.document(), { areaId: id, objectIds: [piranhaId] });
    expect(copied.omittedIds).toEqual([piranhaId]);
    expect(copied.objects).toEqual([]);
    const before = canonical(history.document());
    const pasted = clipboard.paste(history, id, { dx: 16, dy: 0 }, () => fixtureId(82));
    expect(pasted.outcome.status).toBe("noop");
    expect(pasted.omittedIds).toEqual([piranhaId]);
    expect(pasted.pastedIds).toEqual([]);
    expect(canonical(history.document())).toBe(before);
    expect(history.snapshot().undoCount).toBe(0);
  });

  test("partial copy of a castleGoal includes its bridge and translation applies to both", () => {
    const origin = createNewCourseFixture();
    const id = origin.mainAreaId;
    const goalId = fixtureId(60), bowserId = fixtureId(61);
    let course = ok(placeObject(origin, id, { id: bowserId, kind: "bowser", x: 48, y: 96 }));
    course = ok(placeObject(course, id, {
      id: goalId, kind: "castleGoal", x: 160, y: 96,
      props: { bridge: { x: 2, y: 6, width: 8, height: 1 }, bowserId },
    }));
    const history = createHistory(course);
    const clipboard = createClipboard();
    const copied = clipboard.copy(history.document(), { areaId: id, objectIds: [goalId] });
    expect(copied.omittedIds).toEqual([]);
    expect(copied.objects).toHaveLength(1);
    expect(copied.objects[0]).toMatchObject({
      kind: "castleGoal", id: goalId, x: 160, y: 96,
      props: { bridge: { x: 2, y: 6, width: 8, height: 1 }, bowserId },
    });
    const pasted = clipboard.paste(history, id, { dx: 16, dy: 0 }, () => fixtureId(84));
    expect(pasted.outcome.status).toBe("committed");
    const copy = objectById(history.document(), fixtureId(84));
    expect(copy).toEqual({
      id: fixtureId(84), kind: "castleGoal", x: 176, y: 96,
      props: { bridge: { x: 3, y: 6, width: 8, height: 1 } },
    });
    expect(objectById(history.document(), goalId)).toEqual(objectById(course, goalId));
  });

  test("app-local clipboard is not a document field and does not serialize", () => {
    const { course, a, areaId: id } = withLinkedPipes();
    const history = createHistory(course);
    const clipboard = createClipboard();
    clipboard.copy(history.document(), { areaId: id, objectIds: [a] });
    expect(clipboard.contents()).not.toBeNull();
    expect(Object.hasOwn(history.document(), "clipboard")).toBe(false);
    const json = canonical(history.document());
    expect(json.includes("clipboard")).toBe(false);
    expect(authoredContentEqual(history.document(), course)).toBe(true);
  });
});

describe("selection sanitization after undo and delete", () => {
  test("rectangular marquee selects intersecting objects", () => {
    const { course, a, b, areaId: id } = withLinkedPipes();
    const selected = selectRect(course, id, { x0: 40, y0: 150, x1: 130, y1: 220 });
    expect(selected.areaId).toBe(id);
    expect(selected.objectIds).toEqual([a, b]);
    const marquee = beginMarqueeGesture({ areaId: id, origin: { x: 40, y: 150 } });
    marquee.extend({ x: 80, y: 220 });
    const one = marquee.commit(course);
    expect(one.objectIds).toEqual([a]);
  });

  test("delete selection is one command and cannot keep stale IDs", () => {
    const { course, a, b, areaId: id } = withLinkedPipes();
    const history = createHistory(course);
    let selection: EditorSelection = { areaId: id, objectIds: [a, b] };
    const outcome = deleteSelection(history, selection);
    expect(outcome.status).toBe("committed");
    expect(history.snapshot().undoCount).toBe(1);
    expect(objectById(history.document(), a)).toBeUndefined();
    expect(objectById(history.document(), b)).toBeUndefined();
    selection = sanitizeSelection(selection, history.document());
    expect(selection.objectIds).toEqual([]);
    expect(history.undo()).toBe(true);
    expect(objectById(history.document(), a)?.kind).toBe("pipe");
    selection = sanitizeSelection(selection, history.document());
    expect(selection.objectIds).toEqual([]);
  });

  test("undo of paste sanitizes selection away from regenerated IDs", () => {
    const { course, a, b, areaId: id } = withLinkedPipes();
    const history = createHistory(course);
    const clipboard = createClipboard();
    clipboard.copy(history.document(), { areaId: id, objectIds: [a, b] });
    const ids = new Map([[a, fixtureId(90)], [b, fixtureId(91)]]);
    const pasted = clipboard.paste(history, id, { dx: 32, dy: 0 }, (old) => ids.get(old) ?? fixtureId(99));
    expect(pasted.outcome.status).toBe("committed");
    let selection: EditorSelection = { areaId: id, objectIds: pasted.pastedIds };
    expect(sanitizeSelection(selection, history.document()).objectIds).toEqual([fixtureId(90), fixtureId(91)]);
    expect(history.undo()).toBe(true);
    selection = sanitizeSelection(selection, history.document());
    expect(selection.objectIds).toEqual([]);
    expect(objectById(history.document(), fixtureId(90))).toBeUndefined();
  });

  test("deleting through history then sanitizing drops missing objects only", () => {
    const origin = createNewCourseFixture();
    const id = origin.mainAreaId;
    const keep = fixtureId(70), drop = fixtureId(71);
    let course = ok(placeObject(origin, id, { id: keep, kind: "goomba", x: 48, y: 208 }));
    course = ok(placeObject(course, id, { id: drop, kind: "goomba", x: 80, y: 208 }));
    const history = createHistory(course);
    const selection: EditorSelection = { areaId: id, objectIds: [keep, drop, fixtureId(72)] };
    expect(history.commit(deleteObjects(history.document(), [drop])).status).toBe("committed");
    const cleaned = sanitizeSelection(selection, history.document());
    expect(cleaned.objectIds).toEqual([keep]);
    expect(objectById(history.document(), drop)).toBeUndefined();
  });
});

describe("boundary rejection is all-or-nothing", () => {
  test("a drag that would leave the area is rejected and leaves state unchanged", () => {
    const origin = createNewCourseFixture();
    const id = origin.mainAreaId;
    const goombaId = fixtureId(73);
    const course = ok(placeObject(origin, id, { id: goombaId, kind: "goomba", x: 16, y: 208 }));
    const history = createHistory(course);
    const before = canonical(history.document());
    const generation = history.snapshot().generation;
    const move = beginMoveGesture({ objectIds: [goombaId], origin: { x: 16, y: 208 } });
    move.extend({ x: 0, y: 208 });
    const preview = move.preview(history.document());
    expect(preview.dx).toBe(-16);
    expect(preview.dy).toBe(0);
    expect(preview.valid).toBe(false);
    expect(move.commit(history).status).toBe("rejected");
    expect(canonical(history.document())).toBe(before);
    expect(history.snapshot().undoCount).toBe(0);
    expect(history.snapshot().generation).toBe(generation);
    expect(objectById(history.document(), goombaId)).toMatchObject({ x: 16, y: 208 });
  });

  test("a paste that would leave the area is rejected entirely", () => {
    const origin = createNewCourseFixture();
    const id = origin.mainAreaId;
    const goombaId = fixtureId(74);
    const course = ok(placeObject(origin, id, { id: goombaId, kind: "goomba", x: 16, y: 208 }));
    const history = createHistory(course);
    const clipboard = createClipboard();
    clipboard.copy(history.document(), { areaId: id, objectIds: [goombaId] });
    const before = canonical(history.document());
    const pasted = clipboard.paste(history, id, { dx: -16, dy: 0 }, () => fixtureId(85));
    expect(pasted.outcome.status).toBe("rejected");
    expect(pasted.pastedIds).toEqual([]);
    expect(canonical(history.document())).toBe(before);
    expect(history.snapshot().undoCount).toBe(0);
    expect(objectById(history.document(), fixtureId(85))).toBeUndefined();
    expect(objectById(history.document(), goombaId)).toMatchObject({ x: 16, y: 208 });
  });

  test("a valid drag move is one reversible command", () => {
    const origin = createNewCourseFixture();
    const id = origin.mainAreaId;
    const goombaId = fixtureId(75);
    const course = ok(placeObject(origin, id, { id: goombaId, kind: "goomba", x: 48, y: 208 }));
    const history = createHistory(course);
    const move = beginMoveGesture({ objectIds: [goombaId], origin: { x: 48, y: 208 } });
    move.extend({ x: 80, y: 208 });
    expect(move.preview(history.document()).valid).toBe(true);
    expect(move.commit(history).status).toBe("committed");
    expect(history.snapshot().undoCount).toBe(1);
    expect(objectById(history.document(), goombaId)).toMatchObject({ x: 80, y: 208 });
    expect(history.undo()).toBe(true);
    expect(objectById(history.document(), goombaId)).toMatchObject({ x: 48, y: 208 });
  });
});

describe("property atomicity", () => {
  test("timer 0, 30, 999 commit as one command each and 29 writes nothing", () => {
    const origin = createNewCourseFixture();
    const history = createHistory(origin);
    expect(commitCourseProperties(history, { timerSeconds: 0 }).status).toBe("committed");
    expect(history.document().timerSeconds).toBe(0);
    expect(history.snapshot().undoCount).toBe(1);
    expect(commitCourseProperties(history, { timerSeconds: 30 }).status).toBe("committed");
    expect(history.document().timerSeconds).toBe(30);
    expect(commitCourseProperties(history, { timerSeconds: 999 }).status).toBe("committed");
    expect(history.document().timerSeconds).toBe(999);
    expect(history.snapshot().undoCount).toBe(3);
    const generation = history.snapshot().generation;
    expect(commitCourseProperties(history, { timerSeconds: 29 }).status).toBe("rejected");
    expect(history.document().timerSeconds).toBe(999);
    expect(history.snapshot().undoCount).toBe(3);
    expect(history.snapshot().generation).toBe(generation);
    expect(setCourseFields(history.document(), { timerSeconds: 29 }).ok).toBe(false);
    expect(history.undo()).toBe(true);
    expect(history.document().timerSeconds).toBe(30);
    expect(history.undo()).toBe(true);
    expect(history.document().timerSeconds).toBe(0);
    expect(history.undo()).toBe(true);
    expect(history.document().timerSeconds).toBe(400);
  });

  test("cut is copy plus one delete command and duplicate is one paste command", () => {
    const origin = createNewCourseFixture();
    const id = origin.mainAreaId;
    const goombaId = fixtureId(76);
    const course = ok(placeObject(origin, id, { id: goombaId, kind: "goomba", x: 64, y: 208 }));
    const history = createHistory(course);
    const clipboard = createClipboard();
    const cut = clipboard.cut(history, { areaId: id, objectIds: [goombaId] });
    expect(cut.outcome.status).toBe("committed");
    expect(history.snapshot().undoCount).toBe(1);
    expect(objectById(history.document(), goombaId)).toBeUndefined();
    expect(clipboard.contents()?.objects).toHaveLength(1);
    expect(history.undo()).toBe(true);
    expect(objectById(history.document(), goombaId)?.kind).toBe("goomba");
    const duplicated = clipboard.duplicate(history, { areaId: id, objectIds: [goombaId] }, () => fixtureId(86), { dx: 16, dy: 0 });
    expect(duplicated.outcome.status).toBe("committed");
    expect(history.snapshot().undoCount).toBe(1);
    expect(objectById(history.document(), goombaId)).toMatchObject({ x: 64, y: 208 });
    expect(objectById(history.document(), fixtureId(86))).toMatchObject({ kind: "goomba", x: 80, y: 208 });
  });
});
