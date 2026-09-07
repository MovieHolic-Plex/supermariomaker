import assert from "node:assert/strict";
import { resolve } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { chromium } from "playwright-core";
import type { Page } from "playwright-core";
import { serializeCourse } from "../../src/level/serialize";
import { EMPTY_INPUT } from "../../src/input";
import type { PlayObservation } from "../../src/ui/play-gallery";
import { createMovementFixture } from "../../tests/fixtures/movement";
import { fixtureValue } from "../../tests/fixtures/factory";
import { bounded, json, viewport } from "./support";

interface Match { mode?: PlayObservation["mode"]; tick?: number; jump?: boolean; held?: "right" | "jump"; risingTicks?: number; apex?: boolean; grounded?: boolean; wall?: boolean }
async function arm(page: Page, match: Match) {
  await page.evaluate(match => {
    const qa = window.__qa;
    if (!qa) throw new Error("Actual play QA observer missing");
    Object.defineProperty(globalThis, "__movementSignal", { configurable: true, value: qa.nextState(state => {
      const player = state.runtime?.player;
      return (match.mode === undefined || state.mode === match.mode)
        && (match.tick === undefined || (state.runtime?.tick ?? -1) >= match.tick)
        && (!match.jump || state.events.some(event => event.type === "jump"))
        && (match.held === undefined || state.input[match.held].held)
        && (match.risingTicks === undefined || (player?.risingTicks ?? -1) >= match.risingTicks)
        && (!match.apex || (!!player && !player.grounded && player.vy >= 0))
        && (match.grounded === undefined || player?.grounded === match.grounded)
        && (!match.wall || (player?.x === 442 && player.vx === 0));
    }) });
  }, match);
}
const signal = (page: Page): Promise<PlayObservation> => bounded(page.evaluate("globalThis.__movementSignal"), "subscribed movement state");
const state = (page: Page): Promise<PlayObservation> => page.evaluate(() => {
  if (!window.__qa) throw new Error("Missing play observer"); return window.__qa.snapshot();
});
async function armEvent(page: Page, event: string) {
  await page.evaluate(event => {
    Object.defineProperty(globalThis, "__movementDOMSignal", { configurable: true, value: new Promise(resolve => {
      document.addEventListener(event, value => resolve(value instanceof CustomEvent ? value.detail : null), { once: true, capture: true });
    }) });
  }, event);
}
const domSignal = (page: Page) => bounded(page.evaluate("globalThis.__movementDOMSignal"), "subscribed DOM event");
const sha = (bytes: Uint8Array) => Bun.CryptoHasher.hash("sha256", bytes, "hex");
// Match the driver's normal isolation from Windows occlusion throttling, without forcing focus.
const nativeArgs = ["--no-first-run", "--no-default-browser-check", "--force-device-scale-factor=1",
  "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding"];

/** Native isolated profile + documented noDefaults: Playwright's normal contexts force focus ON.
 * A second CDP session cannot undo that session-owned override. No daily-driver profile is touched. */
async function nativeChrome(evidence: string, nativeFocus: boolean) {
  const profile = await mkdtemp(resolve(evidence, "chrome-profile-"));
  const child = Bun.spawn(["C:/Program Files/Google/Chrome/Application/chrome.exe", `--user-data-dir=${profile}`,
    "--remote-debugging-port=0", ...nativeArgs, "about:blank"], { stdout: "ignore", stderr: "pipe" });
  const ready = Promise.withResolvers<string>();
  const stderr = (async () => {
    let text = "";
    for await (const chunk of child.stderr) {
      text += new TextDecoder().decode(chunk);
      const endpoint = /DevTools listening on (ws:\/\/[^\s]+)/.exec(text)?.[1]; if (endpoint) ready.resolve(endpoint);
    }
    ready.reject(new Error("Native Chrome exited before DevTools readiness")); return text;
  })();
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | null = null;
  const close = async () => {
    try {
      if (browser?.isConnected()) await (await browser.newBrowserCDPSession()).send("Browser.close");
      await bounded(child.exited, "native Chrome process exit");
    } finally {
      if (child.exitCode === null) child.kill();
      await child.exited;
      if (browser) await browser.close();
      await Bun.write(`${evidence}/chrome-stderr.txt`, await stderr);
      await rm(profile, { recursive: true });
      await json(`${evidence}/native-cleanup.json`, { pid: child.pid, exitCode: child.exitCode, profileRemoved: !existsSync(profile), browserConnected: browser?.isConnected() ?? false });
    }
  };
  try {
    browser = await chromium.connectOverCDP(await bounded(ready.promise, "native Chrome DevTools stderr event"), { noDefaults: nativeFocus, timeout: 10_000 });
    const context = browser.contexts()[0]; assert(context, "Native isolated default context");
    return { browser, context, close };
  } catch (error) { await close(); throw error; }
}
async function movementScenario(evidence: string, origin: string, edge: boolean) {
  const native = await nativeChrome(evidence, edge), { browser, context } = native;
  const actions: unknown[] = [], captures: unknown[] = [], observations: unknown[] = [], errors: string[] = [], consoleMessages: unknown[] = [];
  let cleanup: unknown = null, contextClosed = false;
  const page = context.pages()[0] ?? await context.newPage().catch(async error => { await native.close(); throw error; }); page.setDefaultTimeout(10_000);
  try {
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { consoleMessages.push({ type: message.type(), text: message.text() }); if (message.type() === "error") errors.push(message.text()); });
    page.on("requestfailed", request => errors.push(`${request.url()} ${request.failure()?.errorText}`));
    await page.setViewportSize(viewport);
    await page.bringToFront();
    const sources: unknown[] = [];
    for (const pattern of ["src/**/*.ts", "scripts/qa/movement.ts", "tests/fixtures/movement.ts", "tests/movement.test.ts", "dist/app.js", "package.json", "bun.lock"]) {
      for await (const file of new Bun.Glob(pattern).scan(".")) sources.push({ file, sha256: sha(await Bun.file(file).bytes()) });
    }
    await json(`${evidence}/source-hashes.json`, sources);
    await json(`${evidence}/versions.json`, { browser: browser.version(), bun: Bun.version, driver: "playwright-core CDP", noDefaults: edge, channel: "native Chrome", headed: true, viewport, args: nativeArgs, focusEmulation: !edge, clock: "real RAF / real wall time" });
    await page.addInitScript(() => {
      const logs: unknown[] = [], lifecycle: unknown[] = [], activeRAFs = new Set<number>();
      Object.defineProperties(globalThis, {
        __movementLogs: { value: logs }, __movementLifecycle: { value: lifecycle },
        __movementRAFs: { value: activeRAFs },
        __movementMounted: { value: new Promise<void>(resolve => document.addEventListener("play-state", () => resolve(), { once: true, capture: true })) },
      });
      const request = window.requestAnimationFrame.bind(window), cancel = window.cancelAnimationFrame.bind(window);
      window.requestAnimationFrame = callback => {
        const id = request(time => { activeRAFs.delete(id); callback(time); }); activeRAFs.add(id); return id;
      };
      window.cancelAnimationFrame = id => { activeRAFs.delete(id); cancel(id); };
      document.addEventListener("play-state", event => { if (event instanceof CustomEvent) logs.push(event.detail); }, true);
      window.addEventListener("blur", event => lifecycle.push({ type: "blur", trusted: event.isTrusted, time: performance.now() }));
      document.addEventListener("visibilitychange", event => lifecycle.push({ type: "visibilitychange", hidden: document.hidden, trusted: event.isTrusted, time: performance.now() }));
    });
    await page.goto(`${origin}/?qa=play`, { waitUntil: "load" });
    await bounded(page.evaluate("globalThis.__movementMounted"), "play mounted event");
    const authored = createMovementFixture(), bytes = new TextEncoder().encode(fixtureValue(serializeCourse(authored)));
    const path = `${evidence}/movement.smb1.json`; await Bun.write(path, bytes);
    await armEvent(page, "fixture-read-settled"); await page.getByTestId("import-course").setInputFiles(resolve(path)); await domSignal(page);
    assert.deepEqual(await page.evaluate(() => window.__qa?.course()), authored);
    actions.push({ action: "actual input[type=file]", file: resolve(path), sha256: sha(bytes), url: page.url() });
    const start = async (restart = false) => {
      for (const key of ["ArrowRight", "ArrowLeft", "Shift", "Space", "z", "x"]) await page.keyboard.up(key);
      await arm(page, { mode: "PLAYING", tick: 0 }); await page.getByTestId(restart ? "restart-course" : "play-start").click();
      const initial = await signal(page); assert.equal(initial.runtime?.tick, 0); assert.equal(initial.runtime.player.x, 40);
      assert.equal(await page.getByTestId("game-canvas").evaluate(canvas => canvas === document.activeElement), true);
      actions.push({ action: restart ? "restart-course" : "play-start", initial }); return initial;
    };
    const pause = async () => {
      await arm(page, { mode: "PAUSED" }); await page.keyboard.press("Escape"); return signal(page);
    };
    const capture = async (name: string) => {
      const observed = await state(page); assert.equal(observed.mode, "PAUSED");
      const canvas = page.getByTestId("game-canvas");
      // CDP box-model corners on headed Windows lose float precision when subtracted.
      // Assert the actual DOM layout dimensions, then every composited screenshot pixel below.
      const box = await canvas.evaluate(element => { const rect = element.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }; });
      assert(box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width && box.y + box.height <= viewport.height);
      assert.deepEqual({ width: box.width, height: box.height }, { width: 512, height: 480 });
      const pixels = await canvas.evaluate(element => {
        if (!(element instanceof HTMLCanvasElement)) throw new Error("Missing game canvas");
        return { width: element.width, height: element.height, pixelated: getComputedStyle(element).imageRendering,
          colors: new Set(element.getContext("2d")?.getImageData(0, 0, 256, 240).data).size };
      });
      assert.equal(pixels.width, 256); assert.equal(pixels.height, 240); assert.equal(pixels.pixelated, "pixelated"); assert(pixels.colors > 5);
      assert(observed.view?.player.key.startsWith("mario.small."));
      const file = `${evidence}/${name}.png`, png = await page.screenshot({ path: file });
      const capturedBox = await canvas.evaluate(element => { const rect = element.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }; });
      await json(`${evidence}/${name}-layout.json`, { beforeScreenshot: box, afterScreenshot: capturedBox });
      assert.deepEqual({ width: capturedBox.width, height: capturedBox.height }, { width: 512, height: 480 });
      assert.deepEqual((await state(page)).runtime, observed.runtime, "Screenshot cannot advance paused physics");
      const pixelsChecked = await page.evaluate(async ({ base64, box }) => {
        const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob());
        const shot = document.createElement("canvas"); shot.width = image.width; shot.height = image.height;
        const context = shot.getContext("2d"); if (!context) throw new Error("Missing screenshot context");
        context.drawImage(image, 0, 0); image.close();
        const live = document.querySelector('[data-testid="game-canvas"]');
        if (!(live instanceof HTMLCanvasElement)) throw new Error("Missing game canvas");
        const actual = live.getContext("2d")?.getImageData(0, 0, 256, 240).data;
        if (!actual) throw new Error("Missing actual pixels");
        const captured = context.getImageData(Math.round(box.x), Math.round(box.y), 512, 480).data;
        for (let y = 0; y < 480; y++) for (let x = 0; x < 512; x++) for (let c = 0; c < 4; c++) {
          if (captured[(y * 512 + x) * 4 + c] !== actual[(Math.floor(y / 2) * 256 + Math.floor(x / 2)) * 4 + c]) throw new Error(`Game compositor mismatch ${x},${y},${c}`);
        }
        return 256 * 240;
      }, { base64: png.toString("base64"), box: capturedBox });
      captures.push({ file, sha256: sha(png), box: capturedBox, pixels, pixelsChecked, state: observed, visualApproval: "requires image inspection" }); observations.push({ name, observed });
    };
    await start();
    if (!edge) {
      const horizontal = async (run: boolean) => {
        if (run) await page.keyboard.down("Shift");
        await arm(page, { held: "right" }); await page.keyboard.down("ArrowRight"); const first = await signal(page);
        assert(first.runtime); await arm(page, { tick: first.runtime.tick + 39 }); const at40 = await signal(page);
        assert(at40.runtime); assert.equal(at40.runtime.player.vx, run ? 2.8 : 1.6);
        const paused = await pause(); await capture(run ? "run-cap" : "walk-cap");
        actions.push({ action: "hold horizontal for 40 observed input ticks", run, first, at40, paused }); return at40.runtime.player.x;
      };
      const walk = await horizontal(false); await start(true); const run = await horizontal(true); assert(run > walk + 20);
      const jumpArc = async (target: 6 | 18) => {
        await start(true); await page.keyboard.down("Shift"); await page.keyboard.down("ArrowRight");
        await arm(page, { jump: true }); await page.keyboard.down("Space"); const launch = await signal(page); assert(launch.runtime);
        await arm(page, { tick: launch.runtime.tick + target - 1 }); const releaseTarget = await signal(page);
        await arm(page, { apex: true }); await page.keyboard.up("Space"); const apex = await signal(page); assert(apex.runtime);
        const paused = await pause(); await capture(target === 6 ? "short-jump-apex" : "long-jump-apex");
        const logs = await page.evaluate("globalThis.__movementLogs") as PlayObservation[];
        const segment = logs.slice(logs.map(value => value.runtime?.tick === 0 && value.mode === "PLAYING").lastIndexOf(true))
          .filter(value => value.mode === "PLAYING" && value.runtime && value.runtime.tick >= launch.runtime!.tick);
        const ticks = [...new Map(segment.map(value => [value.runtime?.tick, value])).values()];
        const heldTicks = ticks.filter(value => value.input.jump.held).length;
        assert(heldTicks >= target, "Release must not precede requested hold ticks");
        assert.equal(ticks.filter(value => value.events.some(event => event.type === "jump")).length, 1);
        actions.push({ action: "real Right+Shift+Space, release after subscribed tick", requestedHoldTicks: target, observedHeldTicks: heldTicks,
          launch, releaseTarget, apex, paused, minimumY: Math.min(...ticks.map(value => value.runtime?.player.y ?? Infinity)) });
        return { apex: Math.min(...ticks.map(value => value.runtime?.player.y ?? Infinity)), heldTicks };
      };
      const short = await jumpArc(6), long = await jumpArc(18); assert(long.apex < short.apex - 20); assert(long.heldTicks > short.heldTicks);
      await start(true); await page.keyboard.down("Shift"); await arm(page, { wall: true }); await page.keyboard.down("ArrowRight"); const wall = await signal(page);
      assert.equal(wall.runtime?.player.x, 442); assert.equal(wall.runtime.player.vx, 0);
      await pause(); await capture("wall-stop"); actions.push({ action: "run into wall", wall });
    } else {
      await page.keyboard.down("Shift"); await page.keyboard.down("ArrowRight");
      await arm(page, { jump: true }); await page.keyboard.down("Space"); const launch = await signal(page); assert(launch.runtime);
      await arm(page, { tick: launch.runtime.tick + 4 }); await signal(page);
      // Actual tab activation, with native browser focus/visibility restored before app startup.
      await arm(page, { mode: "PAUSED" });
      const away = await context.newPage(); await away.goto("about:blank", { waitUntil: "load" }); await away.bringToFront();
      const paused = await signal(page); assert(paused.reason === "blur" || paused.reason === "hidden"); assert(paused.runtime);
      assert.equal(paused.clock.debtMs, 0); assert.deepEqual(paused.input, EMPTY_INPUT);
      const lifecycle = await page.evaluate("globalThis.__movementLifecycle") as { type: string; trusted: boolean }[];
      assert(lifecycle.some(event => event.type === "blur" && event.trusted), "Must observe real trusted browser blur, never synthetic dispatch");
      // The foreign page's actual load/focus events provide the away lifecycle; no sleeps or polling.
      await page.bringToFront(); await away.close();
      assert.deepEqual((await state(page)).runtime, paused.runtime, "Focus return is not explicit resume");
      await page.keyboard.up("ArrowRight"); await page.keyboard.up("Shift"); await page.keyboard.up("Space");
      await page.evaluate(() => {
        Object.defineProperty(globalThis, "__pausedKey", { configurable: true, value: new Promise(resolve => {
          window.addEventListener("keydown", event => resolve({ code: event.code, trusted: event.isTrusted, defaultPrevented: event.defaultPrevented }), { once: true });
        }) });
      });
      await page.keyboard.press("Space");
      const pausedKey = await bounded(page.evaluate("globalThis.__pausedKey"), "real paused key event");
      assert.deepEqual(pausedKey, { code: "Space", trusted: true, defaultPrevented: true });
      assert.deepEqual((await state(page)).runtime, paused.runtime, "Paused keyboard cannot jump");
      actions.push({ action: "paused canvas consumes browser navigation without latching game input", pausedKey });
      await capture("real-blur-paused");
      await arm(page, { mode: "PLAYING", tick: paused.runtime.tick }); await page.getByTestId("resume").click(); const resumed = await signal(page);
      assert.deepEqual(resumed.runtime, paused.runtime); assert.equal(resumed.clock.debtMs, 0); assert.deepEqual(resumed.input, EMPTY_INPUT);
      await arm(page, { tick: paused.runtime.tick + 5 }); const after = await signal(page); assert(after.runtime);
      const logs = await page.evaluate("globalThis.__movementLogs") as PlayObservation[];
      const resumeIndex = logs.map(value => value.mode === "PLAYING" && value.runtime?.tick === paused.runtime?.tick).lastIndexOf(true);
      const resumedTicks = logs.slice(resumeIndex + 1).filter(value => value.mode === "PLAYING" && value.runtime && value.runtime.tick <= after.runtime!.tick);
      assert.equal(resumedTicks.length, 5); assert.deepEqual(resumedTicks.map(value => value.runtime?.tick), Array.from({ length: 5 }, (_, i) => paused.runtime!.tick + i + 1));
      for (const value of resumedTicks) { assert.deepEqual(value.input, EMPTY_INPUT); assert(!value.events.some(event => event.type === "jump")); }
      assert(Math.abs(after.runtime.player.x - paused.runtime.player.x) <= 14); assert(Math.abs(after.runtime.player.y - paused.runtime.player.y) <= 30);
      actions.push({ action: "real blur, inactive keys, explicit resume; five contiguous ticks", lifecycle, paused, resumed, after, resumedTicks });
      await pause(); await capture("resumed-no-stale-input");
      await start(true);
      await page.getByTestId("play-note").focus(); await page.keyboard.type("wasdz"); await page.keyboard.press("Space"); await page.keyboard.press("ArrowRight"); await page.keyboard.press("Shift+X");
      const beforeText = await state(page); assert(beforeText.runtime); await arm(page, { tick: beforeText.runtime.tick + 3 }); const afterText = await signal(page);
      assert.equal(await page.getByTestId("play-note").inputValue(), "wasdz X"); assert.equal(afterText.runtime?.player.x, 40); assert.equal(afterText.runtime.player.y, 208); assert.deepEqual(afterText.input, EMPTY_INPUT);
      actions.push({ action: "real text field keyboard does not leak shortcuts", beforeText, afterText });
      await page.getByTestId("game-canvas").focus(); await pause(); await capture("form-focus-no-leak");
      const initial1 = await start(true); await pause(); const initial2 = await start(true); assert.deepEqual(initial1.runtime, initial2.runtime);
      await pause(); actions.push({ action: "restart twice equal initial runtime", initial1, initial2 });
    }
    await arm(page, { mode: "READY" }); await page.getByTestId("return-editor").click(); const returned = await signal(page); assert.equal(returned.runtime, null);
    assert.deepEqual(await page.evaluate(() => window.__qa?.course()), authored, "Playing/restarting cannot mutate authored document");
    assert.equal(await page.getByTestId("fixture-snapshot").textContent(), JSON.stringify(authored));
    await armEvent(page, "play-cleanup"); await page.getByTestId("fixture-exit").click(); cleanup = await domSignal(page);
    assert.deepEqual(cleanup, { rafCancelled: true, inputDisposed: true, listenersAborted: true, subscriptions: 0, debtMs: 0, qaRemoved: true });
    assert.equal(await page.evaluate("globalThis.__movementRAFs.size"), 0); assert.equal(await page.getByTestId("game-canvas").count(), 0);
    await json(`${evidence}/tick-input-log.json`, await page.evaluate("globalThis.__movementLogs"));
    await json(`${evidence}/lifecycle.json`, await page.evaluate("globalThis.__movementLifecycle"));
    assert.deepEqual(errors, []);
  } finally {
    try {
      if (!page.isClosed()) {
        await json(`${evidence}/last-state.json`, await page.evaluate(() => window.__qa?.snapshot() ?? null));
        await json(`${evidence}/tick-input-log.json`, await page.evaluate("globalThis.__movementLogs ?? []"));
        await json(`${evidence}/lifecycle.json`, await page.evaluate("globalThis.__movementLifecycle ?? []"));
        await json(`${evidence}/browser-state.json`, await page.evaluate(() => ({ hidden: document.hidden, focused: document.hasFocus(),
          width: innerWidth, height: innerHeight, scrollX, scrollY, dpr: devicePixelRatio, active: document.activeElement?.getAttribute("data-testid") })));
        if (!cleanup) await page.screenshot({ path: `${evidence}/failure-surface.png`, timeout: 10_000 });
      }
    } finally {
      await native.close(); contextClosed = true;
    }
    await Promise.all([json(`${evidence}/console.json`, consoleMessages), json(`${evidence}/actions.json`, actions), json(`${evidence}/states.json`, observations), json(`${evidence}/png-manifest.json`, captures), json(`${evidence}/errors.json`, errors),
      json(`${evidence}/cleanup.json`, { host: cleanup, contextClosed, browserConnected: browser.isConnected(), profile: "isolated ephemeral; native-cleanup.json records removal", clock: "unmodified real wall time" })]);
  }
}
export const movement = (evidence: string, origin: string) => movementScenario(evidence, origin, false);
export const movementEdge = (evidence: string, origin: string) => movementScenario(evidence, origin, true);
