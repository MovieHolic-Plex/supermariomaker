import { createNewCourse, createObject, createTile } from "../../src/level/catalog";
import { BLOCK_CONTENTS, OBJECT_KINDS, THEMES, TILE_KINDS } from "../../src/level/types";
import type { CourseV1, ObjectKind, PlacedObject, ValidationCode, ValidationIssue, ValidationResult } from "../../src/level/types";
import { parseCourse, serializeCourse } from "../../src/level/serialize";
import { validateCourse } from "../../src/level/validate";

/** Fixture namespace only. No randomness, clock, shared counter, or generated invalid placeholder IDs. */
export function fixtureId(index: number): string {
  if (!Number.isSafeInteger(index) || index < 0 || index > 0xffffffffffff) throw new RangeError("Fixture ID index must fit 48 bits");
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}
export class FixtureError extends Error {
  constructor(readonly issue: ValidationIssue) { super(`${issue.code} at ${issue.path}: ${issue.message}`); this.name = "FixtureError"; }
}
export function fixtureValue<T>(result: ValidationResult<T>): T {
  if (!result.ok) throw new FixtureError(result.error);
  return result.value;
}
/** Every successful factory leaves through the production serializer/parser, not a fixture-only schema. */
function roundTrip(input: unknown): CourseV1 { return fixtureValue(parseCourse(fixtureValue(serializeCourse(input)))); }
export function createNewCourseFixture(): CourseV1 {
  return roundTrip(fixtureValue(createNewCourse({ courseId: fixtureId(1), areaId: fixtureId(2), goalId: fixtureId(3) })));
}
export function defaultObjectId(kind: ObjectKind): string { return fixtureId(10 + OBJECT_KINDS.indexOf(kind)); }

/** Catalog-layout fixture, not a promised gameplay completion route. Objects have fixed 160px-spaced slots. */
export function createDefaultsFixture(): CourseV1 {
  let course: CourseV1 = fixtureValue(validateCourse({
    format: "smb1-maker", version: 1, id: fixtureId(1), title: "카탈로그 기본값", revision: 0,
    mainAreaId: fixtureId(2), start: { areaId: fixtureId(2), x: 40, y: 480 }, timerSeconds: 400,
    areas: [{ id: fixtureId(2), name: "지상", theme: "overworld", width: 256, height: 32,
      tiles: Array.from({ length: 512 }, (_, i) => ({ x: i % 256, y: 30 + Math.floor(i / 256), kind: "ground" })), objects: [],
    }],
  }));
  for (const [index, kind] of OBJECT_KINDS.entries()) {
    const context = { course, areaId: course.mainAreaId };
    const object = fixtureValue(createObject(context, kind === "piranha"
      ? { kind, id: defaultObjectId(kind), pipeId: defaultObjectId("pipe") }
      : { kind, id: defaultObjectId(kind), x: 256 + index * 160, y: 400 }));
    course = { ...course, areas: course.areas.map((area) => area.id === course.mainAreaId ? { ...area, objects: [...area.objects, object] } : area) };
  }
  for (const [x, kind] of TILE_KINDS.entries()) {
    const tile = fixtureValue(createTile({ course, areaId: course.mainAreaId }, { x, y: 8, kind }));
    course = { ...course, areas: course.areas.map((area) => area.id === course.mainAreaId ? { ...area, tiles: [...area.tiles, tile] } : area) };
  }
  return roundTrip(course);
}

/** All persisted vocabulary, all block contents, four themes, reciprocal pipe/balance links, and Bowser/warp references. */
export function createAllKindsFixture(): CourseV1 {
  const defaults = createDefaultsFixture();
  const areaId = defaults.mainAreaId;
  const pipeId = defaultObjectId("pipe");
  const platformId = defaultObjectId("platform");
  const areas = defaults.areas.map((area) => ({ ...area,
    tiles: [...area.tiles, ...(["brick", "question", "hidden"] as const).flatMap((kind, row) => BLOCK_CONTENTS.map((content, x) => ({ x, y: 9 + row, kind, content })))],
    objects: [...area.objects.map((object): PlacedObject => {
      switch (object.kind) {
        case "pipe": return { ...object, props: { ...object.props, destination: { areaId: fixtureId(3), pipeId: fixtureId(100) } } };
        case "platform": return { ...object, props: { ...object.props, motion: "balance", pairId: fixtureId(105) } };
        case "castleGoal": return { ...object, props: { ...object.props, bowserId: defaultObjectId("bowser") } };
        case "warpZone": return { ...object, props: { pipeIds: [pipeId, fixtureId(101), fixtureId(102)] } };
        case "spring": case "flagGoal": case "goomba": case "koopa": case "paratroopa": case "piranha": case "buzzy":
        case "billCannon": case "hammerBro": case "lakitu": case "cheep": case "blooper": case "podoboo": case "firebar": case "bowser": return object;
        default: return assertNever(object);
      }
    }),
    { id: fixtureId(101), kind: "pipe", x: 3456, y: 400, props: { height: 3, entrance: "down", destination: { areaId: fixtureId(4), pipeId: fixtureId(103) } } },
    { id: fixtureId(102), kind: "pipe", x: 3584, y: 400, props: { height: 3, entrance: "down", destination: { areaId: fixtureId(5), pipeId: fixtureId(104) } } },
    { id: fixtureId(105), kind: "platform", x: 3712, y: 400, props: { motion: "balance", length: 3, travel: 8, speed: 1, pairId: platformId } },
    ] satisfies PlacedObject[],
  }));
  const destinations = [
    { theme: THEMES[1], name: "지하", id: fixtureId(3), pipeId: fixtureId(100), sourceId: pipeId },
    { theme: THEMES[2], name: "수중", id: fixtureId(4), pipeId: fixtureId(103), sourceId: fixtureId(101) },
    { theme: THEMES[3], name: "성", id: fixtureId(5), pipeId: fixtureId(104), sourceId: fixtureId(102) },
  ];
  return roundTrip({ ...defaults, title: "모든 종류", areas: [...areas, ...destinations.map((destination) => ({
    id: destination.id, name: destination.name, theme: destination.theme, width: 32, height: 15,
    tiles: Array.from({ length: 64 }, (_, i) => ({ x: i % 32, y: 13 + Math.floor(i / 32), kind: "ground" })),
    objects: [{ id: destination.pipeId, kind: "pipe", x: 128, y: 208, props: { height: 3, entrance: "up", destination: { areaId, pipeId: destination.sourceId } } }],
  }))] });
}
export const INVALID_FIXTURE_NAMES = ["duplicate-id", "platform-length-zero", "dangling-piranha", "nonreciprocal-pipe", "nonreciprocal-balance", "occupied-bridge", "duplicate-warp", "unknown-version", "spawned-only"] as const;
export type InvalidFixtureName = typeof INVALID_FIXTURE_NAMES[number];
export type InvalidFixture = Readonly<{ name: InvalidFixtureName; json: string; error: ValidationIssue }>;
/** Invalid files deliberately derive from canonical valid bytes. The real parser must reject before they escape. */
export function createInvalidFixture(name: InvalidFixtureName): InvalidFixture {
  const course = createAllKindsFixture();
  const main = course.areas.find((area) => area.id === course.mainAreaId);
  if (!main) throw new Error("Factory requires its main area");
  let input: unknown;
  let code: ValidationCode;
  const change = (kind: ObjectKind, patch: (object: PlacedObject) => unknown) => ({ ...course, areas: course.areas.map((area) => area.id === main.id ? { ...area, objects: area.objects.map((object) => object.kind === kind ? patch(object) : object) } : area) });
  switch (name) {
    case "duplicate-id": input = { ...course, areas: course.areas.map((area) => area.id === main.id ? { ...area, objects: [...area.objects, area.objects[0]] } : area) }; code = "duplicate_id"; break;
    case "platform-length-zero": input = change("platform", (object) => ({ ...object, props: { ...object.props, length: 0 } })); code = "invalid_value"; break;
    case "dangling-piranha": input = change("piranha", (object) => ({ ...object, props: { pipeId: fixtureId(999) } })); code = "invalid_reference"; break;
    case "nonreciprocal-pipe": input = change("pipe", (object) => ({ ...object, props: { height: 3, entrance: "down" } })); code = "invalid_reference"; break;
    case "nonreciprocal-balance": input = change("platform", (object) => ({ ...object, props: { motion: "balance", length: 3, travel: 8, speed: 1, ...(object.id === defaultObjectId("platform") ? { pairId: fixtureId(105) } : {}) } })); code = "invalid_reference"; break;
    case "occupied-bridge": {
      const goal = main.objects.find((object) => object.kind === "castleGoal");
      if (!goal) throw new Error("Factory requires its castle goal");
      input = { ...course, areas: course.areas.map((area) => area.id === main.id ? { ...area, tiles: [...area.tiles, { x: goal.props.bridge.x, y: goal.props.bridge.y, kind: "coin" }] } : area) }; code = "occupied_bridge"; break;
    }
    case "duplicate-warp": input = change("warpZone", (object) => ({ ...object, props: { pipeIds: [defaultObjectId("pipe"), defaultObjectId("pipe"), null] } })); code = "invalid_reference"; break;
    case "unknown-version": input = { ...course, version: 2 }; code = "unsupported_version"; break;
    case "spawned-only": input = change("goomba", (object) => ({ ...object, kind: "shell" })); code = "unknown_kind"; break;
    default: return assertNever(name);
  }
  // A valid serializer cannot emit invalid documents; mutate only after the valid round-trip above.
  const json = JSON.stringify(input);
  const rejected = parseCourse(json);
  if (rejected.ok) throw new Error(`Invalid fixture ${name} unexpectedly passed the production parser`);
  if (rejected.error.code !== code) throw new FixtureError(rejected.error);
  return { name, json, error: rejected.error };
}
function assertNever(value: never): never { throw new Error(`Unknown fixture variant: ${String(value)}`); }
