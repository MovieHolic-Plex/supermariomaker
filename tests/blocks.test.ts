import { describe, expect, test } from "bun:test";
import { EMPTY_INPUT } from "../src/input";
import { createRuntime, currentArea, snapshot } from "../src/game/state";
import { step } from "../src/game/step";
import type { GameEvent } from "../src/game/state";
import { awardChain, collectCoin, damagePlayer, growPlayer, SCORE } from "../src/game/player";
import { collectItems, commitItems, itemBounds, queueItem, updateItems } from "../src/game/items";
import { hasSolidOverlap } from "../src/game/collision";
import type { BlockContent, TileCell } from "../src/level/types";
import { createMovementFixture } from "./fixtures/movement";

const jump = { ...EMPTY_INPUT, jump: { held: true, pressed: true, released: false } };
function fixture(kind: "brick" | "question" | "hidden", content: BlockContent = "none") {
  const source = createMovementFixture();
  return { ...source, areas: source.areas.map(area => ({ ...area, tiles: [...area.tiles, { x: 2, y: 10, kind, content }] })) };
}
function hit(runtime: ReturnType<typeof createRuntime>) {
  runtime.player.x = 40; runtime.player.y = runtime.player.form === "small" || runtime.player.crouched ? 192 : 208;
  runtime.player.vx = 0; runtime.player.vy = -5; runtime.player.grounded = false;
  return step(runtime, EMPTY_INPUT);
}
const cell = (runtime: ReturnType<typeof createRuntime>): TileCell | undefined => currentArea(runtime).tiles.get(10 * 64 + 2);

describe("real step block and progression seam", () => {
  test("starts small with serializable explicit counters", () => {
    const runtime = createRuntime(createMovementFixture());
    expect(snapshot(runtime)).toMatchObject({ player: { form: "small" }, progress: { lives: 3, score: 0, coins: 0 }, combat: { starTicks: 0, invulnerabilityTicks: 0, defeated: false } });
  });
  test("small bumps empty brick; super/fire break it and score once", () => {
    const small = createRuntime(fixture("brick"));
    expect(hit(small).some(event => event.type === "blockBump")).toBe(true); expect(cell(small)?.kind).toBe("brick");
    for (const form of ["super", "fire"] as const) {
      const runtime = createRuntime(fixture("brick")); runtime.player.form = form;
      expect(hit(runtime).some(event => event.type === "blockBreak")).toBe(true); expect(cell(runtime)).toBeUndefined();
      expect(snapshot(runtime)).toMatchObject({ progress: { score: 50 } });
    }
  });
  test("hidden is intangible from side/above and reveals only below, coin once", () => {
    const runtime = createRuntime(fixture("hidden", "coin"));
    runtime.player.x = 20; runtime.player.y = 174; runtime.player.vx = 1.6;
    for (let tick = 0; tick < 30; tick++) step(runtime, { ...EMPTY_INPUT, right: { held: true, pressed: false, released: false } });
    expect(cell(runtime)?.kind).toBe("hidden");
    runtime.player.x = 40; runtime.player.y = 140; runtime.player.vy = 6;
    for (let tick = 0; tick < 12; tick++) step(runtime, EMPTY_INPUT);
    expect(cell(runtime)?.kind).toBe("hidden");
    expect(hit(runtime).some(event => event.type === "blockReveal")).toBe(true); expect(cell(runtime)?.kind).toBe("used");
    hit(runtime); expect(snapshot(runtime)).toMatchObject({ progress: { coins: 1, score: 200 } });
  });
  test("multiCoin exhausts at exactly ten on every container including hidden", () => {
    for (const kind of ["brick", "question", "hidden"] as const) {
      const runtime = createRuntime(fixture(kind, "multiCoin"));
      for (let i = 0; i < 9; i++) hit(runtime);
      expect(cell(runtime)?.kind).not.toBe("used");
      hit(runtime); expect(cell(runtime)?.kind).toBe("used"); hit(runtime);
      expect(snapshot(runtime)).toMatchObject({ progress: { coins: 10, score: 2000 } });
    }
  });
  test("normal jump reaches an authored question, source and snapshots stay detached", () => {
    const course = fixture("question", "coin"), before = JSON.stringify(course), runtime = createRuntime(course);
    step(runtime, jump); for (let tick = 0; tick < 15; tick++) step(runtime, { ...jump, jump: { ...jump.jump, pressed: false } });
    expect(cell(runtime)?.kind).toBe("used"); expect(JSON.stringify(course)).toBe(before); expect(JSON.stringify(runtime.course)).toBe(before);
    const observation = snapshot(runtime); observation.player.x = 999;
    expect(runtime.player.x).not.toBe(999);
    observation.areas[0]?.tiles.splice(0); observation.items.nextId = 999;
    expect(snapshot(runtime).areas[0]?.tiles.length).toBeGreaterThan(0); expect(runtime.items.actors).toHaveLength(0);
    expect(JSON.parse(JSON.stringify(snapshot(runtime)))).toEqual(snapshot(runtime));
  });
  test.each(["brick", "question", "hidden"] as const)("all contents work in %s with queued stable-ID spawns", kind => {
    for (const content of ["none", "coin", "powerup", "star", "oneUp", "vine"] as const) {
      const runtime = createRuntime(fixture(kind, content)); const events = hit(runtime);
      if (content === "none" || content === "coin") { expect(runtime.items.actors).toHaveLength(0); continue; }
      const actor = runtime.items.actors[0]; expect(actor).toBeDefined(); if (!actor) throw new Error("Spawn missing");
      expect(actor.kind).toBe(content === "powerup" ? "mushroom" : content);
      expect(actor.age).toBe(0); expect(actor.bornTick).toBe(runtime.tick); expect(actor.id).toBe("item:0000000001");
      expect(runtime.items.pending).toEqual([]); expect(runtime.blocks.pending).toEqual([]);
      expect(events.findIndex(event => event.type === "itemSpawn")).toBeGreaterThan(events.findIndex(event => event.type === "blockUsed"));
      const y = actor.y; step(runtime, EMPTY_INPUT); expect(actor.age).toBe(1);
      if (content === "vine") expect(actor.height).toBe(1); else expect(actor.y).toBe(y - 1);
    }
  });
  test("adaptive powerup is chosen at the block hit; actual pickup grows and scores", () => {
    for (const form of ["small", "super", "fire"] as const) {
      const runtime = createRuntime(fixture("question", "powerup")); runtime.player.form = form; hit(runtime);
      const actor = runtime.items.actors[0]; if (!actor) throw new Error("Missing powerup");
      expect(actor.kind).toBe(form === "small" ? "mushroom" : "flower");
      for (let i = 0; i < 16; i++) step(runtime, EMPTY_INPUT);
      // Unit contact placement, not a browser hook: exercise the real pickup interaction.
      runtime.player.x = actor.x; runtime.player.y = actor.y; const events: GameEvent[] = []; collectItems(runtime, events);
      expect(runtime.player.form).toBe(form === "small" ? "super" : "fire"); expect(runtime.progress.score).toBe(SCORE.powerup);
      expect(events.some(event => event.type === "itemCollect")).toBe(true); expect(runtime.items.actors).toEqual([]);
    }
  });
  test("growth under low ceiling retains feet and crouch; leaving clearance expands safely", () => {
    const runtime = createRuntime(createMovementFixture()), area = currentArea(runtime), events: GameEvent[] = [];
    area.tiles.set(11 * 64 + 2, { x: 2, y: 11, kind: "hard" });
    growPlayer(runtime, "super", "pickup", events); expect(runtime.player.crouched).toBe(true); expect(runtime.player.y).toBe(208);
    step(runtime, EMPTY_INPUT); expect(runtime.player.crouched).toBe(true);
    area.tiles.delete(11 * 64 + 2); step(runtime, EMPTY_INPUT); expect(runtime.player.crouched).toBe(false);
    step(runtime, { ...EMPTY_INPUT, down: { held: true, pressed: true, released: false } }); expect(runtime.player.crouched).toBe(true);
  });
  test("100 world coins grant one life, wrap counter, remove runtime tiles only", () => {
    const runtime = createRuntime(createMovementFixture()), events: GameEvent[] = [];
    for (let i = 0; i < 99; i++) collectCoin(runtime, `coin:${i}`, events);
    currentArea(runtime).tiles.set(12 * 64 + 2, { x: 2, y: 12, kind: "coin" }); step(runtime, EMPTY_INPUT);
    expect(runtime.progress).toEqual({ lives: 4, coins: 0, score: 20_000 }); expect(currentArea(runtime).tiles.has(12 * 64 + 2)).toBe(false);
    step(runtime, EMPTY_INPUT); expect(runtime.progress.score).toBe(20_000);
    expect(runtime.course.areas[0]?.tiles.some(tile => tile.kind === "coin")).toBe(false);
  });
  test("star/oneUp contacts and exact 600-tick star expiration", () => {
    const runtime = createRuntime(createMovementFixture()), events: GameEvent[] = [];
    for (const kind of ["star", "oneUp"] as const) {
      const actor = queueItem(runtime, kind, runtime.player.x, runtime.player.y, "unit"); actor.emerging = 0;
      commitItems(runtime, events); runtime.tick++; collectItems(runtime, events);
    }
    expect(runtime.progress).toEqual({ lives: 4, score: 1000, coins: 0 }); expect(runtime.combat.starTicks).toBe(600);
    expect(damagePlayer(runtime, { kind: "contact", sourceId: "goomba" }, events)).toBe("ignored");
    for (let i = 0; i < 599; i++) step(runtime, EMPTY_INPUT); expect(runtime.combat.starTicks).toBe(1);
    expect(step(runtime, EMPTY_INPUT).some(event => event.type === "starEnd")).toBe(true); expect(runtime.combat.starTicks).toBe(0);
    expect(step(runtime, EMPTY_INPUT).some(event => event.type === "starEnd")).toBe(false);
  });
  test("fire->super->small->defeated, 120 ticks immunity, one defeat, terminal life consumption deferred", () => {
    const runtime = createRuntime(createMovementFixture()), events: GameEvent[] = [], hit = { kind: "contact", sourceId: "enemy" } as const;
    runtime.player.form = "fire";
    expect(damagePlayer(runtime, hit, events)).toBe("shrunk"); expect(snapshot(runtime).player.form).toBe("super"); expect(runtime.combat.invulnerabilityTicks).toBe(120);
    for (let i = 0; i < 119; i++) step(runtime, EMPTY_INPUT);
    expect(damagePlayer(runtime, hit, events)).toBe("ignored");
    expect(step(runtime, EMPTY_INPUT).some(event => event.type === "invulnerabilityEnd")).toBe(true);
    expect(damagePlayer(runtime, hit, events)).toBe("shrunk"); expect(snapshot(runtime).player.form).toBe("small");
    for (let i = 0; i < 120; i++) step(runtime, EMPTY_INPUT);
    expect(damagePlayer(runtime, hit, events)).toBe("defeated"); expect(damagePlayer(runtime, hit, events)).toBe("ignored");
    expect(events.filter(event => event.type === "playerDefeated")).toHaveLength(1); expect(runtime.progress.lives).toBe(3);
    const crush = createRuntime(createMovementFixture()); crush.combat.starTicks = 600;
    expect(damagePlayer(crush, { kind: "crush", sourceId: "platform" }, [])).toBe("defeated");
  });
  test("central chain score sequence then lives, usable by later stomp/shell owners", () => {
    const runtime = createRuntime(createMovementFixture()), events: GameEvent[] = [];
    for (let i = 0; i < 10; i++) awardChain(runtime, i, events);
    expect(events.filter(event => event.type === "score").map(event => event.points)).toEqual([...SCORE.chain]);
    expect(runtime.progress.lives).toBe(5);
  });
  test("fire requires edge and fire form; max2, next-tick motion, facing, bounce and TTL", () => {
    const runtime = createRuntime(createMovementFixture()); const fire = { ...EMPTY_INPUT, run: { held: true, pressed: true, released: false } };
    step(runtime, fire); expect(runtime.items.actors).toHaveLength(0); runtime.player.form = "fire";
    step(runtime, fire); const actor = runtime.items.actors[0]; if (!actor) throw new Error("Fireball missing");
    expect(actor).toMatchObject({ age: 0, vx: 3, vy: -1 }); const x = actor.x, y = actor.y;
    step(runtime, { ...fire, run: { ...fire.run, pressed: false } });
    expect(actor.x).toBe(x + 3); expect(actor.y).toBeCloseTo(y - 0.8, 2); expect(runtime.items.actors).toHaveLength(1);
    step(runtime, fire); step(runtime, fire); expect(runtime.items.actors).toHaveLength(2);
    // Controlled terrain at exact contact; no wall-clock timing involved.
    actor.x = 120; actor.y = 208; actor.vy = 1; runtime.tick++; const events: GameEvent[] = []; updateItems(runtime, events);
    expect(actor.vy).toBe(-2.5); expect(events.some(event => event.type === "fireballBounce")).toBe(true);
    actor.age = 179; runtime.tick++; updateItems(runtime, events); expect(runtime.items.actors.some(item => item.id === actor.id)).toBe(false);
    expect(events.some(event => event.type === "itemDespawn" && event.reason === "expired")).toBe(true);
    runtime.items.actors = []; runtime.player.facing = -1; step(runtime, fire); expect(runtime.items.actors[0]?.vx).toBe(-3);
  });
  test("item wall reversal, projectile wall/embedded/outside removal and stable ordering", () => {
    const runtime = createRuntime(createMovementFixture()), events: GameEvent[] = [];
    const mushroom = queueItem(runtime, "mushroom", 440, 208, "block"); mushroom.emerging = 0; mushroom.vx = 3;
    const fire = queueItem(runtime, "fireball", 443, 200, "player"); commitItems(runtime, events); runtime.tick++;
    updateItems(runtime, events); expect(mushroom.vx).toBe(-3); expect(runtime.items.actors.some(item => item.id === fire.id)).toBe(false);
    expect(hasSolidOverlap(currentArea(runtime), itemBounds(mushroom))).toBe(false);
    const embedded = queueItem(runtime, "fireball", 452, 200, "player"); commitItems(runtime, events); runtime.tick++; updateItems(runtime, events);
    expect(runtime.items.actors.some(item => item.id === embedded.id)).toBe(false);
    const outside = queueItem(runtime, "fireball", 800, 20, "player"); commitItems(runtime, events); runtime.tick++; updateItems(runtime, events);
    expect(runtime.items.actors.some(item => item.id === outside.id)).toBe(false);
    const first = queueItem(runtime, "star", 40, 208, "a"), second = queueItem(runtime, "oneUp", 40, 208, "b"); first.emerging = second.emerging = 0;
    commitItems(runtime, events); runtime.items.actors.reverse(); runtime.tick++; collectItems(runtime, events);
    expect(events.filter(event => event.type === "itemCollect").map(event => event.id)).toEqual([first.id, second.id]);
  });
  test("vines grow six cells only where unobstructed, are not pickup/solid terrain", () => {
    const runtime = createRuntime(fixture("question", "vine")); hit(runtime); const vine = runtime.items.actors[0]; if (!vine) throw new Error("Vine missing");
    expect(vine).toMatchObject({ y: 160, height: 0, targetHeight: 96 });
    for (let i = 0; i < 95; i++) step(runtime, EMPTY_INPUT); expect(vine.height).toBe(95);
    expect(step(runtime, EMPTY_INPUT).some(event => event.type === "vineGrown")).toBe(true); expect(vine.height).toBe(96);
    const blocked = createRuntime(fixture("hidden", "vine")); currentArea(blocked).tiles.set(7 * 64 + 2, { x: 2, y: 7, kind: "hard" }); hit(blocked);
    expect(blocked.items.actors[0]?.targetHeight).toBe(32);
    const observation = snapshot(runtime); if (observation.items.actors[0]) observation.items.actors[0].height = 999; expect(vine.height).toBe(96);
  });
});
