import assert from "node:assert/strict";
import { resolve } from "node:path";
import type { Page } from "playwright-core";
import type { GameEvent } from "../../src/game/state";
import type { PlayObservation } from "../../src/ui/play-gallery";
import { serializeCourse } from "../../src/level/serialize";
import { createHazardPlayFixture, HAZARD_IDS } from "../../tests/fixtures/hazards";
import type { HazardPlayCase } from "../../tests/fixtures/hazards";
import { fixtureValue } from "../../tests/fixtures/factory";
import { bounded, json, nativeChrome, viewport } from "./support";

interface Match {
  mode?: PlayObservation["mode"]; event?: GameEvent["type"]; actorId?: string;
  initial?: boolean; tick?: number; xMin?: number; xMax?: number;
  grounded?: boolean; stopped?: boolean; defeated?: boolean;
  overload?: boolean; piranhaHidden?: boolean; billCount?: number; hammerCount?: number;
  form?: "small" | "super" | "fire"; star?: boolean; fireballCount?: number; hammerSeparated?: boolean;
  itemReady?: "mushroom" | "star";
}
async function arm(page: Page, match: Match, slot = "__hazardSignal") {
  await page.evaluate(({ match, slot }) => {
    const qa = window.__qa; if (!qa) throw new Error("Actual play observer missing");
    Object.defineProperty(globalThis, slot, { configurable: true, value: qa.nextState(state => {
      const runtime = state.runtime, player = runtime?.player;
      const piranha = runtime?.special.actors.find(actor => actor.id === match.actorId);
      const bills = runtime?.special.actors.filter(actor => actor.kind === "bulletBill") ?? [];
      const hammers = runtime?.special.actors.filter(actor => actor.kind === "hammer") ?? [];
      const thrower = runtime?.special.actors.find(actor => actor.id === match.actorId);
      const fireballs = runtime?.items.actors.filter(actor => actor.kind === "fireball") ?? [];
      return (match.mode === undefined || state.mode === match.mode)
        && (match.event === undefined || state.events.some(event => event.type === match.event && (match.actorId === undefined || ("actorId" in event && event.actorId === match.actorId))))
        && (!match.initial || runtime?.tick === 0)
        && (match.tick === undefined || (runtime?.tick ?? -1) >= match.tick)
        && (match.xMin === undefined || (player?.x ?? -Infinity) >= match.xMin)
        && (match.xMax === undefined || (player?.x ?? Infinity) <= match.xMax)
        && (match.grounded === undefined || player?.grounded === match.grounded)
        && (!match.stopped || player?.vx === 0)
        && (!match.defeated || runtime?.combat.defeated === true)
        && (!match.overload || runtime?.special.overloadedEnemies === true || runtime?.special.overloadedProjectiles === true)
        && (!match.piranhaHidden || (piranha?.kind === "piranha" && piranha.y > piranha.originY))
        && (match.billCount === undefined || bills.length === match.billCount)
        && (match.hammerCount === undefined || hammers.length === match.hammerCount)
        && (match.form === undefined || player?.form === match.form)
        && (!match.star || (runtime?.combat.starTicks ?? 0) > 0)
        && (match.fireballCount === undefined || fireballs.length === match.fireballCount)
        && (!match.itemReady || (runtime?.items.actors.some(actor => actor.kind === match.itemReady && actor.emerging === 0
          && (match.itemReady === "mushroom" ? actor.y >= 208 : actor.y >= 190)) ?? false))
        && (!match.hammerSeparated || hammers.some(hammer => thrower !== undefined
          && (hammer.x - thrower.x) ** 2 + (hammer.y - thrower.y) ** 2 >= 24 * 24));
    }) });
  }, { match, slot });
}
const signal = (page: Page, slot = "__hazardSignal"): Promise<PlayObservation> => bounded(page.evaluate(`globalThis.${slot}`), "hazard native state subscription");
const state = (page: Page): Promise<PlayObservation> => page.evaluate(() => {
  if (!window.__qa) throw new Error("Actual play observer missing"); return window.__qa.snapshot();
});
async function armDOM(page: Page, event: string) {
  await page.evaluate(event => { Object.defineProperty(globalThis, "__hazardDOM", { configurable: true, value: new Promise(resolve => {
    document.addEventListener(event, value => resolve(value instanceof CustomEvent ? value.detail : null), { once: true, capture: true });
  }) }); }, event);
}
const domSignal = (page: Page) => bounded(page.evaluate("globalThis.__hazardDOM"), "hazard DOM subscription");
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
    for (const pattern of ["src/game/*.ts", "src/ui/play-*.ts", "scripts/qa/hazards.ts", "scripts/qa/support.ts", "tests/hazards.test.ts", "tests/fixtures/hazards.ts", "dist/app.js", "package.json", "bun.lock"]) {
      for await (const file of new Bun.Glob(pattern).scan(".")) hashes.push({ file, sha256: sha(await Bun.file(file).bytes()) });
    }
    await json(`${evidence}/source-hashes.json`, hashes);
    await page.addInitScript(() => {
      const logs: unknown[] = [];
      Object.defineProperties(globalThis, {
        __hazardLogs: { value: logs },
        __hazardMounted: { value: new Promise<void>(resolve => document.addEventListener("play-state", () => resolve(), { once: true, capture: true })) },
      });
      document.addEventListener("play-state", event => { if (event instanceof CustomEvent) logs.push(event.detail); }, true);
    });
    await page.goto(`${origin}/?qa=play`, { waitUntil: "load" }); await bounded(page.evaluate("globalThis.__hazardMounted"), "actual play mount");
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
    const load = async (which: HazardPlayCase, first?: Match) => {
      await release();
      if ((await state(page)).mode !== "READY") await observe({ mode: "READY" }, "return original file preview", () => page.getByTestId("return-editor").click());
      const course = createHazardPlayFixture(which), bytes = new TextEncoder().encode(fixtureValue(serializeCourse(course))), file = `${evidence}/${which}.smb1.json`;
      await Bun.write(file, bytes); await armDOM(page, "fixture-read-settled"); await page.getByTestId("import-course").setInputFiles(resolve(file));
      await domSignal(page);
      assert.deepEqual(await page.evaluate(() => window.__qa?.course()), course);
      actions.push({ action: "actual file input", which, file: resolve(file), sha256: sha(bytes) });
      if (first) await arm(page, first, "__hazardFirst");
      const initial = await observe({ mode: "PLAYING", initial: true }, "actual goal-free start", () => page.getByTestId("play-start").click());
      assert.equal(initial.runtime?.player.form, "small");
      const firstState = first ? await signal(page, "__hazardFirst") : initial;
      if (first) actions.push({ first, firstState });
      return { course, initial, firstState };
    };
    const jumpHit = async (event: GameEvent["type"] = "itemSpawn") => {
      await observe({ grounded: true, stopped: true }, "grounded/stationary before jump");
      const hit = await observe({ event }, `Space jump -> ${event}`, () => page.keyboard.down("Space"));
      await observe({ grounded: true }, "release jump -> actual landing", () => page.keyboard.up("Space"));
      return hit;
    };
    if (!edge) {
      const loaded = await load("all", { event: "piranha-emerge", actorId: HAZARD_IDS.piranha });
      assert(loaded.firstState.events.some(event => event.type === "piranha-emerge"));
      const wave = await observe({ event: "cannon-fire", actorId: HAZARD_IDS.cannon }, "seeded cannon interval");
      assert(wave.events.some(event => event.type === "cannon-fire"));
      assert((wave.runtime?.special.actors.some(actor => actor.kind === "bulletBill") ?? false));
      const drop = wave.events.some(event => event.type === "lakitu-drop")
        ? wave
        : await observe({ event: "lakitu-drop", actorId: HAZARD_IDS.lakitu }, "seeded lakitu interval");
      assert(drop.events.some(event => event.type === "lakitu-drop"));
      const lava = wave.events.some(event => event.type === "podoboo-launch")
        ? wave
        : await observe({ event: "podoboo-launch", actorId: HAZARD_IDS.podoboo }, "podoboo launch");
      assert(lava.events.some(event => event.type === "podoboo-launch"));
      await observe({ xMin: 140 }, "run right under the egg roof", () => page.keyboard.down("ArrowRight"));
      await page.keyboard.up("ArrowRight"); await pause(); await capture("piranha-bill-lakitu"); await resume();
      await observe({ xMin: 300, xMax: 360 }, "walk right into hammer-bro view without contact", () => page.keyboard.down("ArrowRight"));
      await page.keyboard.up("ArrowRight");
      const hammer = await observe({ event: "hammer-throw", actorId: HAZARD_IDS.hammerBro }, "hammer bro throw after activation");
      assert(hammer.events.some(event => event.type === "hammer-throw"));
      const airborne = await observe({ actorId: HAZARD_IDS.hammerBro, hammerSeparated: true, hammerCount: 1 }, "hammer actor separated in flight");
      const thrower = airborne.runtime?.special.actors.find(actor => actor.id === HAZARD_IDS.hammerBro);
      const flying = airborne.runtime?.special.actors.filter(actor => actor.kind === "hammer") ?? [];
      assert(thrower && flying.some(actor => (actor.x - thrower.x) ** 2 + (actor.y - thrower.y) ** 2 >= 24 * 24));
      await pause(); await capture("hammer-throw");
      const fire = (await state(page)).view?.hazards.some(sprite => sprite.key === "enemy.firebar");
      assert.equal(fire, true);
      assert.deepEqual(await page.evaluate(() => window.__qa?.course()), loaded.course);
      actions.push({ outcome: "named-hazard-attacks", piranha: loaded.firstState.runtime?.tick, bill: wave.runtime?.tick, drop: drop.runtime?.tick, hammer: hammer.runtime?.tick, lava: lava.runtime?.tick, hammerAirborne: airborne.runtime?.tick });
      const bowserCourse = await load("bowser");
      const mushroom = await jumpHit();
      assert(mushroom.events.some(event => event.type === "itemSpawn" && event.kind === "mushroom"));
      await observe({ itemReady: "mushroom" }, "mushroom walked off the block onto the floor");
      const grown = await observe({ form: "super" }, "hold Right and collect actual moving mushroom", () => page.keyboard.down("ArrowRight"));
      assert.equal(grown.runtime?.player.form, "super");
      await observe({ xMin: 128 }, "walk to second powerup"); await page.keyboard.up("ArrowRight");
      const flower = await jumpHit();
      assert(flower.events.some(event => event.type === "itemSpawn" && event.kind === "flower"));
      await observe({ xMax: 110 }, "walk left beside the flower", () => page.keyboard.down("ArrowLeft"));
      await page.keyboard.up("ArrowLeft");
      await observe({ event: "jump" }, "jump beside used question", () => page.keyboard.down("Space"));
      const fireForm = await observe({ form: "fire" }, "move Right above question and collect actual flower", () => page.keyboard.down("ArrowRight"));
      assert.equal(fireForm.runtime?.player.form, "fire"); await release();
      await observe({ xMin: 192 }, "walk to star question", () => page.keyboard.down("ArrowRight"));
      await page.keyboard.up("ArrowRight");
      const starSpawn = await jumpHit();
      assert(starSpawn.events.some(event => event.type === "itemSpawn" && event.kind === "star"));
      await observe({ itemReady: "star" }, "star dropped to player height");
      const starred = await observe({ star: true }, "walk into bouncing star", () => page.keyboard.down("ArrowRight"));
      assert((starred.runtime?.combat.starTicks ?? 0) > 0);
      await observe({ xMin: 310 }, "walk until Bowser is fully on camera"); await page.keyboard.up("ArrowRight");
      await observe({ grounded: true, stopped: true }, "stop in front of Bowser");
      await pause();
      const bowserSeen = await state(page);
      const live = bowserSeen.runtime?.hazards.actors.find(actor => actor.id === HAZARD_IDS.bowser);
      assert.equal(live?.kind, "bowser");
      if (live?.kind === "bowser") assert.equal(live.hits, 0);
      assert.equal(bowserSeen.view?.hazards.some(sprite => sprite.id === HAZARD_IDS.bowser && sprite.key.startsWith("enemy.bowser")), true);
      actions.push({ outcome: "bowser-visible", tick: bowserSeen.runtime?.tick, hits: live?.kind === "bowser" ? live.hits : null, actor: live });
      await capture("bowser"); await resume();
      let hits = 0; let lastHit: PlayObservation | null = null;
      for (let attempt = 0; attempt < 8 && hits < 5; attempt++) {
        await observe({ event: "fire" }, `real X fireball ${attempt + 1}`, () => page.keyboard.press("x"));
        lastHit = await observe({ fireballCount: 0 }, `fireball ${attempt + 1} resolved`);
        const event = lastHit.events.find(item => item.type === "bowser-hit");
        if (event?.type === "bowser-hit") hits = event.hits;
      }
      assert.equal(hits, 5, "Five fireball hits must land through real X");
      assert(lastHit && lastHit.events.some(event => event.type === "bowser-defeated" && event.actorId === HAZARD_IDS.bowser));
      assert.equal(lastHit.runtime?.combat.defeated, false);
      const corpse = lastHit.runtime?.hazards.actors.find(actor => actor.id === HAZARD_IDS.bowser);
      assert.equal(corpse?.kind, "defeated");
      actions.push({ outcome: "bowser-defeated", tick: lastHit.runtime?.tick, hits, actor: corpse });
      await pause();
      const defeated = await state(page);
      assert.equal(defeated.runtime?.hazards.actors.find(actor => actor.id === HAZARD_IDS.bowser)?.kind, "defeated");
      assert.equal(defeated.runtime?.combat.defeated, false);
      await capture("bowser-defeat");
      assert.deepEqual(await page.evaluate(() => window.__qa?.course()), bowserCourse.course);
    } else {
      const pipe = await load("edge-pipe", { tick: 180 });
      assert.equal(pipe.firstState.events.some(event => event.type === "piranha-emerge"), false);
      const plant = pipe.firstState.runtime?.special.actors.find(actor => actor.id === HAZARD_IDS.piranha);
      assert(plant && plant.kind === "piranha");
      assert(plant.y > plant.originY);
      await pause(); await capture("pipe-safe-radius");
      const cannon = await load("edge-cannon", { tick: 180 });
      assert.equal(cannon.firstState.events.some(event => event.type === "cannon-fire"), false);
      assert.equal(cannon.firstState.runtime?.special.actors.some(actor => actor.kind === "bulletBill"), false);
      await pause(); await capture("cannon-safe-radius");
      await load("edge-spiny", { event: "lakitu-drop" });
      const spinyHit = await observe({ event: "special-damage" }, "egg or spiny contact damages");
      assert.equal(spinyHit.events.some(event => event.type === "special-stomp"), false);
      assert.equal(spinyHit.runtime?.combat.defeated, true);
      await release(); await pause(); await capture("spiny-nonstomp-damage");
      await load("edge-firebar", { event: "hazard-damage", actorId: HAZARD_IDS.firebar });
      const bar = await state(page);
      assert.equal(bar.events.some(event => event.type === "special-stomp"), false);
      assert.equal(bar.runtime?.combat.defeated, true);
      await pause(); await capture("firebar-nonstomp-damage");
      actions.push({ outcome: "safe-radius-and-nonstomp" });
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
        await json(`${evidence}/tick-input-events.json`, await page.evaluate("globalThis.__hazardLogs ?? []"));
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
export const hazards = (evidence: string, origin: string) => scenario(evidence, origin, false);
export const hazardsEdge = (evidence: string, origin: string) => scenario(evidence, origin, true);
