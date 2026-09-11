import type { InputFrame } from "../input";
import type { GameEvent, Runtime } from "./state";
import { currentArea } from "./state";
import { PHYSICS } from "./physics";

/** Current-area theme selects the profile. There is no process-wide water flag. */
export function isUnderwater(runtime: Runtime): boolean {
  return currentArea(runtime).source.theme === "underwater";
}

/** Swim strokes are rising-edge only and share the 60Hz step; cooldown is tick-counted. */
export function applyUnderwaterIntent(runtime: Runtime, input: InputFrame, events: GameEvent[]): void {
  const player = runtime.player, water = PHYSICS.water;
  player.crouched = false;
  const direction = Number(input.right.held) - Number(input.left.held);
  player.skidding = direction !== 0 && player.vx * direction < 0;
  if (direction === 0) player.vx = Math.sign(player.vx) * Math.max(0, Math.abs(player.vx) - PHYSICS.friction);
  else {
    player.facing = direction > 0 ? 1 : -1;
    player.vx = Math.max(-water.cap, Math.min(water.cap, player.vx + direction * water.acceleration));
  }
  const cooling = player.swimCooldown > 0;
  if (cooling) player.swimCooldown--;
  if (input.jump.pressed && !cooling) {
    player.vy = water.swim; player.grounded = false; player.risingTicks = 0;
    player.swimCooldown = water.cooldown;
    events.push({ type: "swim", tick: runtime.tick });
  }
  const rising = player.vy < 0;
  player.vy = Math.min(water.fallCap, player.vy + water.gravity);
  player.risingTicks = rising ? player.risingTicks + 1 : 0;
}
