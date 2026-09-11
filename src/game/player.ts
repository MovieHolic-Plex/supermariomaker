import { hasSolidOverlap, playerBounds } from "./collision";
import { PHYSICS } from "./physics";
import { currentArea } from "./state";
import type { GameEvent, PlayerState, Runtime } from "./state";

/** All run score values, including the later enemy/goal consumers, live here. */
export const SCORE = Object.freeze({ coin: 200, block: 50, powerup: 1000,
  chain: Object.freeze([100, 200, 400, 800, 1000, 2000, 4000, 8000]), goal: 5000 });
export interface ProgressState { lives: number; score: number; coins: number }
export interface CombatState { starTicks: number; invulnerabilityTicks: number; defeated: boolean }
export interface DamageHit { readonly sourceId: string; readonly kind: "contact" | "projectile" | "crush" | "pit" | "timeout" }
export type DamageResult = "ignored" | "shrunk" | "defeated";
export type ProgressEvent =
  | Readonly<{ type: "score"; tick: number; reason: "coin" | "block" | "powerup" | "chain" | "goal"; points: number; total: number }>
  | Readonly<{ type: "coin"; tick: number; sourceId: string; coins: number }>
  | Readonly<{ type: "oneUp"; tick: number; reason: "coins" | "item" | "chain"; lives: number }>
  | Readonly<{ type: "form"; tick: number; from: PlayerState["form"]; to: PlayerState["form"]; sourceId: string }>
  | Readonly<{ type: "starStart" | "starEnd" | "invulnerabilityEnd"; tick: number }>
  | Readonly<{ type: "damage"; tick: number; hit: DamageHit; from: PlayerState["form"]; to: PlayerState["form"] }>
  | Readonly<{ type: "playerDefeated"; tick: number; hit: DamageHit }>
  | Readonly<{ type: "lifeLost"; tick: number; lives: number }>
  | Readonly<{ type: "gameOver"; tick: number }>;
export function awardScore(runtime: Runtime, reason: "coin" | "block" | "powerup" | "goal", events: GameEvent[]): void {
  const points = SCORE[reason]; runtime.progress.score += points;
  events.push({ type: "score", tick: runtime.tick, reason, points, total: runtime.progress.score });
}
export function grantLife(runtime: Runtime, reason: "coins" | "item" | "chain", events: GameEvent[]): void {
  runtime.progress.lives++; events.push({ type: "oneUp", tick: runtime.tick, reason, lives: runtime.progress.lives });
}
/** Zero-based kill index; the caller owns stomp/shell chain reset semantics. */
export function awardChain(runtime: Runtime, index: number, events: GameEvent[]): void {
  const points = SCORE.chain[index];
  if (points === undefined) { grantLife(runtime, "chain", events); return; }
  runtime.progress.score += points; events.push({ type: "score", tick: runtime.tick, reason: "chain", points, total: runtime.progress.score });
}
export function collectCoin(runtime: Runtime, sourceId: string, events: GameEvent[]): void {
  runtime.progress.coins++;
  if (runtime.progress.coins === 100) { runtime.progress.coins = 0; grantLife(runtime, "coins", events); }
  awardScore(runtime, "coin", events);
  events.push({ type: "coin", tick: runtime.tick, sourceId, coins: runtime.progress.coins });
}
export function growPlayer(runtime: Runtime, form: "super" | "fire", sourceId: string, events: GameEvent[]): void {
  const player = runtime.player, from = player.form;
  player.form = form;
  player.crouched = hasSolidOverlap(currentArea(runtime), playerBounds(player, PHYSICS.tallHeight));
  if (from !== form) events.push({ type: "form", tick: runtime.tick, from, to: form, sourceId });
}
/** Tick-start decrement: a pickup/damage on tick T receives its full duration at T's end. */
export function advanceCombat(runtime: Runtime, events: GameEvent[]): void {
  const combat = runtime.combat;
  if (combat.starTicks > 0 && --combat.starTicks === 0) events.push({ type: "starEnd", tick: runtime.tick });
  if (combat.invulnerabilityTicks > 0 && --combat.invulnerabilityTicks === 0) events.push({ type: "invulnerabilityEnd", tick: runtime.tick });
}
/** Enemy integration calls this during interactions. Life consumption belongs to run.ts. */
export function damagePlayer(runtime: Runtime, hit: DamageHit, events: GameEvent[]): DamageResult {
  const combat = runtime.combat, player = runtime.player;
  if (combat.defeated) return "ignored";
  const lethal = hit.kind === "crush" || hit.kind === "pit" || hit.kind === "timeout";
  if (!lethal && (combat.starTicks > 0 || combat.invulnerabilityTicks > 0)) return "ignored";
  if (lethal || player.form === "small") {
    combat.defeated = true; events.push({ type: "playerDefeated", tick: runtime.tick, hit }); return "defeated";
  }
  const from = player.form; player.form = from === "fire" ? "super" : "small";
  if (player.form === "small") player.crouched = false;
  combat.invulnerabilityTicks = 120;
  events.push({ type: "damage", tick: runtime.tick, hit, from, to: player.form }); return "shrunk";
}
