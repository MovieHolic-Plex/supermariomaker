import type { InputFrame } from "../input";
import { currentArea } from "./state";
import type { GameEvent, Runtime } from "./state";
import { hasSolidOverlap, playerBounds, sweepAxis } from "./collision";
import { PHYSICS, snapPosition } from "./physics";

/** One active 60Hz tick. Host must consume input edges once, never once per render. */
export function step(runtime: Runtime, input: InputFrame): GameEvent[] {
  const player = runtime.player, area = currentArea(runtime), events: GameEvent[] = [];
  runtime.tick++;
  // 1. Input/player intent. Opposite axes are neutral; jump has no buffer or grace period.
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
  if (input.jump.pressed && player.grounded) {
    player.vy = PHYSICS.jump; player.grounded = false; player.risingTicks = 0;
    events.push({ type: "jump", tick: runtime.tick });
  }
  // A tap entirely between ticks still jumps, then releases in this same tick.
  if (input.jump.released && player.vy < PHYSICS.releaseClamp) player.vy = PHYSICS.releaseClamp;
  const rising = player.vy < 0;
  const heldGravity = input.jump.held && rising && player.risingTicks < PHYSICS.heldTicks;
  player.vy = Math.min(PHYSICS.fallCap, player.vy + (heldGravity ? PHYSICS.heldGravity : PHYSICS.gravity));
  player.risingTicks = rising ? player.risingTicks + 1 : 0;
  // 2. Actor intents (task 8/9). 3. Terrain movement: swept X, then swept Y.
  const x = sweepAxis(area, playerBounds(player), player.vx, "x");
  player.x = snapPosition(player.x + x.distance);
  if (x.contacts.length) player.vx = 0;
  const y = sweepAxis(area, playerBounds(player), player.vy, "y");
  player.y = snapPosition(player.y + y.distance);
  player.grounded = y.contacts.some(contact => contact.normal === -1);
  if (y.contacts.length) player.vy = 0;
  runtime.contacts = [...x.contacts, ...y.contacts];
  for (const contact of runtime.contacts) events.push({ type: "contact", tick: runtime.tick, contact });
  // 4. Actor interactions, 5. queued terrain/spawns, 6. terminal conditions are later feature owners.
  return events;
}
