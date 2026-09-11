import type { CourseV1, PlacedObject, TileCell } from "../../src/level/types";
import { parseCourse, serializeCourse } from "../../src/level/serialize";
import { createNewCourseFixture, fixtureId, fixtureValue } from "./factory";

export const GOAL_IDS = {
  flag: fixtureId(1401), castle: fixtureId(1402), bowser: fixtureId(1403), goomba: fixtureId(1404),
} as const;

export type GoalFixtureKind = "flag" | "castle" | "timeout" | "pit-flag";

function groundRow(width: number, y: number, skip?: ReadonlySet<number>): TileCell[] {
  const tiles: TileCell[] = [];
  for (let x = 0; x < width; x++) if (!skip?.has(x)) tiles.push({ x, y, kind: "ground" });
  return tiles;
}

function roundTrip(kind: string, timerSeconds: number, tiles: TileCell[], objects: PlacedObject[], theme: CourseV1["areas"][number]["theme"], startX = 40): CourseV1 {
  const seed = createNewCourseFixture();
  return fixtureValue(parseCourse(fixtureValue(serializeCourse({
    ...seed, title: `Goals: ${kind}`, timerSeconds,
    start: { areaId: seed.start.areaId, x: startX, y: 208 },
    areas: seed.areas.map(area => ({ ...area, theme, width: 32, height: 15, tiles, objects })),
  }))));
}

/** Flag at (80,208) height 6, full floor, start (40,208). Castle bridge overlays empty cells 12-19. */
export function createGoalFixture(kind: GoalFixtureKind = "flag"): CourseV1 {
  const floor = [...groundRow(32, 13), ...groundRow(32, 14)];
  const flag: PlacedObject = { id: GOAL_IDS.flag, kind: "flagGoal", x: 80, y: 208, props: { height: 6 } };
  const bowser: PlacedObject = { id: GOAL_IDS.bowser, kind: "bowser", x: 240, y: 208, props: {} };
  const castle: PlacedObject = {
    id: GOAL_IDS.castle, kind: "castleGoal", x: 320, y: 208,
    props: { bridge: { x: 12, y: 13, width: 8, height: 1 }, bowserId: GOAL_IDS.bowser },
  };
  const gap = new Set([12, 13, 14, 15, 16, 17, 18, 19]);
  const castleFloor = [...groundRow(32, 13, gap), ...groundRow(32, 14, gap)];
  switch (kind) {
    case "flag": return roundTrip(kind, 0, floor, [flag], "overworld");
    case "timeout": return roundTrip(kind, 30, floor, [flag], "overworld");
    case "castle": return roundTrip(kind, 0, castleFloor, [bowser, castle], "castle", 300);
    case "pit-flag": {
      const pit = new Set([4, 5, 6, 7, 8, 9, 10, 11]);
      return roundTrip(kind, 0, [...groundRow(32, 13, pit), ...groundRow(32, 14, pit)], [flag], "overworld");
    }
  }
}

export type GoalPlayCase = "flag" | "castle" | "timeout" | "death-tie";

export function createGoalPlayFixture(which: GoalPlayCase): CourseV1 {
  if (which === "death-tie") {
    const course = createGoalFixture("flag");
    const goomba: PlacedObject = { id: GOAL_IDS.goomba, kind: "goomba", x: 80, y: 208, props: {} };
    return fixtureValue(parseCourse(fixtureValue(serializeCourse({
      ...course, title: "Goals: death-tie",
      areas: course.areas.map(area => ({ ...area, objects: [...area.objects, goomba] })),
    }))));
  }
  if (which === "castle") return createGoalFixture("castle");
  return createGoalFixture(which);
}
