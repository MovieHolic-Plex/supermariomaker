import type { Bounds } from "../level/types";
import type { Runtime, PlayerState } from "./state";
import { currentArea } from "./state";
import { overlaps, playerBounds, sweepAxis } from "./collision";
import { PHYSICS, snapPosition } from "./physics";

export const SPAWN_ENEMY_CAP = 128;
export const SPAWN_PROJECTILE_CAP = 128;
export const PIRANHA_SAFE = 24;
export const CANNON_SAFE = 32;
export const CANNON_PERIOD = 180;
export const BULLET_SPEED = 2;
export const HAMMER_MOVE_TICKS = 90;
export const HAMMER_THROW_TICKS = 60;
export const HAMMER_JUMP_TICKS = 180;
export const HAMMER_VX = 1.8;
export const HAMMER_VY = -4;
export const HAMMER_GRAVITY = 0.18;
export const HAMMER_JUMP_VY = -4.2;
export const LAKITU_HEIGHT = 64;
export const LAKITU_DROP_TICKS = 180;
export const LAKITU_TRACK = 1.2;
export const SPINY_SPEED = 0.6;
const SPAWNED_ENEMY = new Set(["bulletBill", "spinyEgg", "spiny"]);
const SPAWNED_PROJECTILE = new Set(["hammer", "bowserFlame"]);
const compareId = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

export interface SpecialBody {
  id: string; areaId: string;
  x: number; y: number; vx: number; vy: number;
  facing: -1 | 1; active: boolean; bornTick: number;
  grounded: boolean; originX: number; originY: number; sourceId: string;
}
export type SpecialForm =
  | { kind: "piranha"; pipeId: string; phase: "hide" | "emerge" | "out" | "retract"; phaseTicks: number }
  | { kind: "billCannon"; cooldown: number }
  | { kind: "bulletBill" }
  | { kind: "hammerBro"; moveTicks: number; throwTicks: number; jumpTicks: number }
  | { kind: "hammer" }
  | { kind: "lakitu"; cooldown: number; drops: number }
  | { kind: "spinyEgg" }
  | { kind: "spiny" }
  | { kind: "defeated"; previousKind: "piranha" | "bulletBill" | "hammerBro" | "lakitu" | "spinyEgg" | "spiny" | "hammer"; cause: "stomp" | "star" | "fireball" | "pit" };
export type SpecialActor = SpecialBody & SpecialForm;
export interface SpecialState {
  actors: Map<string, SpecialActor>;
  pending: SpecialActor[];
  nextId: number;
  overloadedEnemies: boolean;
  overloadedProjectiles: boolean;
}
export interface SpecialMotion { readonly actorId: string; readonly previous: Bounds }
export interface SpecialFrame { readonly tick: number; readonly areaId: string; readonly motions: readonly SpecialMotion[] }
export interface SpecialFireball { readonly id: string; readonly previous: Bounds; readonly bounds: Bounds }
export interface SpecialCombat {
  readonly previousPlayer: Readonly<PlayerState>;
  readonly jumpHeld?: boolean;
  readonly starActive?: boolean;
  readonly invulnerable?: boolean;
  readonly fireballs?: readonly SpecialFireball[];
}
export type SpecialEvent =
  | Readonly<{ type: "piranha-emerge" | "piranha-out" | "piranha-retract"; tick: number; actorId: string }>
  | Readonly<{ type: "cannon-fire"; tick: number; actorId: string; projectileId: string; direction: -1 | 1 }>
  | Readonly<{ type: "hammer-throw"; tick: number; actorId: string; projectileId: string }>
  | Readonly<{ type: "lakitu-drop"; tick: number; actorId: string; projectileId: string }>
  | Readonly<{ type: "spiny-hatch"; tick: number; actorId: string }>
  | Readonly<{ type: "special-stomp"; tick: number; actorId: string; chain: number; result: "defeated" }>
  | Readonly<{ type: "special-defeated"; tick: number; actorId: string; by: "star" | "fireball"; sourceId: string; chain: number }>
  | Readonly<{ type: "special-damage"; tick: number; actorId: string; hit: "contact" | "projectile" }>
  | Readonly<{ type: "special-fireball-contact"; tick: number; actorId: string; fireballId: string }>
  | Readonly<{ type: "special-despawned"; tick: number; actorId: string; reason: "pit" | "outside" }>
  | Readonly<{ type: "spawn-overload"; tick: number; kind: "enemy" | "projectile" }>;

export function specialBounds(actor: SpecialActor): Bounds {
  const height = actor.kind === "hammerBro" ? 24 : 16;
  const width = 16;
  return { x: actor.x - width / 2, y: actor.y - height, width, height };
}
export function seededSign(seed: number, index: number): -1 | 1 {
  return ((Math.imul(seed ^ index, 1664525) + 1013904223) >>> 0) & 1 ? 1 : -1;
}
function body(actor: SpecialBody): SpecialBody {
  const { id, areaId, x, y, vx, vy, facing, active, bornTick, grounded, originX, originY, sourceId } = actor;
  return { id, areaId, x, y, vx, vy, facing, active, bornTick, grounded, originX, originY, sourceId };
}
function spawnClass(kind: string): "enemy" | "projectile" | null {
  if (SPAWNED_ENEMY.has(kind)) return "enemy";
  if (SPAWNED_PROJECTILE.has(kind)) return "projectile";
  return null;
}
function countSpawned(runtime: Runtime, which: "enemy" | "projectile"): number {
  const kinds = which === "enemy" ? SPAWNED_ENEMY : SPAWNED_PROJECTILE;
  let used = 0;
  const visit = (actors: Iterable<{ kind: string }>) => { for (const actor of actors) if (kinds.has(actor.kind)) used++; };
  visit(runtime.special.actors.values()); visit(runtime.special.pending);
  visit(runtime.hazards.actors.values()); visit(runtime.hazards.pending);
  return used;
}
export function spawnFull(runtime: Runtime, which: "enemy" | "projectile"): boolean {
  return countSpawned(runtime, which) >= (which === "enemy" ? SPAWN_ENEMY_CAP : SPAWN_PROJECTILE_CAP);
}
export function markSpawnOverload(runtime: Runtime, which: "enemy" | "projectile"): void {
  if (which === "enemy") runtime.special.overloadedEnemies = true;
  else runtime.special.overloadedProjectiles = true;
}

export function createSpecialState(runtime: Runtime): SpecialState {
  const actors: SpecialActor[] = [];
  for (const [areaId, area] of runtime.areas) {
    for (const object of area.source.objects) {
      const originX = object.x, originY = object.y, sourceId = object.id;
      const base = { id: object.id, areaId, x: object.x, y: object.y, vx: 0, vy: 0, facing: -1 as const,
        active: false, bornTick: 0, grounded: false, originX, originY, sourceId };
      let actor: SpecialActor;
      switch (object.kind) {
        case "piranha": actor = { ...base, y: object.y + 16, kind: "piranha", pipeId: object.props.pipeId, phase: "hide", phaseTicks: 0 }; break;
        case "billCannon": actor = { ...base, kind: "billCannon", cooldown: 0 }; break;
        case "hammerBro": actor = { ...base, kind: "hammerBro", moveTicks: 0, throwTicks: 0, jumpTicks: 0 }; break;
        case "lakitu": actor = { ...base, kind: "lakitu", cooldown: 0, drops: 0 }; break;
        default: continue;
      }
      if (actor.kind === "hammerBro") {
        actor.grounded = sweepAxis(area, specialBounds(actor), 1 / PHYSICS.snap, "y").contacts.some(contact => contact.normal === -1);
      }
      actors.push(actor);
    }
  }
  actors.sort((a, b) => compareId(a.id, b.id));
  return { actors: new Map(actors.map(actor => [actor.id, actor])), pending: [], nextId: 1, overloadedEnemies: false, overloadedProjectiles: false };
}

function queueSpawn(runtime: Runtime, draft: SpecialActor, events: SpecialEvent[]): SpecialActor | null {
  const which = spawnClass(draft.kind);
  if (!which) return null;
  if (spawnFull(runtime, which)) {
    markSpawnOverload(runtime, which);
    events.push({ type: "spawn-overload", tick: runtime.tick, kind: which });
    return null;
  }
  const actor: SpecialActor = { ...draft, id: `spawn:${String(runtime.special.nextId++).padStart(10, "0")}`, bornTick: runtime.tick };
  runtime.special.pending.push(actor);
  return actor;
}

export function linearHit(a: Bounds, nextA: Bounds, b: Bounds, nextB: Bounds): { time: number; normalY: -1 | 0 | 1 } | null {
  if (overlaps(a, b)) return { time: 0, normalY: 0 };
  let enter = -Infinity, exit = Infinity, normalY: -1 | 0 | 1 = 0;
  for (const axis of ["x", "y"] as const) {
    const size = axis === "x" ? "width" : "height";
    const delta = nextA[axis] - a[axis] - (nextB[axis] - b[axis]);
    if (delta === 0) {
      if (a[axis] >= b[axis] + b[size] || a[axis] + a[size] <= b[axis]) return null;
      continue;
    }
    const first = (b[axis] - a[axis] - a[size]) / delta;
    const last = (b[axis] + b[size] - a[axis]) / delta;
    const near = Math.min(first, last), far = Math.max(first, last);
    if (near > enter) { enter = near; normalY = axis === "y" ? delta > 0 ? -1 : 1 : 0; }
    exit = Math.min(exit, far);
  }
  return enter >= 0 && enter <= 1 && enter <= exit ? { time: enter, normalY } : null;
}
export function motionHit(a: Bounds, nextA: Bounds, b: Bounds, nextB: Bounds): { time: number; normalY: -1 | 0 | 1 } | null {
  const midA = { ...a, x: nextA.x }, midB = { ...b, x: nextB.x };
  const x = linearHit(a, midA, b, midB);
  if (x) return { ...x, time: x.time / 2 };
  const y = linearHit(midA, nextA, midB, nextB);
  return y ? { ...y, time: 0.5 + y.time / 2 } : null;
}

function inView(bounds: Bounds, viewport: Bounds, margin: number): boolean {
  return overlaps(bounds, { x: viewport.x - margin, y: viewport.y - margin, width: viewport.width + margin * 2, height: viewport.height + margin * 2 });
}

/** Existing specials move after the tick advances. Queued spawns wait for commit. */
export function moveSpecialEnemies(runtime: Runtime, state: SpecialState, viewport: Bounds, events: SpecialEvent[]): SpecialFrame {
  const area = currentArea(runtime), motions: SpecialMotion[] = [], player = runtime.player;
  for (const actor of [...state.actors.values()].sort((a, b) => compareId(a.id, b.id))) {
    if (actor.areaId !== runtime.areaId || actor.kind === "defeated") { actor.active = false; continue; }
    if (actor.bornTick >= runtime.tick) continue;
    const projectile = actor.kind === "bulletBill" || actor.kind === "hammer" || actor.kind === "spinyEgg";
    const margin = projectile ? 256 : actor.active ? 128 : 64;
    actor.active = inView(specialBounds(actor), viewport, margin);
    if (!actor.active) continue;
    motions.push({ actorId: actor.id, previous: specialBounds(actor) });
    switch (actor.kind) {
      case "piranha": {
        const near = Math.abs(player.x - actor.originX) <= PIRANHA_SAFE;
        if (actor.phase === "hide") {
          if (near) { actor.phaseTicks = 0; break; }
          actor.phaseTicks++;
          if (actor.phaseTicks >= 60) { actor.phase = "emerge"; actor.phaseTicks = 0; events.push({ type: "piranha-emerge", tick: runtime.tick, actorId: actor.id }); }
          break;
        }
        actor.phaseTicks++;
        if (actor.phase === "emerge") {
          actor.y = snapPosition(actor.originY + 16 * (1 - actor.phaseTicks / 90));
          if (actor.phaseTicks >= 90) { actor.phase = "out"; actor.phaseTicks = 0; actor.y = actor.originY; events.push({ type: "piranha-out", tick: runtime.tick, actorId: actor.id }); }
        } else if (actor.phase === "out") {
          if (actor.phaseTicks >= 60) { actor.phase = "retract"; actor.phaseTicks = 0; events.push({ type: "piranha-retract", tick: runtime.tick, actorId: actor.id }); }
        } else {
          actor.y = snapPosition(actor.originY + 16 * (actor.phaseTicks / 90));
          if (actor.phaseTicks >= 90) { actor.phase = "hide"; actor.phaseTicks = 0; actor.y = actor.originY + 16; }
        }
        break;
      }
      case "billCannon": {
        actor.cooldown++;
        if (actor.cooldown < CANNON_PERIOD) break;
        actor.cooldown = 0;
        const distance = Math.hypot(player.x - actor.x, player.y - (actor.y - 8));
        if (distance <= CANNON_SAFE) break;
        const direction: -1 | 1 = player.x < actor.x ? -1 : 1;
        const bill = queueSpawn(runtime, { ...body(actor), kind: "bulletBill", vx: direction * BULLET_SPEED, vy: 0,
          facing: direction, active: true, grounded: false, sourceId: actor.id }, events);
        if (bill) events.push({ type: "cannon-fire", tick: runtime.tick, actorId: actor.id, projectileId: bill.id, direction });
        break;
      }
      case "bulletBill":
        actor.x = snapPosition(actor.x + actor.vx);
        break;
      case "hammerBro": {
        actor.moveTicks++; actor.throwTicks++; actor.jumpTicks++;
        if (actor.moveTicks >= HAMMER_MOVE_TICKS) { actor.facing = actor.facing === 1 ? -1 : 1; actor.moveTicks = 0; }
        const target = actor.originX + actor.facing * 16;
        const stepX = actor.facing * SPINY_SPEED;
        if (Math.abs(target - actor.x) <= Math.abs(stepX)) actor.x = snapPosition(target);
        else actor.x = snapPosition(Math.max(actor.originX - 16, Math.min(actor.originX + 16, actor.x + stepX)));
        actor.vy = Math.min(PHYSICS.fallCap, actor.vy + PHYSICS.gravity);
        const y = sweepAxis(area, specialBounds(actor), actor.vy, "y");
        actor.y = snapPosition(actor.y + y.distance);
        actor.grounded = y.contacts.some(contact => contact.normal === -1);
        if (y.contacts.length) actor.vy = 0;
        if (actor.throwTicks >= HAMMER_THROW_TICKS) {
          actor.throwTicks = 0;
          const hammer = queueSpawn(runtime, { ...body(actor), kind: "hammer", vx: actor.facing * HAMMER_VX, vy: HAMMER_VY,
            facing: actor.facing, active: true, grounded: false, sourceId: actor.id }, events);
          if (hammer) events.push({ type: "hammer-throw", tick: runtime.tick, actorId: actor.id, projectileId: hammer.id });
        }
        if (actor.jumpTicks >= HAMMER_JUMP_TICKS && actor.grounded) { actor.jumpTicks = 0; actor.vy = HAMMER_JUMP_VY; actor.grounded = false; }
        break;
      }
      case "hammer":
        actor.vy = snapPosition(actor.vy + HAMMER_GRAVITY);
        actor.x = snapPosition(actor.x + actor.vx);
        actor.y = snapPosition(actor.y + actor.vy);
        break;
      case "lakitu": {
        const goalX = player.x, goalY = player.y - LAKITU_HEIGHT;
        const dx = goalX - actor.x, dy = goalY - actor.y;
        actor.facing = dx === 0 ? actor.facing : dx > 0 ? 1 : -1;
        actor.x = snapPosition(actor.x + Math.sign(dx) * Math.min(LAKITU_TRACK, Math.abs(dx)));
        actor.y = snapPosition(actor.y + Math.sign(dy) * Math.min(LAKITU_TRACK, Math.abs(dy)));
        actor.cooldown++;
        if (actor.cooldown >= LAKITU_DROP_TICKS) {
          actor.cooldown = 0; actor.drops++;
          const sign = seededSign(runtime.seed, actor.drops);
          const egg = queueSpawn(runtime, { ...body(actor), kind: "spinyEgg", vx: sign * SPINY_SPEED, vy: 0,
            facing: sign, active: true, grounded: false, sourceId: actor.id }, events);
          if (egg) events.push({ type: "lakitu-drop", tick: runtime.tick, actorId: actor.id, projectileId: egg.id });
        }
        break;
      }
      case "spinyEgg": {
        actor.vy = Math.min(PHYSICS.fallCap, actor.vy + PHYSICS.gravity);
        const x = sweepAxis(area, specialBounds(actor), actor.vx, "x");
        actor.x = snapPosition(actor.x + x.distance);
        if (x.contacts.length) { actor.facing = actor.facing === 1 ? -1 : 1; actor.vx = -actor.vx; }
        const y = sweepAxis(area, specialBounds(actor), actor.vy, "y");
        actor.y = snapPosition(actor.y + y.distance);
        actor.grounded = y.contacts.some(contact => contact.normal === -1);
        if (y.contacts.length) actor.vy = 0;
        break;
      }
      case "spiny": {
        actor.vx = actor.facing * SPINY_SPEED;
        actor.vy = Math.min(PHYSICS.fallCap, actor.vy + PHYSICS.gravity);
        const x = sweepAxis(area, specialBounds(actor), actor.vx, "x");
        actor.x = snapPosition(actor.x + x.distance);
        if (x.contacts.length) { actor.facing = actor.facing === 1 ? -1 : 1; actor.vx = 0; }
        const y = sweepAxis(area, specialBounds(actor), actor.vy, "y");
        actor.y = snapPosition(actor.y + y.distance);
        actor.grounded = y.contacts.some(contact => contact.normal === -1);
        if (y.contacts.length) actor.vy = 0;
        break;
      }
      default: break;
    }
  }
  return { tick: runtime.tick, areaId: runtime.areaId, motions };
}

function piranhaTangible(actor: SpecialActor): boolean {
  return actor.kind === "piranha" && actor.phase !== "hide" && actor.y < actor.originY + 16;
}
function stompable(actor: SpecialActor): boolean {
  return actor.kind === "bulletBill" || actor.kind === "hammerBro" || actor.kind === "lakitu";
}
function fireVulnerable(actor: SpecialActor): boolean {
  return actor.kind === "piranha" || actor.kind === "hammerBro" || actor.kind === "lakitu" || actor.kind === "spiny" || actor.kind === "spinyEgg";
}

export function resolveSpecialContacts(runtime: Runtime, state: SpecialState, frame: SpecialFrame, combat: SpecialCombat): SpecialEvent[] {
  const events: SpecialEvent[] = [], removed = new Set<string>(), tick = frame.tick, area = currentArea(runtime);
  const actors = frame.motions.map(motion => ({ actor: state.actors.get(motion.actorId)!, previous: motion.previous }))
    .filter(entry => entry.actor && entry.actor.kind !== "defeated" && entry.actor.kind !== "billCannon");
  function defeat(actor: SpecialActor, cause: "stomp" | "star" | "fireball" | "pit"): void {
    if (actor.kind === "defeated" || actor.kind === "billCannon") return;
    removed.add(actor.id);
    state.actors.set(actor.id, { ...body(actor), kind: "defeated", previousKind: actor.kind, cause, vx: 0, vy: 0, active: false });
  }
  for (const { actor } of actors) {
    const bounds = specialBounds(actor);
    const outside = bounds.y >= area.source.height * 16 || actor.x < 0 || actor.x > area.source.width * 16;
    const far = actor.kind === "bulletBill" || actor.kind === "hammer"
      ? !inView(bounds, { x: Math.max(0, Math.min(area.source.width * 16 - 256, runtime.player.x - 128)),
        y: Math.max(0, Math.min(area.source.height * 16 - 240, runtime.player.y - 160)), width: 256, height: 240 }, 256)
      : false;
    if (outside || far) {
      defeat(actor, "pit"); events.push({ type: "special-despawned", tick, actorId: actor.id, reason: outside ? "pit" : "outside" });
    }
  }
  const fireHits = (combat.fireballs ?? []).flatMap(fireball => actors.flatMap(({ actor, previous }) => {
    if (!fireVulnerable(actor) || (actor.kind === "piranha" && !piranhaTangible(actor))) return [];
    const hit = motionHit(fireball.previous, fireball.bounds, previous, specialBounds(actor));
    return hit ? [{ fireball, actor, ...hit }] : [];
  })).sort((a, b) => a.time - b.time || compareId(a.actor.id, b.actor.id) || compareId(a.fireball.id, b.fireball.id));
  const consumed = new Set<string>();
  for (const { fireball, actor } of fireHits) {
    if (consumed.has(fireball.id) || removed.has(actor.id)) continue;
    consumed.add(fireball.id);
    events.push({ type: "special-fireball-contact", tick, actorId: actor.id, fireballId: fireball.id });
    defeat(actor, "fireball");
    events.push({ type: "special-defeated", tick, actorId: actor.id, by: "fireball", sourceId: fireball.id, chain: 1 });
  }
  const player = runtime.player;
  const playerHits = actors.flatMap(({ actor, previous }) => {
    if (actor.kind === "piranha" && !piranhaTangible(actor)) return [];
    const hit = motionHit(playerBounds(combat.previousPlayer), playerBounds(player), previous, specialBounds(actor));
    return hit ? [{ actor, ...hit }] : [];
  }).sort((a, b) => a.time - b.time || compareId(a.actor.id, b.actor.id));
  for (const { actor, normalY } of playerHits) {
    if (removed.has(actor.id)) continue;
    if (combat.starActive && actor.kind !== "hammer") {
      defeat(actor, "star");
      events.push({ type: "special-defeated", tick, actorId: actor.id, by: "star", sourceId: "player", chain: 1 });
      continue;
    }
    const stomp = stompable(actor) && normalY === -1 && player.y > combat.previousPlayer.y;
    if (stomp) {
      defeat(actor, "stomp");
      player.y = snapPosition(specialBounds(actor).y); player.vy = combat.jumpHeld ? -5 : -3.4;
      player.grounded = false; player.risingTicks = 0;
      events.push({ type: "special-stomp", tick, actorId: actor.id, chain: 1, result: "defeated" });
      break;
    }
    if (!combat.invulnerable) {
      events.push({ type: "special-damage", tick, actorId: actor.id, hit: actor.kind === "hammer" ? "projectile" : "contact" });
      break;
    }
  }
  for (const { actor } of actors) {
    if (removed.has(actor.id) || actor.kind !== "spinyEgg" || !actor.grounded) continue;
    state.actors.set(actor.id, { ...body(actor), kind: "spiny", vx: actor.facing * SPINY_SPEED, vy: 0 });
    events.push({ type: "spiny-hatch", tick, actorId: actor.id });
  }
  return events;
}

export function commitSpecialSpawns(runtime: Runtime): void {
  for (const actor of runtime.special.pending) runtime.special.actors.set(actor.id, actor);
  runtime.special.pending = [];
  runtime.special.overloadedEnemies = spawnFull(runtime, "enemy") || runtime.special.overloadedEnemies;
  runtime.special.overloadedProjectiles = spawnFull(runtime, "projectile") || runtime.special.overloadedProjectiles;
}
