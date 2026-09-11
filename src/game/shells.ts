export type ShellOccupant = "greenKoopa" | "redKoopa" | "buzzy";
export interface ShellState {
  occupant: ShellOccupant;
  moving: boolean;
  idleTicks: number;
  /** Single-player kicker grace uses authoritative runtime ticks, never wall time. */
  kickedAtTick: number | null;
  /** One-based defeat indices are emitted by combat; this is not a score value. */
  chain: number;
}
export const SHELL_SPEED = 4;
export const SHELL_WAKE_TICKS = 600;
export const SHELL_WIGGLE_TICKS = 120;
export const SHELL_KICKER_GRACE = 8;
export function createShellState(occupant: ShellOccupant): ShellState {
  return { occupant, moving: false, idleTicks: 0, kickedAtTick: null, chain: 0 };
}
export function kickShell(shell: ShellState, tick: number): void {
  shell.moving = true; shell.idleTicks = 0; shell.kickedAtTick = tick; shell.chain = 0;
}
export function stopShell(shell: ShellState): void {
  shell.moving = false; shell.idleTicks = 0; shell.kickedAtTick = null; shell.chain = 0;
}
/** Called once per active motion tick; the owner commits a true wake AFTER interactions. */
export function advanceShell(shell: ShellState): boolean {
  if (shell.moving) return false;
  shell.idleTicks++;
  return shell.idleTicks === SHELL_WAKE_TICKS;
}
export function shellWiggling(shell: ShellState): boolean {
  return !shell.moving && shell.idleTicks >= SHELL_WAKE_TICKS - SHELL_WIGGLE_TICKS && shell.idleTicks < SHELL_WAKE_TICKS;
}
export function kickerProtected(shell: ShellState, tick: number): boolean {
  return shell.moving && shell.kickedAtTick !== null && tick >= shell.kickedAtTick && tick - shell.kickedAtTick < SHELL_KICKER_GRACE;
}
