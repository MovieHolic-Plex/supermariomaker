import type { CourseV1, PlacedObject, TileCell } from "../../src/level/types";
import { parseCourse, serializeCourse } from "../../src/level/serialize";
import { createNewCourseFixture, fixtureId, fixtureValue } from "./factory";

export const HAZARD_IDS = {
  pipe: fixtureId(1100), piranha: fixtureId(1101), cannon: fixtureId(1102),
  hammerBro: fixtureId(1103), lakitu: fixtureId(1104), podoboo: fixtureId(1105),
  firebar: fixtureId(1106), bowser: fixtureId(1107),
} as const;

export type HazardFixtureKind =
  | "piranha" | "cannon" | "hammer" | "lakitu" | "podoboo" | "firebar" | "bowser" | "all";

function groundTiles(width = 64): TileCell[] {
  return Array.from({ length: width * 2 }, (_, i) => ({ x: i % width, y: 13 + Math.floor(i / width), kind: "ground" }));
}

function objectsFor(kind: HazardFixtureKind): PlacedObject[] {
  const pipe: PlacedObject = { id: HAZARD_IDS.pipe, kind: "pipe", x: 192, y: 208, props: { height: 3, entrance: "down" } };
  const piranha: PlacedObject = { id: HAZARD_IDS.piranha, kind: "piranha", x: 192, y: 160, props: { pipeId: HAZARD_IDS.pipe } };
  const cannon: PlacedObject = { id: HAZARD_IDS.cannon, kind: "billCannon", x: 160, y: 208, props: {} };
  const hammerBro: PlacedObject = { id: HAZARD_IDS.hammerBro, kind: "hammerBro", x: 160, y: 208, props: {} };
  const lakitu: PlacedObject = { id: HAZARD_IDS.lakitu, kind: "lakitu", x: 160, y: 144, props: {} };
  const podoboo: PlacedObject = { id: HAZARD_IDS.podoboo, kind: "podoboo", x: 160, y: 240, props: {} };
  const firebar: PlacedObject = { id: HAZARD_IDS.firebar, kind: "firebar", x: 96, y: 192, props: { length: 6, direction: "cw", speed: "normal" } };
  const bowser: PlacedObject = { id: HAZARD_IDS.bowser, kind: "bowser", x: 240, y: 208, props: {} };
  switch (kind) {
    case "piranha": return [pipe, piranha];
    case "cannon": return [cannon];
    case "hammer": return [hammerBro];
    case "lakitu": return [lakitu];
    case "podoboo": return [podoboo];
    case "firebar": return [firebar];
    case "bowser": return [bowser];
    case "all": return [
      { id: HAZARD_IDS.pipe, kind: "pipe", x: 16, y: 208, props: { height: 3, entrance: "down" } },
      { id: HAZARD_IDS.piranha, kind: "piranha", x: 16, y: 160, props: { pipeId: HAZARD_IDS.pipe } },
      { id: HAZARD_IDS.cannon, kind: "billCannon", x: 48, y: 96, props: {} },
      { id: HAZARD_IDS.hammerBro, kind: "hammerBro", x: 448, y: 208, props: {} },
      { id: HAZARD_IDS.lakitu, kind: "lakitu", x: 256, y: 144, props: {} },
      { id: HAZARD_IDS.podoboo, kind: "podoboo", x: 32, y: 240, props: {} },
      { id: HAZARD_IDS.firebar, kind: "firebar", x: 64, y: 80, props: { length: 6, direction: "cw", speed: "normal" } },
    ];
  }
}

/** Production serializer/parser round trip; pipe/piranha coordinates match catalog mouth placement. */
export function createHazardFixture(kind: HazardFixtureKind = "all"): CourseV1 {
  const seed = createNewCourseFixture();
  const theme = kind === "bowser" || kind === "podoboo" || kind === "firebar" ? "castle" as const : seed.areas[0]!.theme;
  return fixtureValue(parseCourse(fixtureValue(serializeCourse({
    ...seed, title: `Hazards: ${kind}`, timerSeconds: 0,
    areas: seed.areas.map(area => ({ ...area, theme, width: 64, tiles: groundTiles(), objects: objectsFor(kind) })),
  }))));
}

export type HazardPlayCase = "all" | "edge-pipe" | "edge-cannon" | "edge-spiny" | "edge-firebar" | "bowser";

/** Browser routes: `all` observes seeded attacks from a far start; edge cases stand in a safe radius or walk into a nonstompable.
 * `bowser` is a real-key five-hit fight: two powerups then a star, Bowser stays inactive until fire form. */
export function createHazardPlayFixture(which: HazardPlayCase): CourseV1 {
  if (which === "all") {
    const course = createHazardFixture("all");
    const roof = Array.from({ length: 64 }, (_, x): TileCell => ({ x, y: 10, kind: "hard" }));
    return fixtureValue(parseCourse(fixtureValue(serializeCourse({
      ...course, title: "Hazard play: all", start: { ...course.start, x: 80, y: 208 },
      areas: course.areas.map(area => ({ ...area, tiles: [...area.tiles, ...roof] })),
    }))));
  }
  if (which === "edge-pipe") {
    const course = createHazardFixture("piranha");
    return fixtureValue(parseCourse(fixtureValue(serializeCourse({
      ...course, title: "Hazard play: edge-pipe", start: { ...course.start, x: 168, y: 208 },
    }))));
  }
  if (which === "edge-cannon") {
    const course = createHazardFixture("cannon");
    return fixtureValue(parseCourse(fixtureValue(serializeCourse({
      ...course, title: "Hazard play: edge-cannon", start: { ...course.start, x: 136, y: 208 },
    }))));
  }
  if (which === "edge-firebar") {
    const course = createHazardFixture("firebar");
    return fixtureValue(parseCourse(fixtureValue(serializeCourse({
      ...course, title: "Hazard play: edge-firebar", start: { ...course.start, x: 80, y: 208 },
    }))));
  }
  if (which === "bowser") {
    const course = createHazardFixture("bowser");
    const extra: TileCell[] = [
      { x: 2, y: 10, kind: "question", content: "powerup" },
      { x: 8, y: 10, kind: "question", content: "powerup" },
      { x: 12, y: 10, kind: "question", content: "star" },
      ...Array.from({ length: 13 }, (_, y): TileCell => ({ x: 0, y, kind: "hard" })),
    ];
    return fixtureValue(parseCourse(fixtureValue(serializeCourse({
      ...course, title: "Hazard play: bowser", start: { ...course.start, x: 40, y: 208 },
      areas: course.areas.map(area => ({
        ...area,
        objects: area.objects.map(object => object.kind === "bowser" ? { ...object, x: 400 } : object),
        tiles: [...area.tiles, ...extra],
      })),
    }))));
  }
  const course = createHazardFixture("lakitu");
  return fixtureValue(parseCourse(fixtureValue(serializeCourse({
    ...course, title: "Hazard play: edge-spiny", start: { ...course.start, x: 40, y: 208 },
  }))));
}
