import { describe, expect, test } from "bun:test";
import { previewSprites } from "../src/ui/course-preview";
import { parseCourse } from "../src/level/serialize";
import { fixtureValue } from "./fixtures/factory";
import type { AreaV1 } from "../src/level/types";

const empty: AreaV1 = { id: "preview", name: "preview", theme: "overworld", width: 4096, height: 128, tiles: [], objects: [] };
describe("static course preview", () => {
  test("maps stored cell coordinates to bottom-center sprite coordinates", () => {
    // Given two authored cells, including an editor-only hidden tile.
    const area: AreaV1 = { ...empty, tiles: [{ kind: "ground", x: 0, y: 13 }, { kind: "hidden", x: 2, y: 3, content: "star" }] };
    // When projected; then coordinates and artwork follow authored input.
    expect(previewSprites(area, { x: 0, y: 0 })).toEqual([
      { key: "tile.ground", x: 8, y: 224 }, { key: "tile.hidden", x: 40, y: 64 },
    ]);
  });
  test("composes stored pipe height and platform length without mutating input", () => {
    const area: AreaV1 = { ...empty, objects: [
      { id: "pipe", kind: "pipe", x: 64, y: 208, props: { height: 3, entrance: "up" } },
      { id: "platform", kind: "platform", x: 128, y: 128, props: { motion: "vertical", length: 2, travel: 3, speed: 2 } },
    ] };
    const before = structuredClone(area);
    const result = previewSprites(area, { x: 0, y: 0 });
    expect(result).toEqual([
      { key: "decor.pipeBody", x: 64, y: 208 }, { key: "decor.pipeBody", x: 64, y: 192 }, { key: "decor.pipeCap", x: 64, y: 176 },
      { key: "decor.platform", x: 120, y: 128 }, { key: "decor.platform", x: 136, y: 128 },
    ]);
    expect(area).toEqual(before);
  });
  test("selects stored enemy colors rather than catalog defaults", () => {
    const area: AreaV1 = { ...empty, objects: [
      { id: "koopa", kind: "koopa", x: 32, y: 64, props: { color: "red" } },
      { id: "wings", kind: "paratroopa", x: 64, y: 64, props: { color: "red", motion: "vertical" } },
      { id: "fish", kind: "cheep", x: 96, y: 64, props: { color: "green", mode: "leap" } },
    ] };
    expect(previewSprites(area, { x: 0, y: 0 }).map(item => item.key)).toEqual([
      "enemy.koopa.red.walk1", "enemy.koopa.red.wings1", "enemy.cheep.green.swim1",
    ]);
  });
  test("uses authored bridge cells and firebar length in the static pose", () => {
    const area: AreaV1 = { ...empty, objects: [
      { id: "goal", kind: "castleGoal", x: 128, y: 208, props: { bridge: { x: 2, y: 13, width: 2, height: 1 } } },
      { id: "bar", kind: "firebar", x: 24, y: 80, props: { length: 3, direction: "ccw", speed: "fast" } },
    ] };
    expect(previewSprites(area, { x: 0, y: 0 })).toEqual([
      { key: "decor.bridge", x: 40, y: 224 }, { key: "decor.bridge", x: 56, y: 224 }, { key: "decor.axe", x: 128, y: 208 },
      { key: "enemy.firebar", x: 24, y: 80 }, { key: "enemy.firebar", x: 32, y: 80 }, { key: "enemy.firebar", x: 40, y: 80 },
    ]);
  });
  test("culls a maximum-sized sparse area without dropping partially visible sprites", () => {
    const area: AreaV1 = { ...empty, tiles: [{ kind: "ground", x: 4095, y: 127 }, { kind: "ground", x: 0, y: 0 }] };
    expect(previewSprites(area, { x: 65280, y: 1808 })).toEqual([{ key: "tile.ground", x: 65528, y: 2048 }]);
    expect(previewSprites(area, { x: 15, y: 15 })).toEqual([{ key: "tile.ground", x: 8, y: 16 }]);
  });
  test("projects all four real shipped fixture areas without modifying the parsed document", async () => {
    const course = fixtureValue(parseCourse(await Bun.file("tests/fixtures/all-kinds.smb1.json").bytes()));
    const before = structuredClone(course);
    const results = course.areas.map(area => previewSprites(area, { x: 0, y: area.theme === "overworld" ? 272 : 0 }));
    expect(results).toHaveLength(4);
    expect(results.every(sprites => sprites.length > 0)).toBe(true);
    expect(course).toEqual(before);
  });
});
