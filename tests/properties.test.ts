import { describe, expect, test } from "bun:test";
import { placeObject, setObjectProperties } from "../src/editor/commands";
import { createHistory } from "../src/editor/history";
import { commitObjectProperties } from "../src/editor/selection";
import { authoredContentEqual, serializeCourse } from "../src/level/serialize";
import type { CourseV1, ObjectKind, ObjectProps, PlacedObject, ValidationResult } from "../src/level/types";
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
function mainId(course: CourseV1): string { return course.mainAreaId; }

function withPlaced<K extends Exclude<ObjectKind, "piranha">>(
  kind: K,
  id: string,
  extra?: Partial<{ x: number; y: number; props: ObjectProps[K] }>,
): CourseV1 {
  const origin = createNewCourseFixture();
  return ok(placeObject(origin, origin.mainAreaId, {
    id, kind, x: extra?.x ?? 160, y: extra?.y ?? 208, ...(extra?.props ? { props: extra.props } : {}),
  } as Parameters<typeof placeObject>[2]));
}

describe("configurable kinds round-trip through setObjectProperties", () => {
  test("koopa color commits once and rejects an unknown color without writing", () => {
    const id = fixtureId(200);
    const course = withPlaced("koopa", id);
    const history = createHistory(course);
    expect(objectById(history.document(), id)).toMatchObject({ props: { color: "green" } });
    expect(commitObjectProperties(history, mainId(course), id, { color: "red" }).status).toBe("committed");
    expect(objectById(history.document(), id)).toEqual({ id, kind: "koopa", x: 160, y: 208, props: { color: "red" } });
    expect(history.snapshot().undoCount).toBe(1);
    const generation = history.snapshot().generation;
    const before = canonical(history.document());
    expect(commitObjectProperties(history, mainId(course), id, { color: "blue" }).status).toBe("rejected");
    expect(canonical(history.document())).toBe(before);
    expect(history.snapshot().undoCount).toBe(1);
    expect(history.snapshot().generation).toBe(generation);
    expect(commitObjectProperties(history, mainId(course), id, { color: "red" }).status).toBe("noop");
    expect(history.snapshot().undoCount).toBe(1);
    expect(history.undo()).toBe(true);
    expect(objectById(history.document(), id)).toMatchObject({ props: { color: "green" } });
  });

  test("paratroopa color and motion round-trip; invalid motion is rejected", () => {
    const id = fixtureId(201);
    const course = withPlaced("paratroopa", id);
    const history = createHistory(course);
    expect(commitObjectProperties(history, mainId(course), id, { color: "red", motion: "vertical" }).status).toBe("committed");
    expect(objectById(history.document(), id)).toMatchObject({ props: { color: "red", motion: "vertical" } });
    expect(history.snapshot().undoCount).toBe(1);
    expect(setObjectProperties(history.document(), mainId(course), id, { color: "red", motion: "fly" }).ok).toBe(false);
    expect(objectById(history.document(), id)).toMatchObject({ props: { color: "red", motion: "vertical" } });
    expect(history.undo()).toBe(true);
    expect(objectById(history.document(), id)).toMatchObject({ props: { color: "green", motion: "hop" } });
  });

  test("pipe height and entrance commit; height 1 writes nothing", () => {
    const id = fixtureId(202);
    const course = withPlaced("pipe", id, { x: 64, y: 208 });
    const history = createHistory(course);
    expect(objectById(history.document(), id)).toMatchObject({ props: { height: 3, entrance: "down" } });
    expect(commitObjectProperties(history, mainId(course), id, { height: 5, entrance: "up" }).status).toBe("committed");
    expect(objectById(history.document(), id)).toMatchObject({ props: { height: 5, entrance: "up" } });
    expect(history.snapshot().undoCount).toBe(1);
    const before = canonical(history.document());
    expect(commitObjectProperties(history, mainId(course), id, { height: 1, entrance: "up" }).status).toBe("rejected");
    expect(canonical(history.document())).toBe(before);
    expect(history.undo()).toBe(true);
    expect(objectById(history.document(), id)).toMatchObject({ props: { height: 3, entrance: "down" } });
  });

  test("platform motion length travel speed round-trip; length 0 writes nothing", () => {
    const id = fixtureId(203);
    const course = withPlaced("platform", id, { x: 80, y: 160 });
    const history = createHistory(course);
    expect(objectById(history.document(), id)).toMatchObject({
      props: { motion: "horizontal", length: 3, travel: 8, speed: 1 },
    });
    expect(commitObjectProperties(history, mainId(course), id, {
      motion: "vertical", length: 4, travel: 10, speed: 2,
    }).status).toBe("committed");
    expect(objectById(history.document(), id)).toMatchObject({
      props: { motion: "vertical", length: 4, travel: 10, speed: 2 },
    });
    expect(history.snapshot().undoCount).toBe(1);
    const before = canonical(history.document());
    expect(commitObjectProperties(history, mainId(course), id, {
      motion: "vertical", length: 0, travel: 10, speed: 2,
    }).status).toBe("rejected");
    expect(canonical(history.document())).toBe(before);
  });

  test("flagGoal height 9 to 6 is one command; height 3 is rejected", () => {
    const origin = createNewCourseFixture();
    const flag = origin.areas[0]?.objects.find((item) => item.kind === "flagGoal");
    expect(flag?.kind).toBe("flagGoal");
    if (flag?.kind !== "flagGoal") throw new Error("seed flag missing");
    const history = createHistory(origin);
    expect(commitObjectProperties(history, origin.mainAreaId, flag.id, { height: 6 }).status).toBe("committed");
    expect(objectById(history.document(), flag.id)).toMatchObject({ props: { height: 6 } });
    expect(history.snapshot().undoCount).toBe(1);
    const before = canonical(history.document());
    expect(commitObjectProperties(history, origin.mainAreaId, flag.id, { height: 3 }).status).toBe("rejected");
    expect(canonical(history.document())).toBe(before);
  });

  test("cheep color and mode round-trip", () => {
    const id = fixtureId(204);
    const course = withPlaced("cheep", id, { x: 96, y: 160 });
    const history = createHistory(course);
    expect(commitObjectProperties(history, mainId(course), id, { color: "green", mode: "leap" }).status).toBe("committed");
    expect(objectById(history.document(), id)).toMatchObject({ props: { color: "green", mode: "leap" } });
    expect(history.snapshot().undoCount).toBe(1);
    expect(setObjectProperties(history.document(), mainId(course), id, { color: "blue", mode: "leap" }).ok).toBe(false);
    expect(history.undo()).toBe(true);
    expect(objectById(history.document(), id)).toMatchObject({ props: { color: "red", mode: "swim" } });
  });

  test("firebar length direction speed round-trip; length 2 is rejected", () => {
    const id = fixtureId(205);
    const course = withPlaced("firebar", id, { x: 48, y: 160 });
    const history = createHistory(course);
    expect(commitObjectProperties(history, mainId(course), id, {
      length: 3, direction: "ccw", speed: "fast",
    }).status).toBe("committed");
    expect(objectById(history.document(), id)).toMatchObject({
      props: { length: 3, direction: "ccw", speed: "fast" },
    });
    const before = canonical(history.document());
    expect(commitObjectProperties(history, mainId(course), id, {
      length: 2, direction: "ccw", speed: "fast",
    }).status).toBe("rejected");
    expect(canonical(history.document())).toBe(before);
  });

  test("castleGoal bridge and bowserId stay valid; occupied or out-of-range bridge writes nothing", () => {
    const bowserId = fixtureId(206), goalId = fixtureId(207);
    const origin = createNewCourseFixture();
    let course = ok(placeObject(origin, origin.mainAreaId, { id: bowserId, kind: "bowser", x: 48, y: 96 }));
    course = ok(placeObject(course, origin.mainAreaId, {
      id: goalId, kind: "castleGoal", x: 160, y: 96,
      props: { bridge: { x: 2, y: 6, width: 8, height: 1 } },
    }));
    const history = createHistory(course);
    expect(commitObjectProperties(history, origin.mainAreaId, goalId, {
      bridge: { x: 3, y: 6, width: 4, height: 1 }, bowserId,
    }).status).toBe("committed");
    expect(objectById(history.document(), goalId)).toEqual({
      id: goalId, kind: "castleGoal", x: 160, y: 96,
      props: { bridge: { x: 3, y: 6, width: 4, height: 1 }, bowserId },
    });
    expect(history.snapshot().undoCount).toBe(1);
    const linked = canonical(history.document());
    expect(commitObjectProperties(history, origin.mainAreaId, goalId, {
      bridge: { x: 3, y: 13, width: 4, height: 1 }, bowserId,
    }).status).toBe("rejected");
    expect(canonical(history.document())).toBe(linked);
    expect(commitObjectProperties(history, origin.mainAreaId, goalId, {
      bridge: { x: 3, y: 6, width: 0, height: 1 }, bowserId,
    }).status).toBe("rejected");
    expect(canonical(history.document())).toBe(linked);
    expect(commitObjectProperties(history, origin.mainAreaId, goalId, {
      bridge: { x: 3.5, y: 6, width: 4, height: 1 }, bowserId,
    }).status).toBe("rejected");
    expect(canonical(history.document())).toBe(linked);
    expect(commitObjectProperties(history, origin.mainAreaId, goalId, {
      bridge: { x: 3, y: 6, width: 4, height: 1 }, bowserId: fixtureId(999),
    }).status).toBe("rejected");
    expect(canonical(history.document())).toBe(linked);
    expect(commitObjectProperties(history, origin.mainAreaId, goalId, {
      bridge: { x: 3, y: 6, width: 4, height: 1 },
    }).status).toBe("committed");
    expect(objectById(history.document(), goalId)).toEqual({
      id: goalId, kind: "castleGoal", x: 160, y: 96,
      props: { bridge: { x: 3, y: 6, width: 4, height: 1 } },
    });
    expect(history.snapshot().undoCount).toBe(2);
  });
});

describe("reference-bearing edits stay reciprocal in one command", () => {
  test("pipe destination pairs both ends and unlinks both in the same command", () => {
    const origin = createNewCourseFixture();
    const areaId = origin.mainAreaId;
    const a = fixtureId(210), b = fixtureId(211);
    let course = ok(placeObject(origin, areaId, { id: a, kind: "pipe", x: 64, y: 208 }));
    course = ok(placeObject(course, areaId, { id: b, kind: "pipe", x: 128, y: 208, props: { height: 3, entrance: "up" } }));
    const history = createHistory(course);
    const seed = canonical(course);
    expect(commitObjectProperties(history, areaId, a, {
      height: 3, entrance: "down", destination: { areaId, pipeId: b },
    }).status).toBe("committed");
    expect(history.snapshot().undoCount).toBe(1);
    expect(objectById(history.document(), a)).toMatchObject({
      props: { height: 3, entrance: "down", destination: { areaId, pipeId: b } },
    });
    expect(objectById(history.document(), b)).toMatchObject({
      props: { height: 3, entrance: "up", destination: { areaId, pipeId: a } },
    });
    expect(commitObjectProperties(history, areaId, a, { height: 3, entrance: "down" }).status).toBe("committed");
    expect(history.snapshot().undoCount).toBe(2);
    const left = objectById(history.document(), a);
    const right = objectById(history.document(), b);
    expect(left).toMatchObject({ props: { height: 3, entrance: "down" } });
    expect(right).toMatchObject({ props: { height: 3, entrance: "up" } });
    if (left?.kind === "pipe") expect(left.props.destination).toBeUndefined();
    if (right?.kind === "pipe") expect(right.props.destination).toBeUndefined();
    expect(history.undo()).toBe(true);
    expect(objectById(history.document(), b)).toMatchObject({
      props: { destination: { areaId, pipeId: a } },
    });
    expect(history.undo()).toBe(true);
    expect(canonical(history.document())).toBe(seed);
  });

  test("retargeting a pipe clears the previous partner in the same command", () => {
    const origin = createNewCourseFixture();
    const areaId = origin.mainAreaId;
    const a = fixtureId(212), b = fixtureId(213), c = fixtureId(214);
    let course = ok(placeObject(origin, areaId, { id: a, kind: "pipe", x: 64, y: 208 }));
    course = ok(placeObject(course, areaId, { id: b, kind: "pipe", x: 128, y: 208 }));
    course = ok(placeObject(course, areaId, { id: c, kind: "pipe", x: 192, y: 208 }));
    const history = createHistory(course);
    expect(commitObjectProperties(history, areaId, a, {
      height: 3, entrance: "down", destination: { areaId, pipeId: b },
    }).status).toBe("committed");
    expect(commitObjectProperties(history, areaId, a, {
      height: 3, entrance: "down", destination: { areaId, pipeId: c },
    }).status).toBe("committed");
    expect(history.snapshot().undoCount).toBe(2);
    expect(objectById(history.document(), a)).toMatchObject({ props: { destination: { areaId, pipeId: c } } });
    expect(objectById(history.document(), c)).toMatchObject({ props: { destination: { areaId, pipeId: a } } });
    const previous = objectById(history.document(), b);
    expect(previous?.kind).toBe("pipe");
    if (previous?.kind === "pipe") expect(previous.props.destination).toBeUndefined();
  });

  test("pipe height change keeps the link and moves the attached piranha in the same command", () => {
    const origin = createNewCourseFixture();
    const areaId = origin.mainAreaId;
    const pipeId = fixtureId(215), piranhaId = fixtureId(216), other = fixtureId(217);
    let course = ok(placeObject(origin, areaId, { id: pipeId, kind: "pipe", x: 64, y: 208 }));
    course = ok(placeObject(course, areaId, { id: other, kind: "pipe", x: 128, y: 208 }));
    course = ok(placeObject(course, areaId, { id: piranhaId, kind: "piranha", pipeId }));
    const history = createHistory(course);
    expect(commitObjectProperties(history, areaId, pipeId, {
      height: 3, entrance: "down", destination: { areaId, pipeId: other },
    }).status).toBe("committed");
    expect(commitObjectProperties(history, areaId, pipeId, {
      height: 5, entrance: "down", destination: { areaId, pipeId: other },
    }).status).toBe("committed");
    expect(history.snapshot().undoCount).toBe(2);
    expect(objectById(history.document(), pipeId)).toMatchObject({
      props: { height: 5, entrance: "down", destination: { areaId, pipeId: other } },
    });
    expect(objectById(history.document(), other)).toMatchObject({
      props: { destination: { areaId, pipeId } },
    });
    expect(objectById(history.document(), piranhaId)).toMatchObject({
      x: 64, y: 208 - 5 * 16, props: { pipeId },
    });
  });

  test("balance pairId writes both platforms and clearing unpairs both", () => {
    const origin = createNewCourseFixture();
    const areaId = origin.mainAreaId;
    const a = fixtureId(218), b = fixtureId(219);
    let course = ok(placeObject(origin, areaId, { id: a, kind: "platform", x: 64, y: 160 }));
    course = ok(placeObject(course, areaId, { id: b, kind: "platform", x: 160, y: 160 }));
    const history = createHistory(course);
    expect(commitObjectProperties(history, areaId, a, {
      motion: "balance", length: 3, travel: 8, speed: 1, pairId: b,
    }).status).toBe("committed");
    expect(history.snapshot().undoCount).toBe(1);
    expect(objectById(history.document(), a)).toMatchObject({
      props: { motion: "balance", length: 3, travel: 8, speed: 1, pairId: b },
    });
    expect(objectById(history.document(), b)).toMatchObject({
      props: { motion: "balance", pairId: a },
    });
    expect(commitObjectProperties(history, areaId, a, {
      motion: "balance", length: 3, travel: 8, speed: 1,
    }).status).toBe("committed");
    const left = objectById(history.document(), a);
    const right = objectById(history.document(), b);
    expect(left).toMatchObject({ props: { motion: "balance", length: 3, travel: 8, speed: 1 } });
    expect(right).toMatchObject({ props: { motion: "balance" } });
    if (left?.kind === "platform" && left.props.motion === "balance") expect(left.props.pairId).toBeUndefined();
    if (right?.kind === "platform" && right.props.motion === "balance") expect(right.props.pairId).toBeUndefined();
    expect(history.snapshot().undoCount).toBe(2);
  });

  test("retargeting a balance pair clears the previous partner", () => {
    const origin = createNewCourseFixture();
    const areaId = origin.mainAreaId;
    const a = fixtureId(220), b = fixtureId(221), c = fixtureId(222);
    let course = ok(placeObject(origin, areaId, { id: a, kind: "platform", x: 64, y: 160 }));
    course = ok(placeObject(course, areaId, { id: b, kind: "platform", x: 128, y: 160 }));
    course = ok(placeObject(course, areaId, { id: c, kind: "platform", x: 192, y: 160 }));
    const history = createHistory(course);
    expect(commitObjectProperties(history, areaId, a, {
      motion: "balance", length: 3, travel: 8, speed: 1, pairId: b,
    }).status).toBe("committed");
    expect(commitObjectProperties(history, areaId, a, {
      motion: "balance", length: 3, travel: 8, speed: 1, pairId: c,
    }).status).toBe("committed");
    expect(objectById(history.document(), a)).toMatchObject({ props: { pairId: c } });
    expect(objectById(history.document(), c)).toMatchObject({ props: { motion: "balance", pairId: a } });
    const previous = objectById(history.document(), b);
    expect(previous?.kind).toBe("platform");
    if (previous?.kind === "platform" && previous.props.motion === "balance") {
      expect(previous.props.pairId).toBeUndefined();
    }
  });

  test("warp slots write distinct same-area pipes and reject duplicates without writing", () => {
    const origin = createNewCourseFixture();
    const areaId = origin.mainAreaId;
    const warp = fixtureId(223), a = fixtureId(224), b = fixtureId(225);
    let course = ok(placeObject(origin, areaId, { id: a, kind: "pipe", x: 64, y: 208 }));
    course = ok(placeObject(course, areaId, { id: b, kind: "pipe", x: 128, y: 208 }));
    course = ok(placeObject(course, areaId, { id: warp, kind: "warpZone", x: 160, y: 144 }));
    const history = createHistory(course);
    expect(commitObjectProperties(history, areaId, warp, { pipeIds: [a, b, null] }).status).toBe("committed");
    expect(objectById(history.document(), warp)).toMatchObject({ props: { pipeIds: [a, b, null] } });
    expect(history.snapshot().undoCount).toBe(1);
    const before = canonical(history.document());
    expect(commitObjectProperties(history, areaId, warp, { pipeIds: [a, a, null] }).status).toBe("rejected");
    expect(canonical(history.document())).toBe(before);
    expect(commitObjectProperties(history, areaId, warp, { pipeIds: [null, null, null] }).status).toBe("committed");
    expect(objectById(history.document(), warp)).toMatchObject({ props: { pipeIds: [null, null, null] } });
  });

  test("malformed props leave the document unchanged", () => {
    const id = fixtureId(226);
    const course = withPlaced("koopa", id);
    const history = createHistory(course);
    const before = history.document();
    expect(commitObjectProperties(history, mainId(course), id, null).status).toBe("rejected");
    expect(commitObjectProperties(history, mainId(course), id, []).status).toBe("rejected");
    expect(authoredContentEqual(history.document(), before)).toBe(true);
    expect(history.snapshot().undoCount).toBe(0);
  });
});
