import assert from "node:assert/strict";
import { resolve } from "node:path";
import type { Page } from "playwright-core";
import type { GameEvent } from "../../src/game/state";
import type { PlayObservation } from "../../src/ui/play-gallery";
import { serializeCourse } from "../../src/level/serialize";
import { createGoalPlayFixture, GOAL_IDS } from "../../tests/fixtures/goals";
import type { GoalPlayCase } from "../../tests/fixtures/goals";
import { fixtureValue } from "../../tests/fixtures/factory";
import { bounded, json, nativeChrome, viewport } from "./support";

interface Match {
  mode?: PlayObservation["mode"]; event?: GameEvent["type"];
  initial?: boolean; ending?: "none" | "flag" | "castle";
  phase?: "slide" | "walk" | "wait" | "collapse" | "fall";
  defeated?: boolean; timer?: number; bowserYMin?: number; collapsed?: boolean;
}
async function arm(page: Page, match: Match, slot = "__goalSignal", timeoutMs = 10_000) {
  await page.evaluate(({ match, slot, timeoutMs, bowserId }) => {
    const qa = window.__qa; if (!qa) throw new Error("Actual play observer missing");
    Object.defineProperty(globalThis, slot, { configurable: true, value: qa.nextState(state => {
      const runtime = state.runtime, ending = runtime?.ending;
      const king = runtime?.hazards.actors.find(actor => actor.id === bowserId);
      return (match.mode === undefined || state.mode === match.mode)
        && (match.event === undefined || state.events.some(event => event.type === match.event))
        && (!match.initial || runtime?.tick === 0)
        && (match.ending === undefined || ending?.kind === match.ending)
        && (match.phase === undefined || (ending !== undefined && "phase" in ending && ending.phase === match.phase))
        && (!match.defeated || runtime?.combat.defeated === true)
        && (match.timer === undefined || runtime?.timer.remaining === match.timer)
        && (match.bowserYMin === undefined || (king?.y ?? -Infinity) >= match.bowserYMin)
        && (!match.collapsed || (runtime?.areas.some(area => area.collapsedGoalIds.length > 0) ?? false));
    }, timeoutMs) });
  }, { match, slot, timeoutMs, bowserId: GOAL_IDS.bowser });
}
const signal = (page: Page, slot = "__goalSignal"): Promise<PlayObservation> => bounded(page.evaluate(`globalThis.${slot}`), "goal native state subscription");
const state = (page: Page): Promise<PlayObservation> => page.evaluate(() => {
  if (!window.__qa) throw new Error("Actual play observer missing"); return window.__qa.snapshot();
});
async function armDOM(page: Page, event: string) {
  await page.evaluate(event => { Object.defineProperty(globalThis, "__goalDOM", { configurable: true, value: new Promise(resolve => {
    document.addEventListener(event, value => resolve(value instanceof CustomEvent ? value.detail : null), { once: true, capture: true });
  }) }); }, event);
}
const domSignal = (page: Page) => bounded(page.evaluate("globalThis.__goalDOM"), "goal DOM subscription");
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
    for (const pattern of ["src/game/goals.ts", "src/game/run.ts", "src/ui/hud.ts", "src/ui/play-*.ts", "scripts/qa/goals.ts", "tests/goals.test.ts", "tests/fixtures/goals.ts", "dist/app.js"]) {
      for await (const file of new Bun.Glob(pattern).scan(".")) hashes.push({ file, sha256: sha(await Bun.file(file).bytes()) });
    }
    await json(`${evidence}/source-hashes.json`, hashes);
    await page.addInitScript(() => {
      const logs: unknown[] = [];
      Object.defineProperties(globalThis, {
        __goalLogs: { value: logs },
        __goalMounted: { value: new Promise<void>(resolve => document.addEventListener("play-state", () => resolve(), { once: true, capture: true })) },
      });
      document.addEventListener("play-state", event => { if (event instanceof CustomEvent) logs.push(event.detail); }, true);
    });
    await page.goto(`${origin}/?qa=play`, { waitUntil: "load" }); await bounded(page.evaluate("globalThis.__goalMounted"), "actual play mount");
    const observe = async (match: Match, action: string, input?: () => Promise<unknown>, timeoutMs = 10_000): Promise<PlayObservation> => {
      actions.push({ action, match }); await arm(page, match, "__goalSignal", timeoutMs); if (input) await input();
      const observed: PlayObservation = timeoutMs > 10_000
        ? await page.evaluate(() => (globalThis as unknown as { __goalSignal: Promise<PlayObservation> }).__goalSignal)
        : await signal(page);
      actions.push({ completed: action, observed }); return observed;
    };
    const release = async () => { for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Space", "x"]) await page.keyboard.up(key); };
    const pause = async () => {
      const paused = await observe({ mode: "PAUSED" }, "Escape pause", () => page.keyboard.press("Escape"));
      await release(); return paused;
    };
    const resume = () => observe({ mode: "PLAYING" }, "explicit resume", () => page.getByTestId("resume").click());
    const capture = async (name: string) => {
      const observed = await state(page);
      const pixels = await page.getByTestId("game-canvas").evaluate(element => {
        if (!(element instanceof HTMLCanvasElement)) throw new Error("Actual canvas missing");
        const r = element.getBoundingClientRect();
        return { width: element.width, height: element.height, cssWidth: r.width, cssHeight: r.height,
          pixelated: getComputedStyle(element).imageRendering, fullyVisible: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight };
      });
      assert.deepEqual(pixels, { width: 256, height: 240, cssWidth: 512, cssHeight: 480, pixelated: "pixelated", fullyVisible: true });
      const file = `${evidence}/${name}.png`, png = await page.screenshot({ path: file });
      const after = await state(page);
      assert.equal(after.runtime?.tick, observed.runtime?.tick, "Capture must not advance simulation");
      const dialog = await page.getByTestId("clear-dialog").evaluate(el => ({ hidden: (el as HTMLElement).hidden, ending: (el as HTMLElement).dataset["ending"] ?? null, text: el.textContent }));
      const retryHidden = await page.getByTestId("retry").evaluate(el => (el as HTMLElement).hidden);
      const gameOverHidden = await page.getByTestId("game-over").evaluate(el => (el as HTMLElement).hidden);
      captures.push({ file, sha256: sha(png), pixels, observed, dialog, retryHidden, gameOverHidden, visualApproval: "requires image-capable independent inspection" });
    };
    const load = async (which: GoalPlayCase) => {
      await release();
      if ((await state(page)).mode !== "READY") await observe({ mode: "READY" }, "return original file preview", () => page.getByTestId("return-editor").click());
      const course = createGoalPlayFixture(which), bytes = new TextEncoder().encode(fixtureValue(serializeCourse(course))), file = `${evidence}/${which}.smb1.json`;
      await Bun.write(file, bytes); await armDOM(page, "fixture-read-settled"); await page.getByTestId("import-course").setInputFiles(resolve(file));
      await domSignal(page);
      assert.deepEqual(await page.evaluate(() => window.__qa?.course()), course);
      actions.push({ action: "actual file input", which, file: resolve(file), sha256: sha(bytes) });
      const initial = await observe({ mode: "PLAYING", initial: true }, "actual play start", () => page.getByTestId("play-start").click());
      assert.equal(initial.runtime?.player.form, "small");
      return { course, initial };
    };
    if (!edge) {
      const flag = await load("flag");
      const grabbed = await observe({ event: "flag-grab", ending: "flag" }, "run and jump into the flagpole", async () => {
        await page.keyboard.down("ArrowRight"); await page.keyboard.down("Space");
      });
      assert(grabbed.events.some(event => event.type === "flag-grab" && event.goalId === GOAL_IDS.flag));
      await release();
      if (grabbed.runtime?.ending.kind !== "flag" || grabbed.runtime.ending.phase !== "slide") {
        await observe({ ending: "flag", phase: "slide" }, "flag slide phase");
      }
      await pause();
      assert.equal((await state(page)).runtime?.ending.kind, "flag");
      await capture("flag-slide");
      await resume();
      const cleared = await observe({ mode: "CLEARED", event: "courseClear" }, "flag courseClear dialog");
      assert(cleared.events.some(event => event.type === "courseClear" && event.ending === "flag"));
      const flagDialog = await page.getByTestId("clear-dialog").evaluate(el => ({ hidden: (el as HTMLElement).hidden, ending: (el as HTMLElement).dataset["ending"] ?? null, text: el.textContent }));
      assert.equal(flagDialog.hidden, false);
      assert.equal(flagDialog.ending, "flag");
      await capture("flag-clear-dialog");
      assert.deepEqual(await page.evaluate(() => window.__qa?.course()), flag.course);

      const castle = await load("castle");
      const axe = await observe({ event: "axe", ending: "castle", collapsed: true }, "hold Right into the axe", () => page.keyboard.down("ArrowRight"));
      assert(axe.events.some(event => event.type === "axe" && event.goalId === GOAL_IDS.castle));
      assert(axe.events.some(event => event.type === "bridge-collapse"));
      await release();
      const startY = axe.runtime?.hazards.actors.find(actor => actor.id === GOAL_IDS.bowser)?.y ?? 208;
      await observe({ ending: "castle", bowserYMin: startY + 8 }, "Bowser falls after bridge collapse");
      await pause();
      await capture("castle-axe-bridge-fall");
      await resume();
      const castleClear = await observe({ mode: "CLEARED", event: "courseClear" }, "castle courseClear dialog");
      assert(castleClear.events.some(event => event.type === "courseClear" && event.ending === "castle"));
      const castleDialog = await page.getByTestId("clear-dialog").evaluate(el => ({ hidden: (el as HTMLElement).hidden, ending: (el as HTMLElement).dataset["ending"] ?? null, text: el.textContent }));
      assert.equal(castleDialog.hidden, false);
      assert.equal(castleDialog.ending, "castle");
      assert.notEqual(castleDialog.text, flagDialog.text);
      await capture("castle-clear-dialog");
      assert.deepEqual(await page.evaluate(() => window.__qa?.course()), castle.course);
      actions.push({ outcome: "two-distinct-endings", flagTick: grabbed.runtime?.tick, castleTick: axe.runtime?.tick });
    } else {
      const tie = await load("death-tie");
      const death = await observe({ event: "playerDefeated", defeated: true }, "walk into goomba on the flagpole", () => page.keyboard.down("ArrowRight"));
      assert(death.events.some(event => event.type === "playerDefeated"));
      assert.equal(death.events.some(event => event.type === "flag-grab" || event.type === "courseClear"), false);
      assert.equal(death.runtime?.ending.kind, "none");
      await release();
      await pause();
      assert.equal(await page.getByTestId("clear-dialog").evaluate(el => (el as HTMLElement).hidden), true);
      await capture("death-beats-goal");
      assert.deepEqual(await page.evaluate(() => window.__qa?.course()), tie.course);

      await load("timeout");
      page.setDefaultTimeout(45_000);
      const timeout = await observe({ event: "playerDefeated", timer: 0, defeated: true }, "idle until authored 30s timer expires", undefined, 40_000);
      page.setDefaultTimeout(10_000);
      assert(timeout.events.some(event => event.type === "playerDefeated" && "hit" in event && event.hit.kind === "timeout"));
      assert.equal(timeout.runtime?.timer.remaining, 0);
      const frozen = await observe({ mode: "DEAD" }, "death freeze then retry UI");
      assert.equal(frozen.mode, "DEAD");
      assert.equal(frozen.runtime?.progress.lives, 2);
      assert.equal(await page.getByTestId("retry").evaluate(el => (el as HTMLElement).hidden), false);
      await capture("timeout-game-over");
      await observe({ mode: "PLAYING", initial: true }, "retry restores snapshot", () => page.getByTestId("retry").click());
      const after = await state(page);
      assert.equal(after.runtime?.progress.lives, 2);
      assert.equal(after.runtime?.timer.remaining, 30);
      actions.push({ outcome: "timeout-and-death-tie" });
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
        await json(`${evidence}/tick-input-events.json`, await page.evaluate("globalThis.__goalLogs ?? []"));
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
export const goals = (evidence: string, origin: string) => scenario(evidence, origin, false);
export const goalsEdge = (evidence: string, origin: string) => scenario(evidence, origin, true);
