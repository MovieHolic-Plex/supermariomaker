import type { InputFrame } from "../input";
import { currentArea, runtimeViewport } from "./state";
import type { GameEvent, Runtime } from "./state";
import { hasSolidOverlap, overlaps, playerBounds, sweepAxis } from "./collision";
import { PHYSICS, snapPosition } from "./physics";
import { commitBlocks, interactBlocks } from "./blocks";
import { collectItems, commitItems, firePlayer, itemBounds, removeItem, updateItems } from "./items";
import { advanceCombat, awardChain, damagePlayer } from "./player";
import { moveGroundEnemies, resolveGroundContacts } from "./enemies-ground";
import { climbIntent, createClimbState } from "./climb";
import { platformColliders, selectPlatformRider, stepPlatforms } from "./platforms";
import type { PlatformMotion, PlatformTickResult } from "./platforms";
import { commitSpecialSpawns, moveSpecialEnemies, resolveSpecialContacts } from "./enemies-special";
import type { SpecialEvent } from "./enemies-special";
import { commitHazardSpawns, moveHazards, resolveHazardContacts } from "./hazards";
import type { HazardEvent } from "./hazards";
import { applyUnderwaterIntent, isUnderwater } from "./water";
import { commitWaterSpawns, moveWaterEnemies, resolveWaterContacts } from "./enemies-water";
import type { WaterEvent } from "./enemies-water";
import { stepTransition } from "./transitions";
import { advanceEnding, resolveTerminal } from "./goals";

/** One active 60Hz tick. Host must consume input edges once, never once per render. */
export function step(runtime: Runtime, input: InputFrame): GameEvent[] {
  const player = runtime.player, events: GameEvent[] = [];
  if (runtime.ending.kind !== "none") {
    runtime.tick++;
    advanceEnding(runtime, events);
    return events;
  }
  // Defeat is final until the host recreates this runtime; later contacts cannot rebound or collect.
  if (runtime.combat.defeated) return events;
  const previousPlayer = { ...player };
  const previousContacts = runtime.contacts;
  const previousFireballs = new Map(runtime.items.actors.filter(actor => actor.kind === "fireball" && actor.areaId === runtime.areaId)
    .map(actor => [actor.id, itemBounds(actor)]));
  runtime.tick++;
  const pipeEvents = stepTransition(runtime, input);
  if (pipeEvents) return pipeEvents;
  advanceCombat(runtime, events);
  if (runtime.areaId !== runtime.featureAreaId) {
    const departed = runtime.areas.get(runtime.featureAreaId);
    if (departed) {
      departed.platforms = { ...departed.platforms, bodies: departed.platforms.bodies.map(body =>
        body.kind === "spring" ? { ...body, bounds: body.origin, compressedAt: null, awaitingRelease: false } : body) };
    }
    runtime.climb = createClimbState();
    runtime.contacts = [];
    runtime.player.swimCooldown = 0;
    runtime.featureAreaId = runtime.areaId;
  }
  const area = currentArea(runtime);
  const vines = runtime.items.actors.filter(actor => actor.kind === "vine" && actor.areaId === runtime.areaId
    && actor.bornTick < runtime.tick && actor.height > 0).map(actor => ({ id: actor.id, bounds: itemBounds(actor) }));
  const climb = climbIntent(runtime.climb, player, input, vines, runtime.tick);
  runtime.climb = climb.state;
  for (const event of climb.events) events.push(event);
  // 1. Input/player intent. Opposite axes are neutral; jump has no buffer or grace period.
  if (climb.kind === "climb") {
    player.vx = 0; player.vy = climb.dy; player.skidding = false; player.risingTicks = 0;
  } else if (isUnderwater(runtime)) {
    applyUnderwaterIntent(runtime, input, events);
  } else {
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
    if (climb.kind === "jump") {
      player.vy = climb.vy; player.grounded = false; player.risingTicks = 0;
      events.push({ type: "jump", tick: runtime.tick });
    } else if (input.jump.pressed && player.grounded) {
      player.vy = PHYSICS.jump; player.grounded = false; player.risingTicks = 0;
      events.push({ type: "jump", tick: runtime.tick });
    }
    // A tap entirely between ticks still jumps, then releases in this same tick.
    if (input.jump.released && player.vy < PHYSICS.releaseClamp) player.vy = PHYSICS.releaseClamp;
    const rising = player.vy < 0;
    const heldGravity = input.jump.held && rising && player.risingTicks < PHYSICS.heldTicks;
    player.vy = Math.min(PHYSICS.fallCap, player.vy + (heldGravity ? PHYSICS.heldGravity : PHYSICS.gravity));
    player.risingTicks = rising ? player.risingTicks + 1 : 0;
  }
  if (input.run.pressed) firePlayer(runtime, events);
  const riderId = climb.kind === "climb" ? null : selectPlatformRider(area.platforms, previousPlayer, previousContacts, input);
  const proposed = stepPlatforms(area.platforms, runtime.tick, riderId);
  const resolved = resolvePlatformProposals(area, proposed);
  area.platforms = resolved.state;
  for (const event of resolved.events) events.push(event);
  let crushed = applyPlatformCarry(runtime, resolved.motions, riderId, events);
  if (!crushed) crushed = pushPlatformOverlaps(runtime, resolved.motions, riderId, events);
  // 2. Existing actors only; input/block spawns remain queued until phase 5.
  updateItems(runtime, events);
  const viewport = runtimeViewport(runtime);
  const groundFrame = moveGroundEnemies(runtime, runtime.ground, viewport);
  const specialMoved: SpecialEvent[] = [];
  const specialFrame = moveSpecialEnemies(runtime, runtime.special, viewport, specialMoved);
  for (const event of specialMoved) events.push(event);
  const hazardMoved: HazardEvent[] = [];
  const hazardFrame = moveHazards(runtime, runtime.hazards, viewport, hazardMoved);
  for (const event of hazardMoved) events.push(event);
  const waterMoved: WaterEvent[] = [];
  const waterFrame = moveWaterEnemies(runtime, runtime.water, viewport, waterMoved);
  for (const event of waterMoved) events.push(event);
  // 3. Terrain movement: carry already applied; voluntary swept X, then swept Y.
  if (!crushed) {
    const x = sweepAxis(area, playerBounds(player), player.vx, "x");
    player.x = snapPosition(player.x + x.distance);
    if (x.contacts.length) player.vx = 0;
    if (climb.kind !== "climb") {
      const launch = resolved.events.find(event => event.type === "spring-launch");
      if (launch && riderId === launch.id) player.vy = launch.vy;
    }
    const y = sweepAxis(area, playerBounds(player), player.vy, "y");
    player.y = snapPosition(player.y + y.distance);
    player.grounded = climb.kind === "climb" ? false : y.contacts.some(contact => contact.normal === -1);
    if (y.contacts.length) player.vy = 0;
    runtime.contacts = [...x.contacts, ...y.contacts];
    for (const contact of runtime.contacts) events.push({ type: "contact", tick: runtime.tick, contact });
  }
  // 4. Interactions read this tick's terrain; growth cannot expand through solids.
  if (!runtime.combat.defeated) {
    const fireballs = runtime.items.actors.flatMap(actor => {
      const previous = previousFireballs.get(actor.id);
      return previous ? [{ id: actor.id, previous, bounds: itemBounds(actor) }] : [];
    });
    const combat = {
      previousPlayer, jumpHeld: input.jump.held, starActive: runtime.combat.starTicks > 0,
      invulnerable: runtime.combat.invulnerabilityTicks > 0, fireballs,
    };
    const groundEvents = resolveGroundContacts(runtime, runtime.ground, groundFrame, combat);
    const consumed = new Set(groundEvents.flatMap(event => event.type === "ground-fireball-contact" ? [event.fireballId] : []));
    const remaining = fireballs.filter(fireball => !consumed.has(fireball.id));
    const specialEvents = resolveSpecialContacts(runtime, runtime.special, specialFrame, { ...combat, fireballs: remaining });
    const specialConsumed = new Set(specialEvents.flatMap(event => event.type === "special-fireball-contact" ? [event.fireballId] : []));
    const leftover = remaining.filter(fireball => !specialConsumed.has(fireball.id));
    const hazardEvents = resolveHazardContacts(runtime, runtime.hazards, hazardFrame, { ...combat, fireballs: leftover });
    const hazardConsumed = new Set(hazardEvents.flatMap(event => event.type === "bowser-hit" ? [event.fireballId] : []));
    const waterLeftover = leftover.filter(fireball => !hazardConsumed.has(fireball.id));
    const waterEvents = resolveWaterContacts(runtime, runtime.water, waterFrame, { ...combat, fireballs: waterLeftover });
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
    for (const event of specialEvents) {
      events.push(event);
      switch (event.type) {
        case "special-stomp": case "special-defeated": awardChain(runtime, event.chain - 1, events); break;
        case "special-fireball-contact": removeItem(runtime, event.fireballId, "combat", events); break;
        case "special-damage":
          if (!damaged) damaged = damagePlayer(runtime, { sourceId: event.actorId, kind: event.hit }, events) !== "ignored";
          break;
        default: break;
      }
    }
    for (const event of hazardEvents) {
      events.push(event);
      switch (event.type) {
        case "bowser-hit": removeItem(runtime, event.fireballId, "combat", events); break;
        case "hazard-damage":
          if (!damaged) damaged = damagePlayer(runtime, { sourceId: event.actorId, kind: event.hit }, events) !== "ignored";
          break;
        default: break;
      }
    }
    for (const event of waterEvents) {
      events.push(event);
      switch (event.type) {
        case "water-stomp": case "water-defeated": awardChain(runtime, event.chain - 1, events); break;
        case "water-fireball-contact": removeItem(runtime, event.fireballId, "combat", events); break;
        case "water-damage":
          if (!damaged) damaged = damagePlayer(runtime, { sourceId: event.actorId, kind: event.hit }, events) !== "ignored";
          break;
        default: break;
      }
    }
    // Damage wins over a simultaneous pickup, including shrink followed by flower regrowth.
    if (!damaged) { interactBlocks(runtime, events); collectItems(runtime, events); }
  }
  // 5. Commit terrain and spawns. A new actor's first update is the following tick.
  commitBlocks(runtime);
  commitItems(runtime, events);
  commitSpecialSpawns(runtime);
  commitHazardSpawns(runtime);
  commitWaterSpawns(runtime);
  // 6. Terminal: pit, timer, then goal. Lethal damage already recorded wins the tie.
  resolveTerminal(runtime, events);
  return events;
}

function resolvePlatformProposals(area: ReturnType<typeof currentArea>, proposed: PlatformTickResult): PlatformTickResult {
  const exclude = new Set(proposed.state.bodies.map(body => body.id));
  const original = new Map(proposed.motions.map(motion => [motion.id, motion]));
  const motions: PlatformMotion[] = proposed.motions.map(motion => {
    const body = proposed.state.bodies.find(candidate => candidate.id === motion.id);
    if (!body || body.kind === "spring" || (motion.dx === 0 && motion.dy === 0)) return motion;
    const x = sweepAxis(area, motion.from, motion.dx, "x", exclude);
    const mid = { ...motion.from, x: motion.from.x + x.distance };
    const y = sweepAxis(area, mid, motion.dy, "y", exclude);
    return { ...motion, dx: x.distance, dy: y.distance, to: { ...motion.to, x: snapPosition(mid.x), y: snapPosition(mid.y + y.distance) } };
  });
  const byId = new Map(proposed.state.bodies.map(body => [body.id, body]));
  for (const body of proposed.state.bodies) {
    if (body.kind !== "platform" || body.props.motion !== "balance" || body.props.pairId === undefined || body.id > body.props.pairId) continue;
    const partner = byId.get(body.props.pairId);
    if (!partner) continue;
    const desired = original.get(body.id), a = motions.find(motion => motion.id === body.id), b = motions.find(motion => motion.id === partner.id);
    if (!desired || !a || !b) continue;
    const mag = Math.min(Math.abs(a.dy), Math.abs(b.dy), Math.abs(desired.dy));
    const dy = Math.sign(desired.dy) * mag;
    motions[motions.indexOf(a)] = { ...a, dy, to: { ...a.to, y: snapPosition(a.from.y + dy) } };
    motions[motions.indexOf(b)] = { ...b, dy: -dy, to: { ...b.to, y: snapPosition(b.from.y - dy) } };
  }
  const bodies = proposed.state.bodies.map(body => {
    const motion = motions.find(candidate => candidate.id === body.id);
    return motion ? { ...body, bounds: { ...body.bounds, x: motion.to.x, y: motion.to.y, width: motion.to.width, height: motion.to.height } } : body;
  });
  const state = { ...proposed.state, bodies };
  return { state, motions, colliders: platformColliders(state), events: proposed.events };
}

function applyPlatformCarry(runtime: Runtime, motions: readonly PlatformMotion[], riderId: string | null, events: GameEvent[]): boolean {
  if (!riderId) return false;
  const motion = motions.find(candidate => candidate.id === riderId);
  if (!motion || (motion.dx === 0 && motion.dy === 0)) return false;
  return displacePlayer(runtime, motion, riderId, events);
}

function pushPlatformOverlaps(runtime: Runtime, motions: readonly PlatformMotion[], riderId: string | null, events: GameEvent[]): boolean {
  const player = runtime.player, area = currentArea(runtime);
  for (const motion of motions) {
    if (motion.id === riderId || (motion.dx === 0 && motion.dy === 0)) continue;
    const body = area.platforms.bodies.find(candidate => candidate.id === motion.id);
    if (!body || !overlaps(playerBounds(player), body.bounds)) continue;
    if (displacePlayer(runtime, motion, motion.id, events)) return true;
  }
  return false;
}

function displacePlayer(runtime: Runtime, motion: PlatformMotion, sourceId: string, events: GameEvent[]): boolean {
  const player = runtime.player, area = currentArea(runtime), exclude = new Set([sourceId]);
  const x = sweepAxis(area, playerBounds(player), motion.dx, "x", exclude);
  player.x = snapPosition(player.x + x.distance);
  const y = sweepAxis(area, playerBounds(player), motion.dy, "y", exclude);
  player.y = snapPosition(player.y + y.distance);
  if (motion.dy < 0 && y.distance > motion.dy) {
    damagePlayer(runtime, { sourceId, kind: "crush" }, events);
    runtime.contacts = [...x.contacts, ...y.contacts];
    return true;
  }
  return false;
}
