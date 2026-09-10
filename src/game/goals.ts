import { objectBounds } from "../level/validate";
import type { PlacedObject } from "../level/types";
import { overlaps, playerBounds } from "./collision";
import { PHYSICS, snapPosition } from "./physics";
import { awardScore, damagePlayer } from "./player";
import { currentArea } from "./state";
import type { GameEvent, Runtime } from "./state";

export const GOAL_CLEAR_TICKS = 120;
export const FLAG_SLIDE_SPEED = 4;
export const FLAG_WALK_DISTANCE = 48;
export const TIMER_PULSE_TICKS = 60;

const compareId = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

function goalsIn(runtime: Runtime): PlacedObject[] {
  return currentArea(runtime).source.objects
    .filter(object => object.kind === "flagGoal" || object.kind === "castleGoal")
    .sort((a, b) => compareId(a.id, b.id));
}

function grabFlag(runtime: Runtime, object: Extract<PlacedObject, { kind: "flagGoal" }>, events: GameEvent[]): void {
  const player = runtime.player;
  player.x = object.x;
  player.vx = 0;
  player.vy = 0;
  player.facing = 1;
  player.skidding = false;
  runtime.ending = {
    kind: "flag", goalId: object.id, elapsed: 0, phase: "slide",
    flagY: object.y - object.props.height * 16 + 24,
    poleX: object.x, poleBottom: object.y, height: object.props.height,
  };
  awardScore(runtime, "goal", events);
  events.push({ type: "flag-grab", tick: runtime.tick, goalId: object.id });
}

function grabAxe(runtime: Runtime, object: Extract<PlacedObject, { kind: "castleGoal" }>, events: GameEvent[]): void {
  const area = currentArea(runtime);
  if (!area.collapsedGoalIds.includes(object.id)) area.collapsedGoalIds = [...area.collapsedGoalIds, object.id];
  const bowserId = object.props.bowserId;
  if (bowserId) {
    const actor = runtime.hazards.actors.get(bowserId);
    if (actor?.kind === "bowser") actor.falling = true;
  }
  runtime.player.vx = 0;
  runtime.player.vy = 0;
  runtime.player.skidding = false;
  runtime.ending = { kind: "castle", goalId: object.id, elapsed: 0, phase: "collapse", ...(bowserId ? { bowserId } : {}) };
  awardScore(runtime, "goal", events);
  events.push({ type: "axe", tick: runtime.tick, goalId: object.id });
  events.push({ type: "bridge-collapse", tick: runtime.tick, goalId: object.id });
}

function tryBeginGoal(runtime: Runtime, events: GameEvent[]): void {
  if (runtime.combat.defeated || runtime.ending.kind !== "none") return;
  const bounds = playerBounds(runtime.player);
  for (const object of goalsIn(runtime)) {
    if (!overlaps(bounds, objectBounds(object))) continue;
    if (object.kind === "flagGoal") grabFlag(runtime, object, events);
    else if (object.kind === "castleGoal") grabAxe(runtime, object, events);
    return;
  }
}

function dropBowser(runtime: Runtime): void {
  if (runtime.ending.kind !== "castle" || !runtime.ending.bowserId) return;
  const actor = runtime.hazards.actors.get(runtime.ending.bowserId);
  if (!actor || (actor.kind !== "bowser" && actor.kind !== "defeated")) return;
  actor.vx = 0;
  actor.vy = Math.min(PHYSICS.fallCap, actor.vy + PHYSICS.gravity);
  actor.y = snapPosition(actor.y + actor.vy);
}

export function advanceEnding(runtime: Runtime, events: GameEvent[]): void {
  const ending = runtime.ending, player = runtime.player;
  if (ending.kind === "none") return;
  runtime.ending = { ...ending, elapsed: ending.elapsed + 1 };
  const next = runtime.ending;
  if (next.kind === "flag") {
    if (next.phase === "slide") {
      player.x = next.poleX;
      player.vx = 0;
      player.vy = 0;
      player.facing = 1;
      player.skidding = false;
      player.grounded = false;
      player.y = snapPosition(Math.min(next.poleBottom, player.y + FLAG_SLIDE_SPEED));
      runtime.ending = { ...next, flagY: snapPosition(Math.min(next.poleBottom - 8, next.flagY + FLAG_SLIDE_SPEED)) };
      if (player.y >= next.poleBottom) {
        player.y = next.poleBottom;
        player.grounded = true;
        runtime.ending = { ...runtime.ending, phase: "walk" };
      }
    } else if (next.phase === "walk") {
      player.facing = 1;
      player.skidding = false;
      player.grounded = true;
      player.vy = 0;
      player.vx = PHYSICS.walkCap;
      player.x = snapPosition(player.x + PHYSICS.walkCap);
      if (player.x >= next.poleX + FLAG_WALK_DISTANCE) {
        player.x = next.poleX + FLAG_WALK_DISTANCE;
        player.vx = 0;
        runtime.ending = { ...next, phase: "wait", elapsed: next.elapsed };
      }
    } else {
      player.vx = 0;
      player.vy = 0;
    }
  } else if (next.kind === "castle") {
    if (next.elapsed === 1) runtime.ending = { ...next, phase: "fall" };
    dropBowser(runtime);
    player.vx = 0;
    player.vy = 0;
  }
  const current = runtime.ending;
  if ((current.kind === "flag" || current.kind === "castle") && current.elapsed === GOAL_CLEAR_TICKS) {
    events.push({ type: "courseClear", tick: runtime.tick, ending: current.kind });
    runtime.ending = { ...current, phase: "wait" };
  }
}

export function resolveTerminal(runtime: Runtime, events: GameEvent[]): void {
  if (runtime.ending.kind !== "none") return;
  const area = currentArea(runtime);
  if (!runtime.combat.defeated && runtime.player.y >= area.source.height * 16) {
    damagePlayer(runtime, { sourceId: "pit", kind: "pit" }, events);
  }
  if (!runtime.combat.defeated && runtime.transition.kind === "idle" && runtime.course.timerSeconds > 0) {
    runtime.timer.pulse++;
    if (runtime.timer.pulse >= TIMER_PULSE_TICKS) {
      runtime.timer.pulse = 0;
      runtime.timer.remaining = Math.max(0, runtime.timer.remaining - 1);
      events.push({ type: "timer", tick: runtime.tick, remaining: runtime.timer.remaining });
      if (runtime.timer.remaining === 0) damagePlayer(runtime, { sourceId: "timer", kind: "timeout" }, events);
    }
  }
  if (!runtime.combat.defeated) tryBeginGoal(runtime, events);
}
