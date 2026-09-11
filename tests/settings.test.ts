import { expect, test } from "bun:test";
import { EMPTY_INPUT } from "../src/input";
import { createRuntime } from "../src/game/state";
import { step } from "../src/game/step";
import { sampleCourse } from "../src/level/samples";
import { effectForEvent, musicForPlay, parsePreferences, themeMusic } from "../src/ui/settings";

test("star music restores the area theme after star ends", () => {
  const runtime = createRuntime(sampleCourse("underground"));
  expect(musicForPlay(runtime, "PLAYING")).toBe("underground");
  expect(themeMusic("castle")).toBe("castle");
  runtime.combat.starTicks = 10;
  expect(musicForPlay(runtime, "PLAYING")).toBe("star");
  runtime.combat.starTicks = 0;
  expect(musicForPlay(runtime, "PLAYING")).toBe("underground");
  expect(musicForPlay(runtime, "CLEARED")).toBe("clear");
  expect(musicForPlay(runtime, "DEAD")).toBe("death");
  expect(musicForPlay(runtime, "GAME_OVER")).toBe("gameOver");
});

test("jump events map to the jump effect and idle does not", () => {
  const runtime = createRuntime(sampleCourse("overworld"));
  const events = step(runtime, { ...EMPTY_INPUT, jump: { held: true, pressed: true, released: false } });
  expect(events.some(event => effectForEvent(event) === "jump")).toBe(true);
});

test("preferences clamp volume and default reduced motion off", () => {
  expect(parsePreferences({ volume: 2, muted: true }, true)).toEqual({ volume: 1, muted: true, reducedMotion: true });
  expect(parsePreferences(undefined, undefined).reducedMotion).toBe(false);
});
