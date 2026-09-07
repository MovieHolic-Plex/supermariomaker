export const INPUT_ACTIONS = ["left", "right", "up", "down", "jump", "run", "pause"] as const;
export type InputAction = typeof INPUT_ACTIONS[number];
export interface ButtonFrame { readonly held: boolean; readonly pressed: boolean; readonly released: boolean }
export type InputFrame = Readonly<Record<InputAction, ButtonFrame>>;
const idle = Object.freeze({ held: false, pressed: false, released: false });
export const EMPTY_INPUT: InputFrame = Object.freeze({ left: idle, right: idle, up: idle, down: idle, jump: idle, run: idle, pause: idle });
const bindings: Readonly<Record<string, InputAction>> = {
  ArrowLeft: "left", KeyA: "left", ArrowRight: "right", KeyD: "right", ArrowUp: "up",
  ArrowDown: "down", KeyS: "down", Space: "jump", KeyZ: "jump", ShiftLeft: "run", ShiftRight: "run", KeyX: "run", Escape: "pause",
};
/** Logical edges are latched until ONE simulation tick consumes them, including down+up between RAFs. */
export class InputBuffer {
  private readonly keys = new Set<string>();
  private readonly pressed = new Set<InputAction>();
  private readonly released = new Set<InputAction>();
  private held(action: InputAction): boolean { return [...this.keys].some(code => bindings[code] === action); }
  key(code: string, down: boolean, repeat = false): boolean {
    const action = bindings[code];
    if (!action) return false;
    if (repeat || (down && this.keys.has(code))) return true;
    const before = this.held(action);
    if (down) this.keys.add(code); else this.keys.delete(code);
    const after = this.held(action);
    if (!before && after) this.pressed.add(action);
    if (before && !after) this.released.add(action);
    return true;
  }
  consume(): InputFrame {
    const frame = { ...EMPTY_INPUT };
    for (const action of INPUT_ACTIONS) frame[action] = { held: this.held(action), pressed: this.pressed.has(action), released: this.released.has(action) };
    this.pressed.clear(); this.released.clear(); return frame;
  }
  clear(): void { this.keys.clear(); this.pressed.clear(); this.released.clear(); }
}
export type PauseReason = "button" | "escape" | "blur" | "hidden";
/** Keyboard capture is canvas-focused only; form controls retain native key behavior. */
export function attachInput(canvas: HTMLCanvasElement, pause: (reason: PauseReason) => void) {
  const buffer = new InputBuffer(), events = new AbortController();
  let active = false;
  const document = canvas.ownerDocument, window = document.defaultView;
  if (!window) throw new Error("Game canvas needs a window");
  window.addEventListener("keydown", event => {
    if (document.activeElement !== canvas || event.isComposing || event.ctrlKey || event.altKey || event.metaKey || !bindings[event.code]) return;
    // A paused, focused game canvas still owns navigation keys; Space must not scroll the page.
    // Do not latch them: explicit resume starts from empty input, not from paused key presses.
    event.preventDefault();
    if (!active) return;
    buffer.key(event.code, true, event.repeat);
    if (event.code === "Escape" && !event.repeat) pause("escape");
  }, { signal: events.signal });
  window.addEventListener("keyup", event => {
    if (buffer.key(event.code, false) && active && document.activeElement === canvas) event.preventDefault();
  }, { signal: events.signal });
  canvas.addEventListener("blur", () => buffer.clear(), { signal: events.signal });
  window.addEventListener("blur", () => { buffer.clear(); if (active) pause("blur"); }, { signal: events.signal });
  document.addEventListener("visibilitychange", () => { if (document.hidden) { buffer.clear(); if (active) pause("hidden"); } }, { signal: events.signal });
  return {
    consume: (): InputFrame => buffer.consume(),
    setActive(value: boolean): void { active = value; buffer.clear(); },
    dispose(): void { active = false; buffer.clear(); events.abort(); },
    get disposed(): boolean { return events.signal.aborted; },
  };
}
