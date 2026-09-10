import { describe, expect, test } from "bun:test";
import { EMPTY_INPUT } from "../src/input";
import { PIXELS } from "../src/assets/pixels";
import { createRuntime, currentArea } from "../src/game/state";
import { step } from "../src/game/step";
import { playerBounds } from "../src/game/collision";
import { queueItem, commitItems } from "../src/game/items";
import { playView } from "../src/ui/play-view";
import { createPlatformLiveFixture, platformIds as ids } from "./fixtures/platforms";
import { createHazardFixture, HAZARD_IDS } from "./fixtures/hazards";
import { createGroundEnemyFixture } from "./fixtures/enemies-ground";

const idle = EMPTY_INPUT;
const PLAYER_DEATH = "mario.small.death";
const BOWSER_DEFEAT = "enemy.bowser.defeated";

function crushPlayer() {
  const runtime = createRuntime(createPlatformLiveFixture("crush"));
  runtime.combat.starTicks = 600;
  runtime.combat.invulnerabilityTicks = 120;
  for (let tick = 0; tick < 16; tick++) step(runtime, idle);
  const rising = currentArea(runtime).platforms.bodies.find(body => body.id === ids.vertical);
  if (!rising) throw new Error("missing crush platform");
  Object.assign(runtime.player, { x: 80, y: rising.bounds.y, vx: 0, vy: 0, grounded: true });
  runtime.contacts = [{ id: ids.vertical, source: { kind: "object", objectId: ids.vertical, part: "body" }, axis: "y", normal: -1, time: 0 }];
  let events: ReturnType<typeof step> = [];
  for (let tick = 0; tick < 24 && !runtime.combat.defeated; tick++) events = step(runtime, idle);
  return { runtime, events };
}

function hazardDeath() {
  const runtime = createRuntime(createHazardFixture("bowser"));
  const king = runtime.hazards.actors.get(HAZARD_IDS.bowser);
  if (!king) throw new Error("missing bowser");
  Object.assign(runtime.player, { x: king.x, y: king.y, vy: 0, grounded: true });
  const events = step(runtime, idle);
  return { runtime, events };
}

function enemyContactDeath() {
  const runtime = createRuntime(createGroundEnemyFixture());
  Object.assign(runtime.player, { x: 181, y: 208, form: "small" as const });
  const events = step(runtime, idle);
  return { runtime, events };
}

function bowserFireballDefeat() {
  const runtime = createRuntime(createHazardFixture("bowser"));
  runtime.player.form = "fire";
  Object.assign(runtime.player, { x: 40, y: 208, facing: 1 as const });
  const king = runtime.hazards.actors.get(HAZARD_IDS.bowser);
  if (!king) throw new Error("missing bowser");
  let events: ReturnType<typeof step> = [];
  for (let hit = 1; hit <= 5; hit++) {
    const shot = queueItem(runtime, "fireball", king.x - 16, king.y - 8, "player");
    shot.emerging = 0;
    commitItems(runtime, []);
    Object.assign(shot, { x: king.x - 10, y: king.y - 16, vx: 3, vy: 0, age: 1, bornTick: 0 });
    events = step(runtime, idle);
  }
  return { runtime, events };
}

describe("defeat presentation sprite selection", () => {
  test("crush, hazard, and enemy-contact deaths all select the inverted death key, not idle", () => {
    const crushed = crushPlayer();
    expect(crushed.runtime.combat.defeated).toBe(true);
    expect(crushed.events.some(event => event.type === "playerDefeated" && event.hit.kind === "crush")).toBe(true);
    expect(crushed.runtime.player.y - playerBounds(crushed.runtime.player).height).toBeGreaterThanOrEqual(144);
    expect(playView(crushed.runtime).player.key).toBe(PLAYER_DEATH);
    expect(playView(crushed.runtime).player.key).not.toBe("mario.small.idle");

    const hazard = hazardDeath();
    expect(hazard.runtime.combat.defeated).toBe(true);
    expect(hazard.events.some(event => event.type === "hazard-damage")).toBe(true);
    expect(playView(hazard.runtime).player.key).toBe(PLAYER_DEATH);
    expect(playView(hazard.runtime).player.key).not.toBe("mario.small.idle");

    const contact = enemyContactDeath();
    expect(contact.runtime.combat.defeated).toBe(true);
    expect(contact.events.some(event => event.type === "ground-damage")).toBe(true);
    expect(playView(contact.runtime).player.key).toBe(PLAYER_DEATH);
    expect(playView(contact.runtime).player.key).not.toBe("mario.small.idle");

    expect(PIXELS[PLAYER_DEATH].rows).not.toEqual(PIXELS["mario.small.idle"].rows);
    expect(PIXELS[PLAYER_DEATH].rows).not.toEqual(PIXELS["mario.small.jump"].rows);
    const idleTop = PIXELS["mario.small.idle"].rows[0] ?? "";
    const deathTop = PIXELS[PLAYER_DEATH].rows[0] ?? "";
    const deathBottom = PIXELS[PLAYER_DEATH].rows[15] ?? "";
    expect(idleTop.includes("2")).toBe(true);
    expect(deathTop.includes("2")).toBe(false);
    expect(deathTop.includes("4")).toBe(true);
    expect(deathBottom.includes("2")).toBe(true);
  });

  test("five-hit fireball defeat draws the Bowser defeat sprite at the corpse", () => {
    const { runtime, events } = bowserFireballDefeat();
    expect(events.some(event => event.type === "bowser-defeated" && event.actorId === HAZARD_IDS.bowser)).toBe(true);
    expect(runtime.combat.defeated).toBe(false);
    const corpse = runtime.hazards.actors.get(HAZARD_IDS.bowser);
    expect(corpse?.kind).toBe("defeated");
    const drawn = playView(runtime).hazards.find(sprite => sprite.id === HAZARD_IDS.bowser);
    expect(drawn?.key).toBe(BOWSER_DEFEAT);
    expect(drawn?.x).toBe(corpse?.x);
    expect(drawn?.y).toBe(corpse?.y);
    expect(PIXELS[BOWSER_DEFEAT].rows).not.toEqual(PIXELS["enemy.bowser.walk1"].rows);
    expect(PIXELS[BOWSER_DEFEAT].rows).not.toEqual(PIXELS["enemy.bowser.openMouth"].rows);
  });
});
