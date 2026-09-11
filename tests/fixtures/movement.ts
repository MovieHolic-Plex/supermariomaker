import type { CourseV1, Theme, TileCell } from "../../src/level/types";
import { parseCourse, serializeCourse } from "../../src/level/serialize";
import { createNewCourseFixture, fixtureValue } from "./factory";

/** Start (40,208), flat floor y=208, full-height wall x=448. No actors/items/goal gameplay. */
export function createMovementFixture(theme: Theme = "overworld"): CourseV1 {
  const seed = createNewCourseFixture();
  const tiles: TileCell[] = [
    ...Array.from({ length: 128 }, (_, i): TileCell => ({ x: i % 64, y: 13 + Math.floor(i / 64), kind: "ground" })),
    ...Array.from({ length: 13 }, (_, y): TileCell => ({ x: 28, y, kind: "hard" })),
  ];
  return fixtureValue(parseCourse(fixtureValue(serializeCourse({ ...seed, title: "이동 실험실", timerSeconds: 0,
    areas: seed.areas.map(area => ({ ...area, theme, width: 64, tiles, objects: [] })),
  }))));
}
