import type { InputFrame } from "../input";
import { COURSE_LIMITS } from "../level/types";
import type { Bounds, PlatformProps } from "../level/types";
import { objectBounds } from "../level/validate";
import { playerBounds } from "./collision";
import type { Collider, Contact } from "./collision";
import { PHYSICS, snapPosition } from "./physics";
import type { PlayerState, RuntimeArea } from "./state";

export const PLATFORM_PHYSICS = {
  fallingAcceleration: 0.10, fallingCap: 4, balanceSpeed: 0.75,
  springCompressionTicks: 8, springCompressedHeight: 8, springLaunch: -7,
} as const;
interface BodyState {
  readonly id: string;
  readonly origin: Bounds;
  readonly bounds: Bounds;
}
export interface PlatformState extends BodyState {
  readonly kind: "platform";
  readonly props: PlatformProps;
  readonly direction: -1 | 1;
  readonly falling: boolean;
  readonly vy: number;
}
export interface SpringState extends BodyState {
  readonly kind: "spring";
  readonly compressedAt: number | null;
  /** Launch cannot repeat until the previous rider contact has cleared. */
  readonly awaitingRelease: boolean;
}
export type PlatformBody = PlatformState | SpringState;
/** Owned by one RuntimeArea, not a second course/player or simulation clock. */
export interface PlatformFeatureState {
  readonly areaId: string;
  readonly bodies: readonly PlatformBody[];
}
export type PlatformEvent = Readonly<{ tick: number; id: string }> & (
  | Readonly<{ type: "platform-reverse" | "platform-fall" | "spring-compress" | "spring-cancel" }>
  | Readonly<{ type: "spring-launch"; vy: -7 }>
  | Readonly<{ type: "balance-unpair"; partnerId: string }>
);
export interface PlatformMotion {
  readonly id: string;
  readonly from: Bounds;
  readonly to: Bounds;
  /** Surface displacement; for springs the bottom remains fixed while the top changes. */
  readonly dx: number;
  readonly dy: number;
}
export interface PlatformTickResult {
  readonly state: PlatformFeatureState;
  readonly motions: readonly PlatformMotion[];
  /** REPLACEMENTS for authored platform/spring bodies, never additional static colliders. */
  readonly colliders: readonly Collider[];
  readonly events: readonly PlatformEvent[];
}

/** Caller supplies a validated area's authored objects once, at runtime creation/reset. */
export function createPlatformState(area: RuntimeArea): PlatformFeatureState {
  const bodies: PlatformBody[] = [];
  for (const object of area.source.objects) {
    if (object.kind !== "platform" && object.kind !== "spring") continue;
    const bounds = objectBounds(object);
    const base = { id: object.id, origin: bounds, bounds };
    bodies.push(object.kind === "platform"
      ? { ...base, kind: "platform", props: { ...object.props }, direction: 1, falling: false, vy: 0 }
      : { ...base, kind: "spring", compressedAt: null, awaitingRelease: false });
  }
  bodies.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return { areaId: area.source.id, bodies };
}
export function platformColliders(state: PlatformFeatureState): Collider[] {
  return state.bodies.map(body => ({ id: body.id, ...body.bounds,
    source: { kind: "object", objectId: body.id, part: "body" } }));
}
/** Select at most ONE player rider from previous tick's top contacts, before advancing bodies. */
export function selectPlatformRider(
  state: PlatformFeatureState, player: PlayerState, contacts: readonly Contact[], input: InputFrame,
): string | null {
  if (!player.grounded || player.vy < 0 || input.jump.pressed) return null;
  const bounds = playerBounds(player);
  const supports = new Set(contacts.filter(contact => contact.axis === "y" && contact.normal === -1
    && contact.source.kind === "object" && contact.source.part === "body" && contact.id === contact.source.objectId)
    .map(contact => contact.id));
  // Feature bodies are stable-ID sorted at construction; every update/removal preserves that order.
  return state.bodies.find(body => supports.has(body.id)
    && Math.abs(player.y - body.bounds.y) <= 1 / PHYSICS.snap
    && bounds.x < body.bounds.x + body.bounds.width && bounds.x + bounds.width > body.bounds.x)?.id ?? null;
}

/** One active tick; riderId comes from selectPlatformRider, before bodies or player move.
 * Produces proposed motion, NOT collision resolution, carry, crush, or a player velocity mutation.
 */
export function stepPlatforms(state: PlatformFeatureState, tick: number, riderId: string | null): PlatformTickResult {
  const events: PlatformEvent[] = [], motions: PlatformMotion[] = [];
  const byId = new Map(state.bodies.map(body => [body.id, body]));
  const bodies = state.bodies.map((body): PlatformBody => {
    let next: PlatformBody = body;
    if (body.kind === "spring") next = stepSpring(body, tick, riderId === body.id, events);
    else switch (body.props.motion) {
      case "horizontal": case "vertical": {
        const axis = body.props.motion === "horizontal" ? "x" : "y";
        const lower = body.origin[axis], upper = lower + body.props.travel * COURSE_LIMITS.grid;
        const position = body.bounds[axis] + body.direction * body.props.speed;
        // Authored grid travel is divisible by every supported speed, so endpoints are exact.
        const direction = position >= upper ? -1 : position <= lower ? 1 : body.direction;
        next = { ...body, direction, bounds: { ...body.bounds, [axis]: snapPosition(Math.max(lower, Math.min(upper, position))) } };
        if (direction !== body.direction) events.push({ type: "platform-reverse", tick, id: body.id });
        break;
      }
      case "falling": {
        if (!body.falling && riderId !== body.id) break;
        const vy = Math.min(PLATFORM_PHYSICS.fallingCap, body.vy + PLATFORM_PHYSICS.fallingAcceleration);
        next = { ...body, falling: true, vy, bounds: { ...body.bounds, y: snapPosition(body.bounds.y + vy) } };
        if (!body.falling) events.push({ type: "platform-fall", tick, id: body.id });
        break;
      }
      case "balance": {
        const partner = body.props.pairId === undefined ? undefined : byId.get(body.props.pairId);
        if (!partner || partner.id === body.id || partner.kind !== "platform" || partner.props.motion !== "balance"
          || partner.props.pairId !== body.id) break;
        const desired = riderId === body.id ? PLATFORM_PHYSICS.balanceSpeed
          : riderId === partner.id ? -PLATFORM_PHYSICS.balanceSpeed : 0;
        const offset = body.bounds.y - body.origin.y, partnerOffset = partner.bounds.y - partner.origin.y;
        const travel = body.props.travel * COURSE_LIMITS.grid, partnerTravel = partner.props.travel * COURSE_LIMITS.grid;
        // Clamp the SAME reciprocal displacement to BOTH signed anchor-relative travel limits.
        // Both calculations read old state, so no partner can move twice or see a half-updated pair.
        const lower = Math.max(-travel - offset, partnerOffset - partnerTravel);
        const upper = Math.min(travel - offset, partnerOffset + partnerTravel);
        const dy = Math.max(lower, Math.min(upper, desired));
        next = { ...body, bounds: { ...body.bounds, y: snapPosition(body.bounds.y + dy) } };
        break;
      }
    }
    motions.push({ id: body.id, from: body.bounds, to: next.bounds,
      dx: next.bounds.x - body.bounds.x, dy: next.bounds.y - body.bounds.y });
    return next;
  });
  const nextState: PlatformFeatureState = { ...state, bodies };
  return { state: nextState, motions, colliders: platformColliders(nextState), events };
}
function stepSpring(body: SpringState, tick: number, ridden: boolean, events: PlatformEvent[]): SpringState {
  if (!ridden) {
    if (body.compressedAt !== null) events.push({ type: "spring-cancel", tick, id: body.id });
    return { ...body, bounds: body.origin, compressedAt: null, awaitingRelease: false };
  }
  if (body.awaitingRelease) return body;
  if (body.compressedAt === null) {
    events.push({ type: "spring-compress", tick, id: body.id });
    return { ...body, compressedAt: tick, bounds: { ...body.origin,
      y: body.origin.y + body.origin.height - PLATFORM_PHYSICS.springCompressedHeight,
      height: PLATFORM_PHYSICS.springCompressedHeight } };
  }
  if (tick - body.compressedAt < PLATFORM_PHYSICS.springCompressionTicks) return body;
  events.push({ type: "spring-launch", tick, id: body.id, vy: PLATFORM_PHYSICS.springLaunch });
  return { ...body, bounds: body.origin, compressedAt: null, awaitingRelease: true };
}
/** Runtime-only removal/cancellation. Authored deletion plus reciprocal undo remains an editor command. */
export function removePlatformBodies(state: PlatformFeatureState, ids: ReadonlySet<string>, tick: number): {
  state: PlatformFeatureState; events: readonly PlatformEvent[];
} {
  const events: PlatformEvent[] = [];
  const bodies = state.bodies.filter(body => !ids.has(body.id)).map((body): PlatformBody => {
    if (body.kind !== "platform" || body.props.motion !== "balance" || body.props.pairId === undefined
      || !ids.has(body.props.pairId)) return body;
    const { pairId, ...props } = body.props;
    events.push({ type: "balance-unpair", tick, id: body.id, partnerId: pairId });
    return { ...body, props };
  });
  return { state: { ...state, bodies }, events };
}
