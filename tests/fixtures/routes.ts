import type { InputAction, InputFrame } from "../../src/input";
import type { Theme } from "../../src/level/types";

export type SampleTheme = Theme;
export type RouteKey = Exclude<InputAction, "pause">;
export type RouteSegment = Readonly<{ ticks: number; keys: readonly RouteKey[] }>;

/** Hold-right completions. Jump is unused because each sample keeps a clear floor to its goal. */
export const SAMPLE_ROUTES: Record<SampleTheme, readonly RouteSegment[]> = {
  overworld: [
    { ticks: 280, keys: ["right", "run"] },
    { ticks: 160, keys: [] },
  ],
  underground: [
    { ticks: 280, keys: ["right", "run"] },
    { ticks: 160, keys: [] },
  ],
  underwater: [
    { ticks: 520, keys: ["right"] },
    { ticks: 160, keys: [] },
  ],
  castle: [
    { ticks: 300, keys: ["right", "run"] },
    { ticks: 160, keys: [] },
  ],
};

function button(held: ReadonlySet<RouteKey>, previous: ReadonlySet<RouteKey>, action: InputAction): InputFrame[InputAction] {
  const on = action !== "pause" && held.has(action);
  const was = action !== "pause" && previous.has(action);
  return { held: on, pressed: on && !was, released: !on && was };
}

export function framesForRoute(route: readonly RouteSegment[]): InputFrame[] {
  const frames: InputFrame[] = [];
  let previous = new Set<RouteKey>();
  for (const segment of route) {
    if (!Number.isSafeInteger(segment.ticks) || segment.ticks < 1) throw new Error("Route segment ticks must be a positive integer");
    const held = new Set(segment.keys);
    for (let i = 0; i < segment.ticks; i++) {
      frames.push({
        left: button(held, previous, "left"),
        right: button(held, previous, "right"),
        up: button(held, previous, "up"),
        down: button(held, previous, "down"),
        jump: button(held, previous, "jump"),
        run: button(held, previous, "run"),
        pause: button(held, previous, "pause"),
      });
      previous = held;
    }
  }
  return frames;
}
