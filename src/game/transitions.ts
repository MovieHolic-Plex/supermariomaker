import type { InputFrame } from "../input";
import type { PlacedObject } from "../level/types";
import { hasSolidOverlap, playerBounds } from "./collision";
import { PHYSICS, snapPosition } from "./physics";
import type { GameEvent, Runtime } from "./state";

export const PIPE_TRANSITION_TICKS = 30;
export const PIPE_CENTER_TOLERANCE = 4;

type PipeObject = Extract<PlacedObject, { kind: "pipe" }>;
export type TransitionState =
  | Readonly<{ kind: "idle" }>
  | Readonly<{
    kind: "pipe"; elapsed: number; entrance: "up" | "down";
    fromAreaId: string; fromPipeId: string; toAreaId: string; toPipeId: string;
  }>;
export type TransitionEvent =
  | Readonly<{ type: "pipe-enter"; tick: number; pipeId: string; areaId: string }>
  | Readonly<{ type: "pipe-exit"; tick: number; pipeId: string; areaId: string }>
  | Readonly<{ type: "pipe-reject"; tick: number; pipeId: string; reason: "unlinked" | "exit" }>;

export function createTransitionState(): TransitionState {
  return { kind: "idle" };
}

function asPipe(object: PlacedObject | undefined): PipeObject | undefined {
  return object?.kind === "pipe" ? object : undefined;
}

function mouthY(pipe: PipeObject): number {
  return pipe.props.entrance === "up" ? pipe.y : pipe.y - pipe.props.height * 16;
}

export function exitPosition(pipe: PipeObject, height: number = PHYSICS.smallHeight): Readonly<{ x: number; y: number }> {
  if (pipe.props.entrance === "up") return { x: pipe.x, y: pipe.y + height };
  return { x: pipe.x, y: mouthY(pipe) };
}

function playerHeight(runtime: Runtime): 15 | 31 {
  return runtime.player.form === "small" || runtime.player.crouched ? PHYSICS.smallHeight : PHYSICS.tallHeight;
}

function pipesIn(runtime: Runtime, areaId: string): PipeObject[] {
  const area = runtime.areas.get(areaId);
  if (!area) return [];
  return area.source.objects.filter((object): object is PipeObject => object.kind === "pipe").sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function destClear(runtime: Runtime, destAreaId: string, destPipe: PipeObject): boolean {
  const area = runtime.areas.get(destAreaId);
  if (!area) return false;
  const pos = exitPosition(destPipe, playerHeight(runtime));
  const bounds = playerBounds({ ...runtime.player, x: pos.x, y: pos.y });
  const areaBounds = { x: 0, y: 0, width: area.source.width * 16, height: area.source.height * 16 };
  if (bounds.x < areaBounds.x || bounds.y < areaBounds.y
    || bounds.x + bounds.width > areaBounds.x + areaBounds.width
    || bounds.y + bounds.height > areaBounds.y + areaBounds.height) return false;
  return !hasSolidOverlap(area, bounds, new Set([destPipe.id]));
}

function aligned(runtime: Runtime, pipe: PipeObject, direction: "up" | "down"): boolean {
  const player = runtime.player;
  if (Math.abs(player.x - pipe.x) > PIPE_CENTER_TOLERANCE) return false;
  if (direction === "down") return player.grounded && Math.abs(player.y - mouthY(pipe)) <= PIPE_CENTER_TOLERANCE;
  const height = playerHeight(runtime);
  return player.y >= pipe.y && player.y <= pipe.y + height + PIPE_CENTER_TOLERANCE;
}

function tryEnter(runtime: Runtime, input: InputFrame): GameEvent[] {
  if (runtime.combat.defeated) return [];
  const direction = input.down.held && !input.up.held ? "down" as const : input.up.held && !input.down.held ? "up" as const : null;
  if (!direction) return [];
  for (const pipe of pipesIn(runtime, runtime.areaId)) {
    if (pipe.props.entrance !== direction || !aligned(runtime, pipe, direction)) continue;
    const dest = pipe.props.destination;
    if (!dest) {
      return [{ type: "pipe-reject", tick: runtime.tick, pipeId: pipe.id, reason: "unlinked" }];
    }
    const destPipe = asPipe(runtime.areas.get(dest.areaId)?.source.objects.find(object => object.id === dest.pipeId));
    if (!destPipe) {
      return [{ type: "pipe-reject", tick: runtime.tick, pipeId: pipe.id, reason: "unlinked" }];
    }
    if (!destClear(runtime, dest.areaId, destPipe)) {
      return [{ type: "pipe-reject", tick: runtime.tick, pipeId: pipe.id, reason: "exit" }];
    }
    runtime.player.x = pipe.x;
    runtime.player.vx = 0;
    runtime.player.vy = 0;
    runtime.transition = {
      kind: "pipe", elapsed: 1, entrance: direction,
      fromAreaId: runtime.areaId, fromPipeId: pipe.id, toAreaId: dest.areaId, toPipeId: dest.pipeId,
    };
    return [{ type: "pipe-enter", tick: runtime.tick, pipeId: pipe.id, areaId: runtime.areaId }];
  }
  return [];
}

function finish(runtime: Runtime, transition: Extract<TransitionState, { kind: "pipe" }>): GameEvent[] {
  const destPipe = asPipe(runtime.areas.get(transition.toAreaId)?.source.objects.find(object => object.id === transition.toPipeId));
  runtime.areaId = transition.toAreaId;
  runtime.transition = { kind: "idle" };
  runtime.player.vx = 0;
  runtime.player.vy = 0;
  if (destPipe) {
    const pos = exitPosition(destPipe, playerHeight(runtime));
    runtime.player.x = pos.x;
    runtime.player.y = pos.y;
    runtime.player.grounded = destPipe.props.entrance !== "up";
  }
  return [{ type: "pipe-exit", tick: runtime.tick, pipeId: transition.toPipeId, areaId: transition.toAreaId }];
}

/** Input is ignored for the locked 30 ticks. The authored course is never written. */
export function stepTransition(runtime: Runtime, input: InputFrame): GameEvent[] | null {
  if (runtime.transition.kind === "pipe") {
    const next = { ...runtime.transition, elapsed: runtime.transition.elapsed + 1 };
    runtime.transition = next;
    runtime.player.vx = 0;
    runtime.player.vy = 0;
    runtime.player.x = pipesIn(runtime, next.fromAreaId).find(pipe => pipe.id === next.fromPipeId)?.x ?? runtime.player.x;
    runtime.player.y = snapPosition(runtime.player.y + (next.entrance === "down" ? 1 : -1));
    if (next.elapsed >= PIPE_TRANSITION_TICKS) return finish(runtime, next);
    return [];
  }
  const entered = tryEnter(runtime, input);
  return entered.length ? entered : null;
}
