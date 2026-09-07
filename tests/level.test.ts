// allow: SIZE_OK - table-driven coverage of the complete version-1 boundary, owned by task2.
import { describe, expect, test } from "bun:test";
import { authoredContentEqual, parseCourse, serializeCourse } from "../src/level/serialize";
import { validateCourse, validatePreview } from "../src/level/validate";
import { COURSE_LIMITS, OBJECT_KINDS, type AreaV1, type CourseV1, type PlacedObject, type ValidationCode, type ValidationResult } from "../src/level/types";

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const baseObject = (n: number) => ({ id: id(n), x: 32 + n * 32, y: 400 });
function fixture(): CourseV1 {
  const objects: PlacedObject[] = [
    { ...baseObject(10), kind: "pipe", props: { height: 3, entrance: "down", destination: { areaId: id(2), pipeId: id(29) } } },
    { ...baseObject(11), kind: "platform", props: { motion: "balance", length: 3, travel: 8, speed: 1, pairId: id(30) } },
    { ...baseObject(12), kind: "spring", props: {} },
    { ...baseObject(13), kind: "flagGoal", props: { height: 9 } },
    { ...baseObject(14), kind: "castleGoal", props: { bridge: { x: 120, y: 24, width: 8, height: 1 }, bowserId: id(27) } },
    { ...baseObject(15), kind: "goomba", props: {} },
    { ...baseObject(16), kind: "koopa", props: { color: "green" } },
    { ...baseObject(17), kind: "paratroopa", props: { color: "red", motion: "vertical" } },
    { ...baseObject(18), x: baseObject(10).x, y: 352, kind: "piranha", props: { pipeId: id(10) } },
    { ...baseObject(19), kind: "buzzy", props: {} },
    { ...baseObject(20), kind: "billCannon", props: {} },
    { ...baseObject(21), kind: "hammerBro", props: {} },
    { ...baseObject(22), kind: "lakitu", props: {} },
    { ...baseObject(23), kind: "cheep", props: { color: "red", mode: "swim" } },
    { ...baseObject(24), kind: "blooper", props: {} },
    { ...baseObject(25), kind: "podoboo", props: {} },
    { ...baseObject(26), kind: "firebar", props: { length: 6, direction: "cw", speed: "normal" } },
    { ...baseObject(27), kind: "bowser", props: {} },
    { ...baseObject(28), kind: "warpZone", props: { pipeIds: [id(10), id(29), null] } },
    { ...baseObject(29), kind: "pipe", props: { height: 2, entrance: "up", destination: { areaId: id(2), pipeId: id(10) } } },
    { ...baseObject(30), kind: "platform", props: { motion: "balance", length: 2, travel: 1, speed: 0.5, pairId: id(11) } },
  ];
  return {
    format: "smb1-maker", version: 1, id: id(1), title: "모든 종류", revision: 0,
    mainAreaId: id(2), start: { areaId: id(2), x: 40, y: 208 }, timerSeconds: 400,
    areas: [{ id: id(2), name: "지상", theme: "overworld", width: 256, height: 32, objects,
      tiles: [
        { x: 1, y: 30, kind: "ground" }, { x: 2, y: 30, kind: "brick", content: "none" },
        { x: 3, y: 30, kind: "question", content: "powerup" }, { x: 4, y: 30, kind: "hidden", content: "vine" },
        { x: 5, y: 30, kind: "used" }, { x: 6, y: 30, kind: "hard" }, { x: 7, y: 30, kind: "coin" },
      ],
    }],
  };
}
function area(course = fixture()): AreaV1 {
  const value = course.areas[0];
  if (!value) throw new Error("Fixture requires its area");
  return value;
}
function withArea(patch: Readonly<Record<string, unknown>>, course = fixture()): unknown {
  return { ...course, areas: [{ ...area(course), ...patch }] };
}
function withObject(object: unknown): unknown { return withArea({ objects: [object] }); }
function value<T>(result: ValidationResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}
function rejection(result: ValidationResult<unknown>, code: ValidationCode): void {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.code).toBe(code);
}
function freeze(value: unknown): void {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
}

describe("course document boundary", () => {
  test("roundtrip canonical document with every placed kind and linked prop", () => {
    // Given a complete authored course; when serialized and parsed; then preserve its data.
    const input = fixture();
    const serialized = serializeCourse(input);
    expect(serialized.ok).toBe(true);
    const parsed = value(parseCourse(value(serialized)));
    expect(parsed).toEqual(input);
    expect(new Set(area(parsed).objects.map((object) => object.kind))).toEqual(new Set(OBJECT_KINDS));
  });
  test("canonical serialization ignores key and unordered collection insertion order", () => {
    // Given equivalent sparse documents with reversed insertion order; when encoded; then bytes agree.
    const input = fixture();
    const reversed = { ...input, areas: [{ ...area(input), tiles: [...area(input).tiles].reverse(), objects: [...area(input).objects].reverse() }] };
    const reorderedKeys: unknown = JSON.parse(JSON.stringify(reversed, (_key, item: unknown) => {
      if (item && typeof item === "object" && !Array.isArray(item)) return Object.fromEntries(Object.entries(item).reverse());
      return item;
    }));
    expect(value(serializeCourse(reorderedKeys))).toBe(value(serializeCourse(input)));
  });
  test("canonical serialization sorts area IDs without changing the main/start area", () => {
    const input = fixture();
    const second = { ...area(input), id: id(3), objects: [], tiles: [] };
    const left = { ...input, areas: [area(input), second] };
    const right = { ...input, areas: [second, area(input)] };
    // When serialized; then logical array ordering has one stable representation.
    expect(value(serializeCourse(left))).toBe(value(serializeCourse(right)));
  });
  test("successful validation creates independent nested values from frozen input", () => {
    const input = fixture(); freeze(input);
    // When crossing the boundary; then callers share no mutable nested source references.
    const parsed = value(validateCourse(input));
    expect(parsed).toEqual(input);
    expect(parsed).not.toBe(input);
    expect(area(parsed).objects[0]).not.toBe(area(input).objects[0]);
    expect(area(parsed).objects.find((object) => object.kind === "pipe")?.props)
      .not.toBe(area(input).objects.find((object) => object.kind === "pipe")?.props);
  });
  test("reject duplicate object id transactionally", () => {
    const current = fixture(); freeze(current);
    const before = JSON.stringify(current);
    const duplicate = withArea({ objects: [...area(current).objects, { ...baseObject(10), kind: "goomba", props: {} }] }, current);
    // When a replacement fails; then the caller's current document is byte-for-byte unchanged.
    rejection(validateCourse(duplicate), "duplicate_id");
    expect(JSON.stringify(current)).toBe(before);
  });
  const invalidDocuments: readonly [string, () => unknown, ValidationCode][] = [
    ["null", () => null, "invalid_type"],
    ["array root", () => [], "invalid_type"],
    ["format", () => ({ ...fixture(), format: "other" }), "invalid_value"],
    ["version", () => ({ ...fixture(), version: 2 }), "unsupported_version"],
    ["missing start", () => { const { start: _start, ...rest } = fixture(); return rest; }, "invalid_type"],
    ["root property", () => ({ ...fixture(), script: "alert(1)" }), "unknown_field"],
    ["area property", () => withArea({ extra: true }), "unknown_field"],
    ["start property", () => ({ ...fixture(), start: { ...fixture().start, extra: 1 } }), "unknown_field"],
    ["tile property", () => withArea({ tiles: [{ x: 1, y: 1, kind: "ground", extra: 1 }] }), "unknown_field"],
    ["ground content", () => withArea({ tiles: [{ x: 1, y: 1, kind: "ground", content: "coin" }] }), "unknown_field"],
    ["object property", () => withObject({ ...baseObject(10), kind: "goomba", props: {}, extra: 1 }), "unknown_field"],
    ["empty props property", () => withObject({ ...baseObject(10), kind: "goomba", props: { speed: 2 } }), "unknown_field"],
    ["unknown object", () => withObject({ ...baseObject(10), kind: "shell", props: {} }), "unknown_kind"],
    ["unknown tile", () => withArea({ tiles: [{ x: 1, y: 1, kind: "lava" }] }), "unknown_kind"],
    ["unknown theme", () => withArea({ theme: "space" }), "invalid_value"],
    ["numeric string", () => ({ ...fixture(), timerSeconds: "400" }), "invalid_type"],
    ["NaN", () => ({ ...fixture(), timerSeconds: NaN }), "invalid_value"],
    ["Infinity", () => withObject({ ...baseObject(10), kind: "goomba", props: {}, x: Infinity }), "invalid_value"],
    ["title empty", () => ({ ...fixture(), title: "" }), "invalid_value"],
    ["title untrimmed", () => ({ ...fixture(), title: " course " }), "invalid_value"],
    ["title too long", () => ({ ...fixture(), title: "x".repeat(81) }), "invalid_value"],
    ["UUID course", () => ({ ...fixture(), id: "course" }), "invalid_id"],
    ["UUID area", () => withArea({ id: "area" }), "invalid_id"],
    ["UUID object", () => withObject({ ...baseObject(10), kind: "goomba", props: {}, id: "object" }), "invalid_id"],
    ["negative revision", () => ({ ...fixture(), revision: -1 }), "invalid_value"],
    ["fractional revision", () => ({ ...fixture(), revision: 0.5 }), "invalid_value"],
    ["unsafe revision", () => ({ ...fixture(), revision: Number.MAX_SAFE_INTEGER + 1 }), "invalid_value"],
    ["timer 29", () => ({ ...fixture(), timerSeconds: 29 }), "invalid_value"],
    ["timer 1000", () => ({ ...fixture(), timerSeconds: 1000 }), "invalid_value"],
    ["zero areas", () => ({ ...fixture(), areas: [] }), "limit_exceeded"],
    ["17 areas", () => ({ ...fixture(), areas: Array.from({ length: 17 }, (_, i) => ({ ...area(), id: id(100 + i), objects: [] })) }), "limit_exceeded"],
    ["width minimum", () => withArea({ width: 31 }), "invalid_value"],
    ["width maximum", () => withArea({ width: 4097 }), "invalid_value"],
    ["height minimum", () => withArea({ height: 14 }), "invalid_value"],
    ["height maximum", () => withArea({ height: 129 }), "invalid_value"],
    ["duplicate area", () => ({ ...fixture(), areas: [area(), area()] }), "duplicate_id"],
    ["cross-entity ID", () => ({ ...fixture(), id: id(2) }), "duplicate_id"],
    ["duplicate cells", () => withArea({ tiles: [{ x: 1, y: 1, kind: "coin" }, { x: 1, y: 1, kind: "ground" }] }), "duplicate_cell"],
    ["tile right edge", () => withArea({ tiles: [{ x: 256, y: 1, kind: "coin" }] }), "out_of_bounds"],
    ["tile bottom edge", () => withArea({ tiles: [{ x: 1, y: 32, kind: "coin" }] }), "out_of_bounds"],
    ["negative tile", () => withArea({ tiles: [{ x: -1, y: 1, kind: "coin" }] }), "out_of_bounds"],
    ["fractional tile", () => withArea({ tiles: [{ x: 0.5, y: 1, kind: "coin" }] }), "invalid_value"],
    ["object grid", () => withObject({ ...baseObject(10), kind: "goomba", props: {}, x: 33 }), "invalid_value"],
    ["object left extent", () => withObject({ ...baseObject(10), kind: "goomba", props: {}, x: 0 }), "out_of_bounds"],
    ["pipe top extent", () => withObject({ ...baseObject(10), kind: "pipe", props: { height: 3, entrance: "none" }, y: 32 }), "out_of_bounds"],
    ["bowser right extent", () => withObject({ ...baseObject(10), kind: "bowser", props: {}, x: 4096 }), "out_of_bounds"],
    ["hammerBro top extent", () => withObject({ ...baseObject(10), kind: "hammerBro", props: {}, y: 16 }), "out_of_bounds"],
    ["flag top extent", () => withObject({ ...baseObject(10), kind: "flagGoal", props: { height: 9 }, y: 128 }), "out_of_bounds"],
    ["start extent", () => ({ ...fixture(), start: { areaId: id(2), x: 0, y: 208 } }), "out_of_bounds"],
    ["main area link", () => ({ ...fixture(), mainAreaId: id(99) }), "invalid_reference"],
    ["start area link", () => ({ ...fixture(), start: { ...fixture().start, areaId: id(99) } }), "invalid_reference"],
  ];
  test.each(invalidDocuments)("rejects %s", (_label, input, code) => {
    // Given malformed input; when validated; then the typed reason identifies its boundary failure.
    rejection(validateCourse(input()), code);
  });
  test.each([0, 30, 999])("accepts timer boundary %i", (timerSeconds) => {
    // Given an allowed timer; when parsed; then preserve it without coercion.
    expect(value(validateCourse({ ...fixture(), timerSeconds })).timerSeconds).toBe(timerSeconds);
  });
  test.each(["none", "coin", "multiCoin", "powerup", "star", "oneUp", "vine"])("accepts block content %s", (content) => {
    const input = withArea({ tiles: ["brick", "question", "hidden"].map((kind, x) => ({ kind, x, y: 1, content })) });
    expect(validateCourse(input).ok).toBe(true);
  });
  test("rejects unknown block content", () => {
    rejection(validateCourse(withArea({ tiles: [{ x: 1, y: 1, kind: "brick", content: "script" }] })), "invalid_value");
  });
});

describe("per-kind properties and references", () => {
  const invalidProps: readonly [string, string, unknown, ValidationCode][] = [
    ["pipe height", "pipe", { height: 1, entrance: "down" }, "invalid_value"],
    ["pipe entrance", "pipe", { height: 3, entrance: "left" }, "invalid_value"],
    ["destination field", "pipe", { height: 3, entrance: "down", destination: { areaId: id(2), pipeId: id(29), extra: 1 } }, "unknown_field"],
    ["destination UUID", "pipe", { height: 3, entrance: "down", destination: { areaId: "bad", pipeId: id(29) } }, "invalid_id"],
    ["platform length", "platform", { motion: "horizontal", length: 0, travel: 8, speed: 1 }, "invalid_value"],
    ["platform travel", "platform", { motion: "vertical", length: 2, travel: 33, speed: 1 }, "invalid_value"],
    ["platform speed", "platform", { motion: "falling", length: 2, travel: 1, speed: 1.5 }, "invalid_value"],
    ["non-balance pair", "platform", { motion: "horizontal", length: 2, travel: 1, speed: 1, pairId: id(30) }, "unknown_field"],
    ["flag height", "flagGoal", { height: 13 }, "invalid_value"],
    ["koopa color", "koopa", { color: "blue" }, "invalid_value"],
    ["paratroopa motion", "paratroopa", { color: "green", motion: "swim" }, "invalid_value"],
    ["cheep mode", "cheep", { color: "red", mode: "hop" }, "invalid_value"],
    ["firebar length", "firebar", { length: 13, direction: "cw", speed: "normal" }, "invalid_value"],
    ["firebar direction", "firebar", { length: 3, direction: "left", speed: "normal" }, "invalid_value"],
    ["firebar speed", "firebar", { length: 3, direction: "ccw", speed: 1 }, "invalid_value"],
    ["warp slot count", "warpZone", { pipeIds: [null, null] }, "invalid_value"],
    ["warp slot UUID", "warpZone", { pipeIds: ["bad", null, null] }, "invalid_id"],
    ["bridge height", "castleGoal", { bridge: { x: 5, y: 5, width: 8, height: 2 } }, "invalid_value"],
    ["bridge width", "castleGoal", { bridge: { x: 5, y: 5, width: 65, height: 1 } }, "invalid_value"],
    ["bridge fraction", "castleGoal", { bridge: { x: 5.5, y: 5, width: 8, height: 1 } }, "invalid_value"],
    ["bridge property", "castleGoal", { bridge: { x: 5, y: 5, width: 8, height: 1, extra: 1 } }, "unknown_field"],
    ["bridge bounds", "castleGoal", { bridge: { x: 250, y: 5, width: 8, height: 1 } }, "out_of_bounds"],
    ["missing piranha pipe", "piranha", {}, "invalid_type"],
    ["dangling piranha", "piranha", { pipeId: id(99) }, "invalid_reference"],
    ["dangling Bowser", "castleGoal", { bridge: { x: 5, y: 5, width: 8, height: 1 }, bowserId: id(99) }, "invalid_reference"],
    ["dangling warp", "warpZone", { pipeIds: [id(99), null, null] }, "invalid_reference"],
    ["dangling balance", "platform", { motion: "balance", length: 2, travel: 1, speed: 1, pairId: id(99) }, "invalid_reference"],
  ];
  test.each(invalidProps)("rejects %s", (_label, kind, props, code) => {
    // Given an invalid kind-specific record; when validated; then reject rather than strip fields.
    rejection(validateCourse(withObject({ ...baseObject(10), kind, props })), code);
  });
  const brokenLinks: readonly [string, number, unknown][] = [
    ["nonreciprocal pipe", 29, { height: 2, entrance: "up" }],
    ["self pipe", 10, { height: 3, entrance: "down", destination: { areaId: id(2), pipeId: id(10) } }],
    ["wrong destination area", 10, { height: 3, entrance: "down", destination: { areaId: id(99), pipeId: id(29) } }],
    ["wrong target kind", 10, { height: 3, entrance: "down", destination: { areaId: id(2), pipeId: id(27) } }],
    ["nonreciprocal balance", 30, { motion: "balance", length: 2, travel: 1, speed: 1 }],
    ["self balance", 11, { motion: "balance", length: 2, travel: 1, speed: 1, pairId: id(11) }],
    ["wrong Bowser kind", 14, { bridge: { x: 120, y: 24, width: 8, height: 1 }, bowserId: id(15) }],
    ["duplicate warp pipes", 28, { pipeIds: [id(10), id(10), null] }],
    ["wrong warp kind", 28, { pipeIds: [id(15), null, null] }],
  ];
  test.each(brokenLinks)("rejects %s", (_label, n, props) => {
    const input = withArea({ objects: area().objects.map((object) => object.id === id(n) ? { ...object, props } : object) });
    rejection(validateCourse(input), "invalid_reference");
  });
  test("rejects Piranha position detached from its pipe mouth", () => {
    const input = withArea({ objects: area().objects.map((object) => object.kind === "piranha" ? { ...object, x: object.x + 16 } : object) });
    rejection(validateCourse(input), "invalid_reference");
  });
  test("rejects bridge overlays on any populated terrain including coins", () => {
    const input = withArea({ tiles: [{ x: 120, y: 24, kind: "coin" }] });
    rejection(validateCourse(input), "occupied_bridge");
  });
  test("accepts reciprocal pipes across areas", () => {
    const input = fixture();
    const left = { ...area(input), objects: [{ ...baseObject(10), kind: "pipe", props: { height: 3, entrance: "down", destination: { areaId: id(3), pipeId: id(29) } } }] };
    const right = { ...area(input), id: id(3), objects: [{ ...baseObject(29), kind: "pipe", props: { height: 2, entrance: "up", destination: { areaId: id(2), pipeId: id(10) } } }] };
    expect(validateCourse({ ...input, areas: [left, right] }).ok).toBe(true);
  });
  test.each(["platform", "piranha", "castleGoal", "warpZone"])("rejects cross-area %s references", (kind) => {
    const input = fixture();
    const selected = area(input).objects.filter((object) => object.kind === kind);
    const others = area(input).objects.filter((object) => object.kind !== kind);
    const targetIds = kind === "platform" ? new Set([id(30)]) : new Set<string>();
    const left = { ...area(input), objects: selected.filter((object) => !targetIds.has(object.id)) };
    const right = { ...area(input), id: id(3), objects: [...others, ...selected.filter((object) => targetIds.has(object.id))] };
    rejection(validateCourse({ ...input, areas: [left, right] }), "invalid_reference");
  });
});

describe("draft versus preview eligibility", () => {
  function draft(): CourseV1 {
    return { ...fixture(), areas: [{ ...area(), objects: [
      { ...baseObject(10), kind: "pipe", props: { height: 3, entrance: "down" } },
      { ...baseObject(11), kind: "platform", props: { motion: "balance", length: 3, travel: 8, speed: 1 } },
      { ...baseObject(28), kind: "warpZone", props: { pipeIds: [id(10), null, null] } },
    ] }] };
  }
  test("saves valid incomplete drafts with an unlinked pipe, unpaired balance and warp slots", () => {
    // Given incomplete authoring references; when saved; then preserve rather than invent links.
    expect(value(parseCourse(value(serializeCourse(draft()))))).toEqual(draft());
  });
  test("requires a goal for normal preview", () => {
    rejection(validatePreview(draft()), "goal_required");
  });
  test("permits explicit goal-free preview", () => {
    expect(value(validatePreview(draft(), { allowNoGoal: true }))).toEqual(draft().start);
  });
  test("requires start even for goal-free preview", () => {
    const { start: _start, ...input } = draft();
    rejection(validatePreview(input, { allowNoGoal: true }), "invalid_type");
  });
  test("blocked start can save as a draft", () => {
    const input = withArea({ tiles: [{ x: 2, y: 12, kind: "ground" }] });
    expect(validateCourse(input).ok).toBe(true);
  });
  test.each(["ground", "brick", "question", "used", "hard"])("rejects preview inside %s", (kind) => {
    const input = withArea({ tiles: [{ x: 2, y: 12, kind }] });
    rejection(validatePreview(input), "start_blocked");
  });
  test.each(["hidden", "coin"])("permits start through intangible %s", (kind) => {
    expect(validatePreview(withArea({ tiles: [{ x: 2, y: 12, kind }] })).ok).toBe(true);
  });
  test("allows feet resting exactly on solid terrain", () => {
    expect(validatePreview(withArea({ tiles: [{ x: 2, y: 13, kind: "ground" }] })).ok).toBe(true);
  });
  test.each(["pipe", "platform", "spring", "billCannon", "firebar", "castleGoal"])("rejects preview inside solid %s bounds", (kind) => {
    const input = fixture();
    const object = area(input).objects.find((object) => object.kind === kind);
    if (!object) throw new Error("Fixture missing object");
    const point = object.kind === "castleGoal"
      ? { x: object.props.bridge.x * 16 + 8, y: object.props.bridge.y * 16 + 16 }
      : { x: object.x, y: object.y };
    rejection(validatePreview({ ...input, start: { areaId: id(2), ...point } }), "start_blocked");
  });
  test("cursor override is checked without rewriting saved start", () => {
    const input = fixture(); freeze(input);
    const spawnOverride = { areaId: id(2), x: 72, y: 208 };
    expect(value(validatePreview(input, { spawnOverride }))).toEqual(spawnOverride);
    expect(input.start).toEqual({ areaId: id(2), x: 40, y: 208 });
  });
  test("cursor override cannot bypass solid clearance", () => {
    rejection(validatePreview(fixture(), { spawnOverride: { areaId: id(2), x: 24, y: 496 } }), "start_blocked");
  });
});

describe("portable JSON and author-content identity", () => {
  test.each(["{", "null", "[]", "true", "\"course\""])("rejects malformed or non-document JSON %s", (input) => {
    rejection(parseCourse(input), input === "{" ? "malformed_json" : "invalid_type");
  });
  test("rejects oversized UTF-8 before JSON parsing", () => {
    const input = "가".repeat(Math.floor(COURSE_LIMITS.fileBytes / 3) + 1);
    rejection(parseCourse(input), "file_too_large");
  });
  test("enforces exact byte limit for byte input", () => {
    rejection(parseCourse(new Uint8Array(COURSE_LIMITS.fileBytes + 1)), "file_too_large");
  });
  test("rejects malformed UTF-8 rather than replacing bytes", () => {
    rejection(parseCourse(new Uint8Array([0xc3, 0x28])), "invalid_utf8");
  });
  test("accepts exactly 32 MiB including JSON whitespace", () => {
    const json = JSON.stringify(fixture());
    const padding = COURSE_LIMITS.fileBytes - new TextEncoder().encode(json).length;
    expect(value(parseCourse(json + " ".repeat(padding)))).toEqual(fixture());
  });
  test("roundtrips UTF-8 bytes", () => {
    expect(value(parseCourse(new TextEncoder().encode(JSON.stringify(fixture()))))).toEqual(fixture());
  });
  test("canonical serialization retains revision", () => {
    const input = { ...fixture(), revision: 7 };
    expect(value(parseCourse(value(serializeCourse(input)))).revision).toBe(7);
  });
  test("author-content equality excludes only revision and sparse insertion order", () => {
    const left = fixture(); freeze(left);
    const right = { ...left, revision: 99, areas: [{ ...area(left), tiles: [...area(left).tiles].reverse(), objects: [...area(left).objects].reverse() }] };
    expect(authoredContentEqual(left, right)).toBe(true);
  });
  test.each(["id", "title", "timer", "start", "area", "tile", "object"])("author-content equality detects changed %s", (field) => {
    const left = fixture();
    const changes: Record<string, CourseV1> = {
      id: { ...left, id: id(99) }, title: { ...left, title: "different" }, timer: { ...left, timerSeconds: 0 },
      start: { ...left, start: { ...left.start, x: 72 } },
      area: { ...left, areas: [{ ...area(left), name: "different" }] },
      tile: { ...left, areas: [{ ...area(left), tiles: [] }] },
      object: { ...left, areas: [{ ...area(left), objects: [] }] },
    };
    const right = changes[field]; if (!right) throw new Error("Missing test variant");
    expect(authoredContentEqual(left, right)).toBe(false);
  });
  test("serializer rejects malformed input instead of normalizing unknown fields", () => {
    rejection(serializeCourse({ ...fixture(), extra: true }), "unknown_field");
  });
  test("rejects prototype-like JSON keys", () => {
    const json = JSON.stringify(fixture()).replace('"version":1', '"version":1,"__proto__":{}');
    rejection(parseCourse(json), "unknown_field");
  });
});

describe("sparse capacity", () => {
  test("maximum populated cells and objects roundtrip without dense allocation", () => {
    const input: CourseV1 = { ...fixture(), areas: [{ ...area(), width: 4096, height: 128,
      tiles: Array.from({ length: COURSE_LIMITS.tiles }, (_, i) => ({ x: i % 4096, y: Math.floor(i / 4096), kind: "ground" })),
      objects: Array.from({ length: COURSE_LIMITS.objects }, (_, i) => ({ id: id(1000 + i), kind: "goomba", x: 16 + (i % 4095) * 16, y: 2048, props: {} })),
    }] };
    // Given exact capacity; when passing the actual serializer/parser; then no truncation occurs.
    const json = value(serializeCourse(input));
    expect(new TextEncoder().encode(json).length).toBeLessThanOrEqual(COURSE_LIMITS.fileBytes);
    const parsed = value(parseCourse(json));
    expect(area(parsed).tiles).toHaveLength(COURSE_LIMITS.tiles);
    expect(area(parsed).objects).toHaveLength(COURSE_LIMITS.objects);
  });
  test.each(["tiles", "objects"])("rejects total %s limit across areas", (field) => {
    const source = area();
    const count = field === "tiles" ? COURSE_LIMITS.tiles : COURSE_LIMITS.objects;
    const entries = Array.from({ length: count / 2 + 1 }, (_, i) => field === "tiles"
      ? { x: i % 4096, y: Math.floor(i / 4096), kind: "ground" }
      : { id: id(1000 + i), kind: "goomba", x: 16, y: 2048, props: {} });
    const left = { ...source, width: 4096, height: 128, tiles: [], objects: [], [field]: entries };
    const right = { ...left, id: id(3), [field]: entries.map((entry, i) => field === "objects" ? { ...entry, id: id(10000 + i) } : entry) };
    rejection(validateCourse({ ...fixture(), areas: [left, right] }), "limit_exceeded");
  });
  test("accepts sixteen maximum-dimension empty sparse areas", () => {
    const input = { ...fixture(), areas: Array.from({ length: 16 }, (_, i) => ({ ...area(), id: id(i + 2), width: 4096, height: 128, tiles: [], objects: [] })) };
    expect(value(validateCourse(input)).areas).toHaveLength(16);
  });
});
