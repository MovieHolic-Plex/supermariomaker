import { describe, expect, test } from "bun:test";
import { EMPTY_INPUT, InputBuffer } from "../src/input";
import type { InputAction, InputFrame } from "../src/input";
import { createRuntime, currentArea, snapshot } from "../src/game/state";
import { step } from "../src/game/step";
import { PHYSICS } from "../src/game/physics";
import { playerBounds, sweepAxis } from "../src/game/collision";
import { FixedClock } from "../src/game/clock";
import { createMovementFixture } from "./fixtures/movement";
import { fixtureId } from "./fixtures/factory";
import { playView } from "../src/ui/play-view";
import { THEMES } from "../src/level/types";

const held = (...actions: InputAction[]): InputFrame => ({ ...EMPTY_INPUT, ...Object.fromEntries(actions.map(action => [action, { held: true, pressed: false, released: false }])) });
const jump = { ...EMPTY_INPUT, jump: { held: true, pressed: true, released: false } };
function advance(runtime: ReturnType<typeof createRuntime>, count: number, input = EMPTY_INPUT) { for (let i = 0; i < count; i++) step(runtime, input); }
function arc(hold: number) {
  const runtime = createRuntime(createMovementFixture()), positions: number[] = [];
  step(runtime, jump); positions.push(runtime.player.y);
  for (let i = 1; i < 90; i++) {
    step(runtime, { ...EMPTY_INPUT, jump: { held: i < hold, pressed: false, released: i === hold } }); positions.push(runtime.player.y);
  }
  return { runtime, positions, apex: Math.min(...positions) };
}
describe("authoritative movement", () => {
  test("walk/run exact caps, acceleration, reversal and friction", () => {
    const walk = createRuntime(createMovementFixture()), run = createRuntime(createMovementFixture());
    step(walk, held("right")); expect(walk.player.vx).toBe(0.12); expect(walk.player.x).toBe(40 + 31 / 256);
    advance(walk, 39, held("right")); advance(run, 40, held("right", "run"));
    expect(walk.player.vx).toBe(1.6); expect(run.player.vx).toBe(2.8); expect(run.player.x).toBeGreaterThan(walk.player.x);
    step(run, held("left", "run")); expect(run.player.vx).toBeCloseTo(2.6); expect(run.player.skidding).toBe(true);
    step(walk, EMPTY_INPUT); expect(walk.player.vx).toBeCloseTo(1.5);
    advance(walk, 20); expect(walk.player.vx).toBe(0);
    step(run, held("right", "left")); expect(run.player.vx).toBeCloseTo(2.5);
  });
  test("6 vs 18 rising ticks change jump arc; release clamps, falls cap, no autojump", () => {
    const short = arc(6), long = arc(18);
    expect(short.apex).toBeLessThan(180); expect(long.apex).toBeLessThan(short.apex - 20);
    expect(short.runtime.player.y).toBe(208); expect(long.runtime.player.grounded).toBe(true);
    const runtime = createRuntime(createMovementFixture()); step(runtime, jump);
    expect(runtime.player.vy).toBe(-5); expect(runtime.player.risingTicks).toBe(1);
    step(runtime, { ...EMPTY_INPUT, jump: { held: false, pressed: false, released: true } });
    expect(runtime.player.vy).toBeCloseTo(-1.58);
    advance(runtime, 100, held("jump")); expect(runtime.player.y).toBe(208);
    currentArea(runtime).tiles.clear();
    runtime.player.y = 80; runtime.player.vy = 0; runtime.player.grounded = false;
    advance(runtime, 20); expect(runtime.player.vy).toBe(6); expect(runtime.player.y).toBeLessThan(240);
    advance(runtime, 80); expect(runtime.combat.defeated).toBe(true);
  });
  test("held gravity applies to exactly 18 rising ticks, then ordinary gravity", () => {
    const runtime = createRuntime(createMovementFixture()); step(runtime, jump); advance(runtime, 17, held("jump"));
    expect(runtime.player.risingTicks).toBe(18); expect(runtime.player.vy).toBeCloseTo(-1.6);
    step(runtime, held("jump")); expect(runtime.player.vy).toBeCloseTo(-1.18);
    expect(runtime.player.x * 256).toBeInteger(); expect(runtime.player.y * 256).toBeInteger();
  });
  test("no coyote or buffered jump; initial grounded spawn can jump immediately", () => {
    const runtime = createRuntime(createMovementFixture()); expect(runtime.player.grounded).toBe(true);
    currentArea(runtime).tiles.clear(); step(runtime, EMPTY_INPUT); step(runtime, jump);
    expect(runtime.player.vy).toBeGreaterThan(0);
    const landing = createRuntime(createMovementFixture()); landing.player.y = 190; landing.player.grounded = false; landing.player.vy = 6;
    step(landing, jump); advance(landing, 30, held("jump")); expect(landing.player.y).toBe(208);
  });
  test("wall stops, X then Y corner contacts and no tunneling at large displacement", () => {
    const runtime = createRuntime(createMovementFixture()); advance(runtime, 220, held("right", "run"));
    expect(runtime.player.x).toBe(442); expect(runtime.player.vx).toBe(0); expect(runtime.player.y).toBe(208);
    expect(runtime.contacts.map(contact => contact.axis)).toEqual(["x", "y"]);
    const area = currentArea(runtime);
    const x = sweepAxis(area, { x: 40, y: 193, width: 12, height: 15 }, 1000, "x"); expect(x.distance).toBe(396);
    const y = sweepAxis(area, { x: 40, y: 50, width: 12, height: 15 }, 500, "y"); expect(y.distance).toBe(143);
    const ceiling = sweepAxis(area, { x: 40, y: 80, width: 12, height: 15 }, -500, "y"); expect(ceiling.distance).toBe(-80);
    const corner = createRuntime(createMovementFixture()); corner.player.x = 441; corner.player.y = 207; corner.player.vx = 2.8; corner.player.vy = 6;
    step(corner, held("right", "run")); expect(corner.player.x).toBe(442); expect(corner.player.y).toBe(208);
    expect(corner.contacts.map(contact => contact.axis)).toEqual(["x", "y"]);
  });
  test("equal-time tile contacts sorted by stable ID regardless authored order; hidden below-only", () => {
    const runtime = createRuntime(createMovementFixture()), area = currentArea(runtime);
    const a = sweepAxis(area, { x: 26, y: 170, width: 12, height: 15 }, 60, "y");
    expect(a.contacts).toHaveLength(2); expect(a.contacts.map(contact => contact.id)).toEqual(a.contacts.map(contact => contact.id).sort());
    const reversed = [...area.tiles].reverse(); area.tiles.clear(); for (const [key, tile] of reversed) area.tiles.set(key, tile);
    expect(sweepAxis(area, { x: 26, y: 170, width: 12, height: 15 }, 60, "y")).toEqual(a);
    area.tiles.clear(); area.tiles.set(10 * 64 + 3, { x: 3, y: 10, kind: "hidden" });
    expect(sweepAxis(area, { x: 30, y: 160, width: 12, height: 15 }, 50, "x").contacts).toHaveLength(0);
    expect(sweepAxis(area, { x: 50, y: 100, width: 12, height: 15 }, 100, "y").contacts).toHaveLength(0);
    expect(sweepAxis(area, { x: 50, y: 190, width: 12, height: 15 }, -100, "y").distance).toBe(-14);
  });
  test("super/fire 12x31 crouch 12x15 cannot uncrouch through solid, feet remain anchored", () => {
    for (const form of ["super", "fire"] as const) {
      const runtime = createRuntime(createMovementFixture()), area = currentArea(runtime); runtime.player.form = form;
      expect(playerBounds(runtime.player).height).toBe(31); step(runtime, held("down"));
      expect(playerBounds(runtime.player)).toEqual({ x: 34, y: 193, width: 12, height: 15 });
      area.tiles.set(11 * 64 + 2, { x: 2, y: 11, kind: "hard" }); step(runtime, EMPTY_INPUT);
      expect(runtime.player.crouched).toBe(true); expect(runtime.player.y).toBe(208);
      area.tiles.delete(11 * 64 + 2); step(runtime, EMPTY_INPUT); expect(runtime.player.crouched).toBe(false); expect(playerBounds(runtime.player).height).toBe(31);
    }
  });
  test.each([...THEMES])("view uses active %s source and clamps both camera axes without moving physics", theme => {
    const course = createMovementFixture(), main = course.areas[0]; if (!main) throw new Error("Fixture area missing");
    const other = { ...main, id: fixtureId(100), theme, width: 64, height: 32 };
    const runtime = createRuntime({ ...course, areas: [...course.areas, other] }, { areaId: other.id, x: 40, y: 208 });
    expect(playView(runtime).theme).toBe(theme); runtime.player.x = 9999; runtime.player.y = 9999;
    const before = snapshot(runtime); expect(playView(runtime).camera).toEqual({ x: 768, y: 272 }); expect(snapshot(runtime)).toEqual(before);
    runtime.player.x = 6; runtime.player.y = 15; expect(playView(runtime).camera).toEqual({ x: 0, y: 0 });
  });
  test("runtime terrain and observations cannot mutate authored course; spawn overrides validate", () => {
    const course = createMovementFixture(), before = JSON.stringify(course), runtime = createRuntime(course);
    currentArea(runtime).tiles.clear(); advance(runtime, 5, held("right")); const view = snapshot(runtime); view.player.x = 999;
    expect(runtime.player.x).not.toBe(999); expect(JSON.stringify(course)).toBe(before); expect(runtime.course.areas[0]?.tiles.length).toBeGreaterThan(0);
    expect(() => createRuntime(course, { ...course.start, x: 450 })).toThrow();
    const override = createRuntime(course, { ...course.start, x: 72 }); expect(override.player.x).toBe(72); expect(course.start.x).toBe(40);
  });
});
describe("input and host clock", () => {
  test("rapid tap retains both edges once, repeated keydown creates no edges, aliases aggregate", () => {
    const input = new InputBuffer(); input.key("Space", true); input.key("Space", false);
    expect(input.consume().jump).toEqual({ held: false, pressed: true, released: true }); expect(input.consume()).toEqual(EMPTY_INPUT);
    input.key("Space", true); input.consume(); input.key("Space", true, true); expect(input.consume().jump.pressed).toBe(false);
    input.key("KeyZ", true); input.key("Space", false); expect(input.consume().jump).toEqual({ held: true, pressed: false, released: false });
    input.clear(); input.key("Space", true, true); expect(input.consume()).toEqual(EMPTY_INPUT);
    const runtime = createRuntime(createMovementFixture()); input.key("KeyZ", true); input.key("KeyZ", false); step(runtime, input.consume());
    expect(runtime.player.vy).toBeCloseTo(-1.58); expect(runtime.player.y).toBeLessThan(208);
  });
  test("same input ticks produce identical state at 30/60/144Hz render schedules", () => {
    const run = (hz: number) => {
      const runtime = createRuntime(createMovementFixture()), clock = new FixedClock(); clock.resume();
      for (let frame = 0; frame <= hz * 3; frame++) clock.frame(frame * 1000 / hz, () => {
        const tick = runtime.tick;
        step(runtime, { ...held("right", ...(tick < 60 ? [] : ["run"] as const)), jump: { held: tick >= 20 && tick < 38, pressed: tick === 20, released: tick === 38 } });
      });
      expect(runtime.tick).toBe(180); return snapshot(runtime);
    };
    expect(run(30)).toEqual(run(60)); expect(run(144)).toEqual(run(60));
  });
  test("max five catch-up ticks; blur clears input and debt, explicit resume starts a new baseline", () => {
    const runtime = createRuntime(createMovementFixture()), input = new InputBuffer(), clock = new FixedClock();
    const tick = () => step(runtime, input.consume());
    clock.resume(); clock.frame(0, tick); input.key("ArrowRight", true); input.key("Space", true);
    expect(clock.frame(1000, tick)).toBe(5); expect(runtime.tick).toBe(5); expect(clock.state.droppedMs).toBeGreaterThan(900);
    clock.frame(1005, tick); clock.pause(); input.clear(); const paused = snapshot(runtime);
    clock.frame(60_000, tick); expect(snapshot(runtime)).toEqual(paused); expect(clock.state.debtMs).toBe(0);
    clock.resume(); expect(clock.frame(120_000, tick)).toBe(0); expect(snapshot(runtime)).toEqual(paused);
    expect(input.consume()).toEqual(EMPTY_INPUT); expect(clock.frame(120_000 + 1000 / PHYSICS.hz, tick)).toBe(1); expect(runtime.tick).toBe(6);
  });
});
