import type { CourseV1, PlacedObject, TileCell } from "../../src/level/types";
import { parseCourse, serializeCourse } from "../../src/level/serialize";
import { createNewCourseFixture, fixtureId, fixtureValue } from "./factory";

export const WATER_IDS = {
  cheepRed: fixtureId(1201), cheepGreen: fixtureId(1202), cheepLeap: fixtureId(1203), blooper: fixtureId(1204),
} as const;

export type WaterFixtureKind = "swim" | "leap" | "blooper" | "ceiling" | "themes" | "all";

function groundTiles(width = 64): TileCell[] {
  return Array.from({ length: width * 2 }, (_, i) => ({ x: i % width, y: 13 + Math.floor(i / width), kind: "ground" }));
}

function objectsFor(kind: WaterFixtureKind): PlacedObject[] {
  const cheepRed: PlacedObject = { id: WATER_IDS.cheepRed, kind: "cheep", x: 160, y: 160, props: { color: "red", mode: "swim" } };
  const cheepGreen: PlacedObject = { id: WATER_IDS.cheepGreen, kind: "cheep", x: 208, y: 144, props: { color: "green", mode: "swim" } };
  const cheepLeap: PlacedObject = { id: WATER_IDS.cheepLeap, kind: "cheep", x: 208, y: 208, props: { color: "red", mode: "leap" } };
  const blooper: PlacedObject = { id: WATER_IDS.blooper, kind: "blooper", x: 128, y: 160, props: {} };
  switch (kind) {
    case "swim": return [cheepRed, cheepGreen];
    case "leap": return [cheepLeap];
    case "blooper": return [blooper];
    case "ceiling": return [cheepRed];
    case "themes": return [cheepRed, blooper];
    case "all": return [cheepRed, cheepGreen, cheepLeap, blooper];
  }
}

/** Production serializer/parser round trip. Underwater theme is the physical profile selector. */
export function createWaterFixture(kind: WaterFixtureKind = "all"): CourseV1 {
  const seed = createNewCourseFixture();
  const theme = kind === "leap" ? "overworld" as const : "underwater" as const;
  const ceiling: TileCell[] = kind === "ceiling"
    ? Array.from({ length: 64 }, (_, x): TileCell => ({ x, y: 6, kind: "hard" }))
    : [];
  return fixtureValue(parseCourse(fixtureValue(serializeCourse({
    ...seed, title: `Water: ${kind}`, timerSeconds: 0,
    areas: seed.areas.map(area => ({ ...area, theme, width: 64, tiles: [...groundTiles(), ...ceiling], objects: objectsFor(kind) })),
  }))));
}

export function createThemeTransitionFixture(): CourseV1 {
  const water = createWaterFixture("themes");
  const main = water.areas[0];
  if (!main) throw new Error("Water area missing");
  const landId = fixtureId(1210);
  const land = { ...main, id: landId, name: "지상", theme: "overworld" as const, objects: [] as PlacedObject[] };
  return fixtureValue(parseCourse(fixtureValue(serializeCourse({
    ...water, title: "Water: themes", areas: [main, land],
  }))));
}

export type WaterPlayCase = "all" | "edge-ceiling" | "leap";

/** Browser routes: swim past red Cheep and Blooper, then a leap Cheep further right. Ceiling case proves no penetration. */
export function createWaterPlayFixture(which: WaterPlayCase): CourseV1 {
  if (which === "edge-ceiling") {
    const course = createWaterFixture("ceiling");
    return fixtureValue(parseCourse(fixtureValue(serializeCourse({
      ...course, title: "Water play: edge-ceiling", start: { ...course.start, x: 40, y: 208 },
    }))));
  }
  if (which === "leap") {
    const course = createWaterFixture("leap");
    return fixtureValue(parseCourse(fixtureValue(serializeCourse({
      ...course, title: "Water play: leap", start: { ...course.start, x: 40, y: 208 },
    }))));
  }
  const seed = createNewCourseFixture();
  const objects: PlacedObject[] = [
    { id: WATER_IDS.cheepRed, kind: "cheep", x: 128, y: 160, props: { color: "red", mode: "swim" } },
    { id: WATER_IDS.blooper, kind: "blooper", x: 208, y: 96, props: {} },
    { id: WATER_IDS.cheepLeap, kind: "cheep", x: 400, y: 208, props: { color: "green", mode: "leap" } },
  ];
  return fixtureValue(parseCourse(fixtureValue(serializeCourse({
    ...seed, title: "Water play: all", timerSeconds: 0, start: { ...seed.start, x: 40, y: 208 },
    areas: seed.areas.map(area => ({ ...area, theme: "underwater" as const, width: 64, tiles: groundTiles(), objects })),
  }))));
}
