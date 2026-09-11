import { describe, expect, test } from "bun:test";
import { beginPaintGesture } from "../src/editor/paint";
import { createHistory, HISTORY_CAP } from "../src/editor/history";
import {
  deleteObjects, eraseTiles, fillTiles, moveObjects, pasteObjects, placeObject, previewFill,
  setCourseFields, setObjectProperties, setTiles,
} from "../src/editor/commands";
import { authoredContentEqual, serializeCourse } from "../src/level/serialize";
import { OBJECT_CATALOG } from "../src/level/catalog";
import type { AreaV1, CourseV1, PlacedObject, TileCell, ValidationResult } from "../src/level/types";
import { validateCourse } from "../src/level/validate";
import { createAllKindsFixture, createNewCourseFixture, fixtureId } from "./fixtures/factory";

const brick = (x: number, y: number): TileCell => ({ x, y, kind: "brick", content: "none" });
function ok<T>(result: ValidationResult<T>): T {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`${result.error.code} ${result.error.path}: ${result.error.message}`);
  return result.value;
}
function canonical(course: CourseV1): string { return ok(serializeCourse(course)); }
function main(course: CourseV1): AreaV1 {
  const area = course.areas.find((item) => item.id === course.mainAreaId);
  if (!area) throw new Error("expected main area");
  return area;
}
function tileAt(course: CourseV1, x: number, y: number): TileCell | undefined {
  return main(course).tiles.find((tile) => tile.x === x && tile.y === y);
}
function objectById(course: CourseV1, id: string): PlacedObject | undefined {
  for (const area of course.areas) {
    const found = area.objects.find((item) => item.id === id);
    if (found) return found;
  }
  return undefined;
}
function stroke(count: number, x = 10, y = 5): readonly TileCell[] {
  return Array.from({ length: count }, (_, i) => brick(x + i, y));
}

describe("paint gestures commit as one reversible command", () => {
  test("one stroke is one undo and redo restores exact cells", () => {
    const origin = createNewCourseFixture();
    const history = createHistory(origin);
    const cells = stroke(10);
    const gesture = beginPaintGesture({ areaId: origin.mainAreaId, tool: "paint", brush: { kind: "brick" }, origin: cells[0]! });
    for (const cell of cells.slice(1)) gesture.extend(cell);
    expect(gesture.commit(history).status).toBe("committed");
    expect(history.snapshot().undoCount).toBe(1);
    expect(history.snapshot().redoCount).toBe(0);
    expect(history.snapshot().dirty).toBe(true);
    for (const cell of cells) expect(tileAt(history.document(), cell.x, cell.y)).toEqual(cell);
    expect(main(history.document()).tiles.filter((tile) => tile.y === 5 && tile.kind === "brick")).toHaveLength(10);
    expect(history.undo()).toBe(true);
    expect(canonical(history.document())).toBe(canonical(origin));
    expect(history.snapshot().dirty).toBe(false);
    expect(history.snapshot().redoCount).toBe(1);
    expect(history.redo()).toBe(true);
    for (const cell of cells) expect(tileAt(history.document(), cell.x, cell.y)).toEqual(cell);
    expect(canonical(history.document())).toBe(canonical(ok(setTiles(origin, origin.mainAreaId, cells))));
  });

  test("cancelled gesture leaves document and redo intact", () => {
    const origin = createNewCourseFixture();
    const history = createHistory(origin);
    expect(history.commit(setTiles(origin, origin.mainAreaId, [brick(4, 4)])).status).toBe("committed");
    expect(history.undo()).toBe(true);
    expect(history.snapshot().redoCount).toBe(1);
    const before = canonical(history.document());
    const generation = history.snapshot().generation;
    const gesture = beginPaintGesture({ areaId: origin.mainAreaId, tool: "paint", brush: { kind: "hard" }, origin: { x: 8, y: 3 } });
    gesture.extend({ x: 9, y: 3 });
    gesture.cancel();
    expect(gesture.commit(history).status).toBe("cancelled");
    expect(canonical(history.document())).toBe(before);
    expect(history.snapshot().redoCount).toBe(1);
    expect(history.snapshot().undoCount).toBe(0);
    expect(history.snapshot().generation).toBe(generation);
    expect(history.redo()).toBe(true);
    expect(tileAt(history.document(), 4, 4)).toEqual(brick(4, 4));
  });

  test("no-op commit does not clear redo", () => {
    const origin = createNewCourseFixture();
    const history = createHistory(origin);
    expect(history.commit(setTiles(origin, origin.mainAreaId, [brick(6, 2)])).status).toBe("committed");
    expect(history.undo()).toBe(true);
    expect(history.snapshot().redoCount).toBe(1);
    const generation = history.snapshot().generation;
    expect(history.commit(setTiles(history.document(), origin.mainAreaId, [{ x: 0, y: 13, kind: "ground" }])).status).toBe("noop");
    const gesture = beginPaintGesture({ areaId: origin.mainAreaId, tool: "paint", brush: { kind: "ground" }, origin: { x: 1, y: 13 } });
    expect(gesture.commit(history).status).toBe("noop");
    expect(history.snapshot().redoCount).toBe(1);
    expect(history.snapshot().undoCount).toBe(0);
    expect(history.snapshot().generation).toBe(generation);
    expect(history.snapshot().dirty).toBe(false);
    expect(history.redo()).toBe(true);
    expect(tileAt(history.document(), 6, 2)).toEqual(brick(6, 2));
  });

  test("real command after undo invalidates the redo branch", () => {
    const origin = createNewCourseFixture();
    const history = createHistory(origin);
    expect(history.commit(setTiles(origin, origin.mainAreaId, [brick(1, 1)])).status).toBe("committed");
    expect(history.commit(setTiles(history.document(), origin.mainAreaId, [brick(2, 1)])).status).toBe("committed");
    expect(history.undo()).toBe(true);
    expect(tileAt(history.document(), 2, 1)).toBeUndefined();
    expect(history.snapshot().redoCount).toBe(1);
    expect(history.commit(setTiles(history.document(), origin.mainAreaId, [brick(3, 1)])).status).toBe("committed");
    expect(history.snapshot().redoCount).toBe(0);
    expect(tileAt(history.document(), 3, 1)).toEqual(brick(3, 1));
    expect(tileAt(history.document(), 2, 1)).toBeUndefined();
    expect(history.undo()).toBe(true);
    expect(tileAt(history.document(), 3, 1)).toBeUndefined();
    expect(tileAt(history.document(), 1, 1)).toEqual(brick(1, 1));
    expect(history.redo()).toBe(true);
    expect(tileAt(history.document(), 3, 1)).toEqual(brick(3, 1));
    expect(tileAt(history.document(), 2, 1)).toBeUndefined();
  });
});

describe("rectangle fill clips preview and rejects partial commits", () => {
  test("preview clips to area while an out-of-bounds commit is rejected entirely", () => {
    const origin = createNewCourseFixture();
    const history = createHistory(origin);
    expect(history.commit(setTiles(origin, origin.mainAreaId, [brick(4, 4)])).status).toBe("committed");
    expect(history.undo()).toBe(true);
    const area = main(origin);
    const rect = { x0: 250, y0: 0, x1: 260, y1: 2 };
    const preview = previewFill(area, rect);
    expect(preview.every((cell) => cell.x >= 0 && cell.y >= 0 && cell.x < area.width && cell.y < area.height)).toBe(true);
    expect(preview).toHaveLength(18);
    expect(preview.some((cell) => cell.x === 255 && cell.y === 2)).toBe(true);
    expect(preview.some((cell) => cell.x === 256)).toBe(false);
    const before = canonical(history.document());
    const rejected = fillTiles(origin, origin.mainAreaId, rect, { kind: "hard" });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error.code).toBe("out_of_bounds");
    expect(history.commit(rejected).status).toBe("rejected");
    expect(canonical(history.document())).toBe(before);
    expect(history.snapshot().redoCount).toBe(1);
    const gesture = beginPaintGesture({ areaId: origin.mainAreaId, tool: "fill", brush: { kind: "hard" }, origin: { x: 250, y: 0 } });
    gesture.extend({ x: 260, y: 2 });
    const painted = gesture.preview(history.document());
    expect(painted.clipped).toBe(true);
    expect(painted.outOfBounds).toBe(true);
    expect(painted.cells).toEqual(preview);
    expect(gesture.commit(history).status).toBe("rejected");
    expect(canonical(history.document())).toBe(before);
    expect(history.snapshot().redoCount).toBe(1);
  });

  test("in-bounds fill is one command and erase stroke removes those cells", () => {
    const origin = createNewCourseFixture();
    const history = createHistory(origin);
    const rect = { x0: 10, y0: 5, x1: 12, y1: 6 };
    const gesture = beginPaintGesture({ areaId: origin.mainAreaId, tool: "fill", brush: { kind: "hard" }, origin: { x: 10, y: 5 } });
    gesture.extend({ x: 12, y: 6 });
    expect(gesture.preview(origin).outOfBounds).toBe(false);
    expect(gesture.commit(history).status).toBe("committed");
    expect(history.snapshot().undoCount).toBe(1);
    expect(ok(fillTiles(origin, origin.mainAreaId, rect, { kind: "hard" })).areas[0]?.tiles.filter((tile) => tile.kind === "hard")).toHaveLength(6);
    for (let x = 10; x <= 12; x++) for (let y = 5; y <= 6; y++) expect(tileAt(history.document(), x, y)).toEqual({ x, y, kind: "hard" });
    const erase = beginPaintGesture({ areaId: origin.mainAreaId, tool: "erase", brush: { kind: "ground" }, origin: { x: 10, y: 5 } });
    erase.extend({ x: 11, y: 5 });
    expect(erase.commit(history).status).toBe("committed");
    expect(history.snapshot().undoCount).toBe(2);
    expect(tileAt(history.document(), 10, 5)).toBeUndefined();
    expect(tileAt(history.document(), 11, 5)).toBeUndefined();
    expect(tileAt(history.document(), 12, 5)).toEqual({ x: 12, y: 5, kind: "hard" });
    expect(history.undo()).toBe(true);
    expect(tileAt(history.document(), 10, 5)).toEqual({ x: 10, y: 5, kind: "hard" });
  });
});

describe("history cap, dirty identity and property commands", () => {
  test("evicting the oldest command keeps dirty status and cannot restore the saved document", () => {
    const origin = createNewCourseFixture();
    const history = createHistory(origin);
    for (let i = 0; i < HISTORY_CAP; i++) {
      expect(history.commit(setTiles(history.document(), origin.mainAreaId, [brick(i, 4)])).status).toBe("committed");
    }
    expect(history.snapshot().undoCount).toBe(HISTORY_CAP);
    expect(history.snapshot().dirty).toBe(true);
    const generation = history.snapshot().generation;
    expect(history.commit(setTiles(history.document(), origin.mainAreaId, [brick(HISTORY_CAP, 4)])).status).toBe("committed");
    expect(history.snapshot().undoCount).toBe(HISTORY_CAP);
    expect(history.snapshot().dirty).toBe(true);
    expect(history.snapshot().generation).toBe(generation + 1);
    expect(history.snapshot().redoCount).toBe(0);
    for (let i = 0; i < HISTORY_CAP; i++) expect(history.undo()).toBe(true);
    expect(history.undo()).toBe(false);
    expect(history.snapshot().dirty).toBe(true);
    expect(tileAt(history.document(), 0, 4)).toEqual(brick(0, 4));
    expect(tileAt(history.document(), HISTORY_CAP, 4)).toBeUndefined();
    expect(authoredContentEqual(history.document(), origin)).toBe(false);
  });

  test("committed property edits undo atomically and invalid values write nothing", () => {
    const origin = createNewCourseFixture();
    const history = createHistory(origin);
    expect(history.commit(setCourseFields(origin, { timerSeconds: 30 })).status).toBe("committed");
    expect(history.document().timerSeconds).toBe(30);
    expect(history.snapshot().undoCount).toBe(1);
    expect(history.commit(setCourseFields(history.document(), { timerSeconds: 29 })).status).toBe("rejected");
    expect(history.document().timerSeconds).toBe(30);
    expect(history.snapshot().undoCount).toBe(1);
    expect(history.undo()).toBe(true);
    expect(history.document().timerSeconds).toBe(400);
    expect(history.snapshot().redoCount).toBe(1);
    expect(history.commit(setCourseFields(history.document(), { title: " course " })).status).toBe("rejected");
    expect(history.snapshot().redoCount).toBe(1);
    expect(history.document().title).toBe(origin.title);
  });

  test("undo to saved authored content clears dirty without using revision", () => {
    const origin = { ...createNewCourseFixture(), revision: 4 };
    const history = createHistory(origin);
    expect(history.snapshot().dirty).toBe(false);
    expect(history.commit(setTiles(origin, origin.mainAreaId, [brick(7, 2)])).status).toBe("committed");
    history.markSaved();
    expect(history.snapshot().dirty).toBe(false);
    expect(history.document().revision).toBe(4);
    expect(history.undo()).toBe(true);
    expect(history.snapshot().dirty).toBe(true);
    expect(history.redo()).toBe(true);
    expect(history.snapshot().dirty).toBe(false);
  });
});

describe("object commands, reference cleanup and paste remap", () => {
  test("deleting a pipe clears piranha, reciprocal destination and warp slots in one command", () => {
    const origin = createAllKindsFixture();
    const history = createHistory(origin);
    const pipeId = fixtureId(10);
    const before = canonical(origin);
    expect(history.commit(deleteObjects(origin, [pipeId])).status).toBe("committed");
    expect(history.snapshot().undoCount).toBe(1);
    expect(objectById(history.document(), pipeId)).toBeUndefined();
    expect(main(history.document()).objects.some((item) => item.kind === "piranha")).toBe(false);
    const dest = objectById(history.document(), fixtureId(100));
    expect(dest?.kind).toBe("pipe");
    if (dest?.kind === "pipe") expect(dest.props.destination).toBeUndefined();
    const warp = main(history.document()).objects.find((item) => item.kind === "warpZone");
    expect(warp?.kind).toBe("warpZone");
    if (warp?.kind === "warpZone") expect(warp.props.pipeIds).toEqual([null, fixtureId(101), fixtureId(102)]);
    expect(history.undo()).toBe(true);
    expect(canonical(history.document())).toBe(before);
    expect(history.redo()).toBe(true);
    expect(objectById(history.document(), pipeId)).toBeUndefined();
    expect(main(history.document()).objects.some((item) => item.kind === "piranha")).toBe(false);
  });

  test("deleting one balance partner leaves an unpaired balance draft", () => {
    const origin = createAllKindsFixture();
    const history = createHistory(origin);
    const left = fixtureId(10 + 1);
    const right = fixtureId(105);
    expect(history.commit(deleteObjects(origin, [left])).status).toBe("committed");
    const survivor = objectById(history.document(), right);
    expect(survivor).toEqual({
      id: right, kind: "platform", x: 3712, y: 400,
      props: { motion: "balance", length: 3, travel: 8, speed: 1 },
    });
    expect(history.undo()).toBe(true);
    expect(canonical(history.document())).toBe(canonical(origin));
  });

  test("paste regenerates IDs, remaps internal links and clears external ones", () => {
    const origin = createNewCourseFixture();
    const areaId = origin.mainAreaId;
    const a = fixtureId(40), b = fixtureId(41);
    const withPipes = ok(validateCourse({
      ...origin,
      areas: origin.areas.map((area) => area.id === areaId ? {
        ...area,
        objects: [
          ...area.objects,
          { id: a, kind: "pipe", x: 64, y: 208, props: { height: 3, entrance: "down", destination: { areaId, pipeId: b } } },
          { id: b, kind: "pipe", x: 96, y: 208, props: { height: 3, entrance: "up", destination: { areaId, pipeId: a } } },
        ],
      } : area),
    }));
    const history = createHistory(withPipes);
    const ids = new Map([[a, fixtureId(80)], [b, fixtureId(81)]]);
    const pasted = ok(pasteObjects(withPipes, areaId, main(withPipes).objects.filter((item) => item.kind === "pipe"), {
      idFor: (id) => ids.get(id) ?? fixtureId(99), dx: 32, dy: 0,
    }));
    expect(pasted.omittedIds).toEqual([]);
    expect(history.commit(pasted.course).status).toBe("committed");
    expect(objectById(history.document(), a)).toEqual(objectById(withPipes, a));
    const copyA = objectById(history.document(), fixtureId(80));
    const copyB = objectById(history.document(), fixtureId(81));
    expect(copyA).toMatchObject({ kind: "pipe", x: 96, y: 208, props: { destination: { areaId, pipeId: fixtureId(81) } } });
    expect(copyB).toMatchObject({ kind: "pipe", x: 128, y: 208, props: { destination: { areaId, pipeId: fixtureId(80) } } });
    const piranha = { id: fixtureId(42), kind: "piranha" as const, x: 64, y: 160, props: { pipeId: a } };
    const partial = ok(pasteObjects(withPipes, areaId, [piranha], { idFor: () => fixtureId(82), dx: 0, dy: 0 }));
    expect(partial.omittedIds).toEqual([fixtureId(42)]);
    expect(authoredContentEqual(partial.course, withPipes)).toBe(true);
  });

  test("moving a pipe carries its piranha and a property edit is one command", () => {
    const origin = createNewCourseFixture();
    const areaId = origin.mainAreaId;
    const pipeId = fixtureId(50), piranhaId = fixtureId(51), koopaId = fixtureId(52);
    let course = ok(placeObject(origin, areaId, { id: pipeId, kind: "pipe", x: 64, y: 208 }));
    course = ok(placeObject(course, areaId, { id: piranhaId, kind: "piranha", pipeId }));
    course = ok(placeObject(course, areaId, { id: koopaId, kind: "koopa", x: 160, y: 208 }));
    const history = createHistory(course);
    expect(history.commit(moveObjects(course, [pipeId], { dx: 16, dy: 0 })).status).toBe("committed");
    expect(objectById(history.document(), pipeId)).toMatchObject({ x: 80, y: 208 });
    expect(objectById(history.document(), piranhaId)).toMatchObject({ x: 80, y: 160, props: { pipeId } });
    expect(history.commit(setObjectProperties(history.document(), areaId, koopaId, { color: "red" })).status).toBe("committed");
    expect(objectById(history.document(), koopaId)).toMatchObject({ props: { color: "red" } });
    expect(history.snapshot().undoCount).toBe(2);
    expect(history.commit(setObjectProperties(history.document(), areaId, koopaId, { color: "blue" })).status).toBe("rejected");
    expect(objectById(history.document(), koopaId)).toMatchObject({ props: { color: "red" } });
    expect(history.undo()).toBe(true);
    expect(objectById(history.document(), koopaId)).toMatchObject({ props: { color: "green" } });
    expect(history.undo()).toBe(true);
    expect(objectById(history.document(), pipeId)).toMatchObject({ x: 64, y: 208 });
    expect(objectById(history.document(), piranhaId)).toMatchObject({ x: 64, y: 160 });
  });

  test("object defaults from the catalog place in one command", () => {
    const origin = createNewCourseFixture();
    const history = createHistory(origin);
    const id = fixtureId(60);
    expect(history.commit(placeObject(origin, origin.mainAreaId, { id, kind: "goomba", x: 48, y: 208 })).status).toBe("committed");
    expect(objectById(history.document(), id)).toEqual({ id, kind: "goomba", x: 48, y: 208, props: OBJECT_CATALOG.goomba.defaults });
  });
});

describe("generated command sequences restore canonical documents", () => {
  test("seeded mutations undo to the original serialization and redo the final one", () => {
    for (const seed of [1, 7, 99]) {
      const origin = createNewCourseFixture();
      const history = createHistory(origin);
      const original = canonical(origin);
      let committed = 0;
      const areaId = origin.mainAreaId;
      let rng = (seed >>> 0) || 1;
      const next = () => { rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0; return rng; };
      const placed: string[] = [];
      for (let i = 0; i < 40; i++) {
        const document = history.document();
        const roll = next() % 7;
        let result: ValidationResult<CourseV1> | CourseV1;
        if (roll === 0) result = setTiles(document, areaId, [brick(20 + (i % 30), 2 + (i % 3))]);
        else if (roll === 1) result = eraseTiles(document, areaId, [{ x: 20 + ((i + 3) % 30), y: 2 }]);
        else if (roll === 2) result = fillTiles(document, areaId, { x0: 40, y0: 3, x1: 41, y1: 3 }, { kind: "coin" });
        else if (roll === 3) {
          const id = fixtureId(300 + seed * 40 + i);
          result = placeObject(document, areaId, { id, kind: "goomba", x: 16 + (i % 20) * 16, y: 96 });
          if (result.ok) placed.push(id);
        } else if (roll === 4) {
          const id = placed.pop();
          result = id ? deleteObjects(document, [id]) : eraseTiles(document, areaId, [{ x: 40, y: 3 }]);
        } else if (roll === 5) result = setCourseFields(document, { timerSeconds: document.timerSeconds === 400 ? 30 : 400 });
        else {
          const gesture = beginPaintGesture({ areaId, tool: "paint", brush: { kind: "question" }, origin: { x: 50 + (i % 8), y: 6 } });
          gesture.extend({ x: 51 + (i % 8), y: 6 });
          const outcome = gesture.commit(history);
          if (outcome.status === "committed") committed++;
          continue;
        }
        const outcome = history.commit(result);
        if (outcome.status === "committed") committed++;
      }
      expect(committed).toBeGreaterThan(0);
      expect(history.snapshot().undoCount).toBe(committed);
      const final = canonical(history.document());
      for (let i = 0; i < committed; i++) expect(history.undo()).toBe(true);
      expect(canonical(history.document())).toBe(original);
      expect(history.snapshot().dirty).toBe(false);
      expect(history.snapshot().redoCount).toBe(committed);
      for (let i = 0; i < committed; i++) expect(history.redo()).toBe(true);
      expect(canonical(history.document())).toBe(final);
      expect(history.snapshot().dirty).toBe(true);
    }
  });
});
