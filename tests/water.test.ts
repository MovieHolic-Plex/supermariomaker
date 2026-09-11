import { describe, expect, test } from "bun:test";
import { EMPTY_INPUT } from "../src/input";
import type { InputFrame } from "../src/input";
import { createRuntime, currentArea, snapshot } from "../src/game/state";
import { step } from "../src/game/step";
import { PHYSICS, snapPosition } from "../src/game/physics";
import { playView } from "../src/ui/play-view";
import { createThemeTransitionFixture, createWaterFixture, WATER_IDS } from "./fixtures/water";

const idle = EMPTY_INPUT;
const press: InputFrame = { ...EMPTY_INPUT, jump: { held: true, pressed: true, released: false } };
const hold: InputFrame = { ...EMPTY_INPUT, jump: { held: true, pressed: false, released: false } };
const right: InputFrame = { ...EMPTY_INPUT, right: { held: true, pressed: false, released: false } };
const rightRun: InputFrame = { ...EMPTY_INPUT, right: { held: true, pressed: false, released: false }, run: { held: true, pressed: false, released: false } };

function ticks(runtime: ReturnType<typeof createRuntime>, count: number, input = idle) {
  const events = [];
  for (let i = 0; i < count; i++) events.push(...step(runtime, input));
  return events;
}
function waterActor(runtime: ReturnType<typeof createRuntime>, id: string) {
  const actor = runtime.water.actors.get(id);
  expect(actor).toBeDefined();
  if (!actor) throw new Error(`Missing water actor ${id}`);
  return actor;
}

describe("underwater physics profile", () => {
  test("swim press uses water vy, 12-tick cooldown, and held jump does not restroke", () => {
    const runtime = createRuntime(createWaterFixture("swim"));
    expect(runtime.seed).toBe(0x534d4231);
    expect(PHYSICS.name).toBe("maker-smb1-v1");
    expect(PHYSICS.water).toEqual({ acceleration: 0.08, cap: 1.4, gravity: 0.10, fallCap: 2.2, swim: -2.6, cooldown: 12 });
    const first = step(runtime, press);
    expect(first).toContainEqual({ type: "swim", tick: 1 });
    expect(runtime.player.vy).toBeCloseTo(-2.5);
    expect(runtime.player.swimCooldown).toBe(12);
    const held = ticks(runtime, 11, hold);
    expect(held.some(event => event.type === "swim")).toBe(false);
    expect(runtime.player.swimCooldown).toBe(1);
    const tooSoon = step(runtime, press);
    expect(tooSoon.some(event => event.type === "swim")).toBe(false);
    expect(runtime.player.swimCooldown).toBe(0);
    const again = step(runtime, press);
    expect(again).toContainEqual({ type: "swim", tick: 14 });
    expect(runtime.player.vy).toBeCloseTo(-2.5);
  });

  test("release does not land-clamp; fall caps at 2.2; horizontal accel 0.08/cap 1.4 ignores run", () => {
    const runtime = createRuntime(createWaterFixture("swim"));
    step(runtime, press);
    step(runtime, { ...EMPTY_INPUT, jump: { held: false, pressed: false, released: true } });
    expect(runtime.player.vy).toBeLessThan(-2);
    currentArea(runtime).tiles.clear();
    ticks(runtime, 80);
    expect(runtime.player.vy).toBe(2.2);
    const walk = createRuntime(createWaterFixture("swim"));
    const run = createRuntime(createWaterFixture("swim"));
    step(walk, right); expect(walk.player.vx).toBe(0.08);
    ticks(walk, 40, right); ticks(run, 41, rightRun);
    expect(walk.player.vx).toBe(1.4); expect(run.player.vx).toBe(1.4);
  });

  test("water ceiling stops swept Y; swim release still honors fall cap", () => {
    const runtime = createRuntime(createWaterFixture("ceiling"));
    for (let i = 0; i < 200 && !runtime.contacts.some(contact => contact.axis === "y" && contact.normal === 1); i++) {
      step(runtime, runtime.player.swimCooldown === 0 ? press : hold);
    }
    expect(runtime.player.y - 15).toBeGreaterThanOrEqual(112);
    expect(runtime.contacts.some(contact => contact.axis === "y" && contact.normal === 1)).toBe(true);
    ticks(runtime, 40);
    expect(runtime.player.vy).toBeLessThanOrEqual(2.2);
    expect(runtime.player.y - 15).toBeGreaterThanOrEqual(112);
  });

  test("theme selects the profile for the current area only; cooldown does not leak across areas", () => {
    const runtime = createRuntime(createThemeTransitionFixture());
    expect(runtime.areas.get(runtime.areaId)?.source.theme).toBe("underwater");
    step(runtime, press);
    expect(runtime.player.vy).toBeCloseTo(-2.5);
    expect(runtime.player.swimCooldown).toBe(12);
    const landId = [...runtime.areas.values()].find(area => area.source.theme === "overworld")?.source.id;
    expect(landId).toBeDefined();
    if (!landId) throw new Error("land area missing");
    runtime.areaId = landId;
    Object.assign(runtime.player, { y: 208, grounded: true, vy: 0 });
    const land = step(runtime, press);
    expect(land).toContainEqual({ type: "jump", tick: 2 });
    expect(runtime.player.vy).toBeCloseTo(-5);
    expect(runtime.player.swimCooldown).toBe(0);
    runtime.areaId = [...runtime.areas.values()].find(area => area.source.theme === "underwater")!.source.id;
    const back = step(runtime, press);
    expect(back).toContainEqual({ type: "swim", tick: 3 });
    expect(runtime.player.vy).toBeCloseTo(-2.5);
  });

  test("underwater playView uses swim frames bound to the live tick", () => {
    const runtime = createRuntime(createWaterFixture("swim"));
    expect(playView(runtime).player.key).toMatch(/^mario\.small\.swim/);
    expect(playView(runtime).theme).toBe("underwater");
    step(runtime, press);
    expect(playView(runtime).player.key).toMatch(/^mario\.small\.swim/);
  });
});

describe("cheep cheep", () => {
  test("red swim mode moves left 0.8 and oscillates ±16px over 120 ticks", () => {
    const runtime = createRuntime(createWaterFixture("swim"));
    const fish = waterActor(runtime, WATER_IDS.cheepRed);
    expect(fish.kind).toBe("cheep");
    if (fish.kind !== "cheep") throw new Error("expected cheep");
    expect(fish.color).toBe("red");
    expect(fish.mode).toBe("swim");
    const originY = fish.y, originX = fish.x;
    ticks(runtime, 30);
    let expectedX = originX;
    for (let i = 0; i < 30; i++) expectedX = snapPosition(expectedX - 0.8);
    expect(waterActor(runtime, WATER_IDS.cheepRed).x).toBe(expectedX);
    expect(waterActor(runtime, WATER_IDS.cheepRed).y).toBeCloseTo(originY - 16);
    ticks(runtime, 30);
    expect(waterActor(runtime, WATER_IDS.cheepRed).y).toBeCloseTo(originY);
    ticks(runtime, 30);
    expect(waterActor(runtime, WATER_IDS.cheepRed).y).toBeCloseTo(originY + 16);
    ticks(runtime, 30);
    expect(waterActor(runtime, WATER_IDS.cheepRed).y).toBeCloseTo(originY);
    expect(playView(runtime).water.some(sprite => sprite.id === WATER_IDS.cheepRed && sprite.key.startsWith("enemy.cheep.red.swim"))).toBe(true);
    expect(playView(runtime).water.some(sprite => sprite.id === WATER_IDS.cheepGreen && sprite.key.startsWith("enemy.cheep.green.swim"))).toBe(true);
  });

  test("leap launches at 180 with vy -5 vx 1.2 toward the player, then resets at origin", () => {
    const runtime = createRuntime(createWaterFixture("leap"));
    Object.assign(runtime.player, { x: 40, y: 208, grounded: true });
    const fish = waterActor(runtime, WATER_IDS.cheepLeap);
    const originY = fish.y, originX = fish.x;
    expect(ticks(runtime, 179).some(event => event.type === "cheep-leap")).toBe(false);
    const launch = ticks(runtime, 1);
    expect(launch).toContainEqual({ type: "cheep-leap", tick: 180, actorId: WATER_IDS.cheepLeap });
    const airborne = waterActor(runtime, WATER_IDS.cheepLeap);
    expect(airborne.vy).toBe(-5);
    expect(airborne.vx).toBe(-1.2);
    expect(airborne.bornTick).toBe(0);
    const x = airborne.x;
    step(runtime, idle);
    expect(waterActor(runtime, WATER_IDS.cheepLeap).x).toBeCloseTo(x - 1.2);
    ticks(runtime, 80);
    const reset = waterActor(runtime, WATER_IDS.cheepLeap);
    expect(reset.y).toBe(originY);
    expect(reset.x).toBe(originX);
    expect(reset.vx).toBe(0);
    expect(reset.vy).toBe(0);
    expect(ticks(runtime, 180).some(event => event.type === "cheep-leap")).toBe(true);
  });
});

describe("blooper", () => {
  test("pursues in 60-tick pulse/rest at max 1.2, avoids terrain, and is seed-deterministic", () => {
    const runtime = createRuntime(createWaterFixture("blooper"));
    Object.assign(runtime.player, { x: 200, y: 208, grounded: true });
    const start = waterActor(runtime, WATER_IDS.blooper);
    expect(start.kind).toBe("blooper");
    const originX = start.x, originY = start.y;
    ticks(runtime, 60);
    const pulsed = waterActor(runtime, WATER_IDS.blooper);
    expect(pulsed.x).toBeGreaterThan(originX);
    expect(Math.hypot(pulsed.x - originX, pulsed.y - originY) / 60).toBeLessThanOrEqual(1.2 + 1 / PHYSICS.snap);
    const restX = pulsed.x, restY = pulsed.y;
    ticks(runtime, 60);
    expect(waterActor(runtime, WATER_IDS.blooper).x).toBe(restX);
    expect(waterActor(runtime, WATER_IDS.blooper).y).toBe(restY);
    const twin = createRuntime(createWaterFixture("blooper"));
    Object.assign(twin.player, { x: 200, y: 208, grounded: true });
    ticks(twin, 120);
    expect(snapshot(twin).water.actors).toEqual(snapshot(runtime).water.actors);
    expect(playView(runtime).water.some(sprite => sprite.id === WATER_IDS.blooper && sprite.key.startsWith("enemy.blooper"))).toBe(true);
  });

  test("does not tunnel a solid wall while pulsing toward the player", () => {
    const runtime = createRuntime(createWaterFixture("blooper"));
    const area = [...runtime.areas.values()][0];
    if (!area) throw new Error("area missing");
    for (let y = 0; y < 13; y++) area.tiles.set(y * area.source.width + 9, { x: 9, y, kind: "hard" });
    Object.assign(runtime.player, { x: 200, y: 208, grounded: true });
    ticks(runtime, 60);
    const ink = waterActor(runtime, WATER_IDS.blooper);
    expect(ink.x + 8).toBeLessThanOrEqual(144);
  });
});

describe("aquatic combat and snapshot", () => {
  test("a descending player stomps a cheep; snapshots detach water actors", () => {
    const runtime = createRuntime(createWaterFixture("swim"));
    ticks(runtime, 1);
    const fish = waterActor(runtime, WATER_IDS.cheepRed);
    Object.assign(runtime.player, { x: fish.x, y: fish.y - 18, vy: 2.2, grounded: false });
    const events = step(runtime, idle);
    expect(events.some(event => event.type === "water-stomp" && event.actorId === WATER_IDS.cheepRed)).toBe(true);
    expect(runtime.progress.score).toBe(100);
    const viewed = snapshot(runtime);
    viewed.water.actors[0] && (viewed.water.actors[0].x = 999);
    expect(runtime.water.actors.get(WATER_IDS.cheepRed)?.x).not.toBe(999);
  });
});
