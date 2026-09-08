import type { BlockContent, CourseV1, TileCell } from "../../src/level/types";
import { parseCourse, serializeCourse } from "../../src/level/serialize";
import { createMovementFixture } from "./movement";
import { fixtureValue } from "./factory";

export type BlocksCase = "progression" | "coin" | "multiCoin" | "hidden" | "vine" | "star" | "oneUp" | "smallBrick" | "hiddenSide";
/** Authored chambers, no runtime overrides. Floor208, walls16/144, first block(2,10).
 * Progression: hit first question at40, walk to right wall138, wait for mushroom;
 * hit second at(8,10); walk left to110 then coast, jump/break brick(6,7);
 * jump right into flower above second question. Other cases hit at40.
 * Hidden-side: start(24,176) on elevated floor, walk across hidden(2,10).
 */
export function createBlocksFixture(which: BlocksCase): CourseV1 {
  const source = createMovementFixture();
  const tiles: TileCell[] = [
    ...Array.from({ length: 128 }, (_, i): TileCell => ({ x: i % 64, y: 13 + Math.floor(i / 64), kind: "ground" })),
    ...Array.from({ length: 13 }, (_, y): TileCell => ({ x: 0, y, kind: "hard" })),
    ...Array.from({ length: 13 }, (_, y): TileCell => ({ x: 9, y, kind: "hard" })),
  ];
  if (which === "hiddenSide") {
    for (let x = 1; x < 9; x++) tiles.push({ x, y: 11, kind: "hard" });
    tiles.push({ x: 2, y: 10, kind: "hidden", content: "coin" });
  } else {
    const content: BlockContent = which === "progression" ? "powerup" : which === "hidden" ? "coin" : which === "smallBrick" ? "none" : which;
    tiles.push({ x: 2, y: 10, kind: which === "hidden" ? "hidden" : which === "smallBrick" ? "brick" : "question", content });
    if (which === "progression") tiles.push({ x: 8, y: 10, kind: "question", content: "powerup" }, { x: 6, y: 7, kind: "brick", content: "none" });
    if (which === "coin") tiles.push({ x: 3, y: 12, kind: "coin" });
  }
  return fixtureValue(parseCourse(fixtureValue(serializeCourse({ ...source, title: `블록 실험실 · ${which}`,
    start: { ...source.start, x: which === "hiddenSide" ? 24 : 40, y: which === "hiddenSide" ? 176 : 208 },
    areas: source.areas.map(area => ({ ...area, tiles })),
  }))));
}
