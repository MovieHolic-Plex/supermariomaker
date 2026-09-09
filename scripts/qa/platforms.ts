import assert from "node:assert/strict";
import { resolve } from "node:path";
import type { Page } from "playwright-core";
import type { GameEvent } from "../../src/game/state";
import type { PlayObservation } from "../../src/ui/play-gallery";
import { serializeCourse } from "../../src/level/serialize";
import { createPlatformPlayFixture, platformIds as ids } from "../../tests/fixtures/platforms";
import type { PlatformPlayCase } from "../../tests/fixtures/platforms";
import { fixtureValue } from "../../tests/fixtures/factory";
import { bounded, json, nativeChrome, viewport } from "./support";

interface Match {
  mode?: PlayObservation["mode"]; event?: GameEvent["type"]; initial?: boolean;
  xMin?: number; xMax?: number; yMin?: number; yMax?: number;
  grounded?: boolean; stopped?: boolean; climbing?: boolean; defeated?: boolean;
  crush?: boolean; vineHeight?: number; springLaunch?: boolean;
  platformId?: string; platformXMin?: number; platformYMin?: number; balanceOpposite?: boolean;
}
async function arm(page: Page, match: Match, slot = "__platformSignal") {
  await page.evaluate(({ match, slot }) => {
    const qa = window.__qa; if (!qa) throw new Error("Actual play observer missing");
    Object.defineProperty(globalThis, slot, { configurable: true, value: qa.nextState(state => {
      const runtime = state.runtime, player = runtime?.player;
      const body = runtime?.platforms.bodies.find(candidate => candidate.id === match.platformId);
      const partner = runtime?.platforms.bodies.find(candidate => candidate.id !== match.platformId && candidate.kind === "platform");
      return (match.mode === undefined || state.mode === match.mode)
        && (match.event === undefined || state.events.some(event => event.type === match.event))
        && (!match.initial || runtime?.tick === 0)
        && (match.xMin === undefined || (player?.x ?? -Infinity) >= match.xMin)
        && (match.xMax === undefined || (player?.x ?? Infinity) <= match.xMax)
        && (match.yMin === undefined || (player?.y ?? -Infinity) >= match.yMin)
        && (match.yMax === undefined || (player?.y ?? Infinity) <= match.yMax)
        && (match.grounded === undefined || player?.grounded === match.grounded)
        && (!match.stopped || player?.vx === 0)
        && (!match.climbing || runtime?.climb.vineId !== null)
        && (!match.defeated || runtime?.combat.defeated === true)
        && (!match.crush || state.events.some(event => event.type === "playerDefeated" && event.hit.kind === "crush"))
        && (!match.springLaunch || state.events.some(event => event.type === "spring-launch"))
        && (match.vineHeight === undefined || !!runtime?.items.actors.some(actor => actor.kind === "vine" && actor.height >= (match.vineHeight ?? 0)))
        && (match.platformXMin === undefined || (body?.bounds.x ?? -Infinity) >= match.platformXMin)
        && (match.platformYMin === undefined || (body?.bounds.y ?? -Infinity) >= match.platformYMin)
        && (!match.balanceOpposite || (!!body && !!partner && (body.bounds.y - body.origin.y) + (partner.bounds.y - partner.origin.y) === 0
          && body.bounds.y !== body.origin.y));
    }) });
  }, { match, slot });
}
const signal = (page: Page, slot = "__platformSignal"): Promise<PlayObservation> => bounded(page.evaluate(`globalThis.${slot}`), "platform native state subscription");
const state = (page: Page): Promise<PlayObservation> => page.evaluate(() => {
  if (!window.__qa) throw new Error("Actual play observer missing"); return window.__qa.snapshot();
});
async function armDOM(page: Page, event: string) {
  await page.evaluate(event => { Object.defineProperty(globalThis, "__platformDOM", { configurable: true, value: new Promise(resolve => {
    document.addEventListener(event, value => resolve(value instanceof CustomEvent ? value.detail : null), { once: true, capture: true });
  }) }); }, event);
}
const domSignal = (page: Page) => bounded(page.evaluate("globalThis.__platformDOM"), "platform DOM subscription");
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
    for (const pattern of ["src/game/*.ts", "src/ui/play-*.ts", "scripts/qa/platforms.ts", "scripts/qa/support.ts", "tests/platforms.test.ts", "tests/fixtures/platforms.ts", "dist/app.js", "package.json", "bun.lock"]) {
      for await (const file of new Bun.Glob(pattern).scan(".")) hashes.push({ file, sha256: sha(await Bun.file(file).bytes()) });
    }
    await json(`${evidence}/source-hashes.json`, hashes);
    await page.addInitScript(() => {
      const logs: unknown[] = [];
      Object.defineProperties(globalThis, {
        __platformLogs: { value: logs },
        __platformMounted: { value: new Promise<void>(resolve => document.addEventListener("play-state", () => resolve(), { once: true, capture: true })) },
      });
      document.addEventListener("play-state", event => { if (event instanceof CustomEvent) logs.push(event.detail); }, true);
    });
    await page.goto(`${origin}/?qa=play`, { waitUntil: "load" }); await bounded(page.evaluate("globalThis.__platformMounted"), "actual play mount");
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
    const captureCanvas = async (name: string) => {
      const observed = await state(page); assert.equal(observed.mode, "PAUSED");
      const file = `${evidence}/${name}.png`, png = await page.getByTestId("game-canvas").screenshot({ path: file });
      assert.deepEqual((await state(page)).runtime, observed.runtime, "Paused canvas capture must not advance simulation");
      captures.push({ file, sha256: sha(png), canvasOnly: true, observed, visualApproval: "requires image-capable independent inspection" });
    };
    const load = async (which: PlatformPlayCase, first?: Match) => {
      await release();
      if ((await state(page)).mode !== "READY") await observe({ mode: "READY" }, "return original file preview", () => page.getByTestId("return-editor").click());
      const course = createPlatformPlayFixture(which), bytes = new TextEncoder().encode(fixtureValue(serializeCourse(course))), file = `${evidence}/${which}.smb1.json`;
      await Bun.write(file, bytes); await armDOM(page, "fixture-read-settled"); await page.getByTestId("import-course").setInputFiles(resolve(file));
      await domSignal(page);
      assert.deepEqual(await page.evaluate(() => window.__qa?.course()), course);
      actions.push({ action: "actual file input", which, file: resolve(file), sha256: sha(bytes) });
      if (first) await arm(page, first, "__platformFirst");
      const initial = await observe({ mode: "PLAYING", initial: true }, "actual goal-free start", () => page.getByTestId("play-start").click());
      assert.equal(initial.runtime?.player.form, "small");
      const firstState = first ? await signal(page, "__platformFirst") : initial;
      if (first) actions.push({ first, firstState });
      return { course, initial, firstState };
    };
    if (!edge) {
      const horizontal = await load("horizontal");
      const ridden = await observe({ xMin: 90, platformId: ids.horizontal, platformXMin: 57 }, "idle ride on horizontal platform");
      assert.equal(ridden.runtime?.player.vx, 0);
      assert((ridden.runtime?.player.x ?? 0) > 80);
      await pause(); await capture("horizontal-ride"); await resume();
      const restarted = await observe({ mode: "PLAYING", initial: true }, "restart from authored snapshot", () => page.getByTestId("restart-course").click());
      assert.deepEqual(restarted.runtime, horizontal.initial.runtime);
      assert.deepEqual(await page.evaluate(() => window.__qa?.course()), horizontal.course);

      await load("vertical");
      const vertical = await observe({ yMin: 146, platformId: ids.vertical, platformYMin: 146 }, "idle ride on vertical platform");
      assert((vertical.runtime?.player.y ?? 0) > 136);
      await pause(); await capture("vertical-ride");

      const fallingLoad = await load("falling", { event: "platform-fall" });
      assert(fallingLoad.firstState.events.some(event => event.type === "platform-fall"));
      const falling = await observe({ yMin: 160, platformId: ids.falling, platformYMin: 160 }, "falling platform carries rider down");
      assert(falling.runtime?.platforms.bodies.some(body => body.id === ids.falling && body.kind === "platform" && body.falling));
      await pause(); await capture("falling-platform");

      await load("balance");
      const balance = await observe({ platformId: ids.balanceA, balanceOpposite: true }, "balance pair travels equally opposite");
      const a = balance.runtime?.platforms.bodies.find(body => body.id === ids.balanceA);
      const b = balance.runtime?.platforms.bodies.find(body => body.id === ids.balanceB);
      assert(a && b); assert.equal((a.bounds.y - a.origin.y) + (b.bounds.y - b.origin.y), 0);
      await pause(); await capture("balance-opposite");

      const launchLoad = await load("spring", { springLaunch: true });
      const launch = launchLoad.firstState;
      assert(launch.events.some(event => event.type === "spring-launch" && event.vy === -7));
      assert((launch.runtime?.player.y ?? 0) < 192);
      await pause(); await capture("spring-launch");

      const vine = await load("vine");
      await observe({ grounded: true, stopped: true }, "grounded before vine block jump");
      await observe({ event: "itemSpawn" }, "Space hits vine question", () => page.keyboard.down("Space"));
      await observe({ grounded: true }, "release jump and land", () => page.keyboard.up("Space"));
      await observe({ vineHeight: 20 }, "partial already-born vine growth");
      await observe({ xMax: 24, grounded: true }, "walk left clear of the used block", () => page.keyboard.down("ArrowLeft"));
      await page.keyboard.up("ArrowLeft");
      const attached = await observe({ climbing: true }, "jump right with Up to grab the spawned vine", async () => {
        await page.keyboard.down("ArrowRight"); await page.keyboard.down("ArrowUp"); await page.keyboard.down("Space");
      });
      assert.equal(attached.runtime?.climb.vineId !== null, true);
      const attachedVineId = attached.runtime?.climb.vineId;
      assert.equal(typeof attachedVineId, "string");
      const attachedVineActor = attached.runtime?.items.actors.find(actor => actor.id === attachedVineId);
      assert(attachedVineActor !== undefined && attachedVineActor.kind === "vine" && attachedVineActor.height > 0);
      assert.equal(attached.runtime?.player.vx, 0);
      assert.equal(attached.runtime?.player.grounded, false);
      const attachedVy = attached.runtime?.player.vy ?? Number.NaN;
      assert(attachedVy >= -1 && attachedVy <= 1);
      assert.match(attached.view?.player.key ?? "", /^mario\.small\.climb/);
      assert(attached.events.some(event => event.type === "vine-attach"));
      await page.keyboard.up("Space");
      const frozen = await pause();
      assert.equal(frozen.runtime?.climb.vineId, attachedVineId);
      assert.match(frozen.view?.player.key ?? "", /^mario\.small\.climb/);
      await capture("vine-climb-attached");
      await resume();
      await page.keyboard.down("ArrowRight"); await page.keyboard.down("ArrowUp");
      const detached = await observe({ event: "vine-detach" }, "jump detaches without a second ground jump", () => page.keyboard.down("Space"));
      assert.equal(detached.events.filter(event => event.type === "jump").length, 1);
      assert.equal(detached.runtime?.climb.vineId, null);
      await release(); await pause(); await capture("vine-climb-detach");
      assert.deepEqual(await page.evaluate(() => window.__qa?.course()), vine.course);
    } else {
      await load("crush");
      await observe({ xMin: 110, grounded: true }, "walk right of the crush platform", () => page.keyboard.down("ArrowRight"));
      await page.keyboard.up("ArrowRight");
      await observe({ crush: true, defeated: true }, "jump left onto the rising platform and crush", async () => {
        await page.keyboard.down("ArrowLeft"); await page.keyboard.down("Space");
      });
      const crushed = await state(page);
      assert.equal(crushed.runtime?.combat.defeated, true);
      assert((crushed.runtime?.player.y ?? 0) - 15 >= 144);
      await release(); await pause(); await capture("crush-ceiling");
      assert.equal((await state(page)).view?.player.key, "mario.small.death");
      await captureCanvas("crush-ceiling-canvas");
      assert.equal((await state(page)).view?.player.key, "mario.small.death");

      const valid = await load("horizontal");
      const broken = { ...valid.course, areas: valid.course.areas.map(area => ({ ...area,
        objects: area.objects.filter(object => object.id !== ids.horizontal).concat([
          { id: ids.balanceA, kind: "platform" as const, x: 80, y: 160, props: { motion: "balance" as const, length: 3, travel: 2, speed: 1, pairId: ids.balanceB } },
        ]) })) };
      const bytes = new TextEncoder().encode(JSON.stringify(broken)), file = `${evidence}/malformed-balance.smb1.json`;
      await observe({ mode: "READY" }, "return before malformed import", () => page.getByTestId("return-editor").click());
      await Bun.write(file, bytes);
      await armDOM(page, "fixture-read-settled");
      await page.getByTestId("import-course").setInputFiles(resolve(file));
      await domSignal(page);
      const rejected = await page.evaluate(() => ({
        code: document.querySelector('[data-testid="fixture-status"]')?.getAttribute("data-code"),
        course: window.__qa?.course(),
      }));
      assert.equal(rejected.code, "invalid_reference");
      assert.deepEqual(rejected.course, valid.course);
      actions.push({ outcome: "malformed-reciprocal-rejected", rejected, file: resolve(file) });
      const rejectPng = await page.screenshot({ path: `${evidence}/malformed-rejected.png` });
      captures.push({ file: `${evidence}/malformed-rejected.png`, sha256: sha(rejectPng), rejected, visualApproval: "requires image-capable independent inspection" });
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
        await json(`${evidence}/tick-input-events.json`, await page.evaluate("globalThis.__platformLogs ?? []"));
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
export const platforms = (evidence: string, origin: string) => scenario(evidence, origin, false);
export const platformsEdge = (evidence: string, origin: string) => scenario(evidence, origin, true);
