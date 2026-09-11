import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, type Page } from "playwright-core";
import type { EditorViewState } from "../../src/ui/editor";
import type { CourseV1 } from "../../src/level/types";
import type { GameEvent } from "../../src/game/state";
import type { PlayObservation } from "../../src/ui/play-gallery";
import { serializeCourse } from "../../src/level/serialize";
import { createAreasPlayFixture } from "../../tests/fixtures/areas";
import { fixtureValue } from "../../tests/fixtures/factory";
import { createNormalEditor } from "./editor";
import { bounded, closeOwnedBrowser, json, nativeChrome, viewport } from "./support";

const sha = (bytes: Uint8Array) => Bun.CryptoHasher.hash("sha256", bytes, "hex");
interface EditorSnap { readonly state: EditorViewState; readonly course: CourseV1; readonly proposals: readonly unknown[] }

async function editorSnapshot(page: Page): Promise<EditorSnap> {
  return page.evaluate(`({state:globalThis.__qa.getState(),course:globalThis.__qa.getCourseSnapshot(),proposals:globalThis.__qa.getProposals()})`);
}
async function armEditor(page: Page, reason: string) {
  await page.evaluate(reason => {
    Object.defineProperty(globalThis, "__editorSignal", { configurable: true, value: new Promise((resolve, reject) => {
      const listener = (value: Event) => {
        if (!(value instanceof CustomEvent) || Reflect.get(value.detail, "reason") !== reason) return;
        clearTimeout(timer); document.removeEventListener("editor-view-state", listener, true); resolve(value.detail);
      };
      const timer = setTimeout(() => { document.removeEventListener("editor-view-state", listener, true); reject(new Error(`Missing editor-view-state ${reason}`)); }, 10_000);
      document.addEventListener("editor-view-state", listener, true);
    }) });
  }, reason);
}
const editorSignal = (page: Page) => bounded(page.evaluate("globalThis.__editorSignal"), "exact editor event");
async function editorAction(page: Page, reason: string, run: () => Promise<unknown>) {
  await armEditor(page, reason); await run(); await editorSignal(page);
}
async function capturePage(page: Page, path: string) {
  const png = await page.screenshot({ path, fullPage: false, animations: "disabled" });
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  return { file: resolve(path), sha256: sha(png), bytes: png.byteLength };
}

interface PlayMatch {
  mode?: PlayObservation["mode"]; event?: GameEvent["type"];
  areaId?: string; areaName?: string; initial?: boolean;
  xMin?: number; xMax?: number; grounded?: boolean; y?: number;
}
async function armPlay(page: Page, match: PlayMatch, slot = "__areasSignal") {
  await page.evaluate(({ match, slot }) => {
    const qa = window.__qa; if (!qa) throw new Error("Actual play observer missing");
    Object.defineProperty(globalThis, slot, { configurable: true, value: qa.nextState(state => {
      const runtime = state.runtime, player = runtime?.player, view = state.view;
      return (match.mode === undefined || state.mode === match.mode)
        && (match.event === undefined || state.events.some(event => event.type === match.event))
        && (match.areaId === undefined || runtime?.areaId === match.areaId)
        && (match.areaName === undefined || view?.areaName === match.areaName)
        && (!match.initial || runtime?.tick === 0)
        && (match.xMin === undefined || (player?.x ?? -Infinity) >= match.xMin)
        && (match.xMax === undefined || (player?.x ?? Infinity) <= match.xMax)
        && (match.grounded === undefined || player?.grounded === match.grounded)
        && (match.y === undefined || player?.y === match.y);
    }) });
  }, { match, slot });
}
const playSignal = (page: Page, slot = "__areasSignal"): Promise<PlayObservation> =>
  bounded(page.evaluate(`globalThis.${slot}`), "areas native state subscription");
const playState = (page: Page): Promise<PlayObservation> => page.evaluate(() => {
  if (!window.__qa) throw new Error("Actual play observer missing"); return window.__qa.snapshot();
});
async function armDOM(page: Page, event: string) {
  await page.evaluate(event => { Object.defineProperty(globalThis, "__areasDOM", { configurable: true, value: new Promise(resolve => {
    document.addEventListener(event, value => resolve(value instanceof CustomEvent ? value.detail : null), { once: true, capture: true });
  }) }); }, event);
}
const domSignal = (page: Page) => bounded(page.evaluate("globalThis.__areasDOM"), "areas DOM subscription");

async function runEditor(evidence: string, origin: string, edge: boolean): Promise<CourseV1> {
  const browser = await chromium.launch({ channel: "chrome", headless: true, timeout: 10_000 });
  const errors: string[] = []; const actions: unknown[] = []; const captures: unknown[] = [];
  let passed = false, browserClosed = false, course: CourseV1 | undefined;
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
    try {
      const page = await context.newPage(); page.setDefaultTimeout(10_000);
      page.on("pageerror", error => errors.push(error.message));
      page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
      page.on("requestfailed", request => errors.push(`${request.url()}: ${request.failure()?.errorText}`));
      actions.push(await createNormalEditor(page, origin));
      const before = await editorSnapshot(page);
      assert.equal(before.course.areas.length, 1);
      await editorAction(page, "command", () => page.getByTestId("area-create").click());
      const created = await editorSnapshot(page);
      assert.equal(created.course.areas.length, 2);
      assert.equal(created.state.lastOutcome, "committed");
      const extra = created.course.areas.find(area => area.id !== created.course.mainAreaId);
      assert(extra);
      await editorAction(page, "command", () => page.getByTestId("area-theme").selectOption("underground"));
      const themed = await editorSnapshot(page);
      assert.equal(themed.course.areas.find(area => area.id === extra.id)?.theme, "underground");
      await editorAction(page, "command", () => page.getByTestId("place-pipe").click());
      await editorAction(page, "home", () => page.getByTestId("area-select").selectOption(themed.course.mainAreaId));
      await editorAction(page, "command", () => page.getByTestId("place-pipe").click());
      const withPipes = await editorSnapshot(page);
      const allPipes = withPipes.course.areas.flatMap(area => area.objects.filter(object => object.kind === "pipe").map(pipe => ({ areaId: area.id, pipeId: pipe.id })));
      assert.equal(allPipes.length, 2);
      const first = allPipes[0], second = allPipes[1];
      assert(first && second);
      await page.getByTestId("pipe-link-a").selectOption(`${first.areaId}:${first.pipeId}`);
      await page.getByTestId("pipe-link-b").selectOption(`${second.areaId}:${second.pipeId}`);
      await editorAction(page, "command", () => page.getByTestId("pipe-link-apply").click());
      const linked = await editorSnapshot(page);
      const linkedPipes = linked.course.areas.flatMap(area => area.objects.filter(object => object.kind === "pipe"));
      assert(linkedPipes.every(pipe => pipe.kind === "pipe" && pipe.props.destination));
      captures.push({ step: "area-management", ...(await capturePage(page, `${evidence}/area-management.png`)) });
      await editorAction(page, "command", () => page.getByTestId("place-warp").click());
      const mainPipe = linked.course.areas.find(area => area.id === linked.course.mainAreaId)?.objects.find(object => object.kind === "pipe");
      assert(mainPipe);
      await page.getByTestId("warp-slot-0").selectOption(mainPipe.id);
      await editorAction(page, "command", () => page.getByTestId("warp-slots-apply").click());
      const labeled = await editorSnapshot(page);
      const labels = await page.getByTestId("warp-labels").textContent();
      assert(labels);
      assert.match(labels, /영역 2|지하/);
      assert.match(labels, /-/);
      captures.push({ step: "warp-labels", labels, ...(await capturePage(page, `${evidence}/warp-labels.png`)) });
      if (edge) {
        const destPipe = labeled.course.areas.find(area => area.id !== labeled.course.mainAreaId)?.objects.find(object => object.kind === "pipe");
        assert(destPipe);
        await page.getByTestId("pipe-link-a").selectOption(`${destPipe.kind === "pipe" ? labeled.course.areas.find(area => area.objects.some(object => object.id === destPipe.id))?.id : ""}:${destPipe.id}`);
        const destArea = labeled.course.areas.find(area => area.objects.some(object => object.id === destPipe.id));
        assert(destArea);
        await page.getByTestId("pipe-link-a").selectOption(`${destArea.id}:${destPipe.id}`);
        await editorAction(page, "command", () => page.getByTestId("pipe-delete").click());
        const deleted = await editorSnapshot(page);
        const survivor = deleted.course.areas.flatMap(area => area.objects).find(object => object.kind === "pipe");
        assert(survivor?.kind === "pipe");
        assert.equal(survivor.props.destination, undefined);
        assert.equal(deleted.state.undoCount, labeled.state.undoCount + 1);
        await editorAction(page, "undo", () => page.getByTestId("undo").click());
        const restored = await editorSnapshot(page);
        assert.deepEqual(
          restored.course.areas.map(area => area.objects.filter(object => object.kind === "pipe").map(object => object.kind === "pipe" ? object.props.destination : null)),
          labeled.course.areas.map(area => area.objects.filter(object => object.kind === "pipe").map(object => object.kind === "pipe" ? object.props.destination : null)),
        );
        captures.push({ step: "delete-undo", ...(await capturePage(page, `${evidence}/delete-undo.png`)) });
        course = restored.course;
      } else {
        course = labeled.course;
      }
      const serialized = serializeCourse(course); assert(serialized.ok);
      await Bun.write(`${evidence}/authored.smb1.json`, serialized.value);
    } finally { await context.close(); }
    assert.deepEqual(errors, []); passed = true;
  } finally {
    await closeOwnedBrowser(browser); browserClosed = true;
    await json(`${evidence}/editor-actions.json`, { passed, origin, errors, actions, captures, browser: browser.version() });
    await json(`${evidence}/editor-cleanup.json`, { browserClosed, browserDisconnected: !browser.isConnected(), contextsClosed: true });
  }
  assert(course); return course;
}

async function runPlay(evidence: string, origin: string, edge: boolean, authored: CourseV1) {
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
    await page.addInitScript(() => {
      const logs: unknown[] = [];
      Object.defineProperties(globalThis, {
        __areasLogs: { value: logs },
        __areasMounted: { value: new Promise<void>(resolve => document.addEventListener("play-state", () => resolve(), { once: true, capture: true })) },
      });
      document.addEventListener("play-state", event => { if (event instanceof CustomEvent) logs.push(event.detail); }, true);
    });
    await page.goto(`${origin}/?qa=play`, { waitUntil: "load" }); await bounded(page.evaluate("globalThis.__areasMounted"), "actual play mount");
    const observe = async (match: PlayMatch, action: string, input?: () => Promise<unknown>) => {
      actions.push({ action, match }); await armPlay(page, match); if (input) await input();
      const observed = await playSignal(page); actions.push({ completed: action, observed }); return observed;
    };
    const release = async () => { for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Space"]) await page.keyboard.up(key); };
    const pause = async () => {
      const paused = await observe({ mode: "PAUSED" }, "Escape pause", () => page.keyboard.press("Escape"));
      await release(); return paused;
    };
    const loadBytes = async (course: CourseV1, name: string) => {
      const bytes = new TextEncoder().encode(fixtureValue(serializeCourse(course))), file = `${evidence}/${name}.smb1.json`;
      await Bun.write(file, bytes); await armDOM(page, "fixture-read-settled"); await page.getByTestId("import-course").setInputFiles(resolve(file));
      await domSignal(page);
      assert.equal(fixtureValue(serializeCourse(await page.evaluate(() => window.__qa?.course()))), fixtureValue(serializeCourse(course)));
      actions.push({ action: "actual file input", name, file: resolve(file), sha256: sha(bytes) });
      const initial = await observe({ mode: "PLAYING", initial: true }, "actual goal-free start", () => page.getByTestId("play-start").click());
      assert.equal(initial.runtime?.player.form, "small");
      return { course, initial };
    };
    if (!edge) {
      const loaded = await loadBytes(authored, "user-linked");
      const dest = loaded.course.areas.find(area => area.id !== loaded.course.mainAreaId);
      assert(dest);
      const entered = await observe({ event: "pipe-enter" }, "walk with Down into linked pipe", async () => {
        await page.keyboard.down("ArrowRight");
        await page.keyboard.down("ArrowDown");
      });
      assert(entered.events.some(event => event.type === "pipe-enter"));
      await pause();
      captures.push({ step: "pipe-enter", ...(await capturePage(page, `${evidence}/pipe-enter.png`)), tick: entered.runtime?.tick, areaId: entered.runtime?.areaId });
      await observe({ mode: "PLAYING" }, "explicit resume", () => page.getByTestId("resume").click());
      const arrived = await observe({ event: "pipe-exit", areaId: dest.id }, "arrive in destination area");
      assert.equal(arrived.runtime?.areaId, dest.id);
      assert(arrived.events.some(event => event.type === "pipe-exit"));
      await page.keyboard.up("ArrowDown");
      await pause();
      captures.push({ step: "pipe-exit", ...(await capturePage(page, `${evidence}/pipe-arrive.png`)), tick: arrived.runtime?.tick, areaId: arrived.runtime?.areaId, areaName: arrived.view?.areaName });
      assert.equal(arrived.view?.areaName, dest.name);
      assert.equal(fixtureValue(serializeCourse(await page.evaluate(() => window.__qa?.course()))), fixtureValue(serializeCourse(loaded.course)));
    } else {
      const blocked = createAreasPlayFixture("blocked");
      const loaded = await loadBytes(blocked, "blocked-exit");
      const before = loaded.initial.runtime?.player;
      assert(before);
      const rejected = await observe({ event: "pipe-reject" }, "Down rejected by blocked exit", () => page.keyboard.down("ArrowDown"));
      assert(rejected.events.some(event => event.type === "pipe-reject" && "reason" in event && event.reason === "exit"));
      assert.equal(rejected.runtime?.areaId, loaded.course.start.areaId);
      assert.equal(rejected.runtime?.player.x, before.x);
      assert.equal(rejected.runtime?.player.y, before.y);
      await page.keyboard.up("ArrowDown");
      await pause();
      captures.push({ step: "pipe-reject", ...(await capturePage(page, `${evidence}/pipe-reject.png`)), tick: rejected.runtime?.tick, x: rejected.runtime?.player.x, y: rejected.runtime?.player.y });
      assert.equal(fixtureValue(serializeCourse(await page.evaluate(() => window.__qa?.course()))), fixtureValue(serializeCourse(loaded.course)));
    }
    if ((await playState(page)).mode !== "READY") await observe({ mode: "READY" }, "return original file preview", () => page.getByTestId("return-editor").click());
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
        await json(`${evidence}/tick-input-events.json`, await page.evaluate("globalThis.__areasLogs ?? []"));
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

async function scenario(evidence: string, origin: string, edge: boolean) {
  await mkdir(evidence, { recursive: true });
  const authored = await runEditor(evidence, origin, edge);
  await runPlay(evidence, origin, edge, authored);
}

export const areas = (evidence: string, origin: string) => scenario(evidence, origin, false);
export const areasEdge = (evidence: string, origin: string) => scenario(evidence, origin, true);
