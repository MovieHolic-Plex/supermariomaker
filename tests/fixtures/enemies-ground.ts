import type { CourseV1, PlacedObject, TileCell } from "../../src/level/types";
import { parseCourse, serializeCourse } from "../../src/level/serialize";
import { createNewCourseFixture, fixtureId, fixtureValue } from "./factory";
import { createBlocksFixture } from "./blocks";

export const GROUND_IDS = {
  koopa: fixtureId(800), goomba: fixtureId(801), buzzy: fixtureId(802),
  green: fixtureId(803), red: fixtureId(804), hop: fixtureId(805), vertical: fixtureId(806),
} as const;
export type GroundFixtureKind = "combat" | "ledge" | "wings";
/** Production serializer/parser round trip; all anchors are authored bottom-center grid coordinates. */
export function createGroundEnemyFixture(kind: GroundFixtureKind = "combat"): CourseV1 {
  const seed = createNewCourseFixture();
  let objects: PlacedObject[];
  let tiles: TileCell[] = Array.from({ length: 128 }, (_, i) => ({ x: i % 64, y: 13 + Math.floor(i / 64), kind: "ground" }));
  if (kind === "ledge") {
    // Isolated platforms start x=128 and x=256. Initial patrol faces left.
    tiles = tiles.filter(tile => tile.x < 4 || (tile.x >= 8 && tile.x < 12) || (tile.x >= 16 && tile.x < 20));
    objects = [
      { id: GROUND_IDS.green, kind: "koopa", x: 144, y: 208, props: { color: "green" } },
      { id: GROUND_IDS.red, kind: "koopa", x: 272, y: 208, props: { color: "red" } },
    ];
  } else if (kind === "wings") {
    objects = [
      { id: GROUND_IDS.hop, kind: "paratroopa", x: 128, y: 208, props: { color: "green", motion: "hop" } },
      { id: GROUND_IDS.vertical, kind: "paratroopa", x: 256, y: 144, props: { color: "red", motion: "vertical" } },
    ];
  } else {
    objects = [
      { id: GROUND_IDS.koopa, kind: "koopa", x: 128, y: 208, props: { color: "green" } },
      { id: GROUND_IDS.goomba, kind: "goomba", x: 192, y: 208, props: {} },
      { id: GROUND_IDS.buzzy, kind: "buzzy", x: 256, y: 208, props: {} },
    ];
  }
  return fixtureValue(parseCourse(fixtureValue(serializeCourse({ ...seed, title: `Ground enemies: ${kind}`, timerSeconds: 0,
    areas: seed.areas.map(area => ({ ...area, width: 64, tiles, objects })),
  }))));
}

export type GroundPlayCase = "combat" | "return-shell" | "ledge" | "wings" | "hop-stomp" | "vertical-stomp" | "wake" | "red-shell" | "buzzy-shell" | "squashed" | "fire-buzzy";
/** Real-file routes: combat falls onto Koopa, retreats left, then walks right to kick.
 * Return-shell adds a wall at176; wake leaves the shell idle. Fire uses the proven
 * two-question mushroom/flower chamber, then jumps its low wall to Buzzy at352.
 * Ledge/wings start safely on the left and observe native actor ticks.
 */
export function createGroundPlayFixture(which: GroundPlayCase): CourseV1 {
  let course = createGroundEnemyFixture(which === "ledge" ? "ledge" : which === "wings" || which === "hop-stomp" || which === "vertical-stomp" ? "wings" : "combat");
  if (which === "ledge") course = { ...course, start: { ...course.start, x: 176, y: 208 } };
  if (which === "wings") course = { ...course, start: { ...course.start, x: 192, y: 208 } };
  if (which === "fire-buzzy") {
    const source = createBlocksFixture("progression");
    course = { ...source, areas: source.areas.map(area => ({ ...area,
      tiles: [...area.tiles.filter(tile => tile.x !== 9 || tile.y >= 10),
        ...Array.from({ length: 13 }, (_, y): TileCell => ({ x: 25, y, kind: "hard" }))],
      objects: [{ id: GROUND_IDS.buzzy, kind: "buzzy", x: 352, y: 208, props: {} }],
    })) };
  } else if (which !== "ledge" && which !== "wings") {
    course = { ...course, start: { ...course.start, x: which === "squashed" ? 192 : which === "vertical-stomp" ? 256 : 128,
      y: which === "vertical-stomp" ? 96 : 176 }, areas: course.areas.map(area => {
      let objects = area.objects;
      if (which === "return-shell" || which === "wake") objects = objects.filter(object => object.id === GROUND_IDS.koopa);
      if (which === "red-shell") objects = [{ id: GROUND_IDS.koopa, kind: "koopa", x: 128, y: 208, props: { color: "red" } }];
      if (which === "buzzy-shell") objects = [{ id: GROUND_IDS.buzzy, kind: "buzzy", x: 128, y: 208, props: {} }];
      if (which === "squashed") objects = objects.filter(object => object.id === GROUND_IDS.goomba);
      if (which === "hop-stomp" || which === "vertical-stomp") objects = objects.filter(object => object.id === (which === "hop-stomp" ? GROUND_IDS.hop : GROUND_IDS.vertical));
      const tiles = which === "return-shell" ? [...area.tiles, ...Array.from({ length: 13 }, (_, y): TileCell => ({ x: 11, y, kind: "hard" }))] : area.tiles;
      return { ...area, objects, tiles };
    }) };
  }
  return fixtureValue(parseCourse(fixtureValue(serializeCourse({ ...course, title: `Ground play: ${which}` }))));
}
