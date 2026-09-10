import { describe, expect, test } from "bun:test";
import { EMPTY_INPUT } from "../src/input";
import { createRuntime, currentArea, snapshot } from "../src/game/state";
import { step } from "../src/game/step";
import { SCORE } from "../src/game/player";
import { colliders, sweepAxis } from "../src/game/collision";
import { queueItem, commitItems } from "../src/game/items";
import { GOAL_CLEAR_TICKS } from "../src/game/goals";
import { createRun, DEATH_FREEZE_TICKS, pauseRun, restartRun, resumeRun, retryRun, stepRun } from "../src/game/run";
import { hudModel } from "../src/ui/hud";
import { createGoalFixture, GOAL_IDS } from "./fixtures/goals";
import type { HazardActor } from "../src/game/hazards";

const idle = EMPTY_INPUT;
const right = { ...EMPTY_INPUT, right: { held: true, pressed: false, released: false } };

function ticks(runtime: ReturnType<typeof createRuntime>, count: number, input = idle) {
  const events = [];
  for (let i = 0; i < count; i++) events.push(...step(runtime, input));
  return events;
}

function bowserOf(runtime: ReturnType<typeof createRuntime>): HazardActor {
  const actor = runtime.hazards.actors.get(GOAL_IDS.bowser);
  expect(actor).toBeDefined();
  if (!actor) throw new Error("missing bowser");
  return actor;
}

describe("timer", () => {
  test("decrements once per 60 active ticks and timeout is lethal", () => {
    const runtime = createRuntime(createGoalFixture("timeout"));
    expect(runtime.timer.remaining).toBe(30);
    expect(runtime.timer.pulse).toBe(0);
    expect(ticks(runtime, 59).some(event => event.type === "timer")).toBe(false);
    expect(runtime.timer.remaining).toBe(30);
    const pulse = ticks(runtime, 1);
    expect(pulse).toContainEqual({ type: "timer", tick: 60, remaining: 29 });
    expect(runtime.timer.remaining).toBe(29);
    runtime.timer.remaining = 1;
    runtime.timer.pulse = 59;
    const death = step(runtime, idle);
    expect(death.some(event => event.type === "timer" && event.remaining === 0)).toBe(true);
    const lost = death.find(event => event.type === "playerDefeated");
    expect(lost).toMatchObject({ type: "playerDefeated", hit: { kind: "timeout", sourceId: "timer" } });
    expect(runtime.combat.defeated).toBe(true);
    expect(runtime.progress.lives).toBe(3);
    expect(runtime.ending.kind).toBe("none");
  });
  test("timer 0 is unlimited and never emits timeout", () => {
    const runtime = createRuntime(createGoalFixture("flag"));
    expect(runtime.timer.remaining).toBe(0);
    const events = ticks(runtime, 180);
    expect(runtime.timer.remaining).toBe(0);
    expect(runtime.combat.defeated).toBe(false);
    expect(events.some(event => event.type === "timer" || event.type === "playerDefeated")).toBe(false);
  });
});

describe("pause freeze", () => {
  test("paused run advances neither tick nor timer nor player", () => {
    const authored = createGoalFixture("timeout");
    const frozen = JSON.stringify(authored);
    const run = createRun(authored);
    ticks(run.runtime, 10);
    stepRun(run, right);
    const tick = run.runtime.tick;
    const pulse = run.runtime.timer.pulse;
    const remaining = run.runtime.timer.remaining;
    const x = run.runtime.player.x;
    pauseRun(run, "button");
    expect(run.mode).toBe("PAUSED");
    for (let i = 0; i < 90; i++) expect(stepRun(run, right)).toEqual([]);
    expect(run.runtime.tick).toBe(tick);
    expect(run.runtime.timer.pulse).toBe(pulse);
    expect(run.runtime.timer.remaining).toBe(remaining);
    expect(run.runtime.player.x).toBe(x);
    resumeRun(run);
    expect(run.mode).toBe("PLAYING");
    expect(stepRun(run, idle).length).toBeGreaterThan(0);
    expect(run.runtime.tick).toBe(tick + 1);
    expect(JSON.stringify(authored)).toBe(frozen);
    expect(JSON.stringify(run.authored)).toBe(frozen);
  });
});

describe("lethal damage beats goal", () => {
  test("timeout on the flag pole does not start a flag ending", () => {
    const runtime = createRuntime(createGoalFixture("timeout"));
    const before = JSON.stringify(runtime.course);
    runtime.player.x = 80;
    runtime.player.y = 208;
    runtime.timer.remaining = 1;
    runtime.timer.pulse = 59;
    const events = step(runtime, idle);
    expect(events.some(event => event.type === "playerDefeated" && event.hit.kind === "timeout")).toBe(true);
    expect(events.some(event => event.type === "flag-grab" || event.type === "courseClear" || event.type === "score")).toBe(false);
    expect(runtime.ending.kind).toBe("none");
    expect(runtime.combat.defeated).toBe(true);
    expect(runtime.progress.score).toBe(0);
    expect(JSON.stringify(runtime.course)).toBe(before);
  });
  test("pit death emits playerDefeated and consumes no life inside step", () => {
    const runtime = createRuntime(createGoalFixture("pit-flag"));
    runtime.player.x = 40;
    runtime.player.y = 240;
    runtime.player.grounded = false;
    const events = step(runtime, idle);
    expect(events.some(event => event.type === "playerDefeated" && event.hit.kind === "pit")).toBe(true);
    expect(runtime.progress.lives).toBe(3);
  });
});

describe("bowser without the axe", () => {
  test("five fireball hits defeat bowser and do not collapse the bridge or clear", () => {
    const runtime = createRuntime(createGoalFixture("castle"));
    runtime.player.form = "fire";
    const king = bowserOf(runtime);
    expect(king.kind).toBe("bowser");
    for (let hit = 1; hit <= 5; hit++) {
      const shot = queueItem(runtime, "fireball", king.x - 16, king.y - 8, "player");
      shot.emerging = 0; commitItems(runtime, []);
      Object.assign(shot, { x: king.x - 10, y: king.y - 16, vx: 3, vy: 0, age: 1, bornTick: 0 });
      const events = step(runtime, idle);
      expect(events.some(event => event.type === "bowser-hit" && event.hits === hit)).toBe(true);
      if (hit < 5) expect(events.some(event => event.type === "bowser-defeated")).toBe(false);
      else {
        expect(events.some(event => event.type === "bowser-defeated")).toBe(true);
        expect(events.some(event => event.type === "courseClear" || event.type === "axe" || event.type === "bridge-collapse")).toBe(false);
        expect(runtime.ending.kind).toBe("none");
        expect(currentArea(runtime).collapsedGoalIds).toEqual([]);
      }
    }
    expect(bowserOf(runtime).kind).toBe("defeated");
    const bridge = colliders(currentArea(runtime), { x: 12 * 16, y: 13 * 16, width: 8 * 16, height: 16 })
      .filter(collider => collider.source.kind === "object" && collider.source.part === "bridge");
    expect(bridge.length).toBeGreaterThan(0);
  });
});

describe("castle axe and bridge", () => {
  test("axe contact removes the bridge, drops bowser, then clears after 120 ticks", () => {
    const runtime = createRuntime(createGoalFixture("castle"));
    const authored = JSON.stringify(runtime.course);
    const king = bowserOf(runtime);
    expect(king.kind).toBe("bowser");
    const startY = king.y;
    runtime.player.x = 320;
    runtime.player.y = 208;
    const grab = step(runtime, idle);
    expect(grab.some(event => event.type === "axe" && event.goalId === GOAL_IDS.castle)).toBe(true);
    expect(grab.some(event => event.type === "bridge-collapse" && event.goalId === GOAL_IDS.castle)).toBe(true);
    expect(grab).toContainEqual({ type: "score", tick: 1, reason: "goal", points: SCORE.goal, total: SCORE.goal });
    expect(runtime.ending.kind).toBe("castle");
    expect(currentArea(runtime).collapsedGoalIds).toEqual([GOAL_IDS.castle]);
    const through = sweepAxis(currentArea(runtime), { x: 12 * 16 + 4, y: 13 * 16 - 16, width: 8, height: 16 }, 24, "y");
    expect(through.contacts.some(contact => contact.source.kind === "object" && contact.source.part === "bridge")).toBe(false);
    const falling = bowserOf(runtime);
    expect(falling.kind).toBe("bowser");
    if (falling.kind === "bowser") expect(falling.falling).toBe(true);
    const dropped = ticks(runtime, 20);
    expect(bowserOf(runtime).y).toBeGreaterThan(startY);
    expect(dropped.some(event => event.type === "courseClear")).toBe(false);
    const rest = ticks(runtime, GOAL_CLEAR_TICKS - 20);
    expect(rest.some(event => event.type === "courseClear" && event.ending === "castle")).toBe(true);
    if (runtime.ending.kind !== "castle") throw new Error("expected castle ending");
    expect(runtime.ending.elapsed).toBe(GOAL_CLEAR_TICKS);
    expect(JSON.stringify(runtime.course)).toBe(authored);
  });
});

describe("flagpole", () => {
  test("slide then walk-off then courseClear at 120, distinct from castle", () => {
    const runtime = createRuntime(createGoalFixture("flag"));
    runtime.player.x = 80;
    runtime.player.y = 140;
    runtime.player.grounded = false;
    const grab = step(runtime, right);
    expect(grab.some(event => event.type === "flag-grab" && event.goalId === GOAL_IDS.flag)).toBe(true);
    expect(grab).toContainEqual({ type: "score", tick: 1, reason: "goal", points: SCORE.goal, total: SCORE.goal });
    expect(runtime.ending.kind).toBe("flag");
    if (runtime.ending.kind !== "flag") throw new Error("expected flag ending");
    expect(runtime.player.x).toBe(80);
    expect(runtime.player.vx).toBe(0);
    const startY = runtime.player.y;
    const startFlag = runtime.ending.flagY;
    ticks(runtime, 8);
    if (runtime.ending.kind !== "flag") throw new Error("expected flag ending");
    expect(runtime.player.y).toBeGreaterThan(startY);
    expect(runtime.ending.flagY).toBeGreaterThan(startFlag);
    ticks(runtime, 40);
    if (runtime.ending.kind !== "flag") throw new Error("expected flag ending");
    expect(runtime.ending.phase === "walk" || runtime.ending.phase === "wait").toBe(true);
    if (runtime.ending.phase === "walk" || runtime.ending.phase === "wait") {
      expect(runtime.player.x).toBeGreaterThan(80);
      expect(runtime.player.facing).toBe(1);
    }
    const leftover = GOAL_CLEAR_TICKS - runtime.ending.elapsed;
    const finish = ticks(runtime, leftover);
    expect(finish.some(event => event.type === "courseClear" && event.ending === "flag")).toBe(true);
    expect(runtime.timer.remaining).toBe(0);
    expect(hudModel(runtime).ending).toBe("flag");
  });
});

describe("retry snapshot and lives", () => {
  test("death freeze then retry keeps score/coins, consumes one life, resets timer and form", () => {
    const authored = createGoalFixture("timeout");
    const frozen = JSON.stringify(authored);
    const run = createRun(authored);
    run.runtime.progress.score = 800;
    run.runtime.progress.coins = 7;
    run.runtime.player.form = "fire";
    run.runtime.timer.remaining = 1;
    run.runtime.timer.pulse = 59;
    const death = stepRun(run, idle);
    expect(death.some(event => event.type === "playerDefeated")).toBe(true);
    expect(run.mode).toBe("PLAYING");
    expect(run.runtime.progress.lives).toBe(3);
    for (let i = 0; i < DEATH_FREEZE_TICKS - 1; i++) stepRun(run, right);
    expect(run.mode).toBe("PLAYING");
    const lost = stepRun(run, right);
    expect(lost.some(event => event.type === "lifeLost" && event.lives === 2)).toBe(true);
    expect(run.mode).toBe("DEAD");
    retryRun(run);
    expect(run.mode).toBe("PLAYING");
    expect(snapshot(run.runtime).player.form).toBe("small");
    expect(run.runtime.player.x).toBe(40);
    expect(run.runtime.player.y).toBe(208);
    expect(run.runtime.progress).toEqual({ lives: 2, score: 800, coins: 7 });
    expect(run.runtime.timer.remaining).toBe(30);
    expect(run.runtime.timer.pulse).toBe(0);
    expect(run.runtime.tick).toBe(0);
    expect(run.runtime.combat.defeated).toBe(false);
    expect(JSON.stringify(authored)).toBe(frozen);
    expect(JSON.stringify(run.authored)).toBe(frozen);
  });
  test("third death is game over; restart resets counters from the authored snapshot", () => {
    const authored = createGoalFixture("timeout");
    const run = createRun(authored);
    for (let life = 3; life >= 1; life--) {
      run.runtime.progress.score = 1200;
      run.runtime.timer.remaining = 1;
      run.runtime.timer.pulse = 59;
      stepRun(run, idle);
      for (let i = 0; i < DEATH_FREEZE_TICKS; i++) stepRun(run, idle);
      if (life > 1) {
        expect(run.mode).toBe("DEAD");
        expect(run.runtime.progress.lives).toBe(life - 1);
        retryRun(run);
      }
    }
    expect(run.mode).toBe("GAME_OVER");
    expect(run.runtime.progress.lives).toBe(0);
    restartRun(run);
    expect(run.mode).toBe("PLAYING");
    expect(run.runtime.progress).toEqual({ lives: 3, score: 0, coins: 0 });
    expect(snapshot(run.runtime).player.form).toBe("small");
    expect(run.runtime.timer.remaining).toBe(30);
    expect(snapshot(run.runtime).tick).toBe(0);
  });
});
