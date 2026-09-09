import type { Bounds } from "../level/types";
import type { PlayerState, Runtime } from "./state";
import { currentArea } from "./state";
import { overlaps, playerBounds, sweepAxis } from "./collision";
import { PHYSICS, snapPosition } from "./physics";
import { motionHit, seededSign } from "./enemies-special";

export const CHEEP_SWIM_SPEED = 0.8;
export const CHEEP_SWIM_AMPLITUDE = 16;
export const CHEEP_SWIM_PERIOD = 120;
export const CHEEP_LEAP_PERIOD = 180;
export const CHEEP_LEAP_VY = -5;
export const CHEEP_LEAP_VX = 1.2;
export const BLOOPER_SPEED = 1.2;
export const BLOOPER_PULSE = 60;
export const BLOOPER_CYCLE = 120;
const compareId = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

export interface WaterBody {
  id: string; areaId: string;
  x: number; y: number; vx: number; vy: number;
  facing: -1 | 1; active: boolean; bornTick: number;
  originX: number; originY: number;
}
export type WaterForm =
  | { kind: "cheep"; color: "green" | "red"; mode: "swim" | "leap"; phase: number; phaseTicks: number }
  | { kind: "blooper"; cycleTicks: number }
  | { kind: "defeated"; previousKind: "cheep" | "blooper"; cause: "stomp" | "star" | "fireball" | "pit" };
export type WaterActor = WaterBody & WaterForm;
export interface WaterState { actors: Map<string, WaterActor>; pending: WaterActor[]; nextId: number }
export interface WaterMotion { readonly actorId: string; readonly previous: Bounds }
export interface WaterFrame { readonly tick: number; readonly areaId: string; readonly motions: readonly WaterMotion[] }
export interface WaterFireball { readonly id: string; readonly previous: Bounds; readonly bounds: Bounds }
export interface WaterCombat {
  readonly previousPlayer: Readonly<PlayerState>;
  readonly jumpHeld?: boolean;
  readonly starActive?: boolean;
  readonly invulnerable?: boolean;
  readonly fireballs?: readonly WaterFireball[];
}
export type WaterEvent =
  | Readonly<{ type: "swim"; tick: number }>
  | Readonly<{ type: "cheep-leap"; tick: number; actorId: string }>
  | Readonly<{ type: "blooper-pulse"; tick: number; actorId: string }>
  | Readonly<{ type: "water-stomp"; tick: number; actorId: string; chain: number; result: "defeated" }>
  | Readonly<{ type: "water-defeated"; tick: number; actorId: string; by: "star" | "fireball"; sourceId: string; chain: number }>
  | Readonly<{ type: "water-damage"; tick: number; actorId: string; hit: "contact" }>
  | Readonly<{ type: "water-fireball-contact"; tick: number; actorId: string; fireballId: string }>
  | Readonly<{ type: "water-despawned"; tick: number; actorId: string; reason: "pit" | "outside" }>;

export function waterBounds(actor: WaterActor): Bounds {
  return { x: actor.x - 8, y: actor.y - 16, width: 16, height: 16 };
}
function body(actor: WaterBody): WaterBody {
  const { id, areaId, x, y, vx, vy, facing, active, bornTick, originX, originY } = actor;
  return { id, areaId, x, y, vx, vy, facing, active, bornTick, originX, originY };
}
function inView(bounds: Bounds, viewport: Bounds, margin: number): boolean {
  return overlaps(bounds, { x: viewport.x - margin, y: viewport.y - margin, width: viewport.width + margin * 2, height: viewport.height + margin * 2 });
}

export function createWaterState(runtime: Runtime): WaterState {
  const actors: WaterActor[] = [];
  for (const [areaId, area] of runtime.areas) {
    for (const object of area.source.objects) {
      const originX = object.x, originY = object.y;
      const base = { id: object.id, areaId, x: object.x, y: object.y, vx: 0, vy: 0, facing: -1 as const,
        active: false, bornTick: 0, originX, originY };
      if (object.kind === "cheep") {
        actors.push({ ...base, kind: "cheep", color: object.props.color, mode: object.props.mode, phase: 0, phaseTicks: 0 });
      } else if (object.kind === "blooper") {
        actors.push({ ...base, kind: "blooper", cycleTicks: 0 });
      }
    }
  }
  actors.sort((a, b) => compareId(a.id, b.id));
  return { actors: new Map(actors.map(actor => [actor.id, actor])), pending: [], nextId: 1 };
}

/** Existing aquatic actors move after the tick advances. Queued spawns wait for commit. */
export function moveWaterEnemies(runtime: Runtime, state: WaterState, viewport: Bounds, events: WaterEvent[]): WaterFrame {
  const area = currentArea(runtime), motions: WaterMotion[] = [], player = runtime.player;
  for (const actor of [...state.actors.values()].sort((a, b) => compareId(a.id, b.id))) {
    if (actor.areaId !== runtime.areaId || actor.kind === "defeated") { actor.active = false; continue; }
    if (actor.bornTick >= runtime.tick) continue;
    const margin = actor.active ? 128 : 64;
    actor.active = inView(waterBounds(actor), viewport, margin);
    if (!actor.active) continue;
    motions.push({ actorId: actor.id, previous: waterBounds(actor) });
    switch (actor.kind) {
      case "cheep": {
        if (actor.mode === "swim") {
          actor.phase = (actor.phase + 1) % CHEEP_SWIM_PERIOD;
          actor.facing = -1;
          actor.vx = -CHEEP_SWIM_SPEED;
          actor.x = snapPosition(actor.x + actor.vx);
          actor.y = snapPosition(actor.originY - CHEEP_SWIM_AMPLITUDE * Math.sin(actor.phase * Math.PI * 2 / CHEEP_SWIM_PERIOD));
          actor.vy = 0;
          break;
        }
        const waiting = actor.vy === 0 && actor.y >= actor.originY;
        if (waiting) {
          actor.phaseTicks++;
          if (actor.phaseTicks >= CHEEP_LEAP_PERIOD) {
            actor.phaseTicks = 0;
            actor.vy = CHEEP_LEAP_VY;
            actor.vx = player.x < actor.x ? -CHEEP_LEAP_VX : CHEEP_LEAP_VX;
            actor.facing = actor.vx > 0 ? 1 : -1;
            events.push({ type: "cheep-leap", tick: runtime.tick, actorId: actor.id });
          }
          break;
        }
        actor.vy = Math.min(PHYSICS.fallCap, actor.vy + PHYSICS.gravity);
        actor.x = snapPosition(actor.x + actor.vx);
        actor.y = snapPosition(actor.y + actor.vy);
        if (actor.y >= actor.originY && actor.vy > 0) {
          actor.x = actor.originX; actor.y = actor.originY; actor.vx = 0; actor.vy = 0; actor.phaseTicks = 0;
        }
        break;
      }
      case "blooper": {
        actor.cycleTicks++;
        const pulsing = (actor.cycleTicks - 1) % BLOOPER_CYCLE < BLOOPER_PULSE;
        if (!pulsing) { actor.vx = 0; actor.vy = 0; break; }
        if ((actor.cycleTicks - 1) % BLOOPER_CYCLE === 0) events.push({ type: "blooper-pulse", tick: runtime.tick, actorId: actor.id });
        const dx = player.x - actor.x, dy = player.y - actor.y;
        const dist = Math.hypot(dx, dy);
        if (dist === 0) {
          const sign = seededSign(runtime.seed, actor.cycleTicks);
          actor.vx = sign * BLOOPER_SPEED; actor.vy = 0; actor.facing = sign;
        } else {
          actor.vx = dx / dist * BLOOPER_SPEED;
          actor.vy = dy / dist * BLOOPER_SPEED;
          actor.facing = dx === 0 ? actor.facing : dx > 0 ? 1 : -1;
        }
        const x = sweepAxis(area, waterBounds(actor), actor.vx, "x");
        actor.x = snapPosition(actor.x + x.distance);
        if (x.contacts.length) actor.vx = 0;
        const y = sweepAxis(area, waterBounds(actor), actor.vy, "y");
        actor.y = snapPosition(actor.y + y.distance);
        if (y.contacts.length) actor.vy = 0;
        break;
      }
      default: break;
    }
  }
  return { tick: runtime.tick, areaId: runtime.areaId, motions };
}

export function resolveWaterContacts(runtime: Runtime, state: WaterState, frame: WaterFrame, combat: WaterCombat): WaterEvent[] {
  const events: WaterEvent[] = [], removed = new Set<string>(), tick = frame.tick, area = currentArea(runtime);
  const actors = frame.motions.map(motion => ({ actor: state.actors.get(motion.actorId)!, previous: motion.previous }))
    .filter(entry => entry.actor && entry.actor.kind !== "defeated");
  function defeat(actor: WaterActor, cause: "stomp" | "star" | "fireball" | "pit"): void {
    if (actor.kind === "defeated") return;
    removed.add(actor.id);
    state.actors.set(actor.id, { ...body(actor), kind: "defeated", previousKind: actor.kind, cause, vx: 0, vy: 0, active: false });
  }
  for (const { actor } of actors) {
    const bounds = waterBounds(actor);
    if (bounds.y >= area.source.height * 16 || actor.x < 0 || actor.x > area.source.width * 16) {
      defeat(actor, "pit"); events.push({ type: "water-despawned", tick, actorId: actor.id, reason: "pit" });
    }
  }
  const fireHits = (combat.fireballs ?? []).flatMap(fireball => actors.flatMap(({ actor, previous }) => {
    const hit = motionHit(fireball.previous, fireball.bounds, previous, waterBounds(actor));
    return hit ? [{ fireball, actor, ...hit }] : [];
  })).sort((a, b) => a.time - b.time || compareId(a.actor.id, b.actor.id) || compareId(a.fireball.id, b.fireball.id));
  const consumed = new Set<string>();
  for (const { fireball, actor } of fireHits) {
    if (consumed.has(fireball.id) || removed.has(actor.id)) continue;
    consumed.add(fireball.id);
    events.push({ type: "water-fireball-contact", tick, actorId: actor.id, fireballId: fireball.id });
    defeat(actor, "fireball");
    events.push({ type: "water-defeated", tick, actorId: actor.id, by: "fireball", sourceId: fireball.id, chain: 1 });
  }
  const player = runtime.player;
  const playerHits = actors.flatMap(({ actor, previous }) => {
    const hit = motionHit(playerBounds(combat.previousPlayer), playerBounds(player), previous, waterBounds(actor));
    return hit ? [{ actor, ...hit }] : [];
  }).sort((a, b) => a.time - b.time || compareId(a.actor.id, b.actor.id));
  for (const { actor, normalY } of playerHits) {
    if (removed.has(actor.id)) continue;
    if (combat.starActive) {
      defeat(actor, "star");
      events.push({ type: "water-defeated", tick, actorId: actor.id, by: "star", sourceId: "player", chain: 1 });
      continue;
    }
    const stomp = normalY === -1 && player.y > combat.previousPlayer.y;
    if (stomp) {
      defeat(actor, "stomp");
      player.y = snapPosition(waterBounds(actor).y); player.vy = combat.jumpHeld ? -5 : -3.4;
      player.grounded = false; player.risingTicks = 0;
      events.push({ type: "water-stomp", tick, actorId: actor.id, chain: 1, result: "defeated" });
      break;
    }
    if (!combat.invulnerable) {
      events.push({ type: "water-damage", tick, actorId: actor.id, hit: "contact" });
      break;
    }
  }
  return events;
}

export function commitWaterSpawns(runtime: Runtime): void {
  for (const actor of runtime.water.pending) runtime.water.actors.set(actor.id, actor);
  runtime.water.pending = [];
}
