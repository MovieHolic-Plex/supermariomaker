import { describe, expect, test } from "bun:test";
import { EMPTY_INPUT } from "../src/input";
import { createRuntime, snapshot } from "../src/game/state";
import { step } from "../src/game/step";
import { snapPosition } from "../src/game/physics";
import { queueItem, commitItems } from "../src/game/items";
import { playView } from "../src/ui/play-view";
import { SPAWN_ENEMY_CAP, SPAWN_PROJECTILE_CAP } from "../src/game/enemies-special";
import type { SpecialActor } from "../src/game/enemies-special";
import { firebarBalls } from "../src/game/hazards";
import type { HazardActor } from "../src/game/hazards";
import { createHazardFixture, HAZARD_IDS } from "./fixtures/hazards";

const idle = EMPTY_INPUT;
function ticks(runtime: ReturnType<typeof createRuntime>, count: number) {
  const events = [];
  for (let i = 0; i < count; i++) events.push(...step(runtime, idle));
  return events;
}
function special(runtime: ReturnType<typeof createRuntime>, id = HAZARD_IDS.piranha): SpecialActor {
  const actor = runtime.special.actors.get(id);
  expect(actor).toBeDefined();
  if (!actor) throw new Error(`Missing special ${id}`);
  return actor;
}
function hazard(runtime: ReturnType<typeof createRuntime>, id = HAZARD_IDS.bowser): HazardActor {
  const actor = runtime.hazards.actors.get(id);
  expect(actor).toBeDefined();
  if (!actor) throw new Error(`Missing hazard ${id}`);
  return actor;
}
function spawned(runtime: ReturnType<typeof createRuntime>, kind: SpecialActor["kind"] | HazardActor["kind"]) {
  return [...runtime.special.actors.values(), ...runtime.special.pending, ...runtime.hazards.actors.values(), ...runtime.hazards.pending]
    .filter(actor => actor.kind === kind);
}

describe("piranha phases and safe radius", () => {
  test("emerges and retracts on 90/60/90/60 and first updates after hide", () => {
    const runtime = createRuntime(createHazardFixture("piranha"));
    expect(runtime.seed).toBe(0x534d4231);
    const plant = special(runtime);
    expect(plant.kind).toBe("piranha");
    expect(plant.y).toBe(176);
    expect(ticks(runtime, 60).some(event => event.type === "piranha-emerge")).toBe(true);
    expect(special(runtime).y).toBe(176);
    ticks(runtime, 89);
    expect(special(runtime).y).toBeGreaterThan(160);
    expect(special(runtime).y).toBeLessThan(176);
    const emerged = ticks(runtime, 1);
    expect(special(runtime).y).toBe(160);
    expect(emerged.some(event => event.type === "piranha-out")).toBe(true);
    expect(ticks(runtime, 60).some(event => event.type === "piranha-retract")).toBe(true);
    ticks(runtime, 90);
    expect(special(runtime).y).toBe(176);
  });
  test("stays inside when the player is within 24px of the mouth", () => {
    const runtime = createRuntime(createHazardFixture("piranha"));
    Object.assign(runtime.player, { x: 192, y: 208 });
    const events = ticks(runtime, 180);
    expect(special(runtime).y).toBe(176);
    expect(events.some(event => event.type === "piranha-emerge")).toBe(false);
    expect(spawned(runtime, "piranha")).toHaveLength(1);
  });
});

describe("cannon and bullet bill", () => {
  test("fires toward the player every 180 ticks at speed 2, and the bullet first moves next tick", () => {
    const runtime = createRuntime(createHazardFixture("cannon"));
    const events = ticks(runtime, 180);
    const fire = events.find(event => event.type === "cannon-fire");
    expect(fire?.type).toBe("cannon-fire");
    if (fire?.type !== "cannon-fire") throw new Error("expected cannon-fire");
    const bills = spawned(runtime, "bulletBill");
    expect(bills).toHaveLength(1);
    const bill = bills[0];
    if (!bill || bill.kind !== "bulletBill") throw new Error("expected bill");
    expect(bill.id).toBe(fire.projectileId);
    expect(bill.vx).toBe(-2);
    expect(bill.x).toBe(160);
    expect(bill.bornTick).toBe(180);
    const x = bill.x;
    step(runtime, idle);
    expect(bill.x).toBe(snapPosition(x - 2));
  });
  test("does not fire while the player is within 32px", () => {
    const runtime = createRuntime(createHazardFixture("cannon"));
    Object.assign(runtime.player, { x: 160, y: 208 });
    const events = ticks(runtime, 180);
    expect(events.some(event => event.type === "cannon-fire")).toBe(false);
    expect(spawned(runtime, "bulletBill")).toHaveLength(0);
    expect(runtime.special.actors.get(HAZARD_IDS.cannon)?.kind).toBe("billCannon");
  });
  test("a descending player stomps a bullet once", () => {
    const runtime = createRuntime(createHazardFixture("cannon"));
    ticks(runtime, 180);
    const bill = spawned(runtime, "bulletBill")[0];
    if (!bill) throw new Error("expected bill");
    Object.assign(runtime.player, { x: bill.x, y: bill.y - 18, vy: 4, grounded: false });
    const events = step(runtime, idle);
    expect(events).toContainEqual({ type: "special-stomp", tick: 181, actorId: bill.id, chain: 1, result: "defeated" });
    expect(runtime.progress.score).toBe(100);
  });
});

describe("hammer bro", () => {
  test("throws every 60 ticks with vx ±1.8 vy -4.0 gravity 0.18, jumps every 180, and the hammer waits a tick", () => {
    const runtime = createRuntime(createHazardFixture("hammer"));
    const bro = special(runtime, HAZARD_IDS.hammerBro);
    expect(bro.kind).toBe("hammerBro");
    const origin = bro.x;
    const thrown = ticks(runtime, 60);
    expect(thrown.some(event => event.type === "hammer-throw")).toBe(true);
    const hammers = spawned(runtime, "hammer");
    expect(hammers).toHaveLength(1);
    const hammer = hammers[0];
    if (!hammer || hammer.kind !== "hammer") throw new Error("expected hammer");
    expect(Math.abs(hammer.vx)).toBe(1.8);
    expect(hammer.vy).toBe(-4);
    expect(hammer.bornTick).toBe(60);
    const x = hammer.x, y = hammer.y, vy = hammer.vy;
    step(runtime, idle);
    expect(hammer.vy).toBe(snapPosition(vy + 0.18));
    expect(hammer.x).toBe(snapPosition(x + hammer.vx));
    expect(hammer.y).not.toBe(y);
    ticks(runtime, 119);
    expect(special(runtime, HAZARD_IDS.hammerBro).vy).toBeLessThan(0);
    expect(Math.abs(special(runtime, HAZARD_IDS.hammerBro).x - origin)).toBeLessThanOrEqual(16);
  });
});

describe("lakitu and spiny", () => {
  test("tracks 64px above the player and drops a seeded egg every 180 ticks that hatches on landing", () => {
    const runtime = createRuntime(createHazardFixture("lakitu"));
    Object.assign(runtime.player, { x: 80, y: 208, grounded: true });
    ticks(runtime, 8);
    const cloud = special(runtime, HAZARD_IDS.lakitu);
    expect(cloud.y).toBe(snapPosition(208 - 64));
    expect(Math.abs(cloud.x - 80)).toBeLessThan(80);
    const drop = ticks(runtime, 172);
    expect(drop.some(event => event.type === "lakitu-drop")).toBe(true);
    const eggs = spawned(runtime, "spinyEgg");
    expect(eggs).toHaveLength(1);
    const egg = eggs[0];
    if (!egg || egg.kind !== "spinyEgg") throw new Error("expected egg");
    expect([-0.6, 0.6]).toContain(egg.vx);
    expect(egg.bornTick).toBe(180);
    const again = createRuntime(createHazardFixture("lakitu"));
    Object.assign(again.player, { x: 80, y: 208, grounded: true });
    ticks(again, 180);
    const twin = spawned(again, "spinyEgg")[0];
    expect(twin?.id).toBe(egg.id);
    expect(twin && twin.kind === "spinyEgg" ? twin.vx : null).toBe(egg.vx);
    Object.assign(runtime.player, { x: 16, y: 208, vx: 0, vy: 0, grounded: true });
    let hatch = null;
    for (let i = 0; i < 90; i++) {
      const events = step(runtime, idle);
      const found = events.find(event => event.type === "spiny-hatch");
      if (found) { hatch = found; break; }
    }
    expect(hatch?.type).toBe("spiny-hatch");
    expect(spawned(runtime, "spiny")).toHaveLength(1);
    expect(spawned(runtime, "spinyEgg")).toHaveLength(0);
  });
  test("spiny contact damages and does not stomp", () => {
    const runtime = createRuntime(createHazardFixture("lakitu"));
    ticks(runtime, 180);
    const egg = spawned(runtime, "spinyEgg")[0];
    if (!egg) throw new Error("expected egg");
    runtime.special.actors.set(egg.id, { ...egg, kind: "spiny", y: 208, vy: 0, grounded: true, vx: -0.6 });
    Object.assign(runtime.player, { x: egg.x, y: 194, vy: 4, grounded: false });
    const events = step(runtime, idle);
    expect(events.some(event => event.type === "special-stomp")).toBe(false);
    expect(events.some(event => event.type === "special-damage" && event.actorId === egg.id)).toBe(true);
    expect(runtime.combat.defeated).toBe(true);
  });
});

describe("podoboo and firebar", () => {
  test("podoboo launches every 180 ticks at vy -5.6 with gravity 0.20 and waits a tick to move", () => {
    const runtime = createRuntime(createHazardFixture("podoboo"));
    const lava = hazard(runtime, HAZARD_IDS.podoboo);
    expect(lava.y).toBe(240);
    const launch = ticks(runtime, 180);
    expect(launch.some(event => event.type === "podoboo-launch")).toBe(true);
    expect(hazard(runtime, HAZARD_IDS.podoboo).vy).toBe(-5.6);
    const y = hazard(runtime, HAZARD_IDS.podoboo).y;
    step(runtime, idle);
    expect(hazard(runtime, HAZARD_IDS.podoboo).y).toBe(snapPosition(y - 5.6 + 0.2));
  });
  test("firebar rotates at 0.02 rad/tick and contact damages rather than stomps", () => {
    const runtime = createRuntime(createHazardFixture("firebar"));
    const bar = hazard(runtime, HAZARD_IDS.firebar);
    expect(bar.kind).toBe("firebar");
    if (bar.kind !== "firebar") throw new Error("expected firebar");
    expect(bar.angle).toBe(0);
    step(runtime, idle);
    const spun = hazard(runtime, HAZARD_IDS.firebar);
    expect(spun.kind).toBe("firebar");
    if (spun.kind !== "firebar") throw new Error("expected firebar");
    expect(spun.angle).toBe(0.02);
    const balls = firebarBalls(spun);
    expect(balls).toHaveLength(6);
    const first = balls[1];
    if (!first) throw new Error("expected ball");
    Object.assign(runtime.player, { x: first.x, y: first.y + 8, vy: 4, grounded: false });
    const events = step(runtime, idle);
    expect(events.some(event => event.type === "special-stomp")).toBe(false);
    expect(events.some(event => event.type === "hazard-damage" && event.actorId === HAZARD_IDS.firebar)).toBe(true);
    expect(runtime.combat.defeated).toBe(true);
  });
});

describe("bowser combat", () => {
  test("five fireball hits defeat bowser without clearing, and a sixth never acts on the corpse", () => {
    const runtime = createRuntime(createHazardFixture("bowser"));
    runtime.player.form = "fire";
    Object.assign(runtime.player, { x: 40, y: 208, facing: 1 as const });
    const king = hazard(runtime, HAZARD_IDS.bowser);
    expect(king.kind).toBe("bowser");
    for (let hit = 1; hit <= 5; hit++) {
      const shot = queueItem(runtime, "fireball", king.x - 16, king.y - 8, "player");
      shot.emerging = 0; commitItems(runtime, []);
      Object.assign(shot, { x: king.x - 10, y: king.y - 16, vx: 3, vy: 0, age: 1, bornTick: 0 });
      const events = step(runtime, idle);
      expect(events.some(event => event.type === "bowser-hit" && event.hits === hit)).toBe(true);
      if (hit < 5) expect(events.some(event => event.type === "bowser-defeated")).toBe(false);
      else {
        expect(events.some(event => event.type === "bowser-defeated" && event.actorId === HAZARD_IDS.bowser)).toBe(true);
        expect(runtime.combat.defeated).toBe(false);
        expect(events.some(event => event.type === "score" && event.reason === "goal")).toBe(false);
      }
    }
    const corpse = hazard(runtime, HAZARD_IDS.bowser);
    expect(corpse.kind).toBe("defeated");
    const extra = queueItem(runtime, "fireball", corpse.x, corpse.y - 16, "player");
    extra.emerging = 0; commitItems(runtime, []);
    Object.assign(extra, { x: corpse.x, y: corpse.y - 16, vx: 3, vy: 0, age: 1, bornTick: 0 });
    expect(step(runtime, idle).some(event => event.type === "bowser-hit")).toBe(false);
  });
  test("contact with live bowser damages the player", () => {
    const runtime = createRuntime(createHazardFixture("bowser"));
    const king = hazard(runtime, HAZARD_IDS.bowser);
    Object.assign(runtime.player, { x: king.x, y: king.y, vy: 0, grounded: true });
    const events = step(runtime, idle);
    expect(events.some(event => event.type === "hazard-damage" && event.actorId === HAZARD_IDS.bowser)).toBe(true);
    expect(runtime.combat.defeated).toBe(true);
  });
});

describe("spawn caps, next-tick, presentation", () => {
  test("enemy cap 128 skips a new spawn, keeps the placed lakitu, and flags overload", () => {
    const runtime = createRuntime(createHazardFixture("lakitu"));
    for (let i = 0; i < SPAWN_ENEMY_CAP; i++) {
      runtime.special.actors.set(`fill-${String(i).padStart(4, "0")}`, {
        id: `fill-${String(i).padStart(4, "0")}`, areaId: runtime.areaId, kind: "spiny",
        x: 900, y: 208, vx: 0, vy: 0, facing: -1, active: true, bornTick: 0, grounded: true, originX: 900, originY: 208, sourceId: "fill",
      });
    }
    const events = ticks(runtime, 180);
    expect(events.some(event => event.type === "spawn-overload" && event.kind === "enemy")).toBe(true);
    expect(spawned(runtime, "spinyEgg")).toHaveLength(0);
    expect(special(runtime, HAZARD_IDS.lakitu).kind).toBe("lakitu");
    expect(runtime.special.overloadedEnemies).toBe(true);
    expect(playView(runtime).overload.enemies).toBe(true);
  });
  test("projectile cap 128 skips a hammer and keeps the hammer bro", () => {
    const runtime = createRuntime(createHazardFixture("hammer"));
    for (let i = 0; i < SPAWN_PROJECTILE_CAP; i++) {
      runtime.special.actors.set(`proj-${String(i).padStart(4, "0")}`, {
        id: `proj-${String(i).padStart(4, "0")}`, areaId: runtime.areaId, kind: "hammer",
        x: 16, y: 100, vx: 1.8, vy: -4, facing: 1, active: true, bornTick: 0, grounded: false, originX: 16, originY: 100, sourceId: "fill",
      });
    }
    const events = ticks(runtime, 60);
    expect(events.some(event => event.type === "spawn-overload" && event.kind === "projectile")).toBe(true);
    expect(spawned(runtime, "hammer").filter(actor => actor.sourceId === HAZARD_IDS.hammerBro)).toHaveLength(0);
    expect(special(runtime, HAZARD_IDS.hammerBro).kind).toBe("hammerBro");
    expect(runtime.special.overloadedProjectiles).toBe(true);
  });
  test("snapshots detach, seed is the runtime constant, and playView draws live piranha not the authored cell", () => {
    const course = createHazardFixture("piranha"), runtime = createRuntime(course), initial = snapshot(runtime);
    expect(initial.seed).toBe(0x534d4231);
    ticks(runtime, 150);
    initial.special.actors.length = 0;
    expect(runtime.special.actors.size).toBe(1);
    expect(playView(runtime).special.some(sprite => sprite.id === HAZARD_IDS.piranha && sprite.key.startsWith("enemy.piranha"))).toBe(true);
    expect(snapshot(createRuntime(course)).tick).toBe(0);
  });
});
