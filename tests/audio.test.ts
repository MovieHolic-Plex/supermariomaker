import { describe, expect, test } from "bun:test";
import { createAudioEngine } from "../src/audio/audio";
import { MUSIC, SCORES, audioKeys, effectKeys, musicKeys } from "../src/assets/music";
import type { AudioDriver, AudioSettings, ScheduledNote } from "../src/audio/audio";

// The fake models the audio clock, future source reservations, gain and ended
// delivery. Advancing time, not sleeping, is what ends a scheduled source.
class ClockDriver implements AudioDriver {
  currentTime = 0;
  state = "suspended";
  volume = 1;
  resumeCalls = 0;
  closeCalls = 0;
  denied = false;
  readonly sources: { note: ScheduledNote; stopped: boolean; ended: () => void }[] = [];
  async resume() {
    this.resumeCalls++;
    if (this.denied) throw new DOMException("Blocked by policy", "NotAllowedError");
    this.state = "running";
  }
  async close() { this.closeCalls++; this.state = "closed"; }
  setVolume(value: number) { this.volume = value; }
  schedule(note: ScheduledNote, ended: () => void) {
    if (note.at < this.currentTime) throw new RangeError("Cannot schedule in the past");
    const source = { note, stopped: false, ended };
    this.sources.push(source);
    return { stop: () => { source.stopped = true; } };
  }
  advance(time: number) {
    this.currentTime = time;
    for (const source of this.sources) {
      if (!source.stopped && source.note.at + source.note.duration <= time) {
        source.stopped = true;
        source.ended();
      }
    }
  }
  get live() { return this.sources.filter((source) => !source.stopped); }
}
function setup() {
  const driver = new ClockDriver();
  let creations = 0;
  const engine = createAudioEngine({ createDriver: () => { creations++; return driver; } });
  return { driver, engine, creations: () => creations };
}

describe("audio transport", () => {
  test("does not create or schedule audio before a gesture", () => {
    // Given a locked engine; When game requests arrive; Then no browser audio exists.
    const { driver, engine, creations } = setup();
    engine.playMusic("overworld");
    expect(engine.playEffect("coin")).toBe(false);
    engine.tick();
    expect(creations()).toBe(0);
    expect(driver.sources).toHaveLength(0);
  });
  test("schedules authored layered music against the audio clock after activation", async () => {
    // Given a gesture-enabled engine; When selecting music; Then notes have real voices and precise future times.
    const { driver, engine } = setup();
    await engine.activateFromGesture();
    engine.playMusic("overworld");
    expect(driver.sources.length).toBeGreaterThan(1);
    expect(new Set(driver.sources.map(({ note }) => note.instrument)).size).toBeGreaterThan(1);
    expect(driver.sources.every(({ note }) => note.at >= driver.currentTime && note.duration > 0)).toBe(true);
    await engine.dispose();
  });
  test("mute stops reserved voices and blocks effects without losing the music selection", async () => {
    // Given active music; When muted; Then silence is immediate and no effect is queued.
    const { driver, engine } = setup();
    await engine.activateFromGesture();
    engine.playMusic("castle");
    engine.setMuted(true);
    expect(driver.volume).toBe(0);
    expect(driver.live).toHaveLength(0);
    expect(engine.playEffect("jump")).toBe(false);
    expect(engine.snapshot().music).toBe("castle");
    await engine.dispose();
  });
  test("unmute resumes the selected music instead of replaying stale effects", async () => {
    // Given muted music; When unmuted; Then only current music is scheduled.
    const { driver, engine } = setup();
    await engine.activateFromGesture();
    engine.playMusic("underwater");
    engine.setMuted(true);
    engine.playEffect("coin");
    engine.setMuted(false);
    expect(driver.live.length).toBeGreaterThan(0);
    expect(driver.live.every(({ note }) => note.key === "underwater")).toBe(true);
    await engine.dispose();
  });
  test("caps all reserved voices and pending effect bursts at sixteen", async () => {
    // Given an enabled engine; When 100 layered effects arrive together; Then resources remain bounded.
    const { driver, engine } = setup();
    await engine.activateFromGesture();
    for (let i = 0; i < 100; i++) engine.playEffect("break");
    expect(driver.live.length).toBeGreaterThan(0);
    expect(driver.live.length).toBeLessThanOrEqual(16);
    expect(engine.snapshot().voices).toBe(driver.live.length);
    expect(engine.snapshot().pendingEffects).toBeLessThanOrEqual(16);
    await engine.dispose();
  });
  test("stop cancels future notes and prevents later ticks from restarting", async () => {
    // Given music and a multi-note effect; When stopped; Then no retained source or score can sound later.
    const { driver, engine } = setup();
    await engine.activateFromGesture();
    engine.playMusic("underground");
    engine.playEffect("powerupAppear");
    engine.stop();
    driver.advance(100);
    engine.tick();
    expect(driver.live).toHaveLength(0);
    expect(engine.snapshot()).toMatchObject({ music: null, voices: 0, pendingEffects: 0 });
    await engine.dispose();
  });
  test("pause drops voices and requires explicit gesture resumption", async () => {
    // Given music; When paused across a clock jump; Then ticking cannot resume it.
    const { driver, engine } = setup();
    await engine.activateFromGesture();
    engine.playMusic("star");
    engine.pause();
    driver.advance(100);
    engine.tick();
    expect(driver.live).toHaveLength(0);
    expect(engine.snapshot().status).toBe("paused");
    await engine.activateFromGesture();
    expect(driver.live.length).toBeGreaterThan(0);
    expect(driver.live.every(({ note }) => note.at >= 100)).toBe(true);
    await engine.dispose();
  });
  test("switching theme cancels the previous score including scheduled future sources", async () => {
    // Given an old theme; When a new theme is selected; Then only the new theme remains live.
    const { driver, engine } = setup();
    await engine.activateFromGesture();
    engine.playMusic("overworld");
    engine.playMusic("castle");
    expect(driver.live.length).toBeGreaterThan(0);
    expect(driver.live.every(({ note }) => note.key === "castle")).toBe(true);
    await engine.dispose();
  });
  test("scheduler advances and loops without catch-up bursts after a stalled frame", async () => {
    // Given a running score; When the audio clock leaps beyond a loop; Then notes are scheduled only from now onward.
    const { driver, engine } = setup();
    await engine.activateFromGesture();
    engine.playMusic("overworld");
    driver.advance(60);
    const count = driver.sources.length;
    engine.tick();
    expect(driver.sources.length).toBeGreaterThan(count);
    expect(driver.live.every(({ note }) => note.at >= 60)).toBe(true);
    expect(driver.live.length).toBeLessThanOrEqual(16);
    await engine.dispose();
  });
  test("volume is clamped and settings changes are delivered for persistence", () => {
    // Given a settings sink; When receiving out-of-range UI values; Then only normalized values leave the boundary.
    const saved: AudioSettings[] = [];
    const engine = createAudioEngine({ onSettingsChange: (value) => saved.push(value) });
    engine.setVolume(2);
    engine.setVolume(-1);
    engine.setVolume(Number.NaN);
    engine.setMuted(true);
    expect(saved).toEqual([{ volume: 1, muted: false }, { volume: 0, muted: false }, { volume: 0, muted: true }]);
  });
  test("denied resume reports unavailable without rejecting game requests", async () => {
    // Given a browser denial; When activated; Then the engine becomes nonfatal and releases its context.
    const { driver, engine } = setup();
    driver.denied = true;
    expect(await engine.activateFromGesture()).toBe(false);
    expect(engine.snapshot()).toMatchObject({ status: "unavailable", voices: 0 });
    expect(engine.snapshot().error).toContain("Blocked by policy");
    expect(engine.playEffect("coin")).toBe(false);
    expect(driver.closeCalls).toBe(1);
    await engine.dispose();
  });
  test("repeated enable gestures do not duplicate already-running music", async () => {
    // Given playing music; When enabled again; Then neither sources nor resume calls multiply.
    const { driver, engine } = setup();
    await engine.activateFromGesture();
    engine.playMusic("overworld");
    const count = driver.sources.length;
    await engine.activateFromGesture();
    expect(driver.sources).toHaveLength(count);
    expect(driver.resumeCalls).toBe(1);
    await engine.dispose();
  });
  test("every note in two full loops is scheduled once at its score timestamp", async () => {
    // Given a live audio clock; When frames span two loops; Then transport matches the complete authored score.
    const { driver, engine } = setup();
    await engine.activateFromGesture();
    engine.playMusic("overworld");
    const score = MUSIC.overworld;
    for (let frame = 1; frame <= Math.ceil(score.duration * 2 * 60); frame++) {
      driver.advance(frame / 60); engine.tick();
    }
    const actual = driver.sources.map(({ note }) => note.at).filter((at) => at < 0.015 + 2 * score.duration);
    const expected = [0, 1].flatMap((loop) => score.notes.map((note) => 0.015 + loop * score.duration + note.at));
    expect(actual).toEqual(expected);
    await engine.dispose();
  });
  test("all authored cues have finite in-bounds notes and distinct contours", () => {
    // Given the inventory; When inspecting machine-consumed score data; Then every required cue is playable and unique.
    expect(musicKeys).toHaveLength(9); expect(effectKeys).toHaveLength(14);
    const signatures = new Set<string>();
    for (const key of audioKeys) {
      const score = SCORES[key];
      expect(score.notes.length).toBeGreaterThan(1);
      expect(score.notes.every((note) => note.at >= 0 && note.duration > 0 && note.at + note.duration <= score.duration && Number.isFinite(note.midi) && note.gain <= 0.05)).toBe(true);
      signatures.add(JSON.stringify(score.notes));
    }
    expect(signatures.size).toBe(23);
  });
  test("missing AudioContext is a nonfatal capability failure", async () => {
    // Given no browser API in Bun; When activated; Then availability is reported without throwing.
    const engine = createAudioEngine();
    expect(await engine.activateFromGesture()).toBe(false);
    expect(engine.snapshot().status).toBe("unavailable");
    await engine.dispose();
  });
  for (const cancel of ["pause", "stop"] as const) for (const order of ["old-first", "current-first"] as const) {
    test(`new activation survives ${cancel} with ${order} completion`, async () => {
      // Given two explicit completion barriers; When cancellation separates gestures;
      // Then only the current generation becomes ready, and stale finally cannot evict it.
      const driver = new ClockDriver();
      const older = Promise.withResolvers<void>(); const current = Promise.withResolvers<void>();
      driver.resume = () => { driver.state = "running"; return ++driver.resumeCalls === 1 ? older.promise : current.promise; };
      const engine = createAudioEngine({ createDriver: () => driver });
      engine.playMusic("overworld");
      const oldActivation = engine.activateFromGesture();
      engine[cancel]();
      engine.playMusic("overworld");
      const newActivation = engine.activateFromGesture();
      try {
        if (order === "old-first") {
          older.resolve(); expect(await oldActivation).toBe(false);
          const reused = engine.activateFromGesture();
          current.resolve();
          expect(await newActivation).toBe(true);
          expect(reused).toBe(newActivation);
        } else {
          current.resolve();
          expect(newActivation).not.toBe(oldActivation);
          expect(await newActivation).toBe(true);
          older.resolve(); expect(await oldActivation).toBe(false);
        }
        expect(engine.snapshot()).toMatchObject({ status: "ready", music: "overworld", voices: 2 });
        expect(driver.sources).toHaveLength(2); expect(driver.resumeCalls).toBe(2);
      } finally { older.resolve(); current.resolve(); await engine.dispose(); }
    });
  }
  test("dispose during pending activation cannot resurrect audio", async () => {
    // Given a resume promise in flight; When disposed before resolution; Then its continuation stays disposed.
    const driver = new ClockDriver();
    const resumed = Promise.withResolvers<void>();
    driver.resume = () => resumed.promise;
    const engine = createAudioEngine({ createDriver: () => driver });
    const activation = engine.activateFromGesture();
    await engine.dispose();
    resumed.resolve();
    expect(await activation).toBe(false);
    expect(engine.snapshot().status).toBe("disposed");
    expect(driver.closeCalls).toBe(1);
    expect(driver.live).toHaveLength(0);
  });
});
