import type { InputFrame } from "../input";
import type { Bounds } from "../level/types";
import { overlaps, playerBounds } from "./collision";
import { PHYSICS } from "./physics";
import type { PlayerState } from "./state";

/** Task 7 supplies actual live, unobstructed vine bounds; this module never spawns a vine. */
export interface ClimbableVine { readonly id: string; readonly bounds: Bounds }
export interface ClimbState {
  readonly vineId: string | null;
  /** A jump cannot immediately reattach to the same column before leaving its bounds. */
  readonly blockedVineId: string | null;
}
export type ClimbEvent = Readonly<{ tick: number; vineId: string }> & (
  | Readonly<{ type: "vine-attach" }>
  | Readonly<{ type: "vine-detach"; reason: "jump" | "lost" }>
);
interface ClimbResult { readonly state: ClimbState; readonly events: readonly ClimbEvent[] }
export type ClimbIntent = ClimbResult & (
  | Readonly<{ kind: "free" }>
  | Readonly<{ kind: "climb"; dx: 0; dy: number; vx: 0; vy: 0 }>
  | Readonly<{ kind: "jump"; vy: number }>
);
export const createClimbState = (): ClimbState => ({ vineId: null, blockedVineId: null });
/** Intent only: shared terrain movement must sweep dy, not assign a teleported player position. */
export function climbIntent(
  state: ClimbState, player: PlayerState, input: InputFrame, vines: readonly ClimbableVine[], tick: number,
): ClimbIntent {
  const bounds = playerBounds(player), events: ClimbEvent[] = [];
  const touching = vines.filter(vine => overlaps(bounds, vine.bounds));
  const blockedVineId = touching.some(vine => vine.id === state.blockedVineId) ? state.blockedVineId : null;
  let vine = touching.find(vine => vine.id === state.vineId);
  if (state.vineId !== null && !vine) events.push({ type: "vine-detach", tick, vineId: state.vineId, reason: "lost" });
  if (input.jump.pressed) {
    if (!vine) return { kind: "free", state: { vineId: null, blockedVineId }, events };
    events.push({ type: "vine-detach", tick, vineId: vine.id, reason: "jump" });
    return { kind: "jump", vy: PHYSICS.jump, state: { vineId: null, blockedVineId: vine.id }, events };
  }
  const direction = Number(input.down.held) - Number(input.up.held);
  if (!vine && direction !== 0) {
    vine = touching.filter(candidate => candidate.id !== blockedVineId)
      .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)[0];
    if (vine) events.push({ type: "vine-attach", tick, vineId: vine.id });
  }
  if (!vine) return { kind: "free", state: { vineId: null, blockedVineId }, events };
  // Head cannot climb above the vine top; feet cannot climb below its bottom.
  // Partial-overlap attachment is allowed, but never snaps an already exterior player inward.
  const top = vine.bounds.y + bounds.height, bottom = vine.bounds.y + vine.bounds.height;
  let dy = 0;
  if (direction < 0 && player.y > top) dy = -Math.min(1, player.y - top);
  if (direction > 0 && player.y < bottom) dy = Math.min(1, bottom - player.y);
  return { kind: "climb", dx: 0, dy, vx: 0, vy: 0, state: { vineId: vine.id, blockedVineId }, events };
}
