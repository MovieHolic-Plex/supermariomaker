import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { EMPTY_INPUT } from "../src/input";
import type { InputFrame } from "../src/input";
import { OBJECT_CATALOG, SPAWNED_CATALOG, TILE_CATALOG } from "../src/level/catalog";
import { parseCourse, serializeCourse } from "../src/level/serialize";
import { BLOCK_CONTENTS, OBJECT_KINDS, THEMES, TILE_KINDS } from "../src/level/types";
import type { CourseV1, ObjectKind, TileKind } from "../src/level/types";
import { validateCourse } from "../src/level/validate";
import { sampleCourse, sampleCourses } from "../src/level/samples";
import { createRuntime } from "../src/game/state";
import type { GameEvent, Runtime } from "../src/game/state";
import { step } from "../src/game/step";
import { SAMPLE_ROUTES, framesForRoute } from "./fixtures/routes";
import type { SampleTheme } from "./fixtures/routes";

const PLACED_KINDS = [...TILE_KINDS, ...OBJECT_KINDS] as const;
const SPAWNED_KINDS = Object.keys(SPAWNED_CATALOG) as readonly (keyof typeof SPAWNED_CATALOG)[];

const BEHAVIOR_ASSERTIONS: Record<string, Readonly<{ file: string; token: string }>> = {
  ground: { file: "tests/movement.test.ts", token: "createMovementFixture" },
  brick: { file: "tests/blocks.test.ts", token: "blockBreak" },
  question: { file: "tests/blocks.test.ts", token: "question" },
  hidden: { file: "tests/blocks.test.ts", token: "blockReveal" },
  used: { file: "tests/blocks.test.ts", token: "\"used\"" },
  hard: { file: "tests/water.test.ts", token: "kind: \"hard\"" },
  coin: { file: "tests/blocks.test.ts", token: "kind: \"coin\"" },
  pipe: { file: "tests/areas.test.ts", token: "pipe-enter" },
  platform: { file: "tests/platforms.test.ts", token: "platform-reverse" },
  spring: { file: "tests/platforms.test.ts", token: "spring-launch" },
  flagGoal: { file: "tests/goals.test.ts", token: "flag-grab" },
  castleGoal: { file: "tests/goals.test.ts", token: "\"axe\"" },
  goomba: { file: "tests/enemies-ground.test.ts", token: "goomba" },
  koopa: { file: "tests/enemies-ground.test.ts", token: "koopa" },
  paratroopa: { file: "tests/enemies-ground.test.ts", token: "wings-removed" },
  piranha: { file: "tests/hazards.test.ts", token: "piranha-emerge" },
  buzzy: { file: "tests/enemies-ground.test.ts", token: "buzzy" },
  billCannon: { file: "tests/hazards.test.ts", token: "bulletBill" },
  hammerBro: { file: "tests/hazards.test.ts", token: "hammerBro" },
  lakitu: { file: "tests/hazards.test.ts", token: "lakitu-drop" },
  cheep: { file: "tests/water.test.ts", token: "cheep-leap" },
  blooper: { file: "tests/water.test.ts", token: "toBe(\"blooper\")" },
  podoboo: { file: "tests/hazards.test.ts", token: "podoboo-launch" },
  firebar: { file: "tests/hazards.test.ts", token: "firebar" },
  bowser: { file: "tests/goals.test.ts", token: "bowser-defeated" },
  warpZone: { file: "tests/areas.test.ts", token: "warpLabels" },
  shell: { file: "tests/enemies-ground.test.ts", token: "\"shell\"" },
  bulletBill: { file: "tests/hazards.test.ts", token: "\"bulletBill\"" },
  spiny: { file: "tests/hazards.test.ts", token: "\"spiny\"" },
  spinyEgg: { file: "tests/hazards.test.ts", token: "\"spinyEgg\"" },
  hammer: { file: "tests/hazards.test.ts", token: "\"hammer\"" },
  fireball: { file: "tests/blocks.test.ts", token: "\"fireball\"" },
  mushroom: { file: "tests/blocks.test.ts", token: "\"mushroom\"" },
  flower: { file: "tests/blocks.test.ts", token: "\"flower\"" },
  star: { file: "tests/blocks.test.ts", token: "\"star\"" },
  oneUp: { file: "tests/blocks.test.ts", token: "\"oneUp\"" },
  vine: { file: "tests/blocks.test.ts", token: "\"vine\"" },
  bowserFlame: { file: "tests/content-coverage.test.ts", token: "bowser-flame" },
};

function placedKinds(courses: readonly CourseV1[]): Set<string> {
  const kinds = new Set<string>();
  for (const course of courses) {
    for (const area of course.areas) {
      for (const tile of area.tiles) kinds.add(tile.kind);
      for (const object of area.objects) kinds.add(object.kind);
    }
  }
  return kinds;
}

function missingPlaced(kinds: ReadonlySet<string>): string[] {
  return PLACED_KINDS.filter((kind) => !kinds.has(kind));
}

function blockContents(courses: readonly CourseV1[]): Set<string> {
  const contents = new Set<string>();
  for (const course of courses) {
    for (const area of course.areas) {
      for (const tile of area.tiles) {
        if (tile.kind === "brick" || tile.kind === "question" || tile.kind === "hidden") {
          contents.add(tile.content ?? "none");
        }
      }
    }
  }
  return contents;
}

function play(course: CourseV1, theme: SampleTheme): { runtime: Runtime; events: GameEvent[]; frames: InputFrame[] } {
  const frames = framesForRoute(SAMPLE_ROUTES[theme]);
  const runtime = createRuntime(course);
  const events: GameEvent[] = [];
  for (const frame of frames) events.push(...step(runtime, frame));
  return { runtime, events, frames };
}

test("four themed samples validate and round-trip without unknown fields", () => {
  const courses = sampleCourses();
  expect(courses.map((course) => course.areas.find((area) => area.id === course.mainAreaId)?.theme)).toEqual([...THEMES]);
  for (const theme of THEMES) {
    const course = sampleCourse(theme);
    const validated = validateCourse(course);
    expect(validated.ok).toBe(true);
    const serialized = serializeCourse(course);
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) throw new Error(serialized.error.message);
    const parsed = parseCourse(serialized.value);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.error.message);
    const again = serializeCourse(parsed.value);
    expect(again.ok).toBe(true);
    if (!again.ok) throw new Error(again.error.message);
    expect(again.value).toBe(serialized.value);
    expect(validateCourse({ ...course, extra: true }).ok).toBe(false);
  }
});

test("every catalog kind has placed sample coverage", () => {
  const kinds = placedKinds(sampleCourses());
  expect(missingPlaced(kinds)).toEqual([]);
  expect([...TILE_KINDS].every((kind) => kind in TILE_CATALOG)).toBe(true);
  expect([...OBJECT_KINDS].every((kind) => kind in OBJECT_CATALOG)).toBe(true);
  expect([...blockContents(sampleCourses())].sort()).toEqual([...BLOCK_CONTENTS].sort());
});

test("coverage check fails when a placed kind is withheld in memory", () => {
  const kinds = placedKinds(sampleCourses());
  kinds.delete("goomba");
  expect(missingPlaced(kinds)).toEqual(["goomba"]);
});

test("every catalog kind has a behavior assertion in the suite", () => {
  const required = [...PLACED_KINDS, ...SPAWNED_KINDS];
  expect(Object.keys(BEHAVIOR_ASSERTIONS).sort()).toEqual([...required].sort());
  for (const kind of required) {
    const spec = BEHAVIOR_ASSERTIONS[kind];
    expect(spec).toBeDefined();
    if (!spec) throw new Error(`missing behavior map for ${kind}`);
    const text = readFileSync(spec.file, "utf8");
    expect(text.includes(spec.token)).toBe(true);
  }
});

test.each([...THEMES])("%s sample is completed by its recorded keyboard route", (theme) => {
  const course = sampleCourse(theme);
  const { runtime, events, frames } = play(course, theme);
  expect(frames.length).toBeGreaterThan(0);
  expect(frames.every((frame) => frame.pause.held === false)).toBe(true);
  const clear = events.find((event) => event.type === "courseClear");
  expect(clear).toMatchObject({ type: "courseClear", ending: theme === "castle" ? "castle" : "flag" });
  expect(runtime.combat.defeated).toBe(false);
  expect(events.some((event) => event.type === "playerDefeated")).toBe(false);
  if (theme === "castle") {
    expect(events.some((event) => event.type === "bowser-flame")).toBe(true);
    expect(events.some((event) => event.type === "axe")).toBe(true);
  } else {
    expect(events.some((event) => event.type === "flag-grab")).toBe(true);
  }
});

test("altered sample pipe link is rejected before play", () => {
  const course = sampleCourse("overworld");
  const area = course.areas.find((item) => item.objects.some((object) => object.kind === "pipe" && object.props.destination));
  const pipe = area?.objects.find((object) => object.kind === "pipe" && object.props.destination);
  expect(pipe?.kind).toBe("pipe");
  if (pipe?.kind !== "pipe" || !area) throw new Error("expected linked pipe");
  const destination = pipe.props.destination;
  if (!destination) throw new Error("expected linked pipe");
  const mutated: CourseV1 = {
    ...course,
    areas: course.areas.map((item) => item.id !== area.id ? item : {
      ...item,
      objects: item.objects.map((object) => object.id !== pipe.id ? object : {
        ...pipe,
        props: { ...pipe.props, destination: { areaId: destination.areaId, pipeId: "00000000-0000-4000-8000-ffffffffffff" } },
      }),
    }),
  };
  const rejected = validateCourse(mutated);
  expect(rejected.ok).toBe(false);
  if (!rejected.ok) expect(rejected.error.code).toBe("invalid_reference");
  expect(createRuntime(course).player.x).toBe(course.start.x);
});

test("idle input is the empty frame used by recorded routes", () => {
  expect(EMPTY_INPUT.jump.pressed).toBe(false);
});

const _kindChecks: Record<TileKind | ObjectKind, true> = {
  ground: true, brick: true, question: true, hidden: true, used: true, hard: true, coin: true,
  pipe: true, platform: true, spring: true, flagGoal: true, castleGoal: true, goomba: true, koopa: true,
  paratroopa: true, piranha: true, buzzy: true, billCannon: true, hammerBro: true, lakitu: true, cheep: true,
  blooper: true, podoboo: true, firebar: true, bowser: true, warpZone: true,
};
void _kindChecks;
