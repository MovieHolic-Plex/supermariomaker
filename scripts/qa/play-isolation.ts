import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, type Page } from "playwright-core";
import type { EditorViewState } from "../../src/ui/editor";
import type { CourseV1, TileCell } from "../../src/level/types";
import { authoredContentEqual, serializeCourse } from "../../src/level/serialize";
import { bounded, closeOwnedBrowser, installBootObserver, json } from "./support";

const sha = (bytes: Uint8Array) => Bun.CryptoHasher.hash("sha256", bytes, "hex");
interface Snapshot { readonly state: EditorViewState; readonly course: CourseV1 }
async function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(`({state:globalThis.__qa.getState(),course:globalThis.__qa.getCourseSnapshot()})`);
}
async function capture(page: Page, path: string) {
  const png = await page.screenshot({ path, fullPage: false, animations: "disabled" });
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  return { file: resolve(path), sha256: sha(png), bytes: png.byteLength };
}
function areaTiles(course: CourseV1): readonly TileCell[] {
  const area = course.areas.find(item => item.id === course.mainAreaId); assert(area);
  return area.tiles;
}
function tileAt(course: CourseV1, x: number, y: number) {
  return areaTiles(course).find(tile => tile.x === x && tile.y === y);
}
async function arm(page: Page, event: string, match: Readonly<Record<string, unknown>> = {}, slot = "__editorSignal") {
  await page.evaluate(({ event, match, slot }) => {
    Object.defineProperty(globalThis, slot, { configurable: true, value: new Promise<unknown>((resolve, reject) => {
      const listener = (value: Event) => {
        if (!(value instanceof CustomEvent) || !Object.entries(match).every(([key, expected]) => Reflect.get(value.detail, key) === expected)) return;
        clearTimeout(timer); document.removeEventListener(event, listener, true); resolve(value.detail);
      };
      const timer = setTimeout(() => { document.removeEventListener(event, listener, true); reject(new Error(`Missing ${event}: ${JSON.stringify(match)}`)); }, 10_000);
      document.addEventListener(event, listener, true);
    }) });
  }, { event, match, slot });
}
const signal = (page: Page, slot = "__editorSignal") => bounded(page.evaluate(`globalThis.${slot}`), "exact editor event");
async function action(page: Page, reason: string, run: () => Promise<unknown>): Promise<void> {
  await arm(page, "editor-view-state", { reason }); await run(); await signal(page);
}
async function cellPoint(page: Page, x: number, y: number) {
  const bounds = await page.getByTestId("editor-canvas").boundingBox(); assert(bounds);
  const state = (await snapshot(page)).state;
  return { x: bounds.x + (x * 16 + 8 - state.viewport.x) * state.viewport.zoom, y: bounds.y + (y * 16 + 8 - state.viewport.y) * state.viewport.zoom };
}
async function paintCell(page: Page, x: number, y: number) {
  const point = await cellPoint(page, x, y);
  await action(page, "pointer", () => page.mouse.move(point.x, point.y));
  await action(page, "paint-start", () => page.mouse.down());
  await action(page, "paint-commit", () => page.mouse.up());
}
async function armPlay(page: Page, want: Readonly<{ mode?: string; coin?: boolean; tick0?: boolean }>, slot = "__playSignal") {
  await page.evaluate(({ want, slot }) => {
    Object.defineProperty(globalThis, slot, { configurable: true, value: new Promise<unknown>((resolve, reject) => {
      const listener = (value: Event) => {
        if (!(value instanceof CustomEvent)) return;
        const detail = value.detail as { mode: string; events?: readonly { type: string }[]; runtime?: { progress: { coins: number }; tick: number } | null };
        if (want.mode && detail.mode !== want.mode) return;
        if (want.coin) {
          const coined = (detail.events ?? []).some(event => event.type === "coin") || (detail.runtime !== null && detail.runtime !== undefined && detail.runtime.progress.coins > 0);
          if (!coined) return;
        }
        if (want.tick0 && !(detail.mode === "PLAYING" && detail.runtime && detail.runtime.tick === 0)) return;
        clearTimeout(timer); document.removeEventListener("play-state", listener, true); resolve(detail);
      };
      const timer = setTimeout(() => { document.removeEventListener("play-state", listener, true); reject(new Error(`Missing play-state ${JSON.stringify(want)}`)); }, 10_000);
      document.addEventListener("play-state", listener, true);
    }) });
  }, { want, slot });
}
const playSignal = (page: Page, slot = "__playSignal") => bounded(page.evaluate(`globalThis.${slot}`), "exact play event");

async function openEditor(page: Page, origin: string) {
  await page.addInitScript(installBootObserver);
  await page.goto(`${origin}/?qa=editor`, { waitUntil: "load" });
  await bounded(page.evaluate(() => Reflect.get(globalThis, "__qaBootReady")), "boot");
  await page.getByTestId("new-course").click();
  await page.getByTestId("course-title").fill("플레이 격리");
  await arm(page, "normal-editor-ready", {}, "__readySignal");
  await page.getByTestId("create-course").click();
  await signal(page, "__readySignal");
  assert.equal(await page.getByTestId("editor-view").count(), 1);
}

async function withPage(evidence: string, origin: string, run: (page: Page) => Promise<unknown>) {
  await mkdir(evidence, { recursive: true });
  const browser = await chromium.launch({ channel: "chrome", headless: true, timeout: 10_000 });
  const errors: string[] = [];
  let passed = false, browserClosed = false;
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
    try {
      const page = await context.newPage(); page.setDefaultTimeout(10_000);
      page.on("pageerror", error => errors.push(error.message));
      page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
      page.on("requestfailed", request => errors.push(`${request.url()}: ${request.failure()?.errorText}`));
      await openEditor(page, origin);
      await run(page);
    } finally { await context.close(); }
    assert.deepEqual(errors, []); passed = true;
  } finally {
    await closeOwnedBrowser(browser); browserClosed = true;
    await json(`${evidence}/actions.json`, { passed, origin, errors, browser: browser.version() });
    await json(`${evidence}/cleanup.json`, { browserClosed, browserDisconnected: !browser.isConnected(), contextsClosed: true });
  }
}

function historyKey(state: EditorViewState) {
  return { undoCount: state.undoCount, redoCount: state.redoCount, dirty: state.dirty, selection: state.selection };
}

export async function playIsolation(evidence: string, origin: string) {
  const captures: unknown[] = [];
  await withPage(evidence, origin, async page => {
    await action(page, "home", () => page.getByTestId("viewport-home").click());
    await action(page, "tool", () => page.getByTestId("tool-paint").click());
    await action(page, "palette", () => page.getByTestId("palette-brick").click());
    await paintCell(page, 8, 5);
    await action(page, "category", () => page.getByTestId("category-items").click());
    await action(page, "palette", () => page.getByTestId("palette-coin").click());
    await paintCell(page, 4, 12);
    const before = await snapshot(page);
    assert.equal(tileAt(before.course, 8, 5)?.kind, "brick");
    assert.equal(tileAt(before.course, 4, 12)?.kind, "coin");
    const beforeBytes = serializeCourse(before.course); assert(beforeBytes.ok);
    await Bun.write(`${evidence}/before.smb1.json`, beforeBytes.value);
    const beforeHistory = historyKey(before.state);
    await armPlay(page, { mode: 'PLAYING' });
    await page.getByTestId("play-start").click();
    await playSignal(page);
    assert.equal(await page.getByTestId("game-canvas").count(), 1);
    captures.push({ step: "playtest-running", ...(await capture(page, `${evidence}/playtest-running.png`)) });
    await armPlay(page, { coin: true }, "__coin");
    await page.getByTestId("game-canvas").focus();
    await page.keyboard.down("ArrowRight");
    await playSignal(page, "__coin");
    await page.keyboard.up("ArrowRight");
    await arm(page, "editor-view-state", { reason: "select" }, "__returned");
    await page.getByTestId("return-editor").click();
    await signal(page, "__returned");
    assert.equal(await page.getByTestId("game-canvas").count(), 0);
    const after = await snapshot(page);
    assert.equal(authoredContentEqual(after.course, before.course), true);
    assert.deepEqual(historyKey(after.state), beforeHistory);
    const afterBytes = serializeCourse(after.course); assert(afterBytes.ok);
    await Bun.write(`${evidence}/after.smb1.json`, afterBytes.value);
    assert.equal(afterBytes.value, beforeBytes.value);
    captures.push({ step: "returned-unchanged", ...(await capture(page, `${evidence}/returned-unchanged.png`)) });
    await json(`${evidence}/result.json`, { captures, authoredEqual: true, historyEqual: true, beforeSha256: sha(new TextEncoder().encode(beforeBytes.value)) });
  });
}

export async function playIsolationEdge(evidence: string, origin: string) {
  const captures: unknown[] = [];
  await withPage(evidence, origin, async page => {
    await action(page, "home", () => page.getByTestId("viewport-home").click());
    const ground = await cellPoint(page, 2, 13);
    await action(page, "pointer", () => page.mouse.move(ground.x, ground.y));
    const hovered = (await snapshot(page)).state.hoveredCell;
    assert.deepEqual(hovered, { x: 2, y: 13 });
    await page.getByTestId("play-cursor").click();
    await page.getByTestId("error-dialog").waitFor({ state: "visible", timeout: 10_000 });
    assert.equal(await page.getByTestId("game-canvas").count(), 0);
    assert.equal(await page.getByTestId("editor-view").isVisible(), true);
    captures.push({ step: "cursor-solid-rejected", ...(await capture(page, `${evidence}/cursor-solid-rejected.png`)) });
    await page.getByTestId("cancel").click();
    const air = await cellPoint(page, 8, 12);
    await action(page, "pointer", () => page.mouse.move(air.x, air.y));
    await armPlay(page, { mode: 'PLAYING' }, "__cursorPlay");
    await page.getByTestId("play-cursor").click();
    const first = await playSignal(page, "__cursorPlay") as { runtime: { player: { x: number; y: number }; tick: number } };
    captures.push({ step: "cursor-play-valid", ...(await capture(page, `${evidence}/cursor-play-valid.png`)) });
    await armPlay(page, { tick0: true }, "__restart1");
    await page.getByTestId("restart-course").click();
    const restart1 = await playSignal(page, "__restart1") as { runtime: { player: { x: number; y: number }; progress: { lives: number; score: number; coins: number } } };
    await armPlay(page, { tick0: true }, "__restart2");
    await page.getByTestId("restart-course").click();
    const restart2 = await playSignal(page, "__restart2") as { runtime: { player: { x: number; y: number }; progress: { lives: number; score: number; coins: number } } };
    assert.deepEqual(restart1.runtime.player, restart2.runtime.player);
    assert.deepEqual(restart1.runtime.progress, restart2.runtime.progress);
    await page.getByTestId("return-editor").click();
    await page.getByTestId("editor-view").waitFor({ state: "visible", timeout: 10_000 });
    captures.push({ step: "restarts-equal", firstSpawn: first.runtime.player, restart1: restart1.runtime.player, restart2: restart2.runtime.player });
    await json(`${evidence}/result.json`, { captures, cursorRejected: true, restartsEqual: true });
  });
}
