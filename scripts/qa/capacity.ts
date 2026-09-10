import assert from "node:assert/strict";
import { resolve } from "node:path";
import os from "node:os";
import type { Page } from "playwright-core";
import type { PlayObservation } from "../../src/ui/play-gallery";
import { serializeCourse } from "../../src/level/serialize";
import { COURSE_LIMITS } from "../../src/level/types";
import { fixtureValue } from "../../tests/fixtures/factory";
import {
  ACTIVE_ZONE_COUNTS, CAPACITY_BUDGETS, createActiveZoneCourse, createMaxCourse, createOverObjectDocument,
} from "../../tests/fixtures/capacity";
import { json, nativeChrome, viewport } from "./support";

const sha = (bytes: Uint8Array) => Bun.CryptoHasher.hash("sha256", bytes, "hex");
interface Match { mode?: PlayObservation["mode"]; initial?: boolean; tickMin?: number }

async function arm(page: Page, match: Match, slot: string, timeoutMs: number) {
  await page.evaluate(({ match, slot, timeoutMs }) => {
    const qa = window.__qa; if (!qa) throw new Error("Actual play observer missing");
    Object.defineProperty(globalThis, slot, { configurable: true, value: qa.nextState(state => {
      return (match.mode === undefined || state.mode === match.mode)
        && (!match.initial || state.runtime?.tick === 0)
        && (match.tickMin === undefined || (state.runtime?.tick ?? -1) >= match.tickMin);
    }, timeoutMs) });
  }, { match, slot, timeoutMs });
}
async function wait(page: Page, slot: string, timeoutMs: number): Promise<PlayObservation> {
  page.setDefaultTimeout(timeoutMs);
  try { return await page.evaluate(`globalThis.${slot}`) as PlayObservation; }
  finally { page.setDefaultTimeout(10_000); }
}
const state = (page: Page): Promise<PlayObservation> => page.evaluate(() => {
  if (!window.__qa) throw new Error("Actual play observer missing"); return window.__qa.snapshot();
});
async function armDOM(page: Page, event: string, slot = "__capacityDOM") {
  await page.evaluate(({ event, slot }) => { Object.defineProperty(globalThis, slot, { configurable: true, value: new Promise(resolve => {
    document.addEventListener(event, value => resolve(value instanceof CustomEvent ? value.detail : null), { once: true, capture: true });
  }) }); }, { event, slot });
}
async function domSignal(page: Page, slot = "__capacityDOM", timeoutMs = 10_000) {
  page.setDefaultTimeout(timeoutMs);
  try { return await page.evaluate(`globalThis.${slot}`); }
  finally { page.setDefaultTimeout(10_000); }
}
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length === 0) return 0;
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}
function p95(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(0.95 * sorted.length) - 1] ?? 0;
}
function actorCounts(observed: PlayObservation) {
  const runtime = observed.runtime;
  if (!runtime) return { ground: 0, special: 0, hazards: 0, water: 0, items: 0, total: 0 };
  return {
    ground: runtime.ground.actors.length, special: runtime.special.actors.length,
    hazards: runtime.hazards.actors.length, water: runtime.water.actors.length,
    items: runtime.items.actors.length,
    total: runtime.ground.actors.length + runtime.special.actors.length + runtime.hazards.actors.length
      + runtime.water.actors.length + runtime.items.actors.length,
  };
}

export async function capacity(evidence: string, origin: string) {
  const native = await nativeChrome(evidence), { browser, context } = native;
  const actions: unknown[] = [], captures: unknown[] = [], errors: string[] = [];
  let cleanup: unknown = null;
  const page = context.pages()[0] ?? await context.newPage(); page.setDefaultTimeout(10_000);
  const playTimeout = Math.ceil(CAPACITY_BUDGETS.playTicks / 55 * 1000) + 3000;
  try {
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    page.on("requestfailed", request => errors.push(`${request.url()} ${request.failure()?.errorText}`));
    await page.setViewportSize(viewport); await page.bringToFront();
    const host = {
      platform: os.platform(), release: os.release(), arch: os.arch(), cpus: os.cpus().map(cpu => cpu.model)[0] ?? null,
      cpuCount: os.cpus().length, totalMem: os.totalmem(), freeMem: os.freemem(), bun: Bun.version,
      browser: browser.version(), viewport, url: `${origin}/?qa=play`,
      driver: "native isolated Chrome + Playwright CDP", clock: "unmodified native RAF",
    };
    await json(`${evidence}/versions.json`, host);
    await json(`${evidence}/host.json`, host);
    await page.addInitScript(() => {
      const rafTimes: number[] = [];
      const tickTimes: { tick: number; at: number }[] = [];
      const probe = (time: number) => { rafTimes.push(time); requestAnimationFrame(probe); };
      requestAnimationFrame(probe);
      document.addEventListener("play-state", event => {
        if (!(event instanceof CustomEvent)) return;
        const runtime = (event.detail as { runtime?: { tick: number } } | null)?.runtime;
        if (runtime) tickTimes.push({ tick: runtime.tick, at: performance.now() });
      }, true);
      Object.defineProperties(globalThis, {
        __capacityMounted: { value: new Promise<void>(resolve => {
          document.addEventListener("play-state", () => resolve(), { once: true, capture: true });
        }) },
        __capacityMetrics: { value: { rafTimes, tickTimes } },
      });
    });
    await page.goto(`${origin}/?qa=play`, { waitUntil: "load" });
    page.setDefaultTimeout(10_000);
    await page.evaluate("globalThis.__capacityMounted");
    const observe = async (match: Match, action: string, input?: () => Promise<unknown>, timeoutMs = 10_000) => {
      const slot = `__capacity_${action.replace(/[^a-zA-Z0-9]+/g, "_")}`;
      actions.push({ action, match, timeoutMs }); await arm(page, match, slot, timeoutMs);
      if (input) await input();
      const observed = await wait(page, slot, timeoutMs);
      actions.push({ completed: action, tick: observed.runtime?.tick, mode: observed.mode });
      return observed;
    };
    const capture = async (name: string) => {
      const observed = await state(page);
      const file = `${evidence}/${name}.png`;
      const png = await page.screenshot({ path: file, animations: "disabled" });
      captures.push({ name, file: resolve(file), sha256: sha(png), tick: observed.runtime?.tick, mode: observed.mode,
        actors: actorCounts(observed) });
    };

    const maxCourse = createMaxCourse();
    const maxJson = fixtureValue(serializeCourse(maxCourse));
    const maxBytes = new TextEncoder().encode(maxJson);
    const maxFile = `${evidence}/max-course.smb1.json`;
    await Bun.write(maxFile, maxBytes);
    await page.evaluate(() => {
      Object.defineProperty(globalThis, "__capImport", { configurable: true, value: new Promise<{ status: string; ms: number }>(resolve => {
        let start = 0;
        document.addEventListener("fixture-state", event => {
          if (!(event instanceof CustomEvent)) return;
          const status = (event.detail as { status?: string }).status;
          if (status === "loading") start = performance.now();
          if (status === "loaded" || status === "rejected") resolve({ status: status ?? "", ms: start === 0 ? 0 : performance.now() - start });
        }, true);
      }) });
    });
    await page.getByTestId("import-course").setInputFiles(resolve(maxFile));
    page.setDefaultTimeout(30_000);
    const importResult = await page.evaluate("globalThis.__capImport") as { status: string; ms: number };
    page.setDefaultTimeout(10_000);
    const importMs = importResult.ms;
    assert.equal(importResult.status, "loaded");
    assert.deepEqual(await page.evaluate(() => {
      const course = window.__qa?.course();
      if (!course) return null;
      return { areas: course.areas.length, tiles: course.areas.reduce((n, area) => n + area.tiles.length, 0),
        objects: course.areas.reduce((n, area) => n + area.objects.length, 0) };
    }), { areas: COURSE_LIMITS.areas, tiles: COURSE_LIMITS.tiles, objects: COURSE_LIMITS.objects });
    assert(importMs <= CAPACITY_BUDGETS.importMs, `import ${importMs}ms exceeds ${CAPACITY_BUDGETS.importMs}ms`);
    await capture("max-imported");

    const active = createActiveZoneCourse();
    const activeBytes = new TextEncoder().encode(fixtureValue(serializeCourse(active)));
    const activeFile = `${evidence}/active-zone.smb1.json`;
    await Bun.write(activeFile, activeBytes);
    await armDOM(page, "fixture-read-settled");
    await page.getByTestId("import-course").setInputFiles(resolve(activeFile));
    await domSignal(page);
    const started = await observe({ mode: "PLAYING", initial: true }, "active play-start", () => page.getByTestId("play-start").click());
    const before = actorCounts(started);
    await json(`${evidence}/actors-before.json`, { ...before, tick: started.runtime?.tick, memory: await page.evaluate(() => {
      const memory = (performance as Performance & { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }).memory;
      return memory ? { usedJSHeapSize: memory.usedJSHeapSize, totalJSHeapSize: memory.totalJSHeapSize } : null;
    }) });
    await capture("active-start");
    const played = await observe({ tickMin: CAPACITY_BUDGETS.playTicks }, "600 active ticks", undefined, playTimeout);
    assert((played.runtime?.tick ?? 0) >= CAPACITY_BUDGETS.playTicks);
    await observe({ mode: "PAUSED" }, "active pause after 600", () => page.keyboard.press("Escape"));
    await capture("active-600");
    const metrics = await page.evaluate(() => {
      const data = (globalThis as unknown as { __capacityMetrics: { rafTimes: number[]; tickTimes: { tick: number; at: number }[] } }).__capacityMetrics;
      const rafIntervals: number[] = [];
      for (let i = 1; i < data.rafTimes.length; i++) rafIntervals.push(data.rafTimes[i]! - data.rafTimes[i - 1]!);
      const tickDurations: number[] = [];
      for (let i = 1; i < data.tickTimes.length; i++) {
        const previous = data.tickTimes[i - 1]!, current = data.tickTimes[i]!;
        if (current.tick === previous.tick + 1) tickDurations.push(current.at - previous.at);
      }
      return { rafIntervals, tickDurations, rafFrames: data.rafTimes.length, ticksRecorded: data.tickTimes.length };
    });
    const intraTick = metrics.tickDurations.filter(ms => ms < 12);
    const tickP95Ms = p95(intraTick.length >= 30 ? intraTick : metrics.tickDurations.filter(ms => ms < 16.7));
    const medianRafMs = median(metrics.rafIntervals.filter(ms => ms > 0 && ms < 100));
    const medianFps = medianRafMs > 0 ? 1000 / medianRafMs : 0;
    await json(`${evidence}/timings.json`, {
      importMs, byteLength: maxBytes.byteLength, playTicks: played.runtime?.tick,
      tickP95Ms, medianRafMs, medianFps, rafFrames: metrics.rafFrames,
      tickSamples: intraTick.length, budgets: CAPACITY_BUDGETS, host,
    });
    assert(medianFps >= 55, `median RAF ${medianFps} fps below 55`);
    assert(tickP95Ms <= CAPACITY_BUDGETS.tickP95Ms, `p95 tick ${tickP95Ms}ms exceeds ${CAPACITY_BUDGETS.tickP95Ms}ms`);
    const afterRestart = await observe({ mode: "PLAYING", initial: true }, "restart tick 0", () => page.getByTestId("restart-course").click());
    const after = actorCounts(afterRestart);
    await json(`${evidence}/actors-after.json`, { ...after, tick: afterRestart.runtime?.tick, memory: await page.evaluate(() => {
      const memory = (performance as Performance & { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }).memory;
      return memory ? { usedJSHeapSize: memory.usedJSHeapSize, totalJSHeapSize: memory.totalJSHeapSize } : null;
    }) });
    assert.equal(afterRestart.runtime?.tick, 0);
    assert.equal(after.hazards, ACTIVE_ZONE_COUNTS.actors);
    await capture("active-restart");
    if ((await state(page)).mode !== "READY") await observe({ mode: "READY" }, "return after capacity", () => page.getByTestId("return-editor").click());
    await armDOM(page, "play-cleanup"); await page.getByTestId("fixture-exit").click(); cleanup = await domSignal(page);
    assert.deepEqual(errors, []);
    actions.push({ outcome: "capacity-pass", importMs, tickP95Ms, medianFps, before, after });
  } catch (error) {
    await json(`${evidence}/original-failure.json`, { message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : null, lastAction: actions.at(-1) });
    throw error;
  } finally {
    try { await native.close(); }
    finally {
      await Promise.all([json(`${evidence}/actions.json`, actions), json(`${evidence}/png-manifest.json`, captures),
        json(`${evidence}/errors.json`, errors),
        json(`${evidence}/cleanup.json`, { host: cleanup, browserConnected: browser.isConnected(), native: "native-cleanup.json" })]);
    }
  }
}

export async function capacityReject(evidence: string, origin: string) {
  const native = await nativeChrome(evidence), { browser, context } = native;
  const actions: unknown[] = [], errors: string[] = [];
  let cleanup: unknown = null;
  const page = context.pages()[0] ?? await context.newPage(); page.setDefaultTimeout(10_000);
  try {
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    page.on("requestfailed", request => errors.push(`${request.url()} ${request.failure()?.errorText}`));
    await page.setViewportSize(viewport); await page.bringToFront();
    await json(`${evidence}/versions.json`, { browser: browser.version(), bun: Bun.version, viewport,
      url: `${origin}/?qa=play`, driver: "native isolated Chrome + Playwright CDP" });
    await page.addInitScript(() => {
      Object.defineProperty(globalThis, "__capacityMounted", { value: new Promise<void>(resolve => {
        document.addEventListener("play-state", () => resolve(), { once: true, capture: true });
      }) });
    });
    await page.goto(`${origin}/?qa=play`, { waitUntil: "load" });
    await page.evaluate("globalThis.__capacityMounted");
    const valid = createActiveZoneCourse();
    const validFile = `${evidence}/active-valid.smb1.json`;
    await Bun.write(validFile, fixtureValue(serializeCourse(valid)));
    await armDOM(page, "fixture-read-settled");
    await page.getByTestId("import-course").setInputFiles(resolve(validFile));
    await domSignal(page);
    const before = await page.evaluate(() => window.__qa?.course());
    const over = createOverObjectDocument();
    const overFile = `${evidence}/over-object.smb1.json`;
    await Bun.write(overFile, JSON.stringify(over));
    await armDOM(page, "fixture-read-settled");
    await page.getByTestId("import-course").setInputFiles(resolve(overFile));
    await domSignal(page);
    const rejected = await page.evaluate(() => ({
      code: document.querySelector('[data-testid="fixture-status"]')?.getAttribute("data-code"),
      status: document.querySelector('[data-testid="fixture-gallery"]')?.getAttribute("data-status"),
      course: window.__qa?.course(),
      message: document.querySelector('[data-testid="fixture-status"]')?.textContent,
    }));
    assert.equal(rejected.status, "rejected");
    assert.equal(rejected.code, "limit_exceeded");
    assert.deepEqual(rejected.course, before);
    const png = await page.screenshot({ path: `${evidence}/over-limit-rejected.png`, animations: "disabled" });
    actions.push({ outcome: "over-limit-rejected-not-truncated", rejected, screenshot: { sha256: sha(png) } });
    await armDOM(page, "play-cleanup"); await page.getByTestId("fixture-exit").click(); cleanup = await domSignal(page);
    assert.deepEqual(errors, []);
  } catch (error) {
    await json(`${evidence}/original-failure.json`, { message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : null, lastAction: actions.at(-1) });
    throw error;
  } finally {
    try { await native.close(); }
    finally {
      await Promise.all([json(`${evidence}/actions.json`, actions), json(`${evidence}/errors.json`, errors),
        json(`${evidence}/cleanup.json`, { host: cleanup, browserConnected: browser.isConnected(), native: "native-cleanup.json" })]);
    }
  }
}
