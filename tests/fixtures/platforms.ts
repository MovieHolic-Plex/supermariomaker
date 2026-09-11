import { EMPTY_INPUT } from "../../src/input";
import type { InputAction, InputFrame } from "../../src/input";
import type { PlacedObject, PlatformProps, TileCell } from "../../src/level/types";
import { parseCourse, serializeCourse } from "../../src/level/serialize";
import { createRuntime, currentArea } from "../../src/game/state";
import type { PlayerState } from "../../src/game/state";
import { createPlatformState } from "../../src/game/platforms";
import type { PlatformBody, PlatformFeatureState } from "../../src/game/platforms";
import type { Contact } from "../../src/game/collision";
import { createNewCourseFixture, fixtureId, fixtureValue } from "./factory";

export const platformIds = { horizontal: fixtureId(901), vertical: fixtureId(902), falling: fixtureId(903),
  balanceA: fixtureId(904), balanceB: fixtureId(905), unpaired: fixtureId(906), spring: fixtureId(907),
  goomba: fixtureId(910), areaB: fixtureId(930), areaBPlatform: fixtureId(931) };
export function placedPlatform(id: string, props: PlatformProps, x = 256, y = 160): PlacedObject {
  return { id, kind: "platform", x, y, props };
}
export function createPlatformsFixture(objects?: readonly PlacedObject[]) {
  const seed = createNewCourseFixture();
  return fixtureValue(parseCourse(fixtureValue(serializeCourse({ ...seed, title: "Platform core", timerSeconds: 0,
    areas: seed.areas.map(area => ({ ...area, objects: objects ?? [
      placedPlatform(platformIds.horizontal, { motion: "horizontal", length: 2, travel: 1, speed: 2 }),
      placedPlatform(platformIds.vertical, { motion: "vertical", length: 8, travel: 32, speed: 0.5 }, 512),
      placedPlatform(platformIds.falling, { motion: "falling", length: 3, travel: 8, speed: 1 }, 768),
      placedPlatform(platformIds.balanceA, { motion: "balance", length: 3, travel: 1, speed: 1, pairId: platformIds.balanceB }, 1024),
      placedPlatform(platformIds.balanceB, { motion: "balance", length: 3, travel: 2, speed: 2, pairId: platformIds.balanceA }, 1280),
      placedPlatform(platformIds.unpaired, { motion: "balance", length: 3, travel: 1, speed: 1 }, 1536),
      { id: platformIds.spring, kind: "spring", x: 1792, y: 160, props: {} },
    ] })),
  }))));
}
export function platformRuntime(objects?: readonly PlacedObject[]) {
  const runtime = createRuntime(createPlatformsFixture(objects));
  return { runtime, state: createPlatformState(currentArea(runtime)) };
}
export function bodyById(state: PlatformFeatureState, id: string): PlatformBody {
  const body = state.bodies.find(body => body.id === id);
  if (!body) throw new Error(`Missing fixture body ${id}`);
  return body;
}
export function playerOn(player: PlayerState, body: PlatformBody): PlayerState {
  return { ...player, x: body.bounds.x + body.bounds.width / 2, y: body.bounds.y, vy: 0, grounded: true };
}
export function topContact(id: string): Contact {
  return { id, source: { kind: "object", objectId: id, part: "body" }, axis: "y", normal: -1, time: 0 };
}
export const platformInput = (...actions: InputAction[]): InputFrame => ({ ...EMPTY_INPUT,
  ...Object.fromEntries(actions.map(action => [action, { held: true, pressed: false, released: false }])) });
export const platformJump: InputFrame = { ...EMPTY_INPUT, jump: { held: true, pressed: true, released: false } };

const floor = (width = 64): TileCell[] => Array.from({ length: width * 2 }, (_, i) => ({
  x: i % width, y: 13 + Math.floor(i / width), kind: "ground" as const,
}));

export type PlatformLiveCase = "horizontal" | "vertical" | "falling" | "balance" | "spring" | "crush" | "wall" | "vine" | "enemy" | "areas";
export type PlatformPlayCase = "horizontal" | "vertical" | "falling" | "balance" | "spring" | "vine" | "crush";

/** Authored 16-pixel grid. Player start is on the device top, never overlapping its collider. */
export function createPlatformLiveFixture(which: PlatformLiveCase) {
  const seed = createNewCourseFixture();
  const main = seed.mainAreaId;
  let objects: PlacedObject[] = [];
  let tiles = floor();
  let start = { areaId: main, x: 80, y: 152 };
  let areas = seed.areas;
  switch (which) {
    case "horizontal":
      objects = [placedPlatform(platformIds.horizontal, { motion: "horizontal", length: 3, travel: 4, speed: 1 }, 80, 160)];
      break;
    case "vertical":
      objects = [placedPlatform(platformIds.vertical, { motion: "vertical", length: 3, travel: 4, speed: 1 }, 80, 144)];
      start = { areaId: main, x: 80, y: 136 };
      break;
    case "falling":
      objects = [placedPlatform(platformIds.falling, { motion: "falling", length: 3, travel: 8, speed: 1 }, 80, 160)];
      break;
    case "balance":
      objects = [
        placedPlatform(platformIds.balanceA, { motion: "balance", length: 3, travel: 2, speed: 1, pairId: platformIds.balanceB }, 80, 160),
        placedPlatform(platformIds.balanceB, { motion: "balance", length: 3, travel: 2, speed: 1, pairId: platformIds.balanceA }, 176, 160),
      ];
      break;
    case "spring":
      objects = [{ id: platformIds.spring, kind: "spring", x: 80, y: 208, props: {} }];
      start = { areaId: main, x: 80, y: 192 };
      break;
    case "crush":
      objects = [placedPlatform(platformIds.vertical, { motion: "vertical", length: 3, travel: 2, speed: 2 }, 80, 160)];
      start = { areaId: main, x: 112, y: 208 };
      tiles = [...tiles, ...Array.from({ length: 6 }, (_, i) => ({ x: 3 + i, y: 8, kind: "hard" as const }))];
      break;
    case "wall":
      objects = [placedPlatform(platformIds.horizontal, { motion: "horizontal", length: 3, travel: 8, speed: 2 }, 80, 160)];
      tiles = [...tiles, ...Array.from({ length: 13 }, (_, y) => ({ x: 10, y, kind: "hard" as const }))];
      break;
    case "vine":
      objects = [placedPlatform(platformIds.horizontal, { motion: "horizontal", length: 3, travel: 8, speed: 2 }, 48, 112)];
      tiles = [
        ...floor(),
        ...Array.from({ length: 13 }, (_, y) => ({ x: 0, y, kind: "hard" as const })),
        ...Array.from({ length: 13 }, (_, y) => ({ x: 9, y, kind: "hard" as const })),
        { x: 2, y: 10, kind: "question", content: "vine" },
      ];
      start = { areaId: main, x: 40, y: 208 };
      break;
    case "enemy":
      objects = [
        placedPlatform(platformIds.horizontal, { motion: "horizontal", length: 3, travel: 8, speed: 1 }, 80, 208),
        { id: platformIds.goomba, kind: "goomba", x: 176, y: 208, props: {} },
      ];
      start = { areaId: main, x: 80, y: 200 };
      break;
    case "areas": {
      objects = [
        placedPlatform(platformIds.horizontal, { motion: "horizontal", length: 3, travel: 4, speed: 1 }, 80, 160),
        { id: platformIds.spring, kind: "spring", x: 176, y: 208, props: {} },
      ];
      const second = {
        id: platformIds.areaB, name: "지하", theme: "underground" as const, width: 32, height: 15,
        tiles: floor(32),
        objects: [placedPlatform(platformIds.areaBPlatform, { motion: "horizontal", length: 3, travel: 2, speed: 1 }, 80, 160)],
      };
      areas = seed.areas.map(area => ({ ...area, width: 64, tiles, objects })).concat(second);
      break;
    }
  }
  if (which !== "areas") areas = seed.areas.map(area => ({ ...area, width: 64, tiles, objects }));
  return fixtureValue(parseCourse(fixtureValue(serializeCourse({
    ...seed, title: `Platform live ${which}`, timerSeconds: 0, start, areas,
  }))));
}
/** Play vine: used block is climbable from a 16px step, no moving obstruction. */
export function createPlatformPlayFixture(which: PlatformPlayCase) {
  if (which !== "vine") return createPlatformLiveFixture(which);
  const seed = createNewCourseFixture();
  const tiles = [
    ...Array.from({ length: 128 }, (_, i) => ({ x: i % 64, y: 13 + Math.floor(i / 64), kind: "ground" as const })),
    ...Array.from({ length: 13 }, (_, y) => ({ x: 0, y, kind: "hard" as const })),
    ...Array.from({ length: 13 }, (_, y) => ({ x: 9, y, kind: "hard" as const })),
    { x: 2, y: 10, kind: "question" as const, content: "vine" as const },
    ...Array.from({ length: 6 }, (_, i) => ({ x: 3 + i, y: 11, kind: "hard" as const })),
  ];
  return fixtureValue(parseCourse(fixtureValue(serializeCourse({
    ...seed, title: "Platform play vine", timerSeconds: 0,
    start: { areaId: seed.mainAreaId, x: 40, y: 208 },
    areas: seed.areas.map(area => ({ ...area, width: 64, tiles, objects: [] })),
  }))));
}
