import assert from "node:assert/strict";
import { resolve } from "node:path";
import type { Page } from "playwright-core";
import type { GameEvent } from "../../src/game/state";
import type { PlayObservation } from "../../src/ui/play-gallery";
import { serializeCourse } from "../../src/level/serialize";
import { createWaterPlayFixture, WATER_IDS } from "../../tests/fixtures/water";
import type { WaterPlayCase } from "../../tests/fixtures/water";
import { fixtureValue } from "../../tests/fixtures/factory";
import { bounded, json, nativeChrome, viewport } from "./support";

interface Match {
  mode?: PlayObservation["mode"]; event?: GameEvent["type"]; actorId?: string;
  initial?: boolean; tick?: number; xMin?: number; xMax?: number;
  grounded?: boolean; stopped?: boolean; swimReady?: boolean; ceiling?: boolean; fallCap?: boolean;
  cheepVisible?: boolean; blooperVisible?: boolean; leapVisible?: boolean; swimFrame?: boolean;
}
async function arm(page: Page, match: Match, slot = "__waterSignal") {
  await page.evaluate(({ match, slot }) => {
    const qa = window.__qa; if (!qa) throw new Error("Actual play observer missing");
    Object.defineProperty(globalThis, slot, { configurable: true, value: qa.nextState(state => {
      const runtime = state.runtime, player = runtime?.player, view = state.view;
      const ceiling = runtime?.contacts.some(contact => contact.axis === "y" && contact.normal === 1) ?? false;
      return (match.mode === undefined || state.mode === match.mode)
        && (match.event === undefined || state.events.some(event => event.type === match.event && (match.actorId === undefined || ("actorId" in event && event.actorId === match.actorId))))
        && (!match.initial || runtime?.tick === 0)
        && (match.tick === undefined || (runtime?.tick ?? -1) >= match.tick)
        && (match.xMin === undefined || (player?.x ?? -Infinity) >= match.xMin)
        && (match.xMax === undefined || (player?.x ?? Infinity) <= match.xMax)
        && (match.grounded === undefined || player?.grounded === match.grounded)
        && (!match.stopped || player?.vx === 0)
        && (!match.swimReady || (player?.swimCooldown ?? -1) === 0)
        && (!match.ceiling || ceiling)
        && (!match.fallCap || player?.vy === 2.2)
        && (!match.cheepVisible || (view?.water.some(sprite => sprite.id === match.actorId && sprite.key.startsWith("enemy.cheep")) ?? false))
        && (!match.blooperVisible || (view?.water.some(sprite => sprite.id === match.actorId && sprite.key.startsWith("enemy.blooper")) ?? false))
        && (!match.leapVisible || (view?.water.some(sprite => sprite.id === match.actorId && sprite.key.startsWith("enemy.cheep")) ?? false))
        && (!match.swimFrame || (view?.player.key.startsWith("mario.small.swim") ?? false));
    }) });
  }, { match, slot });
}
const signal = (page: Page, slot = "__waterSignal"): Promise<PlayObservation> => bounded(page.evaluate(`globalThis.${slot}`), "water native state subscription");
const state = (page: Page): Promise<PlayObservation> => page.evaluate(() => {
  if (!window.__qa) throw new Error("Actual play observer missing"); return window.__qa.snapshot();
});
async function armDOM(page: Page, event: string) {
  await page.evaluate(event => { Object.defineProperty(globalThis, "__waterDOM", { configurable: true, value: new Promise(resolve => {
    document.addEventListener(event, value => resolve(value instanceof CustomEvent ? value.detail : null), { once: true, capture: true });
  }) }); }, event);
}
const domSignal = (page: Page) => bounded(page.evaluate("globalThis.__waterDOM"), "water DOM subscription");
const sha = (bytes: Uint8Array) => Bun.CryptoHasher.hash("sha256", bytes, "hex");

async function scenario(evidence: string, origin: string, edge: boolean) {
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
      url: `${origin}/?qa=play`, driver: "native isolated Chrome + Playwright CDP", clock: "unmodified native RAF", focusEmulation: true });
    const hashes = [];
    for (const pattern of ["src/game/*.ts", "src/ui/play-*.ts", "scripts/qa/water.ts", "scripts/qa/support.ts", "tests/water.test.ts", "tests/fixtures/water.ts", "dist/app.js", "package.json", "bun.lock"]) {
      for await (const file of new Bun.Glob(pattern).scan(".")) hashes.push({ file, sha256: sha(await Bun.file(file).bytes()) });
    }
    await json(`${evidence}/source-hashes.json`, hashes);
    await page.addInitScript(() => {
      const logs: unknown[] = [];
      Object.defineProperties(globalThis, {
        __waterLogs: { value: logs },
        __waterMounted: { value: new Promise<void>(resolve => document.addEventListener("play-state", () => resolve(), { once: true, capture: true })) },
      });
      document.addEventListener("play-state", event => { if (event instanceof CustomEvent) logs.push(event.detail); }, true);
    });
    await page.goto(`${origin}/?qa=play`, { waitUntil: "load" }); await bounded(page.evaluate("globalThis.__waterMounted"), "actual play mount");
    const observe = async (match: Match, action: string, input?: () => Promise<unknown>) => {
      actions.push({ action, match }); await arm(page, match); if (input) await input();
      const observed = await signal(page); actions.push({ completed: action, observed }); return observed;
    };
    const release = async () => { for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Space", "x"]) await page.keyboard.up(key); };
    const pause = async () => {
      const paused = await observe({ mode: "PAUSED" }, "Escape pause", () => page.keyboard.press("Escape"));
      await release(); return paused;
    };
    const resume = () => observe({ mode: "PLAYING" }, "explicit resume", () => page.getByTestId("resume").click());
    const capture = async (name: string) => {
      const observed = await state(page); assert.equal(observed.mode, "PAUSED");
      const pixels = await page.getByTestId("game-canvas").evaluate(element => {
        if (!(element instanceof HTMLCanvasElement)) throw new Error("Actual canvas missing");
        const r = element.getBoundingClientRect();
        return { width: element.width, height: element.height, cssWidth: r.width, cssHeight: r.height,
          pixelated: getComputedStyle(element).imageRendering, fullyVisible: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight };
      });
      assert.deepEqual(pixels, { width: 256, height: 240, cssWidth: 512, cssHeight: 480, pixelated: "pixelated", fullyVisible: true });
      const file = `${evidence}/${name}.png`, png = await page.screenshot({ path: file });
      assert.deepEqual((await state(page)).runtime, observed.runtime, "Paused capture must not advance simulation");
      captures.push({ file, sha256: sha(png), pixels, observed, visualApproval: "requires image-capable independent inspection" });
    };
    const load = async (which: WaterPlayCase) => {
      await release();
      if ((await state(page)).mode !== "READY") await observe({ mode: "READY" }, "return original file preview", () => page.getByTestId("return-editor").click());
      const course = createWaterPlayFixture(which), bytes = new TextEncoder().encode(fixtureValue(serializeCourse(course))), file = `${evidence}/${which}.smb1.json`;
      await Bun.write(file, bytes); await armDOM(page, "fixture-read-settled"); await page.getByTestId("import-course").setInputFiles(resolve(file));
      await domSignal(page);
      assert.deepEqual(await page.evaluate(() => window.__qa?.course()), course);
      actions.push({ action: "actual file input", which, file: resolve(file), sha256: sha(bytes) });
      const initial = await observe({ mode: "PLAYING", initial: true }, "actual goal-free start", () => page.getByTestId("play-start").click());
      assert.equal(initial.runtime?.player.form, "small");
      return { course, initial };
    };
    if (!edge) {
      const loaded = await load("all");
      const stroked = await observe({ event: "swim", swimFrame: true }, "Space swim stroke", () => page.keyboard.press("Space"));
      assert(stroked.events.some(event => event.type === "swim"));
      assert(stroked.view?.player.key.startsWith("mario.small.swim"));
      assert(stroked.view?.water.some(sprite => sprite.id === WATER_IDS.cheepRed && sprite.key.startsWith("enemy.cheep.red")));
      assert(stroked.view?.water.some(sprite => sprite.id === WATER_IDS.blooper && sprite.key.startsWith("enemy.blooper")));
      const paused = await pause(); await capture("swim-cheep-blooper");
      assert.equal(paused.view?.player.key.startsWith("mario.small.swim"), true);
      assert.equal(paused.view?.water.some(sprite => sprite.id === WATER_IDS.cheepRed), true);
      assert.equal(paused.view?.water.some(sprite => sprite.id === WATER_IDS.blooper), true);
      await resume();
      const moved = await observe({ xMin: 300, xMax: 360 }, "swim right into leap-cheep view", () => page.keyboard.down("ArrowRight"));
      await page.keyboard.up("ArrowRight");
      const leap = moved.events.some(event => event.type === "cheep-leap" && event.actorId === WATER_IDS.cheepLeap)
        ? moved
        : await observe({ event: "cheep-leap", actorId: WATER_IDS.cheepLeap, leapVisible: true }, "seeded leap cheep");
      assert(leap.events.some(event => event.type === "cheep-leap" && event.actorId === WATER_IDS.cheepLeap)
        || (leap.runtime?.water.actors.some(actor => actor.id === WATER_IDS.cheepLeap && actor.kind === "cheep" && actor.vy < 0) ?? false));
      assert.equal(leap.view?.water.some(sprite => sprite.id === WATER_IDS.cheepLeap && sprite.key.startsWith("enemy.cheep.green")), true);
      await pause(); await capture("leap-cheep");
      assert.deepEqual(await page.evaluate(() => window.__qa?.course()), loaded.course);
      actions.push({ outcome: "swim-and-aquatic-enemies", swim: stroked.runtime?.tick, leap: leap.runtime?.tick,
        cheep: paused.runtime?.water.actors.find(actor => actor.id === WATER_IDS.cheepRed),
        blooper: paused.runtime?.water.actors.find(actor => actor.id === WATER_IDS.blooper),
        leaper: leap.runtime?.water.actors.find(actor => actor.id === WATER_IDS.cheepLeap) });
    } else {
      const loaded = await load("edge-ceiling");
      await arm(page, { ceiling: true }, "__waterCeiling");
      const ceilingWait = signal(page, "__waterCeiling");
      const strokes = (async () => {
        for (let stroke = 0; stroke < 16; stroke++) {
          await observe({ event: "swim" }, `Space swim stroke ${stroke + 1}`, () => page.keyboard.press("Space"));
          await observe({ swimReady: true }, `cooldown after stroke ${stroke + 1}`);
        }
      })();
      const ceiling = await Promise.race([
        ceilingWait,
        strokes.then(() => Promise.reject(new Error("16 swim strokes did not contact the water ceiling"))),
      ]);
      actions.push({ completed: "ceiling contact", observed: ceiling });
      assert((ceiling.runtime?.player.y ?? 0) - 15 >= 112);
      assert(ceiling.runtime?.contacts.some(contact => contact.axis === "y" && contact.normal === 1));
      const paused = await pause(); await capture("water-ceiling");
      assert((paused.runtime?.player.y ?? 0) < 160);
      await resume();
      await release();
      const falling = await observe({ fallCap: true }, "release swim honors fall cap 2.2");
      assert.equal(falling.runtime?.player.vy, 2.2);
      assert((falling.runtime?.player.y ?? 0) - 15 >= 112);
      await pause(); await capture("water-fall-cap");
      actions.push({ outcome: "ceiling-and-fall-cap", ceilingTick: ceiling.runtime?.tick, fallTick: falling.runtime?.tick,
        ceilingY: ceiling.runtime?.player.y, fallVy: falling.runtime?.player.vy });
      assert.deepEqual(await page.evaluate(() => window.__qa?.course()), loaded.course);
    }
    if ((await state(page)).mode !== "READY") await observe({ mode: "READY" }, "return original file preview", () => page.getByTestId("return-editor").click());
    await armDOM(page, "play-cleanup"); await page.getByTestId("fixture-exit").click(); cleanup = await domSignal(page);
    assert.deepEqual(cleanup, { rafCancelled: true, inputDisposed: true, listenersAborted: true, subscriptions: 0, debtMs: 0, qaRemoved: true });
    assert.deepEqual(errors, []);
  } catch (error) {
    await json(`${evidence}/original-failure.json`, { message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : null, lastAction: actions.at(-1) });
    throw error;
  } finally {
    try {
      if (!page.isClosed()) {
        await json(`${evidence}/tick-input-events.json`, await page.evaluate("globalThis.__waterLogs ?? []"));
        await json(`${evidence}/last-state.json`, await page.evaluate(() => window.__qa?.snapshot() ?? null));
      }
    } finally {
      try { await native.close(); }
      finally {
        await Promise.all([json(`${evidence}/actions.json`, actions), json(`${evidence}/png-manifest.json`, captures), json(`${evidence}/errors.json`, errors),
          json(`${evidence}/cleanup.json`, { host: cleanup, browserConnected: browser.isConnected(), native: "native-cleanup.json" })]);
      }
    }
  }
}
export const water = (evidence: string, origin: string) => scenario(evidence, origin, false);
export const waterEdge = (evidence: string, origin: string) => scenario(evidence, origin, true);
