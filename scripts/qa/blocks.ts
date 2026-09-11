import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import type { Page } from "playwright-core";
import { serializeCourse } from "../../src/level/serialize";
import type { GameEvent } from "../../src/game/state";
import type { PlayObservation } from "../../src/ui/play-gallery";
import { createBlocksFixture } from "../../tests/fixtures/blocks";
import type { BlocksCase } from "../../tests/fixtures/blocks";
import { fixtureValue } from "../../tests/fixtures/factory";
import { bounded, closeOwnedBrowser, json, viewport } from "./support";

interface Match {
  mode?: PlayObservation["mode"]; event?: GameEvent["type"]; form?: "small" | "super" | "fire";
  xMin?: number; xMax?: number; grounded?: boolean; stopped?: boolean; coins?: number;
  star?: boolean; lives?: number; vineHeight?: number;
}
async function arm(page: Page, match: Match) {
  await page.evaluate(match => {
    const qa = window.__qa; if (!qa) throw new Error("Real play observer missing");
    Object.defineProperty(globalThis, "__blocksSignal", { configurable: true, value: qa.nextState(state => {
      const runtime = state.runtime, player = runtime?.player;
      return (match.mode === undefined || state.mode === match.mode)
        && (match.event === undefined || state.events.some(event => event.type === match.event))
        && (match.form === undefined || player?.form === match.form)
        && (match.xMin === undefined || (player?.x ?? -Infinity) >= match.xMin)
        && (match.xMax === undefined || (player?.x ?? Infinity) <= match.xMax)
        && (match.grounded === undefined || player?.grounded === match.grounded)
        && (!match.stopped || player?.vx === 0)
        && (match.coins === undefined || runtime?.progress.coins === match.coins)
        && (!match.star || (runtime?.combat.starTicks ?? 0) > 0)
        && (match.lives === undefined || runtime?.progress.lives === match.lives)
        && (match.vineHeight === undefined || !!runtime?.items.actors.some(actor => actor.kind === "vine" && actor.height === match.vineHeight));
    }) });
  }, match);
}
const signal = (page: Page): Promise<PlayObservation> => bounded(page.evaluate("globalThis.__blocksSignal"), "subscribed blocks state");
const state = (page: Page): Promise<PlayObservation> => page.evaluate(() => {
  if (!window.__qa) throw new Error("Missing observer"); return window.__qa.snapshot();
});
async function armDOM(page: Page, event: string) {
  await page.evaluate(event => {
    Object.defineProperty(globalThis, "__blocksDOMSignal", { configurable: true, value: new Promise(resolve => {
      document.addEventListener(event, value => resolve(value instanceof CustomEvent ? value.detail : null), { once: true, capture: true });
    }) });
  }, event);
}
const domSignal = (page: Page) => bounded(page.evaluate("globalThis.__blocksDOMSignal"), "subscribed blocks DOM event");
const sha = (bytes: Uint8Array) => Bun.CryptoHasher.hash("sha256", bytes, "hex");

async function blocksScenario(evidence: string, origin: string, edge: boolean) {
  const browser = await chromium.launch({ channel: "chrome", headless: true, timeout: 10_000 });
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const page = await context.newPage(); page.setDefaultTimeout(10_000);
  const actions: unknown[] = [], captures: unknown[] = [], errors: string[] = [], consoleMessages: unknown[] = [];
  let cleanup: unknown = null, contextClosed = false;
  try {
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { consoleMessages.push({ type: message.type(), text: message.text() }); if (message.type() === "error") errors.push(message.text()); });
    page.on("requestfailed", request => errors.push(`${request.url()} ${request.failure()?.errorText}`));
    await json(`${evidence}/versions.json`, { browser: browser.version(), bun: Bun.version, driver: "playwright-core", channel: "chrome", headless: true, viewport, clock: "unmodified native RAF", url: `${origin}/?qa=play` });
    const hashes: unknown[] = [];
    for (const pattern of ["src/game/*.ts", "src/ui/play-*.ts", "scripts/qa/blocks.ts", "tests/blocks.test.ts", "tests/fixtures/blocks.ts", "dist/app.js", "package.json", "bun.lock"]) {
      for await (const file of new Bun.Glob(pattern).scan(".")) hashes.push({ file, sha256: sha(await Bun.file(file).bytes()) });
    }
    await json(`${evidence}/source-hashes.json`, hashes);
    await page.addInitScript(() => {
      const logs: unknown[] = [];
      Object.defineProperties(globalThis, {
        __blocksLogs: { value: logs },
        __blocksMounted: { value: new Promise<void>(resolve => document.addEventListener("play-state", () => resolve(), { once: true, capture: true })) },
      });
      document.addEventListener("play-state", event => { if (event instanceof CustomEvent) logs.push(event.detail); }, true);
    });
    await page.goto(`${origin}/?qa=play`, { waitUntil: "load" }); await bounded(page.evaluate("globalThis.__blocksMounted"), "real play mount");
    const observe = async (match: Match, label: string, action?: () => Promise<unknown>) => {
      actions.push({ action: label, match }); await arm(page, match); if (action) await action();
      const observed = await signal(page); actions.push({ completed: label, observed }); return observed;
    };
    const release = async () => { for (const key of ["ArrowRight", "ArrowLeft", "Space", "Shift", "x"]) await page.keyboard.up(key); };
    const pause = () => observe({ mode: "PAUSED" }, "Escape pause", () => page.keyboard.press("Escape"));
    const resume = () => observe({ mode: "PLAYING" }, "explicit resume", () => page.getByTestId("resume").click());
    const capture = async (name: string) => {
      const observed = await state(page); assert.equal(observed.mode, "PAUSED");
      const canvas = page.getByTestId("game-canvas");
      const pixels = await canvas.evaluate(element => {
        if (!(element instanceof HTMLCanvasElement)) throw new Error("Game canvas missing");
        const rect = element.getBoundingClientRect();
        return { width: element.width, height: element.height, cssWidth: rect.width, cssHeight: rect.height, pixelated: getComputedStyle(element).imageRendering,
          fullyVisible: rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight };
      });
      assert.deepEqual(pixels, { width: 256, height: 240, cssWidth: 512, cssHeight: 480, pixelated: "pixelated", fullyVisible: true });
      const file = `${evidence}/${name}.png`, png = await page.screenshot({ path: file });
      assert.deepEqual((await state(page)).runtime, observed.runtime);
      captures.push({ file, sha256: sha(png), pixels, state: observed, visualApproval: "requires image-capable independent inspection" });
    };
    const load = async (which: BlocksCase) => {
      await release();
      if ((await state(page)).mode !== "READY") await observe({ mode: "READY" }, "return unchanged file preview", () => page.getByTestId("return-editor").click());
      const course = createBlocksFixture(which), bytes = new TextEncoder().encode(fixtureValue(serializeCourse(course))), file = `${evidence}/${which}.smb1.json`;
      await Bun.write(file, bytes); await armDOM(page, "fixture-read-settled"); await page.getByTestId("import-course").setInputFiles(resolve(file)); await domSignal(page);
      assert.deepEqual(await page.evaluate(() => window.__qa?.course()), course);
      actions.push({ action: "actual file input", which, file: resolve(file), sha256: sha(bytes) });
      const initial = await observe({ mode: "PLAYING" }, "real goal-free play start", () => page.getByTestId("play-start").click());
      assert.equal(initial.runtime?.tick, 0); assert.equal(initial.runtime.player.form, "small"); return course;
    };
    const jumpHit = async (event: GameEvent["type"] = "blockUsed") => {
      await observe({ grounded: true, stopped: true }, "grounded/stationary before jump");
      const hit = await observe({ event }, `Space jump -> ${event}`, () => page.keyboard.down("Space"));
      await observe({ grounded: true }, "release jump -> actual landing", () => page.keyboard.up("Space")); return hit;
    };
    const tile = (observed: PlayObservation, x = 2, y = 10) => observed.runtime?.areas.find(area => area.id === observed.runtime?.areaId)?.tiles.find(tile => tile.x === x && tile.y === y);
    if (!edge) {
      const course = await load("progression");
      const mushroomSpawn = await jumpHit(); assert(mushroomSpawn.events.some(event => event.type === "itemSpawn" && event.kind === "mushroom"));
      const superState = await observe({ form: "super" }, "hold Right and collect actual moving mushroom", () => page.keyboard.down("ArrowRight"));
      assert.equal(superState.runtime?.progress.score, 1000); assert.equal(superState.view?.player.key.startsWith("mario.super."), true);
      await observe({ xMin: 138, stopped: true }, "reach right wall"); await page.keyboard.up("ArrowRight"); await pause(); await capture("super-from-question"); await resume();
      const flowerSpawn = await jumpHit(); assert(flowerSpawn.events.some(event => event.type === "itemSpawn" && event.kind === "flower"));
      await observe({ xMax: 110 }, "walk left toward brick", () => page.keyboard.down("ArrowLeft"));
      await observe({ stopped: true, grounded: true }, "release left and coast to rest", () => page.keyboard.up("ArrowLeft"));
      const broken = await jumpHit("blockBreak"); assert.equal(tile(broken, 6, 7), undefined);
      await pause(); await capture("super-break-brick"); await resume();
      await observe({ event: "jump" }, "jump from beside used question", () => page.keyboard.down("Space"));
      const fireState = await observe({ form: "fire" }, "move Right above question and collect actual flower", () => page.keyboard.down("ArrowRight"));
      assert.equal(fireState.runtime?.progress.score, 2050); await release(); await pause(); await capture("fire-from-flower"); await resume();
      const shot = await observe({ event: "fire" }, "real X fire edge", () => page.keyboard.down("x"));
      assert(shot.runtime?.items.actors.some(actor => actor.kind === "fireball" && actor.age === 0)); await page.keyboard.up("x"); await pause(); await capture("fireball");
      assert.deepEqual(await page.evaluate(() => window.__qa?.course()), course);
      for (const which of ["coin", "hidden", "multiCoin", "vine", "star", "oneUp"] as const) {
        const original = await load(which);
        if (which === "multiCoin") {
          for (let i = 0; i < 10; i++) { const hit = await jumpHit("blockBump"); assert.equal(hit.runtime?.progress.coins, i + 1); }
          assert.equal(tile(await state(page))?.kind, "used");
        } else {
          const hit = await jumpHit(); assert.equal(tile(hit)?.kind, "used");
          if (which === "coin" || which === "hidden") assert.equal(hit.runtime?.progress.coins, 1);
          if (which === "hidden") assert(hit.events.some(event => event.type === "blockReveal"));
          if (which === "vine") await observe({ vineHeight: 96 }, "actual six-cell vine growth");
          if (which === "coin") await observe({ coins: 2 }, "walk into world coin", () => page.keyboard.down("ArrowRight"));
          if (which === "star") await observe({ star: true }, "walk into bouncing star", () => page.keyboard.down("ArrowRight"));
          if (which === "oneUp") await observe({ lives: 4 }, "walk into moving 1UP", () => page.keyboard.down("ArrowRight"));
        }
        await release(); await pause(); await capture(which); assert.deepEqual(await page.evaluate(() => window.__qa?.course()), original);
      }
    } else {
      const hidden = await load("hiddenSide");
      const crossed = await observe({ xMin: 80 }, "walk through hidden block from side", () => page.keyboard.down("ArrowRight"));
      assert.equal(tile(crossed)?.kind, "hidden"); assert.equal(crossed.runtime?.progress.coins, 0); assert.equal(crossed.runtime.player.form, "small");
      await release(); await pause(); await capture("hidden-side-no-reveal"); assert.deepEqual(await page.evaluate(() => window.__qa?.course()), hidden);
      const brick = await load("smallBrick"); const bump = await jumpHit("blockBump");
      assert.equal(tile(bump)?.kind, "brick"); assert.equal(bump.runtime?.progress.score, 0); assert(!bump.events.some(event => event.type === "blockBreak"));
      await pause(); await capture("small-brick-no-break"); assert.deepEqual(await page.evaluate(() => window.__qa?.course()), brick);
    }
    await observe({ mode: "READY" }, "return authoring file unchanged", () => page.getByTestId("return-editor").click());
    await armDOM(page, "play-cleanup"); await page.getByTestId("fixture-exit").click(); cleanup = await domSignal(page);
    assert.deepEqual(cleanup, { rafCancelled: true, inputDisposed: true, listenersAborted: true, subscriptions: 0, debtMs: 0, qaRemoved: true });
    assert.equal(await page.getByTestId("game-canvas").count(), 0); assert.deepEqual(errors, []);
  } finally {
    try {
      if (!page.isClosed()) {
        await json(`${evidence}/tick-input-events.json`, await page.evaluate("globalThis.__blocksLogs ?? []"));
        await json(`${evidence}/last-state.json`, await page.evaluate(() => window.__qa?.snapshot() ?? null));
        if (!cleanup) await page.screenshot({ path: `${evidence}/failure-surface.png` });
      }
    } finally { await context.close(); contextClosed = true; await closeOwnedBrowser(browser); }
    await Promise.all([json(`${evidence}/actions.json`, actions), json(`${evidence}/png-manifest.json`, captures), json(`${evidence}/errors.json`, errors), json(`${evidence}/console.json`, consoleMessages),
      json(`${evidence}/cleanup.json`, { host: cleanup, contextClosed, browserConnected: browser.isConnected(), isolatedProfile: true, clock: "unmodified native RAF" })]);
  }
}
export const blocks = (evidence: string, origin: string) => blocksScenario(evidence, origin, false);
export const blocksEdge = (evidence: string, origin: string) => blocksScenario(evidence, origin, true);
