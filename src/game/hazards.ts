import type { Bounds } from "../level/types";
import type { Runtime, PlayerState } from "./state";
import { currentArea } from "./state";
import { overlaps, playerBounds, sweepAxis } from "./collision";
import { PHYSICS, snapPosition } from "./physics";
import { markSpawnOverload, motionHit, spawnFull } from "./enemies-special";
import type { SpecialFireball } from "./enemies-special";

export const PODOBOO_PERIOD = 180;
export const PODOBOO_VY = -5.6;
export const PODOBOO_GRAVITY = 0.2;
export const FIREBAR_SPEED = { slow: 0.01, normal: 0.02, fast: 0.03 } as const;
export const FIREBAR_SPACING = 8;
export const BOWSER_PATROL = 32;
export const BOWSER_SPEED = 0.5;
export const BOWSER_JUMP_TICKS = 180;
export const BOWSER_FLAME_TICKS = 120;
export const BOWSER_HITS = 5;
export const BOWSER_FLAME_SPEED = 2;
export const BOWSER_JUMP_VY = -4.2;
const compareId = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

export interface HazardBody {
  id: string; areaId: string;
  x: number; y: number; vx: number; vy: number;
  facing: -1 | 1; active: boolean; bornTick: number;
  grounded: boolean; originX: number; originY: number; sourceId: string;
}
export type HazardForm =
  | { kind: "podoboo"; cooldown: number; waiting: boolean }
  | { kind: "firebar"; length: number; direction: "cw" | "ccw"; speed: "slow" | "normal" | "fast"; angle: number }
  | { kind: "bowser"; hits: number; jumpTicks: number; flameTicks: number }
  | { kind: "bowserFlame" }
  | { kind: "defeated"; previousKind: "bowser" | "podoboo" | "firebar" | "bowserFlame"; cause: "fireball" | "pit" };
export type HazardActor = HazardBody & HazardForm;
export interface HazardState { actors: Map<string, HazardActor>; pending: HazardActor[]; nextId: number }
export interface HazardMotion { readonly actorId: string; readonly previous: Bounds }
export interface HazardFrame { readonly tick: number; readonly areaId: string; readonly motions: readonly HazardMotion[] }
export interface HazardCombat {
  readonly previousPlayer: Readonly<PlayerState>;
  readonly jumpHeld?: boolean;
  readonly starActive?: boolean;
  readonly invulnerable?: boolean;
  readonly fireballs?: readonly SpecialFireball[];
}
export type HazardEvent =
  | Readonly<{ type: "podoboo-launch"; tick: number; actorId: string }>
  | Readonly<{ type: "bowser-flame"; tick: number; actorId: string; projectileId: string }>
  | Readonly<{ type: "bowser-hit"; tick: number; actorId: string; hits: number; fireballId: string }>
  | Readonly<{ type: "bowser-defeated"; tick: number; actorId: string }>
  | Readonly<{ type: "hazard-damage"; tick: number; actorId: string; hit: "contact" | "projectile" }>
  | Readonly<{ type: "hazard-despawned"; tick: number; actorId: string; reason: "pit" | "outside" }>
  | Readonly<{ type: "spawn-overload"; tick: number; kind: "enemy" | "projectile" }>;

export function hazardBounds(actor: HazardActor): Bounds {
  const width = actor.kind === "bowser" ? 32 : 16;
  const height = actor.kind === "bowser" ? 32 : 16;
  return { x: actor.x - width / 2, y: actor.y - height, width, height };
}
export function firebarBalls(actor: HazardActor): { x: number; y: number }[] {
  if (actor.kind !== "firebar") return [];
  const cx = actor.x, cy = actor.y - 8;
  return Array.from({ length: actor.length }, (_, index) => ({
    x: snapPosition(cx + Math.cos(actor.angle) * index * FIREBAR_SPACING),
    y: snapPosition(cy + Math.sin(actor.angle) * index * FIREBAR_SPACING),
  }));
}
function firebarHurtBoxes(actor: HazardActor): Bounds[] {
  return firebarBalls(actor).map(ball => ({ x: ball.x - 4, y: ball.y - 4, width: 8, height: 8 }));
}
function body(actor: HazardBody): HazardBody {
  const { id, areaId, x, y, vx, vy, facing, active, bornTick, grounded, originX, originY, sourceId } = actor;
  return { id, areaId, x, y, vx, vy, facing, active, bornTick, grounded, originX, originY, sourceId };
}
function inView(bounds: Bounds, viewport: Bounds, margin: number): boolean {
  return overlaps(bounds, { x: viewport.x - margin, y: viewport.y - margin, width: viewport.width + margin * 2, height: viewport.height + margin * 2 });
}

export function createHazardState(runtime: Runtime): HazardState {
  const actors: HazardActor[] = [];
  for (const [areaId, area] of runtime.areas) {
    for (const object of area.source.objects) {
      const base = { id: object.id, areaId, x: object.x, y: object.y, vx: 0, vy: 0, facing: -1 as const,
        active: false, bornTick: 0, grounded: false, originX: object.x, originY: object.y, sourceId: object.id };
      let actor: HazardActor;
      switch (object.kind) {
        case "podoboo": actor = { ...base, kind: "podoboo", cooldown: 0, waiting: true }; break;
        case "firebar": actor = { ...base, kind: "firebar", ...object.props, angle: 0 }; break;
        case "bowser": actor = { ...base, kind: "bowser", hits: 0, jumpTicks: 0, flameTicks: 0 }; break;
        default: continue;
      }
      if (actor.kind === "bowser") {
        actor.grounded = sweepAxis(area, hazardBounds(actor), 1 / PHYSICS.snap, "y").contacts.some(contact => contact.normal === -1);
      }
      actors.push(actor);
    }
  }
  actors.sort((a, b) => compareId(a.id, b.id));
  return { actors: new Map(actors.map(actor => [actor.id, actor])), pending: [], nextId: 1 };
}

function queueFlame(runtime: Runtime, source: HazardActor, events: HazardEvent[]): HazardActor | null {
  if (spawnFull(runtime, "projectile")) {
    markSpawnOverload(runtime, "projectile");
    events.push({ type: "spawn-overload", tick: runtime.tick, kind: "projectile" });
    return null;
  }
  const direction: -1 | 1 = runtime.player.x < source.x ? -1 : 1;
  const actor: HazardActor = {
    ...body(source), id: `hazard:${String(runtime.hazards.nextId++).padStart(10, "0")}`, bornTick: runtime.tick,
    kind: "bowserFlame", vx: direction * BOWSER_FLAME_SPEED, vy: 0, facing: direction, active: true, grounded: false,
    y: source.y - 16, sourceId: source.id,
  };
  runtime.hazards.pending.push(actor);
  return actor;
}

export function moveHazards(runtime: Runtime, state: HazardState, viewport: Bounds, events: HazardEvent[]): HazardFrame {
  const area = currentArea(runtime), motions: HazardMotion[] = [];
  for (const actor of [...state.actors.values()].sort((a, b) => compareId(a.id, b.id))) {
    if (actor.areaId !== runtime.areaId || actor.kind === "defeated") { actor.active = false; continue; }
    if (actor.bornTick >= runtime.tick) continue;
    const projectile = actor.kind === "bowserFlame";
    const margin = projectile ? 256 : actor.active ? 128 : 64;
    actor.active = inView(hazardBounds(actor), viewport, margin);
    if (!actor.active) continue;
    motions.push({ actorId: actor.id, previous: actor.kind === "firebar" ? { x: actor.x - 4, y: actor.y - 12, width: 8, height: 8 } : hazardBounds(actor) });
    switch (actor.kind) {
      case "podoboo":
        if (actor.waiting) {
          actor.cooldown++;
          if (actor.cooldown >= PODOBOO_PERIOD) {
            actor.cooldown = 0; actor.waiting = false; actor.vy = PODOBOO_VY;
            events.push({ type: "podoboo-launch", tick: runtime.tick, actorId: actor.id });
          }
          break;
        }
        actor.vy = snapPosition(actor.vy + PODOBOO_GRAVITY);
        actor.y = snapPosition(actor.y + actor.vy);
        if (actor.vy > 0 && actor.y >= actor.originY) { actor.y = actor.originY; actor.vy = 0; actor.waiting = true; }
        break;
      case "firebar": {
        const delta = FIREBAR_SPEED[actor.speed] * (actor.direction === "cw" ? 1 : -1);
        actor.angle += delta;
        break;
      }
      case "bowser": {
        if (actor.x <= actor.originX - BOWSER_PATROL) actor.facing = 1;
        else if (actor.x >= actor.originX + BOWSER_PATROL) actor.facing = -1;
        actor.vx = actor.facing * BOWSER_SPEED;
        actor.vy = Math.min(PHYSICS.fallCap, actor.vy + PHYSICS.gravity);
        const x = sweepAxis(area, hazardBounds(actor), actor.vx, "x");
        actor.x = snapPosition(actor.x + x.distance);
        if (x.contacts.length) { actor.facing = actor.facing === 1 ? -1 : 1; actor.vx = 0; }
        const y = sweepAxis(area, hazardBounds(actor), actor.vy, "y");
        actor.y = snapPosition(actor.y + y.distance);
        actor.grounded = y.contacts.some(contact => contact.normal === -1);
        if (y.contacts.length) actor.vy = 0;
        actor.jumpTicks++; actor.flameTicks++;
        if (actor.jumpTicks >= BOWSER_JUMP_TICKS && actor.grounded) { actor.jumpTicks = 0; actor.vy = BOWSER_JUMP_VY; actor.grounded = false; }
        if (actor.flameTicks >= BOWSER_FLAME_TICKS) {
          actor.flameTicks = 0;
          const flame = queueFlame(runtime, actor, events);
          if (flame) events.push({ type: "bowser-flame", tick: runtime.tick, actorId: actor.id, projectileId: flame.id });
        }
        break;
      }
      case "bowserFlame":
        actor.x = snapPosition(actor.x + actor.vx);
        break;
      default: break;
    }
  }
  return { tick: runtime.tick, areaId: runtime.areaId, motions };
}

export function resolveHazardContacts(runtime: Runtime, state: HazardState, frame: HazardFrame, combat: HazardCombat): HazardEvent[] {
  const events: HazardEvent[] = [], removed = new Set<string>(), tick = frame.tick, area = currentArea(runtime);
  const actors = frame.motions.map(motion => ({ actor: state.actors.get(motion.actorId)!, previous: motion.previous }))
    .filter(entry => entry.actor && entry.actor.kind !== "defeated");
  function defeat(actor: HazardActor, cause: "fireball" | "pit"): void {
    if (actor.kind === "defeated") return;
    removed.add(actor.id);
    state.actors.set(actor.id, { ...body(actor), kind: "defeated", previousKind: actor.kind, cause, vx: 0, vy: 0, active: false });
  }
  for (const { actor } of actors) {
    if (actor.kind !== "bowserFlame") continue;
    const bounds = hazardBounds(actor);
    const outside = bounds.y >= area.source.height * 16 || actor.x < 0 || actor.x > area.source.width * 16;
    const camera = { x: Math.max(0, Math.min(area.source.width * 16 - 256, runtime.player.x - 128)),
      y: Math.max(0, Math.min(area.source.height * 16 - 240, runtime.player.y - 160)), width: 256, height: 240 };
    if (outside || !inView(bounds, camera, 256)) {
      defeat(actor, "pit"); events.push({ type: "hazard-despawned", tick, actorId: actor.id, reason: outside ? "pit" : "outside" });
    }
  }
  const fireHits = (combat.fireballs ?? []).flatMap(fireball => actors.flatMap(({ actor, previous }) => {
    if (actor.kind !== "bowser") return [];
    const hit = motionHit(fireball.previous, fireball.bounds, previous, hazardBounds(actor));
    return hit ? [{ fireball, actor, ...hit }] : [];
  })).sort((a, b) => a.time - b.time || compareId(a.actor.id, b.actor.id) || compareId(a.fireball.id, b.fireball.id));
  const consumed = new Set<string>();
  for (const { fireball, actor } of fireHits) {
    if (consumed.has(fireball.id) || removed.has(actor.id) || actor.kind !== "bowser") continue;
    consumed.add(fireball.id);
    actor.hits++;
    events.push({ type: "bowser-hit", tick, actorId: actor.id, hits: actor.hits, fireballId: fireball.id });
    if (actor.hits >= BOWSER_HITS) {
      defeat(actor, "fireball");
      events.push({ type: "bowser-defeated", tick, actorId: actor.id });
    }
  }
  const player = runtime.player;
  const playerHits: { actor: HazardActor; time: number; normalY: -1 | 0 | 1 }[] = [];
  for (const { actor, previous } of actors) {
    if (actor.kind === "firebar") {
      for (const box of firebarHurtBoxes(actor)) {
        const hit = motionHit(playerBounds(combat.previousPlayer), playerBounds(player), box, box);
        if (hit) playerHits.push({ actor, ...hit });
      }
      continue;
    }
    const hit = motionHit(playerBounds(combat.previousPlayer), playerBounds(player), previous, hazardBounds(actor));
    if (hit) playerHits.push({ actor, ...hit });
  }
  playerHits.sort((a, b) => a.time - b.time || compareId(a.actor.id, b.actor.id));
  for (const { actor } of playerHits) {
    if (removed.has(actor.id) || actor.kind === "defeated") continue;
    if (!combat.invulnerable) {
      events.push({ type: "hazard-damage", tick, actorId: actor.id, hit: actor.kind === "bowserFlame" ? "projectile" : "contact" });
      break;
    }
  }
  return events;
}

export function commitHazardSpawns(runtime: Runtime): void {
  for (const actor of runtime.hazards.pending) runtime.hazards.actors.set(actor.id, actor);
  runtime.hazards.pending = [];
}
