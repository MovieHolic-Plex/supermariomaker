import type { CourseStart, CourseV1 } from "../level/types";
import type { InputFrame, PauseReason } from "../input";
import { createRuntime } from "./state";
import type { GameEvent, Runtime } from "./state";
import { step } from "./step";

export const DEATH_FREEZE_TICKS = 45;
export type RunMode = "PLAYING" | "PAUSED" | "DEAD" | "CLEARED" | "GAME_OVER";

export interface Run {
  readonly authored: CourseV1;
  readonly spawn: CourseStart;
  runtime: Runtime;
  mode: RunMode;
  pauseReason: PauseReason | null;
  deathTicks: number;
}

export function createRun(course: CourseV1, spawnOverride?: CourseStart): Run {
  const authored = structuredClone(course);
  const spawn = spawnOverride ?? { ...authored.start };
  return { authored, spawn, runtime: createRuntime(authored, spawnOverride), mode: "PLAYING", pauseReason: null, deathTicks: 0 };
}

export function pauseRun(run: Run, reason: PauseReason = "button"): void {
  if (run.mode !== "PLAYING") return;
  run.mode = "PAUSED";
  run.pauseReason = reason;
}

export function resumeRun(run: Run): void {
  if (run.mode !== "PAUSED") return;
  run.mode = "PLAYING";
  run.pauseReason = null;
}

export function stepRun(run: Run, input: InputFrame): GameEvent[] {
  if (run.mode === "PAUSED" || run.mode === "DEAD" || run.mode === "GAME_OVER" || run.mode === "CLEARED") return [];
  if (run.runtime.combat.defeated) {
    run.deathTicks++;
    if (run.deathTicks < DEATH_FREEZE_TICKS) return [];
    run.runtime.progress.lives--;
    const events: GameEvent[] = [{ type: "lifeLost", tick: run.runtime.tick, lives: run.runtime.progress.lives }];
    if (run.runtime.progress.lives <= 0) {
      run.mode = "GAME_OVER";
      events.push({ type: "gameOver", tick: run.runtime.tick });
    } else run.mode = "DEAD";
    return events;
  }
  const events = step(run.runtime, input);
  if (events.some(event => event.type === "courseClear")) run.mode = "CLEARED";
  return events;
}

function restore(run: Run, progress: Runtime["progress"]): void {
  run.runtime = createRuntime(run.authored, run.spawn);
  run.runtime.progress.lives = progress.lives;
  run.runtime.progress.score = progress.score;
  run.runtime.progress.coins = progress.coins;
  run.runtime.player.form = "small";
  run.runtime.player.crouched = false;
  run.mode = "PLAYING";
  run.pauseReason = null;
  run.deathTicks = 0;
}

export function retryRun(run: Run): void {
  if (run.mode !== "DEAD") return;
  restore(run, { ...run.runtime.progress });
}

export function restartRun(run: Run): void {
  restore(run, { lives: 3, score: 0, coins: 0 });
}
