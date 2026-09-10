import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { Page } from "playwright-core";
import type { PlayObservation } from "../../src/ui/play-gallery";
import { parseCourse, serializeCourse } from "../../src/level/serialize";
import { fixtureValue } from "../../tests/fixtures/factory";
import { createPlatformPlayFixture } from "../../tests/fixtures/platforms";
import { createGroundPlayFixture } from "../../tests/fixtures/enemies-ground";
import { createHazardPlayFixture, HAZARD_IDS } from "../../tests/fixtures/hazards";
import { assertPortFree, bounded, json, nativeChrome, origin, viewport } from "./support";

const evidenceRoot = ".omo/evidence/smb1-level-maker/task-27/capture";
const sha = (bytes: Uint8Array) => Bun.CryptoHasher.hash("sha256", bytes, "hex");
interface Match {
  mode?: PlayObservation["mode"]; initial?: boolean; defeated?: boolean; crush?: boolean;
  event?: string; tick?: number; xMin?: number; xMax?: number; grounded?: boolean; stopped?: boolean;
  star?: boolean; fireballCount?: number; form?: "small" | "super" | "fire";
  itemReady?: "mushroom" | "star";
}

async function arm(page: Page, match: Match, slot: string, timeoutMs = 10_000) {
  await page.evaluate(({ match, slot, timeoutMs }) => {
    const qa = window.__qa; if (!qa) throw new Error("Actual play observer missing");
    Object.defineProperty(globalThis, slot, { configurable: true, value: qa.nextState(state => {
      const runtime = state.runtime, player = runtime?.player;
      const fireballs = runtime?.items.actors.filter(actor => actor.kind === "fireball") ?? [];
      return (match.mode === undefined || state.mode === match.mode)
        && (!match.initial || runtime?.tick === 0)
        && (!match.defeated || runtime?.combat.defeated === true)
        && (!match.crush || state.events.some(event => event.type === "playerDefeated" && event.hit.kind === "crush"))
        && (match.event === undefined || state.events.some(event => event.type === match.event))
        && (match.tick === undefined || (runtime?.tick ?? -1) >= match.tick)
        && (match.xMin === undefined || (player?.x ?? -Infinity) >= match.xMin)
        && (match.xMax === undefined || (player?.x ?? Infinity) <= match.xMax)
        && (match.grounded === undefined || player?.grounded === match.grounded)
        && (!match.stopped || player?.vx === 0)
        && (match.form === undefined || player?.form === match.form)
        && (!match.star || (runtime?.combat.starTicks ?? 0) > 0)
        && (match.fireballCount === undefined || fireballs.length === match.fireballCount)
        && (!match.itemReady || (runtime?.items.actors.some(actor => actor.kind === match.itemReady && actor.emerging === 0
          && (match.itemReady === "mushroom" ? actor.y >= 208 : actor.y >= 190)) ?? false));
    }, timeoutMs) });
  }, { match, slot, timeoutMs });
}
async function wait(page: Page, slot: string, timeoutMs = 10_000): Promise<PlayObservation> {
  page.setDefaultTimeout(timeoutMs);
  try { return await page.evaluate(`globalThis.${slot}`) as PlayObservation; }
  finally { page.setDefaultTimeout(10_000); }
}
const snapshot = (page: Page): Promise<PlayObservation> => page.evaluate(() => {
  if (!window.__qa) throw new Error("Actual play observer missing"); return window.__qa.snapshot();
});
async function armDOM(page: Page, event: string) {
  await page.evaluate(event => { Object.defineProperty(globalThis, "__defeatDOM", { configurable: true, value: new Promise(resolve => {
    document.addEventListener(event, value => resolve(value instanceof CustomEvent ? value.detail : null), { once: true, capture: true });
  }) }); }, event);
}

function damageCourse() {
  const course = createGroundPlayFixture("squashed");
  return fixtureValue(parseCourse(fixtureValue(serializeCourse({ ...course, start: { ...course.start, x: 80, y: 208 } }))));
}

async function run() {
  await mkdir(evidenceRoot, { recursive: true });
  await assertPortFree();
  const build = Bun.spawn([process.execPath, "run", "build"], { stdout: Bun.file(`${evidenceRoot}/build.txt`), stderr: "pipe" });
  try {
    const stderr = new Response(build.stderr).text();
    assert.equal(await bounded(build.exited, "fresh build"), 0, await stderr);
  } finally {
    if (build.exitCode === null) build.kill();
    await build.exited;
  }
  const server = Bun.spawn([process.execPath, "run", "scripts/preview.ts"], {
    stdout: "pipe", stderr: Bun.file(`${evidenceRoot}/preview-stderr.txt`),
  });
  let previewExit: number | null = null;
  let portFree = false;
  const native = await nativeChrome(evidenceRoot);
  const { browser, context } = native;
  const page = context.pages()[0] ?? await context.newPage(); page.setDefaultTimeout(10_000);
  const actions: unknown[] = [], captures: unknown[] = [], errors: string[] = [];
  try {
    const ready = (async () => {
      const reader = server.stdout.getReader();
      let output = "";
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) throw new Error(`Preview exited before READY: ${output}`);
          output += new TextDecoder().decode(value);
          if (output.includes(`READY ${origin}/`)) { await Bun.write(`${evidenceRoot}/preview.txt`, output); return; }
        }
      } finally { reader.releaseLock(); }
    })();
    await bounded(ready, "preview READY stdout event");
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    await page.setViewportSize(viewport); await page.bringToFront();
    await json(`${evidenceRoot}/versions.json`, { browser: browser.version(), bun: Bun.version, viewport, url: `${origin}/?qa=play` });
    await page.addInitScript(() => {
      Object.defineProperty(globalThis, "__defeatMounted", { value: new Promise<void>(resolve => {
        document.addEventListener("play-state", () => resolve(), { once: true, capture: true });
      }) });
    });
    await page.goto(`${origin}/?qa=play`, { waitUntil: "load" });
    await bounded(page.evaluate("globalThis.__defeatMounted"), "play mount");
    const observe = async (match: Match, action: string, input?: () => Promise<unknown>, timeoutMs = 10_000) => {
      const slot = `__defeat_${action.replace(/[^a-zA-Z0-9]+/g, "_")}`;
      actions.push({ action, match }); await arm(page, match, slot, timeoutMs);
      if (input) await input();
      const observed = await wait(page, slot, timeoutMs);
      actions.push({ completed: action, tick: observed.runtime?.tick, mode: observed.mode, defeated: observed.runtime?.combat.defeated });
      return observed;
    };
    const load = async (name: string, bytes: Uint8Array) => {
      const file = `${evidenceRoot}/${name}.smb1.json`;
      await Bun.write(file, bytes);
      if ((await snapshot(page)).mode !== "READY") await observe({ mode: "READY" }, `${name} return`, () => page.getByTestId("return-editor").click());
      await armDOM(page, "fixture-read-settled");
      await page.getByTestId("import-course").setInputFiles(resolve(file));
      await bounded(page.evaluate("globalThis.__defeatDOM"), "import settled");
      await observe({ mode: "PLAYING", initial: true }, `${name} play-start`, () => page.getByTestId("play-start").click());
    };
    const canvasCapture = async (name: string, assertState: (state: PlayObservation) => void) => {
      await observe({ mode: "PAUSED" }, `${name} pause`, () => page.keyboard.press("Escape"));
      const observed = await snapshot(page);
      assertState(observed);
      const file = `${evidenceRoot}/${name}.png`;
      const png = await page.getByTestId("game-canvas").screenshot({ path: file });
      assert.equal((await snapshot(page)).view?.player.key, observed.view?.player.key);
      captures.push({ name, file: resolve(file), sha256: sha(png), bytes: png.byteLength, tick: observed.runtime?.tick,
        mode: observed.mode, defeated: observed.runtime?.combat.defeated, playerKey: observed.view?.player.key,
        hazards: observed.view?.hazards, player: observed.view?.player });
      actions.push({ capture: name, playerKey: observed.view?.player.key, defeated: observed.runtime?.combat.defeated });
    };

    await load("crush", new TextEncoder().encode(fixtureValue(serializeCourse(createPlatformPlayFixture("crush")))));
    await observe({ xMin: 110, grounded: true }, "walk under crush platform", () => page.keyboard.down("ArrowRight"));
    await page.keyboard.up("ArrowRight");
    await observe({ crush: true, defeated: true }, "jump onto rising platform", async () => {
      await page.keyboard.down("ArrowLeft"); await page.keyboard.down("Space");
    });
    for (const key of ["ArrowLeft", "ArrowRight", "Space"]) await page.keyboard.up(key);
    await canvasCapture("crush-death", state => {
      assert.equal(state.runtime?.combat.defeated, true);
      assert.equal(state.view?.player.key, "mario.small.death");
    });

    await load("damage", new TextEncoder().encode(fixtureValue(serializeCourse(damageCourse()))));
    await page.getByTestId("game-canvas").focus();
    await observe({ defeated: true }, "walk into goomba", () => page.keyboard.down("ArrowRight"));
    await page.keyboard.up("ArrowRight");
    await canvasCapture("damage-death", state => {
      assert.equal(state.runtime?.combat.defeated, true);
      assert.equal(state.view?.player.key, "mario.small.death");
    });

    await load("bowser", new TextEncoder().encode(fixtureValue(serializeCourse(createHazardPlayFixture("bowser")))));
    const jumpHit = async (label: string) => {
      const spawned = await observe({ event: "itemSpawn" }, label, () => page.keyboard.down("Space"));
      await page.keyboard.up("Space");
      return spawned;
    };
    await jumpHit("mushroom spawn");
    await observe({ itemReady: "mushroom" }, "mushroom on floor");
    await observe({ form: "super" }, "collect mushroom", () => page.keyboard.down("ArrowRight"));
    await observe({ xMin: 128 }, "walk to second powerup");
    await page.keyboard.up("ArrowRight");
    await jumpHit("flower spawn");
    await observe({ xMax: 110 }, "walk left beside flower", () => page.keyboard.down("ArrowLeft"));
    await page.keyboard.up("ArrowLeft");
    await observe({ event: "jump" }, "jump beside used question", () => page.keyboard.down("Space"));
    await observe({ form: "fire" }, "collect flower", () => page.keyboard.down("ArrowRight"));
    await page.keyboard.up("ArrowRight"); await page.keyboard.up("Space");
    await observe({ xMin: 192 }, "walk to star", () => page.keyboard.down("ArrowRight"));
    await page.keyboard.up("ArrowRight");
    await jumpHit("star spawn");
    await observe({ itemReady: "star" }, "star at player height");
    await observe({ star: true }, "collect star", () => page.keyboard.down("ArrowRight"));
    await observe({ xMin: 310 }, "walk until Bowser on camera");
    await page.keyboard.up("ArrowRight");
    await observe({ grounded: true, stopped: true }, "stop in front of Bowser");
    let hits = 0;
    for (let attempt = 0; attempt < 8 && hits < 5; attempt++) {
      await observe({ event: "fire" }, `fireball ${attempt + 1}`, () => page.keyboard.press("x"));
      const lastHit = await observe({ fireballCount: 0 }, `fireball ${attempt + 1} resolved`);
      const event = lastHit.events.find(item => item.type === "bowser-hit");
      if (event?.type === "bowser-hit") hits = event.hits;
    }
    assert.equal(hits, 5);
    const defeated = await snapshot(page);
    assert.equal(defeated.runtime?.hazards.actors.find(actor => actor.id === HAZARD_IDS.bowser)?.kind, "defeated");
    assert.equal(defeated.view?.hazards.some(sprite => sprite.key === "enemy.bowser.defeated"), true);
    await canvasCapture("bowser-defeat", state => {
      assert.equal(state.runtime?.hazards.actors.find(actor => actor.id === HAZARD_IDS.bowser)?.kind, "defeated");
      assert.equal(state.view?.hazards.some(sprite => sprite.key === "enemy.bowser.defeated"), true);
      assert.equal(state.runtime?.combat.defeated, false);
    });
    assert.deepEqual(errors, []);
    console.log(`PASS defeat-capture -> ${evidenceRoot}`);
  } catch (error) {
    await json(`${evidenceRoot}/original-failure.json`, { message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : null, lastAction: actions.at(-1) });
    throw error;
  } finally {
    try { await native.close(); }
    finally {
      if (server.exitCode === null) server.kill();
      previewExit = await bounded(server.exited, "preview teardown");
      await assertPortFree();
      portFree = true;
      await Promise.all([
        json(`${evidenceRoot}/actions.json`, actions),
        json(`${evidenceRoot}/png-manifest.json`, captures),
        json(`${evidenceRoot}/errors.json`, errors),
        json(`${evidenceRoot}/cleanup.json`, { previewPid: server.pid, previewExit, port: 4173, portFree, native: "native-cleanup.json" }),
      ]);
    }
  }
}

await run();
