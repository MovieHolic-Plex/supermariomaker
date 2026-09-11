import { describe, expect, test } from "bun:test";
import { createRuntime, currentArea, snapshot } from "../src/game/state";
import { queueItem, commitItems } from "../src/game/items";
import type { PlayerState } from "../src/game/state";
import { createGroundState, groundBounds, moveGroundEnemies, resolveGroundContacts } from "../src/game/enemies-ground";
import type { GroundActor, GroundCombat, GroundEvent } from "../src/game/enemies-ground";
import { advanceShell, createShellState, kickShell, kickerProtected, shellWiggling, stopShell } from "../src/game/shells";
import { createGroundEnemyFixture, GROUND_IDS } from "./fixtures/enemies-ground";
import { fixtureId } from "./fixtures/factory";
import { snapPosition } from "../src/game/physics";
import { step } from "../src/game/step";
import { EMPTY_INPUT } from "../src/input";
import { playView } from "../src/ui/play-view";

const view = { x: 0, y: 0, width: 1024, height: 240 };
test("live step applies a descending Koopa stomp and the central first-chain award exactly once", () => {
  const runtime = createRuntime(createGroundEnemyFixture());
  Object.assign(runtime.player, { x: 128, y: 189, vy: 4, grounded: false });
  const events = step(runtime, EMPTY_INPUT);
  expect(events).toContainEqual({ type: "ground-stomp", tick: 1, actorId: GROUND_IDS.koopa, chain: 1, result: "shelled" });
  expect(runtime.progress.score).toBe(100);
  expect(events.filter(event => event.type === "score")).toEqual([{ type: "score", tick: 1, reason: "chain", points: 100, total: 100 }]);
  expect(runtime.player.y).toBe(192);
  expect(runtime.player.vy).toBe(-3.4);
});
function setup(kind: "combat" | "ledge" | "wings" = "combat") {
  const course = createGroundEnemyFixture(kind), runtime = createRuntime(course), state = runtime.ground;
  const actor = (id = GROUND_IDS.koopa): GroundActor => {
    const found = state.actors.get(id);
    expect(found).toBeDefined();
    if (!found) throw new Error(`Missing actor ${id}`);
    return found;
  };
  function tick(combat: Partial<GroundCombat> = {}, viewport = view): GroundEvent[] {
    const previousPlayer = { ...runtime.player };
    runtime.tick++;
    return resolveGroundContacts(runtime, state, moveGroundEnemies(runtime, state, viewport), { previousPlayer, ...combat });
  }
  function stomp(id = GROUND_IDS.koopa, jumpHeld = false): GroundEvent[] {
    const target = actor(id);
    const previousPlayer: PlayerState = { ...runtime.player, x: target.x, y: target.y - 18, vy: 4, grounded: false };
    Object.assign(runtime.player, previousPlayer, { y: target.y - 14 });
    return tick({ previousPlayer, jumpHeld });
  }
  function kick(id = GROUND_IDS.koopa): GroundEvent[] {
    const target = actor(id);
    Object.assign(runtime.player, { x: target.x - 12, y: target.y, vy: 0, grounded: true });
    return tick();
  }
  const park = () => Object.assign(runtime.player, { x: 40, y: 208, vy: 0, grounded: true });
  return { course, runtime, state, actor, tick, stomp, kick, park };
}

describe("live runtime integration", () => {
  test("shell motion, two victim scores and chain life use the existing progression owner", () => {
    const s = setup();
    Object.assign(s.runtime.player, { x: 128, y: 189, vy: 4, grounded: false });
    step(s.runtime, EMPTY_INPUT);
    const x = s.actor().x;
    Object.assign(s.runtime.player, { x: x - 13, y: 208, vy: 0 });
    expect(step(s.runtime, EMPTY_INPUT).some(event => event.type === "shell-kicked")).toBe(true);
    expect(s.actor().x).toBe(x);
    s.park();
    const scores = [];
    for (let tick = 0; tick < 30; tick++) scores.push(...step(s.runtime, EMPTY_INPUT).filter(event => event.type === "score"));
    expect(scores.map(event => event.points)).toEqual([100, 200]);
    expect(s.runtime.progress.score).toBe(400);
    expect(s.actor(GROUND_IDS.buzzy).kind).toBe("defeated");
    const shell = s.actor(); if (shell.kind !== "shell") throw new Error("Expected live shell");
    shell.shell.chain = 8;
    s.state.actors.set(GROUND_IDS.goomba, { ...shell, id: GROUND_IDS.goomba, kind: "goomba", x: shell.x + 17 });
    expect(step(s.runtime, EMPTY_INPUT)).toContainEqual({ type: "oneUp", tick: s.runtime.tick, reason: "chain", lives: 4 });
    expect(s.runtime.progress.score).toBe(400);
  });
  test.each(["small", "super", "fire"] as const)("contact damage wins over simultaneous flower pickup for %s", form => {
    const s = setup();
    Object.assign(s.runtime.player, { x: 181, y: 208, form });
    const flower = queueItem(s.runtime, "flower", 181, 208, "fixture"); flower.emerging = 0; commitItems(s.runtime, []);
    const events = step(s.runtime, EMPTY_INPUT);
    expect(events.some(event => event.type === "ground-damage")).toBe(true);
    expect(events.some(event => event.type === "itemCollect")).toBe(false);
    expect(s.runtime.player.form).toBe(form === "fire" ? "super" : "small");
    expect(s.runtime.combat.defeated).toBe(form === "small");
    if (form === "small") {
      const before = snapshot(s.runtime);
      expect(step(s.runtime, { ...EMPTY_INPUT, jump: { held: true, pressed: true, released: false } })).toEqual([]);
      expect(snapshot(s.runtime)).toEqual(before);
    } else expect(s.runtime.combat.invulnerabilityTicks).toBe(120);
  });
  test("existing real fireball is consumed by Buzzy once without score; newborn fireballs wait", () => {
    const s = setup(); s.runtime.player.form = "fire";
    Object.assign(s.runtime.player, { x: 224, facing: 1 });
    const shot = step(s.runtime, { ...EMPTY_INPUT, run: { held: true, pressed: true, released: false } });
    expect(shot.some(event => event.type === "ground-fireball-contact")).toBe(false);
    const fireball = s.runtime.items.actors[0]; if (!fireball) throw new Error("Expected player fireball");
    expect(fireball.age).toBe(0);
    s.park();
    // Legitimate projectile-owner boundary supplies a low, terrain-clear shot to the live step.
    Object.assign(fireball, { x: 243, y: 201, vy: 0 });
    const hit = step(s.runtime, EMPTY_INPUT);
    expect(hit.filter(event => event.type === "ground-fireball-contact")).toEqual([
      { type: "ground-fireball-contact", tick: 2, actorId: GROUND_IDS.buzzy, fireballId: fireball.id, immune: true },
    ]);
    expect(hit.filter(event => event.type === "itemDespawn")).toEqual([{ type: "itemDespawn", tick: 2, id: fireball.id, reason: "combat" }]);
    expect(s.actor(GROUND_IDS.buzzy).kind).toBe("buzzy"); expect(s.runtime.progress.score).toBe(0);
    expect(s.runtime.items.actors).toEqual([]);
  });
  test("live activation preserves suspended phase, snapshots detach, restart restores source", () => {
    const s = setup("wings"), original = structuredClone(s.course), initial = snapshot(s.runtime);
    const before = snapshot(s.runtime);
    step(s.runtime, EMPTY_INPUT);
    const hop = s.actor(GROUND_IDS.hop); expect(hop.y).toBeLessThan(208);
    expect(before).toEqual(initial);
    const saved = structuredClone(hop);
    s.runtime.player.x = 900; step(s.runtime, EMPTY_INPUT);
    expect(hop.active).toBe(false); expect(hop.y).toBe(saved.y);
    s.runtime.player.x = 40; step(s.runtime, EMPTY_INPUT);
    expect(hop.active).toBe(true); expect(hop.y).not.toBe(saved.y);
    before.ground.actors.length = 0;
    expect(s.runtime.ground.actors.size).toBe(2);
    expect(snapshot(createRuntime(s.course))).toEqual(initial);
    expect(s.course).toEqual(original); expect(s.runtime.course).toEqual(original);
  });
  test("live form presentation follows wings, shell warning, wake and squashed Goomba", () => {
    const s = setup("wings");
    expect(playView(s.runtime).ground.map(actor => actor.key)).toEqual(["enemy.koopa.green.wings1", "enemy.koopa.red.wings1"]);
    const combat = setup(); combat.stomp(); combat.park();
    const shell = combat.actor(); if (shell.kind !== "shell") throw new Error("Expected shell");
    shell.shell.idleTicks = 479; step(combat.runtime, EMPTY_INPUT);
    expect(playView(combat.runtime).ground.find(actor => actor.id === shell.id)?.wiggling).toBe(true);
    shell.shell.idleTicks = 599; step(combat.runtime, EMPTY_INPUT);
    expect(playView(combat.runtime).ground.find(actor => actor.id === shell.id)?.key).toMatch(/^enemy.koopa.green.walk/);
    combat.stomp(GROUND_IDS.goomba);
    expect(playView(combat.runtime).ground.find(actor => actor.id === GROUND_IDS.goomba)?.key).toBe("enemy.goomba.squashed");
  });
});

describe("shell clock and kick contract", () => {
  test("600 idle updates, exactly the final 120 warning ticks, no moving-shell wake", () => {
    const shell = createShellState("redKoopa");
    expect(shell.idleTicks).toBe(0);
    for (let age = 1; age <= 600; age++) {
      expect(advanceShell(shell)).toBe(age === 600);
      expect(shellWiggling(shell)).toBe(age >= 480 && age < 600);
    }
    kickShell(shell, 700);
    for (let i = 0; i < 700; i++) expect(advanceShell(shell)).toBe(false);
    expect(shell.idleTicks).toBe(0);
    shell.chain = 9;
    stopShell(shell);
    expect(shell).toEqual({ occupant: "redKoopa", moving: false, idleTicks: 0, kickedAtTick: null, chain: 0 });
  });
  test("protection covers kick tick through +7, never +8 or a stopped shell", () => {
    const shell = createShellState("greenKoopa");
    kickShell(shell, 50);
    for (let tick = 50; tick < 58; tick++) expect(kickerProtected(shell, tick)).toBe(true);
    expect(kickerProtected(shell, 58)).toBe(false);
    stopShell(shell);
    expect(kickerProtected(shell, 51)).toBe(false);
  });
});

describe("ground actors", () => {
  test("creates stable IDs from the runtime copy; patrol quantization and terrain wall reversal", () => {
    const s = setup(), before = structuredClone(s.course);
    expect([...s.state.actors.keys()]).toEqual(Object.values(GROUND_IDS).slice(0, 3));
    const initial = s.actor().x;
    s.tick();
    expect(s.actor().vx).toBe(-0.6);
    expect(s.actor().x).toBe(snapPosition(initial - 0.6));
    expect(s.actor().y).toBe(208);
    // A live runtime hard wall immediately to the left; use the actual shared terrain query.
    const area = currentArea(s.runtime);
    area.tiles.set(12 * area.source.width + 6, { x: 6, y: 12, kind: "hard" });
    s.actor().x = 120;
    s.tick();
    expect(s.actor().x).toBe(120);
    expect(s.actor().facing).toBe(1);
    s.tick(); expect(s.actor().x).toBe(snapPosition(120.6));
    expect(s.course).toEqual(before);
    expect(s.runtime.course).toEqual(before);
  });
  test("red tests its leading next foot, not center or trailing support; green falls", () => {
    const s = setup("ledge");
    for (let i = 0; i < 14; i++) s.tick();
    expect(s.actor(GROUND_IDS.red).facing).toBe(1);
    expect(s.actor(GROUND_IDS.red).x).toBeGreaterThanOrEqual(264);
    expect(s.actor(GROUND_IDS.green).facing).toBe(-1);
    for (let i = 0; i < 30; i++) s.tick();
    expect(s.actor(GROUND_IDS.green).y).toBeGreaterThan(208);
    expect(s.actor(GROUND_IDS.red).y).toBe(208);
  });
  test("hidden and coin cells are not red ledge support; changed runtime terrain is authoritative", () => {
    for (const kind of ["hidden", "coin"] as const) {
      const s = setup("ledge"), area = currentArea(s.runtime);
      s.actor(GROUND_IDS.red).x = 264;
      area.tiles.set(13 * area.source.width + 15, { x: 15, y: 13, kind });
      s.tick();
      expect(s.actor(GROUND_IDS.red).facing).toBe(1);
    }
  });
  test("Goomba stomp defeats, side and rising contact request damage, invulnerability suppresses only damage", () => {
    const stomp = setup();
    expect(stomp.stomp(GROUND_IDS.goomba)).toContainEqual({ type: "ground-stomp", tick: 1, actorId: GROUND_IDS.goomba, chain: 1, result: "defeated" });
    expect(stomp.actor(GROUND_IDS.goomba).kind).toBe("defeated");
    expect(stomp.runtime.player.vy).toBe(-3.4);
    for (const vy of [0, -4]) {
      const side = setup();
      Object.assign(side.runtime.player, { x: 181, y: 208, vy });
      expect(side.tick()).toContainEqual({ type: "ground-damage", tick: 1, actorId: GROUND_IDS.goomba });
      expect(side.actor(GROUND_IDS.goomba).kind).toBe("goomba");
      expect(side.tick({ invulnerable: true }).some(event => event.type === "ground-damage")).toBe(false);
    }
  });
  test("Koopa and Buzzy stomps make stationary shells, preserve identity, do not kick or move twice", () => {
    for (const id of [GROUND_IDS.koopa, GROUND_IDS.buzzy]) {
      const s = setup(), x = s.actor(id).x;
      const events = s.stomp(id, true), actor = s.actor(id);
      expect(events.filter(event => event.type === "ground-stomp")).toHaveLength(1);
      expect(events.some(event => event.type === "shell-kicked")).toBe(false);
      expect(actor.kind).toBe("shell");
      expect(actor.x).toBe(snapPosition(x - 0.6));
      if (actor.kind !== "shell") throw new Error("Expected shell");
      expect(actor.shell.moving).toBe(false);
      expect(actor.shell.idleTicks).toBe(0);
      expect(actor.shell.occupant).toBe(id === GROUND_IDS.buzzy ? "buzzy" : "greenKoopa");
      expect(s.runtime.player.vy).toBe(-5);
    }
  });
  test("hop and vertical motion respect props; wings removal becomes a Koopa only, then a shell on a later stomp", () => {
    const s = setup("wings"), hop = s.actor(GROUND_IDS.hop), vertical = s.actor(GROUND_IDS.vertical);
    s.tick();
    expect(hop.y).toBeLessThan(208);
    expect(hop.vx).toBe(-0.6);
    expect(vertical.x).toBe(256);
    expect(vertical.y).toBeLessThan(144);
    for (let i = 1; i < 120; i++) s.tick();
    expect(vertical.y).toBe(144);
    const events = s.stomp(GROUND_IDS.vertical);
    expect(events.some(event => event.type === "ground-stomp" && event.result === "wings-removed")).toBe(true);
    expect(s.actor(GROUND_IDS.vertical).kind).toBe("koopa");
    expect(s.actor(GROUND_IDS.vertical).vx).toBe(0);
    s.stomp(GROUND_IDS.vertical);
    expect(s.actor(GROUND_IDS.vertical).kind).toBe("shell");
  });
  test("kick starts next motion at 4, protects kicker for 8 ticks, then damages; stomp stops and resets chain", () => {
    const s = setup(); s.stomp();
    const x = s.actor().x, events = s.kick(), kickedAt = s.runtime.tick;
    expect(events).toContainEqual({ type: "shell-kicked", tick: kickedAt, actorId: GROUND_IDS.koopa, direction: 1 });
    expect(s.actor().x).toBe(x);
    for (let age = 1; age <= 8; age++) {
      Object.assign(s.runtime.player, { x: s.actor().x + 4, y: 208, vy: 0 });
      const contact = s.tick();
      expect(s.actor().x).toBe(x + age * 4);
      expect(contact.some(event => event.type === "ground-damage")).toBe(age === 8);
    }
    const stopped = s.stomp();
    expect(stopped.some(event => event.type === "ground-stomp" && event.result === "shell-stopped")).toBe(true);
    const shell = s.actor();
    if (shell.kind !== "shell") throw new Error("Expected shell");
    expect(shell.shell.moving).toBe(false); expect(shell.shell.chain).toBe(0);
    expect(shell.shell.idleTicks).toBe(0);
  });
  test("shell chains kill Goomba and fire-immune Buzzy with semantic indices, not a second score table", () => {
    const s = setup(); s.stomp(); s.kick(); s.park();
    const events: GroundEvent[] = [];
    for (let i = 0; i < 30; i++) events.push(...s.tick());
    const defeats = events.filter(event => event.type === "ground-defeated");
    expect(defeats.map(event => [event.actorId, event.by, event.chain])).toEqual([
      [GROUND_IDS.goomba, "shell", 1], [GROUND_IDS.buzzy, "shell", 2],
    ]);
    expect(s.actor(GROUND_IDS.goomba).kind).toBe("defeated");
    expect(s.actor(GROUND_IDS.buzzy).kind).toBe("defeated");
  });
  test("fireballs sweep to the nearest target once, consume on Buzzy immunity, star kills Buzzy and moving shells", () => {
    const s = setup();
    const events = s.tick({ fireballs: [{ id: "fire:1", previous: { x: 160, y: 195, width: 8, height: 8 }, bounds: { x: 300, y: 195, width: 8, height: 8 } }] });
    expect(events.filter(event => event.type === "ground-fireball-contact")).toEqual([
      { type: "ground-fireball-contact", tick: 1, actorId: GROUND_IDS.goomba, fireballId: "fire:1", immune: false },
    ]);
    const buzzyBounds = groundBounds(s.actor(GROUND_IDS.buzzy));
    expect(s.tick({ fireballs: [{ id: "fire:2", previous: buzzyBounds, bounds: buzzyBounds }] })).toContainEqual(
      { type: "ground-fireball-contact", tick: 2, actorId: GROUND_IDS.buzzy, fireballId: "fire:2", immune: true });
    expect(s.actor(GROUND_IDS.buzzy).kind).toBe("buzzy");
    Object.assign(s.runtime.player, { x: s.actor(GROUND_IDS.buzzy).x, y: 208 });
    expect(s.tick({ starActive: true }).some(event => event.type === "ground-defeated" && event.by === "star")).toBe(true);
    expect(s.actor(GROUND_IDS.buzzy).kind).toBe("defeated");
    s.stomp(); s.kick();
    Object.assign(s.runtime.player, { x: s.actor().x + 4, y: 208 });
    expect(s.tick({ starActive: true }).some(event => event.type === "ground-defeated" && event.by === "star")).toBe(true);
    expect(s.actor().kind).toBe("defeated");
  });
  test("Buzzy shell stays fire immune; shell wake at 600 does not patrol until next tick", () => {
    const s = setup(); s.stomp(GROUND_IDS.buzzy); s.park();
    const bounds = groundBounds(s.actor(GROUND_IDS.buzzy));
    s.tick({ fireballs: [{ id: "fire:buzzy", previous: bounds, bounds }] });
    expect(s.actor(GROUND_IDS.buzzy).kind).toBe("shell");
    for (let i = 1; i < 599; i++) s.tick();
    const shell = s.actor(GROUND_IDS.buzzy), x = shell.x;
    if (shell.kind !== "shell") throw new Error("Expected shell");
    expect(shell.shell.idleTicks).toBe(599); expect(shellWiggling(shell.shell)).toBe(true);
    expect(s.tick()).toContainEqual({ type: "shell-woke", tick: 601, actorId: GROUND_IDS.buzzy });
    expect(s.actor(GROUND_IDS.buzzy).kind).toBe("buzzy");
    expect(s.actor(GROUND_IDS.buzzy).x).toBe(x);
    s.tick(); expect(s.actor(GROUND_IDS.buzzy).x).toBe(snapPosition(x - 0.6));
  });
  test("airborne stomp chains increment across targets and reset on real grounded contact", () => {
    const s = setup();
    expect(s.stomp().find(event => event.type === "ground-stomp")?.chain).toBe(1);
    expect(s.stomp(GROUND_IDS.goomba).find(event => event.type === "ground-stomp")?.chain).toBe(2);
    s.park(); s.tick();
    expect(s.stomp(GROUND_IDS.buzzy).find(event => event.type === "ground-stomp")?.chain).toBe(1);
  });
  test("suspended actors preserve shell age and resume with activation hysteresis; inactive areas never contact", () => {
    const s = setup(); s.stomp(); s.park();
    const shell = s.actor();
    if (shell.kind !== "shell") throw new Error("Expected shell");
    s.tick({}, { x: 600, y: 0, width: 256, height: 240 });
    expect(shell.active).toBe(false); expect(shell.shell.idleTicks).toBe(0);
    s.tick({}, { x: 200, y: 0, width: 256, height: 240 });
    expect(shell.active).toBe(false);
    s.tick({}, { x: 190, y: 0, width: 256, height: 240 });
    expect(shell.active).toBe(true); expect(shell.shell.idleTicks).toBe(1);
    s.tick({}, { x: 250, y: 0, width: 256, height: 240 });
    expect(shell.active).toBe(true); expect(shell.shell.idleTicks).toBe(2);
    const other = { ...s.actor(GROUND_IDS.goomba), id: fixtureId(899), areaId: fixtureId(99), x: 40 };
    s.state.actors.set(other.id, other);
    expect(s.tick().some(event => "actorId" in event && event.actorId === other.id)).toBe(false);
  });
  test("real step gravity turnaround crosses Goomba top downward despite previous negative velocity", () => {
    const s = setup();
    Object.assign(s.runtime.player, { x: 192, y: 191.8984375, vy: -0.1, grounded: false });
    const previousPlayer = { ...s.runtime.player };
    // An enemy-free control characterizes raw movement; the actual runtime resolves exactly once.
    const control = createRuntime({ ...s.course, areas: s.course.areas.map(area => ({ ...area, objects: [] })) });
    Object.assign(control.player, previousPlayer);
    step(control, EMPTY_INPUT);
    const events = step(s.runtime, EMPTY_INPUT).filter(event => event.type.startsWith("ground-"));
    expect(previousPlayer.y).toBe(191.8984375);
    expect(previousPlayer.vy).toBe(-0.1);
    expect(control.player.y).toBe(192.21875);
    expect(control.player.vy).toBeCloseTo(0.32, 12);
    expect(events).toEqual([{ type: "ground-stomp", tick: 1, actorId: GROUND_IDS.goomba, chain: 1, result: "defeated" }]);
    expect(s.actor(GROUND_IDS.goomba).kind).toBe("defeated");
    expect(s.runtime.player.y).toBe(192);
    expect(s.runtime.player.vy).toBe(-3.4);
    expect(s.runtime.player.grounded).toBe(false);
  });
  test.each([
    { name: "rising underside", enemyY: 160, enemyVy: 0, playerY: 177, playerVy: -4, result: "ground-damage" },
    { name: "rising player met by faster rising actor", enemyY: 208, enemyVy: -3.4, playerY: 191, playerVy: -1, result: "ground-damage" },
    { name: "descending player meets rising actor", enemyY: 208, enemyVy: -3.4, playerY: 191, playerVy: 0.1, result: "ground-stomp" },
    { name: "descending actor escapes slower descending player", enemyY: 176, enemyVy: 2, playerY: 159.8984375, playerVy: 0.1, result: null },
  ])("real resolved relative contact: $name", ({ enemyY, enemyVy, playerY, playerVy, result }) => {
    const s = setup(), enemy = s.actor(GROUND_IDS.goomba);
    Object.assign(enemy, { y: enemyY, vy: enemyVy, grounded: false });
    Object.assign(s.runtime.player, { x: 192, y: playerY, vy: playerVy, grounded: false });
    const events = step(s.runtime, EMPTY_INPUT).filter(event => event.type.startsWith("ground-"));
    if (result === null) { expect(enemy.y).toBeGreaterThan(enemyY); expect(s.runtime.player.y).toBeGreaterThan(playerY); }
    expect(events.map(event => event.type)).toEqual(result ? [result] : []);
    expect(s.actor(GROUND_IDS.goomba).kind).toBe(result === "ground-stomp" ? "defeated" : "goomba");
  });
  test("real horizontal side crossing remains damage, not a stomp", () => {
    const s = setup();
    Object.assign(s.runtime.player, { x: 177, y: 208, vx: 2, vy: 0 });
    const events = step(s.runtime, EMPTY_INPUT).filter(event => event.type.startsWith("ground-"));
    expect(events).toEqual([{ type: "ground-damage", tick: 1, actorId: GROUND_IDS.goomba }]);
    expect(s.actor(GROUND_IDS.goomba).kind).toBe("goomba");
  });
  test("fire immunity consumes the projectile before later targets; fire defeat precedes player damage", () => {
    const s = setup();
    s.actor(GROUND_IDS.buzzy).x = 176;
    const events = s.tick({ fireballs: [{ id: "fire:immune-first", previous: { x: 160, y: 194, width: 8, height: 8 }, bounds: { x: 220, y: 194, width: 8, height: 8 } }] });
    expect(events).toEqual([{ type: "ground-fireball-contact", tick: 1, actorId: GROUND_IDS.buzzy, fireballId: "fire:immune-first", immune: true }]);
    expect(s.actor(GROUND_IDS.goomba).kind).toBe("goomba");
    Object.assign(s.runtime.player, { x: s.actor(GROUND_IDS.goomba).x, y: 208 });
    const bounds = groundBounds(s.actor(GROUND_IDS.goomba));
    const defeated = s.tick({ fireballs: [{ id: "fire:before-player", previous: bounds, bounds }] });
    expect(defeated.map(event => event.type)).toEqual(["ground-fireball-contact", "ground-defeated"]);
    expect(s.actor(GROUND_IDS.goomba).kind).toBe("defeated");
  });
  test("caller-owned ground states, runtime terrain and saved frame bounds remain isolated", () => {
    const s = setup(), authored = structuredClone(s.course);
    const otherRuntime = createRuntime(s.course), other = createGroundState(otherRuntime), sameRuntime = createGroundState(s.runtime);
    const otherBefore = structuredClone(other), sameBefore = structuredClone(sameRuntime);
    const progression = structuredClone(s.runtime.progress), combat = structuredClone(s.runtime.combat);
    const previousPlayer = { ...s.runtime.player }, previousCopy = { ...previousPlayer };
    s.runtime.tick++;
    const frame = moveGroundEnemies(s.runtime, s.state, view), frameCopy = structuredClone(frame);
    resolveGroundContacts(s.runtime, s.state, frame, { previousPlayer });
    s.stomp(); s.kick(); s.park(); s.tick();
    const area = currentArea(s.runtime), key = 12 * area.source.width + 6;
    area.tiles.set(key, { x: 6, y: 12, kind: "hard" });
    expect(currentArea(otherRuntime).tiles.has(key)).toBe(false);
    expect(other).toEqual(otherBefore); expect(sameRuntime).toEqual(sameBefore);
    expect(frame).toEqual(frameCopy); expect(previousPlayer).toEqual(previousCopy);
    expect(s.course).toEqual(authored); expect(s.runtime.course).toEqual(authored);
    expect(s.runtime.progress).toEqual(progression); expect(s.runtime.combat).toEqual(combat);
  });
  test("swept falling crosses an enemy top without tunneling; an X-then-Y miss is not a diagonal hit", () => {
    const s = setup();
    const previousPlayer = { ...s.runtime.player, x: 192, y: 160, vy: 6, grounded: false };
    Object.assign(s.runtime.player, previousPlayer, { y: 212 });
    expect(s.tick({ previousPlayer }).some(event => event.type === "ground-stomp" && event.actorId === GROUND_IDS.goomba)).toBe(true);
    expect(s.runtime.player.y).toBe(192);
    const miss = setup();
    const previous = { ...miss.runtime.player, x: 160, y: 175, vy: 6, grounded: false };
    Object.assign(miss.runtime.player, previous, { x: 224, y: 220 });
    expect(miss.tick({ previousPlayer: previous })).toEqual([]);
  });
  test("a moving shell uses wall sweeps, preserves its chain on reversal and never tunnels through terrain", () => {
    const s = setup(); s.stomp(); s.kick(); s.park();
    const shell = s.actor(), area = currentArea(s.runtime);
    if (shell.kind !== "shell") throw new Error("Expected shell");
    shell.x = 149; shell.shell.chain = 7;
    area.tiles.set(12 * area.source.width + 10, { x: 10, y: 12, kind: "hard" });
    s.tick();
    expect(shell.x).toBe(152); expect(shell.facing).toBe(-1); expect(shell.shell.chain).toBe(7);
    s.tick(); expect(shell.x).toBe(148); expect(shell.vx).toBe(-4);
  });
  test("shell chain indices continue beyond the score table; stopping then kicking starts a fresh chain", () => {
    const s = setup(); s.stomp(); s.kick(); s.park();
    const shell = s.actor();
    if (shell.kind !== "shell") throw new Error("Expected shell");
    shell.shell.chain = 8;
    s.actor(GROUND_IDS.goomba).x = shell.x + 17;
    expect(s.tick().find(event => event.type === "ground-defeated")?.chain).toBe(9);
    s.stomp(); s.kick();
    expect(shell.shell.chain).toBe(0);
  });
  test("a kick or stomp on the wake boundary cancels waking; newly awakened red retains its color", () => {
    const kick = setup(); kick.stomp();
    const shell = kick.actor();
    if (shell.kind !== "shell") throw new Error("Expected shell");
    shell.shell.idleTicks = 599;
    expect(kick.kick().some(event => event.type === "shell-woke")).toBe(false);
    expect(shell.shell.moving).toBe(true);
    const stop = setup(); stop.stomp();
    const idle = stop.actor();
    if (idle.kind !== "shell") throw new Error("Expected shell");
    idle.shell.idleTicks = 599;
    expect(stop.stomp().some(event => event.type === "shell-woke")).toBe(false);
    expect(idle.shell.idleTicks).toBe(0);
    const red = setup("ledge"); red.stomp(GROUND_IDS.red); red.park();
    for (let i = 0; i < 600; i++) red.tick();
    const awake = red.actor(GROUND_IDS.red);
    expect(awake.kind).toBe("koopa");
    if (awake.kind !== "koopa") throw new Error("Expected Koopa");
    expect(awake.color).toBe("red");
  });
  test("equal-time combat ties use stable IDs independent of map insertion and simultaneous moving shells destroy each other", () => {
    const run = (reverse: boolean) => {
      const s = setup();
      s.actor(GROUND_IDS.buzzy).x = s.actor(GROUND_IDS.goomba).x;
      if (reverse) s.state.actors = new Map([...s.state.actors].reverse());
      return s.tick({ fireballs: [{ id: "fire:tie", previous: { x: 160, y: 194, width: 8, height: 8 }, bounds: { x: 210, y: 194, width: 8, height: 8 } }] });
    };
    expect(run(false)).toEqual(run(true));
    expect(run(false).find(event => event.type === "ground-fireball-contact")?.actorId).toBe(GROUND_IDS.goomba);
    const s = setup(); s.stomp(); s.stomp(GROUND_IDS.buzzy); s.kick();
    const buzzy = s.actor(GROUND_IDS.buzzy);
    Object.assign(s.runtime.player, { x: buzzy.x + 12, y: 208, vy: 0 }); s.tick(); s.park();
    const events: GroundEvent[] = [];
    for (let i = 0; i < 20; i++) events.push(...s.tick());
    expect(s.actor().kind).toBe("defeated"); expect(s.actor(GROUND_IDS.buzzy).kind).toBe("defeated");
    expect(events.filter(event => event.type === "ground-defeated" && event.by === "shell").length).toBe(3);
  });
});
