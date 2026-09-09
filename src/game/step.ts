import type { InputFrame } from "../input";
import { currentArea, runtimeViewport } from "./state";
import type { GameEvent, Runtime } from "./state";
import { hasSolidOverlap, playerBounds, sweepAxis } from "./collision";
import { PHYSICS, snapPosition } from "./physics";
import { commitBlocks, interactBlocks } from "./blocks";
import { collectItems, commitItems, firePlayer, itemBounds, removeItem, updateItems } from "./items";
import { advanceCombat, awardChain, damagePlayer } from "./player";
import { moveGroundEnemies, resolveGroundContacts } from "./enemies-ground";

/** One active 60Hz tick. Host must consume input edges once, never once per render. */
export function step(runtime: Runtime, input: InputFrame): GameEvent[] {
  const player = runtime.player, area = currentArea(runtime), events: GameEvent[] = [];
  // Defeat is final until the host recreates this runtime; later contacts cannot rebound or collect.
  if (runtime.combat.defeated) return events;
  const previousPlayer = { ...player };
  const previousFireballs = new Map(runtime.items.actors.filter(actor => actor.kind === "fireball" && actor.areaId === runtime.areaId)
    .map(actor => [actor.id, itemBounds(actor)]));
  runtime.tick++;
  advanceCombat(runtime, events);
  // 1. Input/player intent. Opposite axes are neutral; jump has no buffer or grace period.
  if (player.form === "small") player.crouched = false;
  else if (input.down.held && !input.up.held) player.crouched = true;
  else if (!hasSolidOverlap(area, playerBounds(player, PHYSICS.tallHeight))) player.crouched = false;
  const direction = Number(input.right.held) - Number(input.left.held);
  player.skidding = direction !== 0 && player.vx * direction < 0;
  if (direction === 0) player.vx = Math.sign(player.vx) * Math.max(0, Math.abs(player.vx) - PHYSICS.friction);
  else {
    player.facing = direction > 0 ? 1 : -1;
    const acceleration = player.skidding ? PHYSICS.reversal : PHYSICS.acceleration;
    const cap = input.run.held ? PHYSICS.runCap : PHYSICS.walkCap;
    player.vx = Math.max(-cap, Math.min(cap, player.vx + direction * acceleration));
  }
  if (input.jump.pressed && player.grounded) {
    player.vy = PHYSICS.jump; player.grounded = false; player.risingTicks = 0;
    events.push({ type: "jump", tick: runtime.tick });
  }
  // A tap entirely between ticks still jumps, then releases in this same tick.
  if (input.jump.released && player.vy < PHYSICS.releaseClamp) player.vy = PHYSICS.releaseClamp;
  const rising = player.vy < 0;
  const heldGravity = input.jump.held && rising && player.risingTicks < PHYSICS.heldTicks;
  player.vy = Math.min(PHYSICS.fallCap, player.vy + (heldGravity ? PHYSICS.heldGravity : PHYSICS.gravity));
  player.risingTicks = rising ? player.risingTicks + 1 : 0;
  if (input.run.pressed) firePlayer(runtime, events);
  // 2. Existing actors only; input/block spawns remain queued until phase 5.
  updateItems(runtime, events);
  const groundFrame = moveGroundEnemies(runtime, runtime.ground, runtimeViewport(runtime));
  // 3. Terrain movement: swept X, then swept Y.
  const x = sweepAxis(area, playerBounds(player), player.vx, "x");
  player.x = snapPosition(player.x + x.distance);
  if (x.contacts.length) player.vx = 0;
  const y = sweepAxis(area, playerBounds(player), player.vy, "y");
  player.y = snapPosition(player.y + y.distance);
  player.grounded = y.contacts.some(contact => contact.normal === -1);
  if (y.contacts.length) player.vy = 0;
  runtime.contacts = [...x.contacts, ...y.contacts];
  for (const contact of runtime.contacts) events.push({ type: "contact", tick: runtime.tick, contact });
  // 4. Interactions read this tick's terrain; growth cannot expand through solids.
  const groundEvents = resolveGroundContacts(runtime, runtime.ground, groundFrame, {
    previousPlayer, jumpHeld: input.jump.held, starActive: runtime.combat.starTicks > 0,
    invulnerable: runtime.combat.invulnerabilityTicks > 0,
    fireballs: runtime.items.actors.flatMap(actor => {
      const previous = previousFireballs.get(actor.id);
      return previous ? [{ id: actor.id, previous, bounds: itemBounds(actor) }] : [];
    }),
  });
  let damaged = false;
  for (const event of groundEvents) {
    events.push(event);
    switch (event.type) {
      case "ground-stomp": case "ground-defeated": awardChain(runtime, event.chain - 1, events); break;
      case "ground-fireball-contact": removeItem(runtime, event.fireballId, "combat", events); break;
      case "ground-damage": damaged = damagePlayer(runtime, { sourceId: event.actorId, kind: "contact" }, events) !== "ignored"; break;
      case "shell-kicked": case "shell-woke": case "ground-despawned": break;
    }
  }
  // Damage wins over a simultaneous pickup, including shrink followed by flower regrowth.
  if (!damaged) { interactBlocks(runtime, events); collectItems(runtime, events); }
  // 5. Commit terrain and spawns. A new actor's first update is the following tick.
  commitBlocks(runtime);
  commitItems(runtime, events);
  // 6. Terminal conditions and death UI/life consumption belong to task 14.
  return events;
}
