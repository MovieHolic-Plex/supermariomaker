import assert from "node:assert/strict";
import { resolve } from "node:path";
import type { Page } from "playwright-core";
import type { PlayObservation } from "../../src/ui/play-gallery";
import { parseCourse, serializeCourse } from "../../src/level/serialize";
import { validateCourse } from "../../src/level/validate";
import type { CourseV1, Theme } from "../../src/level/types";
import { sampleCourse } from "../../src/level/samples";
import { fixtureValue } from "../../tests/fixtures/factory";
import { SAMPLE_ROUTES, type RouteKey, type SampleTheme } from "../../tests/fixtures/routes";
import { bounded, json, nativeChrome, viewport } from "./support";

/** Playwright key names whose `event.code` matches src/input.ts bindings. Run is KeyX, not Shift. */
const KEYS: Record<RouteKey, string> = {
  left: "ArrowLeft", right: "ArrowRight", up: "ArrowUp", down: "ArrowDown", jump: "Space", run: "x",
};
const ALL_KEYS = Object.values(KEYS);
const THEMES: readonly SampleTheme[] = ["overworld", "underground", "underwater", "castle"];
interface Match { mode?: PlayObservation["mode"]; initial?: boolean; tickMin?: number; cleared?: boolean; ending?: "flag" | "castle"; phase?: "slide" | "walk" | "wait" | "collapse" | "fall" }
const sha = (bytes: Uint8Array) => Bun.CryptoHasher.hash("sha256", bytes, "hex");
const routeTicks = (theme: SampleTheme) => SAMPLE_ROUTES[theme].reduce((sum, segment) => sum + segment.ticks, 0);
const routeTimeoutMs = (theme: SampleTheme) => Math.ceil(routeTicks(theme) / 60 * 1000) + 2000;
const canonical = (course: CourseV1): CourseV1 => fixtureValue(parseCourse(fixtureValue(serializeCourse(course))));

async function arm(page: Page, match: Match, slot: string, timeoutMs: number) {
  await page.evaluate(({ match, slot, timeoutMs }) => {
    const qa = window.__qa; if (!qa) throw new Error("Actual play observer missing");
    Object.defineProperty(globalThis, slot, { configurable: true, value: qa.nextState(state => {
      const ending = state.runtime?.ending;
      return (match.mode === undefined || state.mode === match.mode)
        && (!match.initial || state.runtime?.tick === 0)
        && (match.tickMin === undefined || (state.runtime?.tick ?? -1) >= match.tickMin)
        && (!match.cleared || state.mode === "CLEARED" || state.events.some(event => event.type === "courseClear"))
        && (match.ending === undefined || ending?.kind === match.ending)
        && (match.phase === undefined || (ending !== undefined && "phase" in ending && ending.phase === match.phase));
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
async function armDOM(page: Page, event: string) {
  await page.evaluate(event => { Object.defineProperty(globalThis, "__sampleDOM", { configurable: true, value: new Promise(resolve => {
    document.addEventListener(event, value => resolve(value instanceof CustomEvent ? value.detail : null), { once: true, capture: true });
  }) }); }, event);
}
const domSignal = (page: Page) => bounded(page.evaluate("globalThis.__sampleDOM"), "sample DOM subscription");

async function hold(page: Page, keys: readonly RouteKey[]) {
  await page.getByTestId("game-canvas").focus();
  for (const code of ALL_KEYS) await page.keyboard.up(code);
  const wanted = new Set(keys.map(key => KEYS[key]));
  for (const code of wanted) await page.keyboard.down(code);
}

function malformedOverworld(): CourseV1 {
  const course = sampleCourse("overworld");
  const area = course.areas.find(item => item.objects.some(object => object.kind === "pipe" && object.props.destination));
  const pipe = area?.objects.find(object => object.kind === "pipe" && object.props.destination);
  if (pipe?.kind !== "pipe" || !area || !pipe.props.destination) throw new Error("expected linked sample pipe");
  const destination = pipe.props.destination;
  return {
    ...course,
    areas: course.areas.map(item => item.id !== area.id ? item : {
      ...item,
      objects: item.objects.map(object => object.id !== pipe.id ? object : {
        ...pipe,
        props: { ...pipe.props, destination: { areaId: destination.areaId, pipeId: "00000000-0000-4000-8000-ffffffffffff" } },
      }),
    }),
  };
}

export async function samples(evidence: string, origin: string) {
  const native = await nativeChrome(evidence), { browser, context } = native;
  const actions: unknown[] = [], captures: unknown[] = [], errors: string[] = [];
  let cleanup: unknown = null;
  const page = context.pages()[0] ?? await context.newPage(); page.setDefaultTimeout(10_000);
  try {
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    page.on("requestfailed", request => errors.push(`${request.url()} ${request.failure()?.errorText}`));
    await page.setViewportSize(viewport); await page.bringToFront();
    await json(`${evidence}/versions.json`, { browser: browser.version(), bun: Bun.version, viewport,
      url: `${origin}/?qa=play`, driver: "native isolated Chrome + Playwright CDP", clock: "unmodified native RAF",
      input: "real keyboard from SAMPLE_ROUTES (ArrowRight/x)", stateSetters: false });
    await page.addInitScript(() => {
      Object.defineProperty(globalThis, "__sampleMounted", { value: new Promise<void>(resolve => {
        document.addEventListener("play-state", () => resolve(), { once: true, capture: true });
      }) });
    });
    await page.goto(`${origin}/?qa=play`, { waitUntil: "load" });
    await bounded(page.evaluate("globalThis.__sampleMounted"), "actual play mount");
    const observe = async (match: Match, action: string, input?: () => Promise<unknown>, timeoutMs = 10_000) => {
      const slot = `__sample_${action.replace(/[^a-zA-Z0-9]+/g, "_")}`;
      actions.push({ action, match, timeoutMs }); await arm(page, match, slot, timeoutMs);
      if (input) await input();
      const observed = await wait(page, slot, timeoutMs);
      actions.push({ completed: action, tick: observed.runtime?.tick, mode: observed.mode, x: observed.runtime?.player.x });
      return observed;
    };
    const capture = async (theme: Theme, phase: "beginning" | "interaction" | "ending") => {
      const observed = await state(page);
      const file = `${evidence}/${theme}-${phase}.png`;
      const png = await page.screenshot({ path: file, animations: "disabled" });
      const dialog = await page.getByTestId("clear-dialog").evaluate(el => ({
        hidden: (el as HTMLElement).hidden, ending: (el as HTMLElement).dataset["ending"] ?? null, text: el.textContent,
      }));
      captures.push({ theme, phase, file: resolve(file), sha256: sha(png), bytes: png.byteLength,
        tick: observed.runtime?.tick, mode: observed.mode, dialog, player: observed.view?.player,
        visualApproval: "requires image-capable independent inspection" });
      return observed;
    };
    for (const theme of THEMES) {
      const course = canonical(sampleCourse(theme));
      const bytes = new TextEncoder().encode(fixtureValue(serializeCourse(course)));
      const file = `${evidence}/${theme}.smb1.json`;
      await Bun.write(file, bytes);
      if ((await state(page)).mode !== "READY") {
        await observe({ mode: "READY" }, `${theme} return`, () => page.getByTestId("return-editor").click());
      }
      await armDOM(page, "fixture-read-settled");
      await page.getByTestId("import-course").setInputFiles(resolve(file));
      await domSignal(page);
      assert.deepEqual(await page.evaluate(() => window.__qa?.course()), course);
      actions.push({ action: "actual file input", theme, file: resolve(file), sha256: sha(bytes) });
      const initial = await observe({ mode: "PLAYING", initial: true }, `${theme} play-start`,
        () => page.getByTestId("play-start").click());
      assert.equal(initial.runtime?.tick, 0);
      await observe({ mode: "PAUSED" }, `${theme} pause beginning`, () => page.keyboard.press("Escape"));
      await capture(theme, "beginning");
      await observe({ mode: "PLAYING" }, `${theme} resume beginning`, () => page.getByTestId("resume").click());
      const route = SAMPLE_ROUTES[theme];
      const timeoutMs = routeTimeoutMs(theme);
      const first = route[0]; assert(first);
      await hold(page, first.keys);
      const midTick = Math.max(1, Math.min(80, Math.floor(first.ticks / 2)));
      await observe({ tickMin: midTick }, `${theme} interaction tick`, undefined, timeoutMs);
      await hold(page, []);
      await observe({ mode: "PAUSED" }, `${theme} pause interaction`, () => page.keyboard.press("Escape"));
      await capture(theme, "interaction");
      await observe({ mode: "PLAYING" }, `${theme} resume interaction`, () => page.getByTestId("resume").click());
      await hold(page, first.keys);
      if (theme === "castle") {
        await observe({ ending: "castle", phase: "fall" }, `${theme} axe-bridge-fall`, undefined, timeoutMs);
        await hold(page, []);
        await observe({ mode: "PAUSED" }, `${theme} pause ending`, () => page.keyboard.press("Escape"));
        const endingShot = await capture(theme, "ending");
        assert.equal(endingShot.runtime?.ending.kind, "castle");
        assert.equal(endingShot.runtime?.ending && "phase" in endingShot.runtime.ending ? endingShot.runtime.ending.phase : "", "fall");
        await observe({ mode: "PLAYING" }, `${theme} resume ending`, () => page.getByTestId("resume").click());
      }
      const cleared = await observe({ cleared: true, mode: "CLEARED" }, `${theme} clear`, undefined, timeoutMs);
      assert.equal(cleared.mode, "CLEARED");
      assert.equal(cleared.runtime?.combat.defeated, false);
      const dialog = await page.getByTestId("clear-dialog").evaluate(el => ({ hidden: (el as HTMLElement).hidden, text: el.textContent }));
      assert.equal(dialog.hidden, false);
      assert(dialog.text && /클리어/.test(dialog.text));
      if (theme !== "castle") await capture(theme, "ending");
      await hold(page, []);
      actions.push({ outcome: `${theme}-cleared`, tick: cleared.runtime?.tick, ending: cleared.runtime?.ending });
    }
    if ((await state(page)).mode !== "READY") await observe({ mode: "READY" }, "return after samples", () => page.getByTestId("return-editor").click());
    await armDOM(page, "play-cleanup"); await page.getByTestId("fixture-exit").click(); cleanup = await domSignal(page);
    assert.deepEqual(errors, []);
  } catch (error) {
    await json(`${evidence}/original-failure.json`, { message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : null, lastAction: actions.at(-1) });
    throw error;
  } finally {
    try {
      if (!page.isClosed()) await json(`${evidence}/last-state.json`, await page.evaluate(() => window.__qa?.snapshot() ?? null));
    } finally {
      try { await native.close(); }
      finally {
        await Promise.all([json(`${evidence}/actions.json`, actions), json(`${evidence}/png-manifest.json`, captures),
          json(`${evidence}/errors.json`, errors),
          json(`${evidence}/cleanup.json`, { host: cleanup, browserConnected: browser.isConnected(), native: "native-cleanup.json" })]);
      }
    }
  }
}

export async function samplesInvalid(evidence: string, origin: string) {
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
      Object.defineProperty(globalThis, "__sampleMounted", { value: new Promise<void>(resolve => {
        document.addEventListener("play-state", () => resolve(), { once: true, capture: true });
      }) });
    });
    await page.goto(`${origin}/?qa=play`, { waitUntil: "load" });
    await bounded(page.evaluate("globalThis.__sampleMounted"), "actual play mount");
    const valid = canonical(sampleCourse("overworld"));
    const validBytes = new TextEncoder().encode(fixtureValue(serializeCourse(valid)));
    const validFile = `${evidence}/overworld-valid.smb1.json`;
    await Bun.write(validFile, validBytes);
    await armDOM(page, "fixture-read-settled");
    await page.getByTestId("import-course").setInputFiles(resolve(validFile));
    await domSignal(page);
    assert.deepEqual(await page.evaluate(() => window.__qa?.course()), valid);
    const before = await page.evaluate(() => window.__qa?.course());
    const mutated = malformedOverworld();
    const rejectedCheck = validateCourse(mutated);
    assert.equal(rejectedCheck.ok, false);
    if (!rejectedCheck.ok) assert.equal(rejectedCheck.error.code, "invalid_reference");
    const badBytes = new TextEncoder().encode(JSON.stringify(mutated));
    const badFile = `${evidence}/overworld-dangling-pipe.smb1.json`;
    await Bun.write(badFile, badBytes);
    await armDOM(page, "fixture-read-settled");
    await page.getByTestId("import-course").setInputFiles(resolve(badFile));
    await domSignal(page);
    const rejected = await page.evaluate(() => ({
      code: document.querySelector('[data-testid="fixture-status"]')?.getAttribute("data-code"),
      course: window.__qa?.course(),
      status: document.querySelector('[data-testid="fixture-gallery"]')?.getAttribute("data-status"),
      message: document.querySelector('[data-testid="fixture-status"]')?.textContent,
    }));
    assert.equal(rejected.code, "invalid_reference");
    assert.equal(rejected.status, "rejected");
    assert.deepEqual(rejected.course, before);
    const png = await page.screenshot({ path: `${evidence}/malformed-rejected.png`, animations: "disabled" });
    actions.push({ outcome: "malformed-pipe-rejected", rejected, file: resolve(badFile), screenshot: { sha256: sha(png) } });
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
