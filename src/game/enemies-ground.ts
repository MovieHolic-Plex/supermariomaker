import type { Bounds } from "../level/types";
import type { Runtime, PlayerState } from "./state";
import { currentArea } from "./state";
import { overlaps, playerBounds, sweepAxis } from "./collision";
import { PHYSICS, snapPosition } from "./physics";
import { advanceShell, createShellState, kickShell, kickerProtected, SHELL_SPEED, SHELL_WAKE_TICKS, stopShell } from "./shells";
import type { ShellState } from "./shells";

export interface GroundBody {
  readonly id: string; readonly areaId: string;
  x: number; y: number; vx: number; vy: number;
  facing: -1 | 1; grounded: boolean; active: boolean;
}
export type GroundForm =
  | { kind: "goomba" }
  | { kind: "buzzy" }
  | { kind: "koopa"; color: "green" | "red" }
  | { kind: "paratroopa"; color: "green" | "red"; motion: "hop" | "vertical"; originY: number; phase: number }
  | { kind: "shell"; shell: ShellState }
  | { kind: "defeated"; previousKind: "goomba" | "buzzy" | "koopa" | "paratroopa" | "shell"; cause: "stomp" | "shell" | "star" | "fireball" | "pit" };
export type GroundActor = GroundBody & GroundForm;
export interface GroundState { actors: Map<string, GroundActor>; stompChain: number }
export interface GroundMotion { readonly actorId: string; readonly previous: Bounds }
export interface GroundFrame { readonly tick: number; readonly areaId: string; readonly motions: readonly GroundMotion[]; readonly waking: readonly string[] }
export interface GroundFireball { readonly id: string; readonly previous: Bounds; readonly bounds: Bounds }
export interface GroundCombat {
  readonly previousPlayer: Readonly<PlayerState>;
  readonly jumpHeld?: boolean;
  readonly starActive?: boolean;
  readonly invulnerable?: boolean;
  readonly fireballs?: readonly GroundFireball[];
}
export type GroundEvent =
  | Readonly<{ type: "ground-stomp"; tick: number; actorId: string; chain: number; result: "defeated" | "shelled" | "wings-removed" | "shell-stopped" }>
  | Readonly<{ type: "ground-defeated"; tick: number; actorId: string; by: "shell" | "star" | "fireball"; sourceId: string; chain: number }>
  | Readonly<{ type: "ground-damage"; tick: number; actorId: string }>
  | Readonly<{ type: "shell-kicked"; tick: number; actorId: string; direction: -1 | 1 }>
  | Readonly<{ type: "shell-woke"; tick: number; actorId: string }>
  | Readonly<{ type: "ground-despawned"; tick: number; actorId: string; reason: "pit" }>
  | Readonly<{ type: "ground-fireball-contact"; tick: number; actorId: string; fireballId: string; immune: boolean }>;
export function groundBounds(actor: GroundActor): Bounds { return { x: actor.x - 8, y: actor.y - 16, width: 16, height: 16 }; }
export const GROUND_PATROL_SPEED = 0.6;
// Unspecified original-like tuning: hop -3.4, vertical +/-16 over 120 active ticks.
export const PARATROOPA_HOP = -3.4;
const compareId = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
function body(actor: GroundBody): GroundBody {
  const { id, areaId, x, y, vx, vy, facing, grounded, active } = actor;
  return { id, areaId, x, y, vx, vy, facing, grounded, active };
}

/** Read the existing runtime's private area copies, not another document/player model. */
export function createGroundState(runtime: Runtime): GroundState {
  const actors: GroundActor[] = [];
  for (const [areaId, area] of runtime.areas) {
    for (const object of area.source.objects) {
      let form: GroundForm;
      switch (object.kind) {
        case "goomba": case "buzzy": form = { kind: object.kind }; break;
        case "koopa": form = { kind: "koopa", color: object.props.color }; break;
        case "paratroopa": form = { kind: "paratroopa", ...object.props, originY: object.y, phase: 0 }; break;
        default: continue;
      }
      const actor: GroundActor = { id: object.id, areaId, x: object.x, y: object.y, vx: 0, vy: 0,
        facing: -1, grounded: false, active: false, ...form };
      actor.grounded = sweepAxis(area, groundBounds(actor), 1 / PHYSICS.snap, "y").contacts.some(contact => contact.normal === -1);
      actors.push(actor);
    }
  }
  actors.sort((a, b) => compareId(a.id, b.id));
  return { actors: new Map(actors.map(actor => [actor.id, actor])), stompChain: 0 };
}

/** Once per tick after its number advances, before actor interactions/queued terrain changes.
 * Viewport is the host's logical camera rectangle; no rendering state decides collisions.
 * Existing actors move X then Y. Wake/form transitions are deferred to resolveGroundContacts.
 */
export function moveGroundEnemies(runtime: Runtime, state: GroundState, viewport: Bounds): GroundFrame {
  const area = currentArea(runtime), motions: GroundMotion[] = [], waking: string[] = [];
  for (const actor of [...state.actors.values()].sort((a, b) => compareId(a.id, b.id))) {
    if (actor.areaId !== runtime.areaId || actor.kind === "defeated") { actor.active = false; continue; }
    const margin = actor.active ? 128 : 64;
    actor.active = overlaps(groundBounds(actor), { x: viewport.x - margin, y: viewport.y - margin,
      width: viewport.width + margin * 2, height: viewport.height + margin * 2 });
    if (!actor.active) continue;
    motions.push({ actorId: actor.id, previous: groundBounds(actor) });
    if (actor.kind === "shell" && advanceShell(actor.shell)) waking.push(actor.id);
    if (actor.kind === "paratroopa" && actor.motion === "vertical") {
      actor.phase = (actor.phase + 1) % 120;
      actor.vx = 0;
      actor.vy = snapPosition(actor.originY - 16 * Math.sin(actor.phase * Math.PI * 2 / 120)) - actor.y;
    } else {
      if (actor.kind === "koopa" && actor.color === "red" && actor.grounded) {
        // Thin probe at the NEXT LEADING edge. Center/trailing support incorrectly walks off ledges.
        const foot = actor.x + actor.facing * (8 + GROUND_PATROL_SPEED);
        const support = sweepAxis(area, { x: foot - 1 / PHYSICS.snap, y: actor.y - 1,
          width: 2 / PHYSICS.snap, height: 1 }, 1 / PHYSICS.snap, "y");
        if (!support.contacts.some(contact => contact.normal === -1)) actor.facing = actor.facing === 1 ? -1 : 1;
      }
      actor.vx = actor.facing * (actor.kind === "shell" ? actor.shell.moving ? SHELL_SPEED : 0 : GROUND_PATROL_SPEED);
      if (actor.kind === "paratroopa" && actor.grounded) actor.vy = PARATROOPA_HOP;
      actor.vy = Math.min(PHYSICS.fallCap, actor.vy + PHYSICS.gravity);
    }
    const x = sweepAxis(area, groundBounds(actor), actor.vx, "x");
    actor.x = snapPosition(actor.x + x.distance);
    if (x.contacts.length) { actor.facing = actor.facing === 1 ? -1 : 1; actor.vx = 0; }
    const y = sweepAxis(area, groundBounds(actor), actor.vy, "y");
    actor.y = snapPosition(actor.y + y.distance);
    actor.grounded = y.contacts.some(contact => contact.normal === -1);
    if (y.contacts.length) actor.vy = 0;
  }
  return { tick: runtime.tick, areaId: runtime.areaId, motions, waking };
}

interface Hit { time: number; normalY: -1 | 0 | 1 }
/** Relative swept AABB. Initial overlap is contact, never a newly crossed stomp surface. */
function linearHit(a: Bounds, nextA: Bounds, b: Bounds, nextB: Bounds): Hit | null {
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
/** Actor contacts use the same X-then-Y paths as terrain, not a fictitious diagonal. */
function motionHit(a: Bounds, nextA: Bounds, b: Bounds, nextB: Bounds): Hit | null {
  const midA = { ...a, x: nextA.x }, midB = { ...b, x: nextB.x };
  const x = linearHit(a, midA, b, midB);
  if (x) return { ...x, time: x.time / 2 };
  const y = linearHit(midA, nextA, midB, nextB);
  return y ? { ...y, time: 0.5 + y.time / 2 } : null;
}
function fireImmune(actor: GroundActor): boolean {
  return actor.kind === "buzzy" || (actor.kind === "shell" && actor.shell.occupant === "buzzy");
}

/** Once after player/actor terrain movement, before terrain/spawn commits and terminal decisions.
 * Requests are legitimate terrain-clipped fireball movements from the item owner. Each contact
 * consumes that fireball (including immunity); this module never owns projectiles or progression.
 * Order: fireballs, moving shell pairs, player, queued wakes. Within a phase: time then stable IDs.
 * Form/death replacements commit only after every interaction, so a spawn never acts twice.
 */
export function resolveGroundContacts(runtime: Runtime, state: GroundState, frame: GroundFrame, combat: GroundCombat): GroundEvent[] {
  const events: GroundEvent[] = [], changes = new Map<string, GroundActor>(), removed = new Set<string>();
  const tick = frame.tick, area = currentArea(runtime);
  const actors = frame.motions.map(motion => ({ actor: state.actors.get(motion.actorId)!, previous: motion.previous }));
  function defeat(actor: GroundActor, cause: "stomp" | "shell" | "star" | "fireball" | "pit"): void {
    if (actor.kind === "defeated") return;
    removed.add(actor.id);
    changes.set(actor.id, { ...body(actor), kind: "defeated", previousKind: actor.kind, cause, vx: 0, vy: 0, active: false });
  }
  // Falling beyond the area is permanent, rather than suspending an unreturnable pit actor.
  for (const { actor } of actors) {
    if (groundBounds(actor).y >= area.source.height * 16) {
      defeat(actor, "pit"); events.push({ type: "ground-despawned", tick, actorId: actor.id, reason: "pit" });
    }
  }
  const fireHits = (combat.fireballs ?? []).flatMap(fireball => actors.flatMap(({ actor, previous }) => {
    const hit = motionHit(fireball.previous, fireball.bounds, previous, groundBounds(actor));
    return hit ? [{ fireball, actor, ...hit }] : [];
  })).sort((a, b) => a.time - b.time || compareId(a.actor.id, b.actor.id) || compareId(a.fireball.id, b.fireball.id));
  const consumed = new Set<string>();
  for (const { fireball, actor } of fireHits) {
    if (consumed.has(fireball.id) || removed.has(actor.id)) continue;
    consumed.add(fireball.id);
    const immune = fireImmune(actor);
    events.push({ type: "ground-fireball-contact", tick, actorId: actor.id, fireballId: fireball.id, immune });
    if (!immune) {
      defeat(actor, "fireball");
      events.push({ type: "ground-defeated", tick, actorId: actor.id, by: "fireball", sourceId: fireball.id, chain: 1 });
    }
  }
  const shellHits: { a: GroundActor; b: GroundActor; time: number }[] = [];
  for (const [index, a] of actors.entries()) {
    for (const b of actors.slice(index + 1)) {
      if (!(a.actor.kind === "shell" && a.actor.shell.moving) && !(b.actor.kind === "shell" && b.actor.shell.moving)) continue;
      const hit = motionHit(a.previous, groundBounds(a.actor), b.previous, groundBounds(b.actor));
      if (hit) shellHits.push({ a: a.actor, b: b.actor, time: hit.time });
    }
  }
  shellHits.sort((a, b) => a.time - b.time || compareId(a.a.id, b.a.id) || compareId(a.b.id, b.b.id));
  for (const { a, b } of shellHits) {
    if (removed.has(a.id) || removed.has(b.id)) continue;
    // Both moving shells destroy one another; an idle shell is an ordinary shell target.
    for (const [source, target] of [[a, b], [b, a]] as const) {
      if (source.kind !== "shell" || !source.shell.moving) continue;
      defeat(target, "shell"); source.shell.chain++;
      events.push({ type: "ground-defeated", tick, actorId: target.id, by: "shell", sourceId: source.id, chain: source.shell.chain });
    }
  }
  const player = runtime.player;
  if (player.grounded) state.stompChain = 0;
  const playerHits = actors.flatMap(({ actor, previous }) => {
    const hit = motionHit(playerBounds(combat.previousPlayer), playerBounds(player), previous, groundBounds(actor));
    return hit ? [{ actor, ...hit }] : [];
  }).sort((a, b) => a.time - b.time || compareId(a.actor.id, b.actor.id));
  for (const { actor, normalY } of playerHits) {
    if (removed.has(actor.id)) continue;
    if (combat.starActive) {
      defeat(actor, "star");
      events.push({ type: "ground-defeated", tick, actorId: actor.id, by: "star", sourceId: "player", chain: 1 });
      continue;
    }
    // The relative top hit and resolved descent are authoritative; pre-gravity vy may still be negative.
    const stomp = normalY === -1 && player.y > combat.previousPlayer.y;
    if (stomp) {
      let result: Extract<GroundEvent, { type: "ground-stomp" }>["result"];
      switch (actor.kind) {
        case "goomba": defeat(actor, "stomp"); result = "defeated"; break;
        case "paratroopa":
          changes.set(actor.id, { ...body(actor), kind: "koopa", color: actor.color, vx: 0, vy: 0 }); result = "wings-removed"; break;
        case "koopa": case "buzzy":
          changes.set(actor.id, { ...body(actor), kind: "shell", vx: 0, vy: 0,
            shell: createShellState(actor.kind === "buzzy" ? "buzzy" : actor.color === "red" ? "redKoopa" : "greenKoopa") });
          result = "shelled"; break;
        case "shell": stopShell(actor.shell); actor.vx = 0; result = "shell-stopped"; break;
        case "defeated": continue;
      }
      player.y = snapPosition(actor.y - 16); player.vy = combat.jumpHeld ? -5 : -3.4;
      player.grounded = false; player.risingTicks = 0;
      state.stompChain++;
      events.push({ type: "ground-stomp", tick, actorId: actor.id, chain: state.stompChain, result });
      // The rebound invalidates the rest of the original falling trajectory.
      break;
    }
    if (actor.kind === "shell") {
      if (!actor.shell.moving) {
        actor.facing = player.x < actor.x ? 1 : player.x > actor.x ? -1 : player.facing;
        kickShell(actor.shell, tick); actor.vx = actor.facing * SHELL_SPEED;
        events.push({ type: "shell-kicked", tick, actorId: actor.id, direction: actor.facing });
        continue;
      }
      if (kickerProtected(actor.shell, tick)) continue;
    }
    if (!combat.invulnerable) { events.push({ type: "ground-damage", tick, actorId: actor.id }); break; }
  }
  for (const id of frame.waking) {
    const actor = state.actors.get(id)!;
    if (removed.has(id) || changes.has(id) || actor.kind !== "shell" || actor.shell.moving || actor.shell.idleTicks < SHELL_WAKE_TICKS) continue;
    const form: GroundForm = actor.shell.occupant === "buzzy" ? { kind: "buzzy" }
      : { kind: "koopa", color: actor.shell.occupant === "redKoopa" ? "red" : "green" };
    changes.set(id, { ...body(actor), ...form, vx: 0, vy: 0 });
    events.push({ type: "shell-woke", tick, actorId: id });
  }
  for (const [id, actor] of changes) state.actors.set(id, actor);
  return events;
}
