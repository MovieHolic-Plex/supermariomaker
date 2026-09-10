import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, type Page } from "playwright-core";
import type { EditorViewState } from "../../src/ui/editor";
import type { CourseV1, TileCell } from "../../src/level/types";
import { authoredContentEqual, serializeCourse } from "../../src/level/serialize";
import { bounded, installBootObserver, json } from "./support";

const sha = (bytes: Uint8Array) => Bun.CryptoHasher.hash("sha256", bytes, "hex");

interface Snapshot { readonly state: EditorViewState; readonly course: CourseV1 }

async function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(`({state:globalThis.__qa.getState(),course:globalThis.__qa.getCourseSnapshot()})`);
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
async function armSave(page: Page, saveStatus: string, slot = "__saveSignal") {
  await arm(page, "editor-view-state", { reason: "save", saveStatus }, slot);
}
const saveSignal = (page: Page, slot = "__saveSignal") => signal(page, slot);

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

async function box(page: Page) {
  const bounds = await page.getByTestId("editor-canvas").boundingBox(); assert(bounds);
  return bounds;
}
async function cellPoint(page: Page, x: number, y: number) {
  const bounds = await box(page), state = (await snapshot(page)).state;
  return { x: bounds.x + (x * 16 + 8 - state.viewport.x) * state.viewport.zoom, y: bounds.y + (y * 16 + 8 - state.viewport.y) * state.viewport.zoom };
}

async function paintCell(page: Page, x: number, y: number) {
  const point = await cellPoint(page, x, y);
  await action(page, "pointer", () => page.mouse.move(point.x, point.y));
  await action(page, "paint-start", () => page.mouse.down());
}

async function idbCourse(page: Page, id: string) {
  return page.evaluate(async courseId => {
    const request = indexedDB.open("smb1-maker", 1);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onerror = () => reject(request.error ?? new Error("IDB open failed"));
      request.onsuccess = () => resolve(request.result);
    });
    try {
      const tx = db.transaction("courses", "readonly");
      const got = tx.objectStore("courses").get(courseId);
      return await new Promise<unknown>((resolve, reject) => {
        got.onerror = () => reject(got.error ?? new Error("IDB get failed"));
        got.onsuccess = () => resolve(got.result ?? null);
      });
    } finally { db.close(); }
  }, id);
}

function installAbortInstrument() {
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (value, key) {
    if (Reflect.get(globalThis, "__qaAbortNextWrite") === true) {
      Reflect.set(globalThis, "__qaAbortNextWrite", false);
      this.transaction.abort();
    }
    return key === undefined ? put.call(this, value) : put.call(this, value, key);
  };
}

async function openSavedEditor(page: Page, origin: string) {
  await page.addInitScript(installBootObserver);
  await page.goto(`${origin}/?qa=editor`, { waitUntil: "load" });
  await bounded(page.evaluate(() => Reflect.get(globalThis, "__qaBootReady")), "normal app startup");
  assert.equal(await page.getByTestId("library").isVisible(), true);
  await page.getByTestId("new-course").click();
  await page.getByTestId("course-title").fill("저장 검증");
  await arm(page, "normal-editor-ready", {}, "__readySignal");
  await armSave(page, "saved");
  await page.getByTestId("create-course").click();
  await signal(page, "__readySignal");
  assert.equal(await page.getByTestId("editor-view").count(), 1);
  await saveSignal(page);
  const opened = await snapshot(page);
  assert.equal(await page.getByTestId("save-status").getAttribute("data-status"), "saved");
  assert.match(await page.getByTestId("save-status").innerText(), /저장됨/);
  assert.equal(opened.state.saveStatus, "saved");
  return opened;
}

async function withPage(
  evidence: string,
  origin: string,
  setup: (page: Page) => Promise<void>,
  run: (page: Page) => Promise<unknown>,
) {
  await mkdir(evidence, { recursive: true });
  const browser = await chromium.launch({ channel: "chrome", headless: true, timeout: 10_000 });
  const errors: string[] = [];
  let passed = false, browserClosed = false;
  const actions: unknown[] = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
    try {
      const page = await context.newPage(); page.setDefaultTimeout(10_000);
      page.on("pageerror", error => errors.push(error.message));
      page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
      page.on("requestfailed", request => errors.push(`${request.url()}: ${request.failure()?.errorText}`));
      await setup(page);
      await run(page);
    } catch (error) {
      const page = browser.contexts()[0]?.pages()[0];
      if (page && !page.isClosed()) {
        await capture(page, `${evidence}/failure.png`).catch(() => undefined);
        await json(`${evidence}/failure-dom.json`, {
          title: await page.title().catch(() => null),
          saveStatus: await page.getByTestId("save-status").innerText().catch(() => null),
          saveAttr: await page.getByTestId("save-status").getAttribute("data-status").catch(() => null),
        }).catch(() => undefined);
      }
      await json(`${evidence}/failure.json`, { message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : null });
      throw error;
    } finally { await context.close(); }
    assert.deepEqual(errors, []); passed = true;
  } finally {
    await browser.close(); browserClosed = true;
    await json(`${evidence}/actions.json`, { passed, origin, errors, actions, browser: browser.version() });
    await json(`${evidence}/cleanup.json`, { browserClosed, browserDisconnected: !browser.isConnected(), contextsClosed: true });
  }
}

export async function storage(evidence: string, origin: string) {
  const captures: unknown[] = [];
  await withPage(evidence, origin, async () => undefined, async page => {
    const opened = await openSavedEditor(page, origin);
    await page.exposeBinding("__qaAfterDirty", async () => {
      captures.push({ step: "dirty-before-commit", ...(await capture(page, `${evidence}/dirty-before-save.png`)) });
    });
    await action(page, "tool", () => page.getByTestId("tool-paint").click());
    await action(page, "palette", () => page.getByTestId("palette-brick").click());
    await armSave(page, "dirty", "__saveDirty");
    await armSave(page, "saved", "__saveSaved");
    await paintCell(page, 10, 5);
    await action(page, "paint-commit", () => page.mouse.up());
    const dirtyEvent = await saveSignal(page, "__saveDirty") as EditorViewState & { reason: string };
    assert.equal(dirtyEvent.saveStatus, "dirty");
    assert.equal(tileAt((await snapshot(page)).course, 10, 5)?.kind, "brick");
    await saveSignal(page, "__saveSaved");
    const saved = await snapshot(page);
    assert.equal(saved.state.saveStatus, "saved");
    assert.equal(await page.getByTestId("save-status").getAttribute("data-status"), "saved");
    assert.match(await page.getByTestId("save-status").innerText(), /저장됨/);
    const stored = await idbCourse(page, saved.course.id);
    assert(stored && typeof stored === "object" && "document" in stored);
    const storedDocument = (stored as { document: CourseV1 }).document;
    assert.equal(authoredContentEqual(storedDocument, saved.course), true);
    assert.equal(captures.some(item => typeof item === "object" && item !== null && "step" in item && item.step === "dirty-before-commit"), true);
    captures.push({ step: "saved-after-commit", ...(await capture(page, `${evidence}/saved-after-commit.png`)) });
    const serialized = serializeCourse(saved.course); assert(serialized.ok);
    await Bun.write(`${evidence}/committed.smb1.json`, serialized.value);
    await page.addInitScript(() => {
      Object.defineProperty(globalThis, "__restoredEditor", { value: new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Restored editor did not mount")), 10_000);
        document.addEventListener("normal-editor-ready", () => { clearTimeout(timer); resolve(); }, { once: true });
      }) });
    });
    await page.reload({ waitUntil: "load" });
    await bounded(page.evaluate("globalThis.__restoredEditor"), "last-open restore");
    assert.equal(await page.getByTestId("library").count(), 0);
    assert.equal(await page.getByTestId("editor-view").count(), 1);
    const restored = await snapshot(page);
    assert.equal(restored.course.id, saved.course.id);
    assert.equal(authoredContentEqual(restored.course, saved.course), true);
    assert.equal(tileAt(restored.course, 10, 5)?.kind, "brick");
    assert.equal(restored.state.saveStatus, "saved");
    assert.notEqual(tileAt(opened.course, 10, 5)?.kind, "brick");
    captures.push({ step: "restored-after-reload", ...(await capture(page, `${evidence}/restored-after-reload.png`)) });
    await json(`${evidence}/result.json`, {
      captures, courseId: saved.course.id, dirtyEvent: { reason: dirtyEvent.reason, saveStatus: dirtyEvent.saveStatus },
      committedSha256: sha(new TextEncoder().encode(serialized.value)),
      restoredEqual: true,
    });
  });
}

export async function storageFailure(evidence: string, origin: string) {
  const captures: unknown[] = [];
  await withPage(evidence, origin, async page => {
    await page.addInitScript(installAbortInstrument);
  }, async page => {
    await openSavedEditor(page, origin);
    await action(page, "tool", () => page.getByTestId("tool-paint").click());
    await action(page, "category", () => page.getByTestId("category-items").click());
    await action(page, "palette", () => page.getByTestId("palette-coin").click());
    await armSave(page, "failed");
    await page.evaluate(() => { Reflect.set(globalThis, "__qaAbortNextWrite", true); });
    await paintCell(page, 12, 4);
    await action(page, "paint-commit", () => page.mouse.up());
    await saveSignal(page);
    const failed = await snapshot(page);
    assert.equal(tileAt(failed.course, 12, 4)?.kind, "coin");
    assert.equal(failed.state.saveStatus, "failed");
    assert.equal(failed.state.dirty, true);
    assert.equal(await page.getByTestId("save-status").getAttribute("data-status"), "failed");
    assert.match(await page.getByTestId("save-status").innerText(), /저장 실패/);
    assert.equal(await page.getByTestId("save-retry").isVisible(), true);
    assert.equal(await page.getByTestId("save-retry").isEnabled(), true);
    assert.equal(await page.getByTestId("export-course").isDisabled(), true);
    assert.deepEqual(failed.state.saveRecovery, ["retry", "export"]);
    const storedBeforeRetry = await idbCourse(page, failed.course.id);
    assert(storedBeforeRetry && typeof storedBeforeRetry === "object" && "document" in storedBeforeRetry);
    assert.equal(tileAt((storedBeforeRetry as { document: CourseV1 }).document, 12, 4)?.kind, undefined);
    captures.push({ step: "abort-retains-dirty-error", ...(await capture(page, `${evidence}/abort-error.png`)) });
    await armSave(page, "saved");
    await page.getByTestId("save-retry").click();
    await saveSignal(page);
    const retried = await snapshot(page);
    assert.equal(retried.state.saveStatus, "saved");
    assert.equal(tileAt(retried.course, 12, 4)?.kind, "coin");
    const storedAfter = await idbCourse(page, retried.course.id);
    assert(storedAfter && typeof storedAfter === "object" && "document" in storedAfter);
    assert.equal(tileAt((storedAfter as { document: CourseV1 }).document, 12, 4)?.kind, "coin");
    captures.push({ step: "retry-saved", ...(await capture(page, `${evidence}/retry-saved.png`)) });
    await json(`${evidence}/result.json`, { captures, abortedDirty: true, retrySaved: true, exportDisabled: true });
  });
}
