import { PHYSICS } from "./physics";

/** RAF is only a wall-clock adapter. Dropped wall time never increments authoritative tick numbers. */
export class FixedClock {
  private last: number | null = null;
  private debt = 0;
  private active = false;
  private dropped = 0;
  readonly tickMs = 1000 / PHYSICS.hz;
  resume(): void { this.active = true; this.last = null; this.debt = 0; }
  pause(): void { this.active = false; this.last = null; this.debt = 0; }
  frame(now: number, tick: () => void): number {
    if (!this.active) return 0;
    if (this.last === null) { this.last = now; return 0; }
    const elapsed = Math.max(0, now - this.last); this.last = now;
    const backlog = this.debt + elapsed, cap = this.tickMs * 5;
    this.dropped += Math.max(0, backlog - cap); this.debt = Math.min(backlog, cap);
    let ticks = 0;
    while (this.active && ticks < 5 && this.debt + 1e-9 >= this.tickMs) {
      this.debt = Math.max(0, this.debt - this.tickMs); ticks++; tick();
    }
    return ticks;
  }
  get state() { return { active: this.active, debtMs: this.debt, droppedMs: this.dropped, alpha: this.debt / this.tickMs }; }
}
