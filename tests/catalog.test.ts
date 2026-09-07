import { expect, test } from "bun:test";
import { CATALOG_CATEGORIES, OBJECT_CATALOG, SPAWNED_CATALOG, SPAWNED_KINDS, TILE_CATALOG, catalogWarnings, createNewCourse, createObject, createTile, validateObjectProperties } from "../src/level/catalog";
import { BLOCK_CONTENTS, OBJECT_KINDS, THEMES, TILE_KINDS, type AreaV1, type CourseV1, type ObjectKind, type PlacedObject, type ValidationCode, type ValidationResult } from "../src/level/types";
import { objectBounds, validateCourse, validatePreview } from "../src/level/validate";
import { getFrame } from "../src/assets/manifest";
import { isAssetKey } from "../src/assets/pixels";
import { parseCourse, serializeCourse } from "../src/level/serialize";
import { INVALID_FIXTURE_NAMES, createAllKindsFixture, createDefaultsFixture, createInvalidFixture, createNewCourseFixture, defaultObjectId, fixtureId, fixtureValue } from "./fixtures/factory";

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const course: CourseV1 = {
  format: "smb1-maker", version: 1, id: id(1), title: "Catalog test", revision: 0,
  mainAreaId: id(2), start: { areaId: id(2), x: 40, y: 208 }, timerSeconds: 400,
  areas: [{ id: id(2), name: "Main", theme: "overworld", width: 256, height: 32, tiles: [], objects: [] }],
};
const context = { course, areaId: id(2) };

test("all catalog defaults validate: platform has the contracted default properties", () => {
  // Given a real valid parent; when constructing a default; then its exact props are valid.
  expect(validateCourse(course).ok).toBe(true);
  const result = createObject(context, { id: id(10), kind: "platform", x: 256, y: 208 });
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.value.props).toEqual({ motion: "horizontal", length: 3, travel: 8, speed: 1 });
});

test("platform length zero rejected with the real property path", () => {
  // Given a zero-length platform; when constructed; then reject its property without mutating the parent.
  const before = JSON.stringify(course);
  const result = createObject(context, { id: id(10), kind: "platform", x: 256, y: 208,
    props: { motion: "horizontal", length: 0, travel: 8, speed: 1 } });
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error.code).toBe("invalid_value");
    expect(result.error.path).toBe("$.areas[0].objects[0].props.length");
  }
  expect(JSON.stringify(course)).toBe(before);
});

const malformedProps = (["platform", "castleGoal", "goomba"] as const).flatMap((kind) => [null, undefined, false, 0, "", []].map((props) => [kind, props] as const));
test.each(malformedProps)("%s rejects explicitly supplied malformed props %j", (kind, props) => {
  // Given an explicit malformed runtime property; when constructed; then the existing schema rejects it unchanged.
  const request = Object.freeze(Object.defineProperty({ id: id(10), kind, x: 256, y: 208 }, "props", { value: props, enumerable: true }));
  const before = structuredClone({ course, request });
  const result = createObject(context, request);
  expect<ValidationResult<unknown>>(result).toEqual(validateCourse({ ...course, areas: [{ ...main(course), objects: [request] }] }));
  rejected(result, "invalid_type");
  expect({ course, request }).toEqual(before);
});

function main(input: CourseV1): AreaV1 {
  const area = input.areas.find((area) => area.id === input.mainAreaId);
  if (!area) throw new Error("Expected main area");
  return area;
}
function object(input: CourseV1, kind: ObjectKind): PlacedObject {
  const found = main(input).objects.find((item) => item.kind === kind);
  if (!found) throw new Error(`Expected ${kind}`);
  return found;
}
function rejected(result: ValidationResult<unknown>, code: ValidationCode): void {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.code).toBe(code);
}
const defaults = createDefaultsFixture();
const defaultContext = { course: defaults, areaId: defaults.mainAreaId };
const expectedDefaults = {
  pipe: { height: 3, entrance: "down" }, platform: { motion: "horizontal", length: 3, travel: 8, speed: 1 },
  spring: {}, flagGoal: { height: 9 }, castleGoal: { bridge: { x: 48, y: 25, width: 8, height: 1 } },
  goomba: {}, koopa: { color: "green" }, paratroopa: { color: "green", motion: "hop" },
  piranha: { pipeId: defaultObjectId("pipe") }, buzzy: {}, billCannon: {}, hammerBro: {}, lakitu: {},
  cheep: { color: "red", mode: "swim" }, blooper: {}, podoboo: {}, firebar: { length: 6, direction: "cw", speed: "normal" },
  bowser: {}, warpZone: { pipeIds: [null, null, null] },
} as const;

test.each([...OBJECT_KINDS])("all catalog defaults validate: %s", (kind) => {
  // Given factory defaults; when crossing the inspector's real schema boundary; then preserve exact contracted props.
  const input = object(defaults, kind);
  expect(fixtureValue(validateObjectProperties(defaultContext, input.id, input.props)).props).toEqual(expectedDefaults[kind]);
});
test.each([...TILE_KINDS])("tile %s supplies a valid default and cell bounds", (kind) => {
  const result = fixtureValue(createTile(context, { kind, x: 3, y: 4 }));
  expect(result).toEqual({ kind, x: 3, y: 4, ...TILE_CATALOG[kind].defaults });
  expect(TILE_CATALOG[kind].bounds(result)).toEqual({ x: 48, y: 64, width: 16, height: 16 });
});
test("catalog vocabulary is exhaustive and spawned-only types are separate", () => {
  expect(Object.keys(TILE_CATALOG)).toEqual([...TILE_KINDS]);
  expect(Object.keys(OBJECT_CATALOG)).toEqual([...OBJECT_KINDS]);
  expect(SPAWNED_KINDS).toEqual(["shell", "bulletBill", "spiny", "spinyEgg", "hammer", "fireball", "mushroom", "flower", "star", "oneUp", "vine", "bowserFlame"]);
  expect(Object.keys(SPAWNED_CATALOG)).toEqual([...SPAWNED_KINDS]);
});
test.each(Object.entries({ ...TILE_CATALOG, ...OBJECT_CATALOG, ...SPAWNED_CATALOG }))("%s references real manifest artwork and a defined category", (_kind, entry) => {
  // Given every catalog entry; when resolving every referenced frame; then no fabricated key/dimension is allowed.
  expect(Object.hasOwn(CATALOG_CATEGORIES, entry.category)).toBe(true);
  expect(entry.frames).toContain(entry.assetKey);
  for (const key of entry.frames) {
    expect(isAssetKey(key)).toBe(true);
    const frame = getFrame(key);
    expect(frame.key).toBe(key);
    expect(frame.width).toBeGreaterThan(0);
    expect(frame.height).toBeGreaterThan(0);
  }
});
test.each([...SPAWNED_KINDS])("%s cannot be persisted as a placed object", (kind) => {
  const entry = SPAWNED_CATALOG[kind];
  expect(entry.placeable).toBe(false);
  expect(entry.defaults).toEqual({});
  expect(entry.properties).toEqual({});
  const frame = getFrame(entry.assetKey);
  expect(entry.bounds({ x: 64, y: 64 })).toEqual({ x: 64 - frame.anchor.x, y: 64 - frame.anchor.y, width: frame.width, height: frame.height });
  rejected(validateCourse({ ...course, areas: [{ ...main(course), objects: [{ id: id(10), kind, x: 256, y: 208, props: {} }] }] }), "unknown_kind");
});
test.each([...OBJECT_KINDS])("%s uses schema-owned bounds and rejects unknown props", (kind) => {
  const entry = OBJECT_CATALOG[kind];
  const item = object(defaults, kind);
  expect(entry.placeable).toBe(true);
  expect(entry.bounds).toBe(objectBounds);
  expect(entry.bounds(item)).toEqual(objectBounds(item));
  rejected(validateObjectProperties(defaultContext, item.id, { ...item.props, script: "no" }), "unknown_field");
});

test("metadata includes every property, including optional and conditional references", () => {
  const keys: Record<ObjectKind, readonly string[]> = {
    pipe: ["height", "entrance", "destination"], platform: ["motion", "length", "travel", "speed", "pairId"], spring: [], flagGoal: ["height"],
    castleGoal: ["bridge", "bowserId"], goomba: [], koopa: ["color"], paratroopa: ["color", "motion"], piranha: ["pipeId"], buzzy: [],
    billCannon: [], hammerBro: [], lakitu: [], cheep: ["color", "mode"], blooper: [], podoboo: [], firebar: ["length", "direction", "speed"], bowser: [], warpZone: ["pipeIds"],
  };
  for (const kind of OBJECT_KINDS) expect(Object.keys(OBJECT_CATALOG[kind].properties).sort()).toEqual([...keys[kind]].sort());
  expect(OBJECT_CATALOG.platform.properties.pairId).toMatchObject({ optional: true, reciprocal: true, distinct: true, scope: "same-area", when: { property: "motion", equals: "balance" } });
  expect(OBJECT_CATALOG.pipe.properties.destination.fields.pipeId).toMatchObject({ reciprocal: true, distinct: true, scope: "course", target: "pipe" });
  expect(OBJECT_CATALOG.piranha.properties.pipeId).toMatchObject({ scope: "same-area", target: "pipe" });
  expect(OBJECT_CATALOG.castleGoal.properties.bowserId).toMatchObject({ optional: true, scope: "same-area", target: "bowser" });
  expect(OBJECT_CATALOG.warpZone.properties.pipeIds).toMatchObject({ length: 3, nullable: true, distinct: true, scope: "same-area" });
});
const integerLimits = [
  ["pipe", "height", 2, 16], ["platform", "length", 2, 8], ["platform", "travel", 1, 32], ["flagGoal", "height", 4, 12], ["firebar", "length", 3, 12],
] as const;
test.each(integerLimits)("%s.%s metadata and boundary values match the real validator", (kind, property, min, max) => {
  const fields = OBJECT_CATALOG[kind].properties;
  const metadata = Object.entries(fields).find(([key]) => key === property)?.[1];
  expect(metadata).toMatchObject({ type: "integer", min, max, unit: "cells" });
  // Remove dependent Piranha so changing pipe height tests a numeric limit, not attachment position.
  const input = { ...defaults, areas: defaults.areas.map((area) => ({ ...area, objects: area.objects.filter((item) => item.kind !== "piranha") })) };
  const item = object(input, kind);
  const ctx = { course: input, areaId: input.mainAreaId };
  for (const value of [min, max]) expect(validateObjectProperties(ctx, item.id, { ...item.props, [property]: value }).ok).toBe(true);
  for (const value of [min - 1, max + 1, min + 0.5, NaN, Infinity, String(min)]) rejected(validateObjectProperties(ctx, item.id, { ...item.props, [property]: value }), typeof value === "string" ? "invalid_type" : "invalid_value");
});
const choices = [
  ["pipe", "entrance", ["none", "down", "up"]], ["platform", "motion", ["horizontal", "vertical", "falling", "balance"]],
  ["platform", "speed", [0.5, 1, 2]], ["koopa", "color", ["green", "red"]], ["paratroopa", "color", ["green", "red"]],
  ["paratroopa", "motion", ["hop", "vertical"]], ["cheep", "color", ["green", "red"]], ["cheep", "mode", ["swim", "leap"]],
  ["firebar", "direction", ["cw", "ccw"]], ["firebar", "speed", ["slow", "normal", "fast"]],
] as const;
test.each(choices)("%s.%s lists and validates every choice", (kind, property, values) => {
  const metadata = Object.entries(OBJECT_CATALOG[kind].properties).find(([key]) => key === property)?.[1];
  expect(metadata).toMatchObject({ type: "choice", values });
  const item = object(defaults, kind);
  for (const value of values) expect(validateObjectProperties(defaultContext, item.id, { ...item.props, [property]: value }).ok).toBe(true);
  rejected(validateObjectProperties(defaultContext, item.id, { ...item.props, [property]: "unsupported" }), "invalid_value");
});
test("bridge metadata covers cell geometry, width limits and fixed height", () => {
  const fields = OBJECT_CATALOG.castleGoal.properties.bridge.fields;
  expect(fields.x).toMatchObject({ min: 0, max: 4095, maximumFrom: "area.width-1" });
  expect(fields.y).toMatchObject({ min: 0, max: 127, maximumFrom: "area.height-1" });
  expect(fields.width).toMatchObject({ min: 1, max: 64 });
  expect(fields.height).toMatchObject({ values: [1] });
  for (const width of [1, 64]) expect(createObject(context, { kind: "castleGoal", id: id(10), x: 2048, y: 208, props: { bridge: { x: 10, y: 13, width, height: 1 } } }).ok).toBe(true);
  const item = object(defaults, "castleGoal");
  for (const bridge of [{ x: 48, y: 25, width: 0, height: 1 }, { x: 48, y: 25, width: 65, height: 1 }, { x: 48, y: 25, width: 8, height: 2 }, { x: 48.5, y: 25, width: 8, height: 1 }]) rejected(validateObjectProperties(defaultContext, item.id, { bridge }), "invalid_value");
});
test.each(["brick", "question", "hidden"] as const)("%s exposes and validates all block contents", (kind) => {
  expect(TILE_CATALOG[kind].properties.content.values).toEqual(BLOCK_CONTENTS);
  for (const content of BLOCK_CONTENTS) expect(createTile(context, { kind, x: 3, y: 4, content }).ok).toBe(true);
  expect(TILE_CATALOG[kind].defaults.content).toBe(kind === "brick" ? "none" : "coin");
});

test("Piranha requires a chosen same-area pipe and derives the mouth, not a placeholder position", () => {
  const pipe = object(defaults, "pipe");
  if (pipe.kind !== "pipe") throw new Error("Expected pipe");
  const result = fixtureValue(createObject(defaultContext, { kind: "piranha", id: id(500), pipeId: pipe.id }));
  expect(result).toEqual({ id: id(500), kind: "piranha", x: pipe.x, y: pipe.y - pipe.props.height * 16, props: { pipeId: pipe.id } });
  rejected(createObject(defaultContext, { kind: "piranha", id: id(500), pipeId: id(999) }), "invalid_reference");
  rejected(createObject(defaultContext, { kind: "piranha", id: id(500), pipeId: defaultObjectId("goomba") }), "invalid_reference");
  const all = createAllKindsFixture();
  rejected(createObject({ course: all, areaId: all.mainAreaId }, { kind: "piranha", id: id(500), pipeId: id(100) }), "invalid_reference");
});
test("castle bridge ends immediately before the axe and is never shifted into bounds", () => {
  const result = fixtureValue(createObject(context, { kind: "castleGoal", id: id(10), x: 256, y: 208 }));
  if (result.kind !== "castleGoal") throw new Error("Expected castle goal");
  expect(result.props).toEqual({ bridge: { x: 8, y: 13, width: 8, height: 1 } });
  expect(result.props.bridge.x + result.props.bridge.width - 1).toBe(result.x / 16 - 1);
  rejected(createObject(context, { kind: "castleGoal", id: id(10), x: 112, y: 208 }), "out_of_bounds");
  rejected(createObject(context, { kind: "castleGoal", id: id(10), x: 256, y: 512 }), "out_of_bounds");
});
test("unpaired balance is a valid warning draft without conversion or changed travel", () => {
  const input = fixtureValue(createObject(context, { kind: "platform", id: id(10), x: 256, y: 208, props: { motion: "balance", length: 3, travel: 8, speed: 1 } }));
  const area = { ...main(course), objects: [input] };
  expect(fixtureValue(parseCourse(fixtureValue(serializeCourse({ ...course, areas: [area] })))).areas[0]?.objects[0]).toEqual(input);
  expect(catalogWarnings(area)).toEqual([{ code: "unpaired_balance", objectId: input.id }]);
});
test("reference warnings distinguish complete links from valid incomplete drafts", () => {
  expect(catalogWarnings(main(defaults))).toEqual([{ code: "unlinked_pipe", objectId: defaultObjectId("pipe") }, { code: "unlinked_warp", objectId: defaultObjectId("warpZone") }]);
  expect(catalogWarnings(main(createAllKindsFixture()))).toEqual([]);
});
test("invalid property combinations cannot alter a valid original object", () => {
  const before = fixtureValue(serializeCourse(defaults));
  rejected(validateObjectProperties(defaultContext, defaultObjectId("platform"), { motion: "horizontal", length: 3, travel: 8, speed: 1, pairId: id(999) }), "unknown_field");
  rejected(validateObjectProperties(defaultContext, defaultObjectId("platform"), { motion: "balance", length: 3, travel: 8, speed: 1, pairId: id(999) }), "invalid_reference");
  rejected(validateObjectProperties(defaultContext, defaultObjectId("warpZone"), { pipeIds: [null, null] }), "invalid_value");
  rejected(validateObjectProperties(defaultContext, defaultObjectId("piranha"), { pipeId: defaultObjectId("bowser") }), "invalid_reference");
  expect(fixtureValue(serializeCourse(defaults))).toBe(before);
});
test("constructors reject grid, extent, ID and context violations", () => {
  for (const point of [{ x: 33, y: 208 }, { x: 256, y: 209 }]) rejected(createObject(context, { kind: "goomba", id: id(10), ...point }), "invalid_value");
  for (const point of [{ x: 0, y: 208 }, { x: 4096, y: 208 }, { x: 256, y: 0 }]) rejected(createObject(context, { kind: "goomba", id: id(10), ...point }), "out_of_bounds");
  rejected(createObject(context, { kind: "goomba", id: "placeholder", x: 256, y: 208 }), "invalid_id");
  rejected(createObject(context, { kind: "goomba", id: course.id, x: 256, y: 208 }), "duplicate_id");
  rejected(createObject({ course, areaId: id(999) }, { kind: "goomba", id: id(10), x: 256, y: 208 }), "invalid_reference");
  rejected(validateObjectProperties(context, id(999), {}), "invalid_reference");
  rejected(createTile(context, { kind: "ground", x: 0.5, y: 4 }), "invalid_value");
  rejected(createTile(context, { kind: "ground", x: 256, y: 4 }), "out_of_bounds");
});
test("new-course factory matches the prescribed playable seed and validates supplied IDs", () => {
  const seed = createNewCourseFixture();
  expect(seed).toMatchObject({ title: "새 코스", timerSeconds: 400, revision: 0, start: { x: 40, y: 208 } });
  expect(main(seed)).toMatchObject({ width: 256, height: 15, theme: "overworld" });
  expect(main(seed).tiles).toEqual(Array.from({ length: 512 }, (_, i) => ({ x: i % 256, y: 13 + Math.floor(i / 256), kind: "ground" })));
  expect(main(seed).objects).toEqual([{ kind: "flagGoal", id: id(3), x: 3840, y: 208, props: { height: 9 } }]);
  expect(validatePreview(seed).ok).toBe(true);
  rejected(createNewCourse({ courseId: "placeholder", areaId: id(2), goalId: id(3) }), "invalid_id");
  rejected(createNewCourse({ courseId: id(1), areaId: id(1), goalId: id(3) }), "duplicate_id");
});
test("all-kinds fixture is explicit, complete, preview-valid and byte-deterministic", () => {
  const input = createAllKindsFixture();
  expect(new Set(main(input).objects.map((item) => item.kind))).toEqual(new Set(OBJECT_KINDS));
  expect(new Set(main(input).tiles.map((tile) => tile.kind))).toEqual(new Set(TILE_KINDS));
  expect(input.areas.map((area) => area.theme)).toEqual([...THEMES]);
  for (const kind of ["brick", "question", "hidden"]) expect(new Set(main(input).tiles.filter((tile) => tile.kind === kind && "content" in tile).map((tile) => "content" in tile ? tile.content : undefined))).toEqual(new Set(BLOCK_CONTENTS));
  expect(validatePreview(input).ok).toBe(true);
  expect(fixtureValue(serializeCourse(createAllKindsFixture()))).toBe(fixtureValue(serializeCourse(input)));
  expect(fixtureValue(parseCourse(fixtureValue(serializeCourse(input))))).toEqual(input);
});
test.each([...INVALID_FIXTURE_NAMES])("derived invalid fixture %s is rejected by the production parser", (name) => {
  const fixture = createInvalidFixture(name);
  const result = parseCourse(fixture.json);
  expect(result).toEqual({ ok: false, error: fixture.error });
});
test("fixture IDs are deterministic UUIDs with explicit invalid-input failure", () => {
  expect(fixtureId(1)).toBe(id(1));
  expect(fixtureId(0xffffffffffff)).toBe("00000000-0000-4000-8000-ffffffffffff");
  for (const index of [-1, 0.5, Infinity, 0x1000000000000]) expect(() => fixtureId(index)).toThrow(RangeError);
});
test.each(["new-course", "defaults", "all-kinds"] as const)("shipped %s JSON equals the real factory serialization", async (name) => {
  const builders = { "new-course": createNewCourseFixture, defaults: createDefaultsFixture, "all-kinds": createAllKindsFixture };
  const bytes = await Bun.file(new URL(`./fixtures/${name}.smb1.json`, import.meta.url)).text();
  expect(bytes).toBe(fixtureValue(serializeCourse(builders[name]())));
});
test.each([...INVALID_FIXTURE_NAMES])("shipped invalid %s JSON preserves its deliberate failure", async (name) => {
  const bytes = await Bun.file(new URL(`./fixtures/${name}.smb1.json`, import.meta.url)).text();
  const fixture = createInvalidFixture(name);
  expect(bytes).toBe(fixture.json);
  expect(parseCourse(bytes)).toEqual({ ok: false, error: fixture.error });
});
