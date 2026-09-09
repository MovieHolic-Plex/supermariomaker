import assert from "node:assert/strict";
import { resolve } from "node:path";
import type { Page } from "playwright-core";
import type { GameEvent } from "../../src/game/state";
import type { GroundActor } from "../../src/game/enemies-ground";
import type { PlayObservation } from "../../src/ui/play-gallery";
import { serializeCourse } from "../../src/level/serialize";
import { createGroundPlayFixture, GROUND_IDS } from "../../tests/fixtures/enemies-ground";
import type { GroundPlayCase } from "../../tests/fixtures/enemies-ground";
import { fixtureValue } from "../../tests/fixtures/factory";
import { bounded, json, nativeChrome, viewport } from "./support";

interface Match {
  mode?: PlayObservation["mode"]; event?: GameEvent["type"]; actorId?: string;
  kind?: GroundActor["kind"]; tick?: number; initial?: boolean; age?: number;
  xMin?: number; xMax?: number; grounded?: boolean; stopped?: boolean;
  form?: "super" | "fire"; victims?: number;
}
async function arm(page: Page, match: Match, slot = "__groundSignal") {
  await page.evaluate(({ match, slot }) => {
    const qa = window.__qa; if (!qa) throw new Error("Actual play observer missing");
    Object.defineProperty(globalThis, slot, { configurable: true, value: qa.nextState(state => {
      const runtime = state.runtime, player = runtime?.player;
      const actor = runtime?.ground.actors.find(actor => actor.id === match.actorId);
      return (match.mode === undefined || state.mode === match.mode)
        && (match.event === undefined || state.events.some(event => event.type === match.event && (match.actorId === undefined || ("actorId" in event && event.actorId === match.actorId))))
        && (match.kind === undefined || actor?.kind === match.kind)
        && (match.tick === undefined || (runtime?.tick ?? -1) >= match.tick)
        && (!match.initial || runtime?.tick === 0)
        && (match.age === undefined || (actor?.kind === "shell" && actor.shell.idleTicks >= match.age))
        && (match.xMin === undefined || (player?.x ?? -Infinity) >= match.xMin)
        && (match.xMax === undefined || (player?.x ?? Infinity) <= match.xMax)
        && (match.grounded === undefined || player?.grounded === match.grounded)
        && (!match.stopped || player?.vx === 0)
        && (match.form === undefined || player?.form === match.form)
        && (match.victims === undefined || runtime?.ground.actors.filter(actor => actor.kind === "defeated").length === match.victims);
    }) });
  }, { match, slot });
}
const signal = (page: Page, slot = "__groundSignal"): Promise<PlayObservation> => bounded(page.evaluate(`globalThis.${slot}`), "ground native state subscription");
const state = (page: Page): Promise<PlayObservation> => page.evaluate(() => {
  if (!window.__qa) throw new Error("Actual play observer missing"); return window.__qa.snapshot();
});
async function armDOM(page: Page, event: string) {
  await page.evaluate(event => { Object.defineProperty(globalThis, "__groundDOM", { configurable: true, value: new Promise(resolve => {
    document.addEventListener(event, value => resolve(value instanceof CustomEvent ? value.detail : null), { once: true, capture: true });
  }) }); }, event);
}
const domSignal = (page: Page) => bounded(page.evaluate("globalThis.__groundDOM"), "ground DOM subscription");
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
    for (const pattern of ["src/**/*.ts", "scripts/qa/enemies-ground.ts", "scripts/qa/support.ts", "tests/fixtures/enemies-ground.ts", "tests/enemies-ground.test.ts", "dist/app.js", "package.json", "bun.lock"]) {
      for await (const file of new Bun.Glob(pattern).scan(".")) hashes.push({ file, sha256: sha(await Bun.file(file).bytes()) });
    }
    await json(`${evidence}/source-hashes.json`, hashes);
    await page.addInitScript(() => {
      const logs: unknown[] = [];
      Object.defineProperties(globalThis, {
        __groundLogs: { value: logs },
        __groundMounted: { value: new Promise<void>(resolve => document.addEventListener("play-state", () => resolve(), { once: true, capture: true })) },
      });
      document.addEventListener("play-state", event => { if (event instanceof CustomEvent) logs.push(event.detail); }, true);
    });
    await page.goto(`${origin}/?qa=play`, { waitUntil: "load" }); await bounded(page.evaluate("globalThis.__groundMounted"), "actual play mount");
    const observe = async (match: Match, action: string, input?: () => Promise<unknown>) => {
      actions.push({ action, match }); await arm(page, match); if (input) await input();
      const observed = await signal(page); actions.push({ completed: action, observed }); return observed;
    };
    const release = async () => { for (const key of ["ArrowLeft", "ArrowRight", "ArrowDown", "Space", "x"]) await page.keyboard.up(key); };
    const pause = async () => {
      const paused = await observe({ mode: "PAUSED" }, "Escape pause", () => page.keyboard.press("Escape"));
      // The app clears its buffer on pause. Release the driver's physical keys too,
      // otherwise the next down is a repeat and correctly cannot synthesize input.
      await release(); return paused;
    };
    const resume = () => observe({ mode: "PLAYING" }, "explicit resume", () => page.getByTestId("resume").click());
    const capture = async (name: string, expectedKeys: readonly string[] = []) => {
      const observed = await state(page); assert.equal(observed.mode, "PAUSED");
      const view = observed.view; assert(view);
      const visible = view.ground.filter(actor => actor.x + 8 > view.camera.x && actor.x - 8 < view.camera.x + 256
        && actor.y > view.camera.y && actor.y - 16 < view.camera.y + 240);
      for (const prefix of expectedKeys) assert(visible.some(actor => actor.key.startsWith(prefix)), `Visible ${prefix} required for ${name}`);
      const pixels = await page.getByTestId("game-canvas").evaluate(element => {
        if (!(element instanceof HTMLCanvasElement)) throw new Error("Actual canvas missing");
        const r = element.getBoundingClientRect();
        return { width: element.width, height: element.height, cssWidth: r.width, cssHeight: r.height,
          pixelated: getComputedStyle(element).imageRendering, fullyVisible: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight };
      });
      assert.deepEqual(pixels, { width: 256, height: 240, cssWidth: 512, cssHeight: 480, pixelated: "pixelated", fullyVisible: true });
      const file = `${evidence}/${name}.png`, png = await page.screenshot({ path: file });
      assert.deepEqual((await state(page)).runtime, observed.runtime, "Paused capture must not advance simulation");
      captures.push({ file, sha256: sha(png), pixels, visible, observed, visualApproval: "requires image-capable independent inspection" });
    };
    const load = async (which: GroundPlayCase, first: Match = { tick: 1 }) => {
      await release();
      if ((await state(page)).mode !== "READY") await observe({ mode: "READY" }, "return original file preview", () => page.getByTestId("return-editor").click());
      const course = createGroundPlayFixture(which), bytes = new TextEncoder().encode(fixtureValue(serializeCourse(course))), file = `${evidence}/${which}.smb1.json`;
      await Bun.write(file, bytes); await armDOM(page, "fixture-read-settled"); await page.getByTestId("import-course").setInputFiles(resolve(file)); await domSignal(page);
      assert.deepEqual(await page.evaluate(() => window.__qa?.course()), course);
      actions.push({ action: "actual file input", which, file: resolve(file), sha256: sha(bytes) });
      await arm(page, first, "__groundFirst");
      const initial = await observe({ mode: "PLAYING", initial: true }, "actual goal-free start", () => page.getByTestId("play-start").click());
      assert.equal(initial.runtime?.player.form, "small");
      const firstState = await signal(page, "__groundFirst"); actions.push({ first, firstState });
      return { course, initial, firstState };
    };
    const retreat = async () => {
      await observe({ xMax: 94 }, "retreat left from stomp-created shell", () => page.keyboard.down("ArrowLeft"));
      await observe({ grounded: true, stopped: true }, "release left and land beside shell", () => page.keyboard.up("ArrowLeft"));
    };
    if (!edge) {
      const { course, initial, firstState } = await load("combat", { event: "ground-stomp" });
      assert(firstState.events.some(event => event.type === "ground-stomp" && event.result === "shelled"));
      assert.equal(firstState.runtime?.progress.score, 100);
      await pause(); await capture("koopa-stomp-idle-shell", ["enemy.koopa.green.shell", "enemy.goomba.walk", "enemy.buzzy.walk"]); await resume();
      await retreat();
      await arm(page, { victims: 2 }, "__groundVictims");
      const kick = await observe({ event: "shell-kicked" }, "walk right to kick shell", () => page.keyboard.down("ArrowRight"));
      await page.keyboard.up("ArrowRight"); await pause(); await capture("moving-green-shell", ["enemy.koopa.green.shell"]); await resume();
      const killed = await signal(page, "__groundVictims");
      assert.equal(killed.runtime?.combat.defeated, false);
      const shell = killed.runtime?.ground.actors.find(actor => actor.id === GROUND_IDS.koopa);
      assert(shell?.kind === "shell"); assert.equal(shell.shell.chain, 2);
      assert.equal(killed.runtime?.progress.score, (kick.runtime?.progress.score ?? 0) + 300);
      await pause(); await capture("shell-goomba-buzzy-chain");
      actions.push({ outcome: "stomp-kick-two-victims", kick, killed });
      assert.deepEqual(await page.evaluate(() => window.__qa?.course()), course);
      const restarted = await observe({ mode: "PLAYING", initial: true }, "restart from authored snapshot", () => page.getByTestId("restart-course").click());
      assert.deepEqual(restarted.runtime, initial.runtime);
      await pause();
      const restartedAgain = await observe({ mode: "PLAYING", initial: true }, "second identical restart", () => page.getByTestId("restart-course").click());
      assert.deepEqual(restartedAgain.runtime, initial.runtime);

      await load("ledge", { tick: 48 }); await pause();
      const actors = (await state(page)).runtime?.ground.actors;
      const green = actors?.find(actor => actor.id === GROUND_IDS.green), red = actors?.find(actor => actor.id === GROUND_IDS.red);
      assert(green && red); assert(green.y > 208); assert.equal(red.y, 208); assert.equal(red.facing, 1);
      await capture("green-falls-red-turns", ["enemy.koopa.green.walk", "enemy.koopa.red.walk"]);
      await load("wings", { tick: 8 }); await pause();
      await capture("green-hop-red-vertical-wings", ["enemy.koopa.green.wings", "enemy.koopa.red.wings"]);
      for (const which of ["hop-stomp", "vertical-stomp", "red-shell", "buzzy-shell", "squashed"] as const) {
        const loaded = await load(which, { event: "ground-stomp" }); await pause();
        const expected = which === "hop-stomp" ? "enemy.koopa.green.walk" : which === "vertical-stomp" ? "enemy.koopa.red.walk"
          : which === "red-shell" ? "enemy.koopa.red.shell" : which === "buzzy-shell" ? "enemy.buzzy.shell" : "enemy.goomba.squashed";
        await capture(which, [expected]); assert.deepEqual(await page.evaluate(() => window.__qa?.course()), loaded.course);
      }
      await load("wake", { event: "ground-stomp" }); await retreat();
      await observe({ actorId: GROUND_IDS.koopa, age: 480 }, "native active idle-shell warning boundary");
      await pause(); await capture("idle-shell-warning", ["enemy.koopa.green.shell"]);
      assert((await state(page)).view?.ground.some(actor => actor.wiggling));
      await arm(page, { event: "shell-woke" }, "__groundWake"); await resume();
      const wake = await signal(page, "__groundWake"); assert.equal(wake.runtime?.ground.actors[0]?.kind, "koopa");
      await pause(); await capture("shell-wakes-as-koopa", ["enemy.koopa.green.walk"]);
    } else {
      await load("return-shell", { event: "ground-stomp" }); await retreat();
      const kick = await observe({ event: "shell-kicked" }, "walk into idle shell and kick toward wall", () => page.keyboard.down("ArrowRight"));
      const damage = await observe({ event: "playerDefeated" }, "walk into returning moving shell after grace");
      assert(kick.runtime && damage.runtime); assert(damage.runtime.tick - kick.runtime.tick >= 8);
      assert.equal(damage.runtime.combat.invulnerabilityTicks, 0); assert.equal(damage.runtime.combat.starTicks, 0);
      await release(); await pause(); await capture("moving-shell-damage", ["enemy.koopa.green.shell"]);
      assert.equal((await state(page)).view?.player.key, "mario.small.death");
      actions.push({ outcome: "moving-shell-lethal-after-grace", kick, damage });
      const loaded = await load("fire-buzzy");
      const jumpHit = async () => {
        await observe({ grounded: true, stopped: true }, "grounded before real block jump");
        await observe({ event: "blockUsed" }, "Space hits adaptive powerup question", () => page.keyboard.down("Space"));
        await observe({ grounded: true }, "release jump and land", () => page.keyboard.up("Space"));
      };
      await jumpHit();
      await observe({ form: "super" }, "collect real mushroom walking right", () => page.keyboard.down("ArrowRight"));
      await observe({ xMin: 138, stopped: true }, "reach low right wall"); await page.keyboard.up("ArrowRight");
      await pause(); await capture("acquired-super"); await resume();
      await jumpHit();
      await observe({ xMax: 110 }, "walk left beside flower question", () => page.keyboard.down("ArrowLeft"));
      await observe({ stopped: true, grounded: true }, "release left before flower jump", () => page.keyboard.up("ArrowLeft"));
      await observe({ event: "blockBreak" }, "super breaks overhead brick", () => page.keyboard.down("Space"));
      await observe({ grounded: true }, "release brick jump and land", () => page.keyboard.up("Space"));
      await observe({ event: "jump" }, "jump toward actual emerged flower", () => page.keyboard.down("Space"));
      const fire = await observe({ form: "fire" }, "collect actual flower moving right", () => page.keyboard.down("ArrowRight"));
      await page.keyboard.up("Space"); await pause(); await capture("acquired-fire"); await resume();
      await observe({ xMin: 240, grounded: true }, "cross low wall into Buzzy arena", () => page.keyboard.down("ArrowRight"));
      await observe({ stopped: true, grounded: true }, "release right before firing", () => page.keyboard.up("ArrowRight"));
      await page.keyboard.down("ArrowDown");
      await arm(page, { event: "ground-fireball-contact", actorId: GROUND_IDS.buzzy }, "__groundImmune");
      await observe({ event: "fire" }, "real crouched X fire toward Buzzy", () => page.keyboard.down("x"));
      const immune = await signal(page, "__groundImmune");
      const contact = immune.events.find(event => event.type === "ground-fireball-contact"); assert(contact?.type === "ground-fireball-contact"); assert.equal(contact.immune, true);
      assert(immune.events.some(event => event.type === "itemDespawn" && event.id === contact.fireballId && event.reason === "combat"));
      assert.equal(immune.runtime?.ground.actors.find(actor => actor.id === GROUND_IDS.buzzy)?.kind, "buzzy");
      assert.equal(immune.runtime?.progress.score, fire.runtime?.progress.score);
      await release(); await pause(); await capture("acquired-fire-buzzy-survives", ["enemy.buzzy.walk"]);
      actions.push({ outcome: "acquired-fire-immune-contact-consumed-once", fire, immune });
      assert.deepEqual(await page.evaluate(() => window.__qa?.course()), loaded.course);
    }
    await observe({ mode: "READY" }, "return original file preview", () => page.getByTestId("return-editor").click());
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
        await json(`${evidence}/tick-input-events.json`, await page.evaluate("globalThis.__groundLogs ?? []"));
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
export const enemiesGround = (evidence: string, origin: string) => scenario(evidence, origin, false);
export const enemiesGroundEdge = (evidence: string, origin: string) => scenario(evidence, origin, true);
