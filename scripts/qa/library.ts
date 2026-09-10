import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, type Page } from "playwright-core";
import type { CourseV1 } from "../../src/level/types";
import type { EditorViewState } from "../../src/ui/editor";
import { bounded, installBootObserver, json } from "./support";

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
  const slot = `__ed_${reason.replaceAll("-", "_")}`;
  await arm(page, "editor-view-state", { reason }, slot);
  await run();
  await bounded(page.evaluate(`globalThis.${slot}`), `editor-view-state ${reason}`);
}
async function paintCell(page: Page, x: number, y: number) {
  const bounds = await page.getByTestId("editor-canvas").boundingBox();
  assert(bounds && bounds.width > 64);
  const state = (await snapshot(page)).state;
  const position = {
    x: (x * 16 + 8 - state.viewport.x) * state.viewport.zoom,
    y: (y * 16 + 8 - state.viewport.y) * state.viewport.zoom,
  };
  assert(position.x >= 0 && position.y >= 0 && position.x <= bounds.width && position.y <= bounds.height, `paint target off canvas ${JSON.stringify({ position, bounds, viewport: state.viewport })}`);
  await action(page, "pointer", () => page.getByTestId("editor-canvas").hover({ position }));
  await action(page, "paint-start", () => page.mouse.down());
  await action(page, "paint-commit", () => page.mouse.up());
}

const sha = (bytes: Uint8Array) => Bun.CryptoHasher.hash("sha256", bytes, "hex");

async function capture(page: Page, path: string) {
  const png = await page.screenshot({ path, fullPage: false, animations: "disabled" });
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  return { file: resolve(path), sha256: sha(png), bytes: png.byteLength };
}

async function idbCourses(page: Page) {
  return page.evaluate(async () => {
    const request = indexedDB.open("smb1-maker", 1);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onerror = () => reject(request.error ?? new Error("IDB open failed"));
      request.onsuccess = () => resolve(request.result);
    });
    try {
      const tx = db.transaction("courses", "readonly");
      const got = tx.objectStore("courses").getAll();
      return await new Promise<unknown[]>((resolve, reject) => {
        got.onerror = () => reject(got.error ?? new Error("IDB getAll failed"));
        got.onsuccess = () => resolve((got.result as unknown[]) ?? []);
      });
    } finally { db.close(); }
  });
}

async function openLibrary(page: Page, origin: string) {
  await page.addInitScript(installBootObserver);
  await page.goto(`${origin}/?qa=editor`, { waitUntil: "load" });
  await bounded(page.evaluate(() => Reflect.get(globalThis, "__qaBootReady")), "library startup");
  assert.equal(await page.getByTestId("library").isVisible(), true);
}

async function createNamedCourse(page: Page, title: string) {
  await page.getByTestId("new-course").click();
  await page.getByTestId("course-title").fill(title);
  await page.evaluate(() => {
    Object.defineProperty(globalThis, "__readySignal", { configurable: true, value: new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("normal-editor-ready missing")), 10_000);
      document.addEventListener("normal-editor-ready", () => { clearTimeout(timer); resolve(); }, { once: true });
    }) });
  });
  await page.getByTestId("create-course").click();
  await bounded(page.evaluate("globalThis.__readySignal"), "editor after create");
  assert.equal(await page.getByTestId("editor-view").count(), 1);
}

async function backToLibrary(page: Page) {
  await page.getByTestId("open-library").click();
  await page.getByTestId("library").waitFor({ state: "visible", timeout: 10_000 });
  await page.getByTestId("course-list").waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(await page.getByTestId("editor-view").count(), 0);
}

export async function library(evidence: string, origin: string) {
  await mkdir(evidence, { recursive: true });
  const browser = await chromium.launch({ channel: "chrome", headless: true, timeout: 10_000 });
  const errors: string[] = [];
  const captures: unknown[] = [];
  let passed = false, browserClosed = false;
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(10_000);
      page.on("pageerror", error => errors.push(error.message));
      page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
      page.on("requestfailed", request => errors.push(`${request.url()}: ${request.failure()?.errorText}`));
      await openLibrary(page, origin);
      await page.getByTestId("library-blank").waitFor({ state: "visible", timeout: 10_000 });
      captures.push({ step: "library-blank", ...(await capture(page, `${evidence}/library-blank.png`)) });
      await createNamedCourse(page, "원본 코스");
      await backToLibrary(page);
      assert.equal(await page.getByTestId("course-list").isVisible(), true);
      assert.equal(await page.getByTestId("library-blank").isHidden(), true);
      captures.push({ step: "library-list", ...(await capture(page, `${evidence}/library-list.png`)) });
      const originalId = await page.locator('[data-testid="course-list"] li').first().getAttribute("data-course-id");
      assert(originalId);
      await page.getByTestId("rename-course").click();
      await page.getByTestId("library-dialog").waitFor({ state: "visible", timeout: 10_000 });
      await page.getByTestId("rename-title").fill("이름 변경됨");
      await page.getByTestId("confirm").click();
      await page.getByTestId("library-dialog").waitFor({ state: "hidden", timeout: 10_000 });
      assert.match(await page.locator('[data-testid="course-list"] li').first().innerText(), /이름 변경됨/);
      await page.getByTestId("duplicate-course").click();
      await page.locator('[data-testid="course-list"] li').nth(1).waitFor({ state: "visible", timeout: 10_000 });
      const ids = await page.locator('[data-testid="course-list"] li').evaluateAll(items => items.map(item => item.getAttribute("data-course-id")));
      assert.equal(ids.length, 2);
      assert.equal(new Set(ids).size, 2);
      const duplicateRow = page.locator('[data-testid="course-list"] li').filter({ hasNot: page.locator(`[data-course-id="${originalId}"]`) }).first();
      await duplicateRow.getByTestId("delete-course").click();
      await page.getByTestId("library-dialog").waitFor({ state: "visible", timeout: 10_000 });
      captures.push({ step: "delete-dialog", ...(await capture(page, `${evidence}/delete-dialog.png`)) });
      await page.getByTestId("cancel").click();
      await page.getByTestId("library-dialog").waitFor({ state: "hidden", timeout: 10_000 });
      captures.push({ step: "delete-cancel", ...(await capture(page, `${evidence}/delete-cancel.png`)) });
      assert.equal(await page.locator('[data-testid="course-list"] li').count(), 2);
      await duplicateRow.getByTestId("delete-course").click();
      await page.getByTestId("confirm").click();
      await page.locator('[data-testid="course-list"] li').nth(1).waitFor({ state: "detached", timeout: 10_000 });
      assert.equal(await page.locator('[data-testid="course-list"] li').count(), 1);
      await page.getByTestId("open-course").click();
      await page.getByTestId("editor-view").waitFor({ state: "visible", timeout: 10_000 });
      assert.equal(await page.getByTestId("course-title").inputValue(), "이름 변경됨");
      const stored = await idbCourses(page);
      assert.equal(stored.length, 1);
      await json(`${evidence}/result.json`, { captures, originalId, remaining: stored.length, titles: stored.map(row => (row as { title: string }).title) });
    } finally { await context.close(); }
    assert.deepEqual(errors, []);
    passed = true;
  } finally {
    await browser.close(); browserClosed = true;
    await json(`${evidence}/actions.json`, { passed, origin, errors, browser: browser.version() });
    await json(`${evidence}/cleanup.json`, { browserClosed, browserDisconnected: !browser.isConnected(), contextsClosed: true });
  }
}

export async function libraryConflict(evidence: string, origin: string) {
  await mkdir(evidence, { recursive: true });
  const browser = await chromium.launch({ channel: "chrome", headless: true, timeout: 10_000 });
  const errors: string[] = [];
  const captures: unknown[] = [];
  let passed = false, browserClosed = false;
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
    try {
      const pageA = await context.newPage();
      const pageB = await context.newPage();
      for (const page of [pageA, pageB]) {
        page.setDefaultTimeout(10_000);
        page.on("pageerror", error => errors.push(error.message));
        page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
      }
      await openLibrary(pageA, origin);
      await createNamedCourse(pageA, "충돌 원본");
      const courseA = await pageA.evaluate(`globalThis.__qa.getCourseSnapshot()`) as CourseV1;
      await pageB.addInitScript(() => {
        Object.defineProperty(globalThis, "__restoredEditor", { value: new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("Page B editor did not mount")), 10_000);
          document.addEventListener("normal-editor-ready", () => { clearTimeout(timer); resolve(); }, { once: true });
        }) });
      });
      await pageB.goto(`${origin}/?qa=editor`, { waitUntil: "load" });
      await bounded(pageB.evaluate("globalThis.__restoredEditor"), "page B last-open");
      assert.equal(await pageB.getByTestId("editor-view").count(), 1);
      await pageA.bringToFront();
      const canvasA = pageA.getByTestId("editor-canvas");
      await canvasA.waitFor({ state: "visible", timeout: 10_000 });
      const boxA = await canvasA.boundingBox();
      assert(boxA && boxA.width > 64 && boxA.height > 64, `page A canvas box ${JSON.stringify(boxA)}`);
      await action(pageA, "home", () => pageA.getByTestId("viewport-home").click());
      await action(pageA, "tool", () => pageA.getByTestId("tool-paint").click());
      await action(pageA, "palette", () => pageA.getByTestId("palette-brick").click());
      await arm(pageA, "editor-view-state", { reason: "save", saveStatus: "saved" }, "__saveA");
      await paintCell(pageA, 10, 5);
      await signal(pageA, "__saveA");
      await pageB.bringToFront();
      const canvasB = pageB.getByTestId("editor-canvas");
      await canvasB.waitFor({ state: "visible", timeout: 10_000 });
      const boxB = await canvasB.boundingBox();
      assert(boxB && boxB.width > 64 && boxB.height > 64, `page B canvas box ${JSON.stringify(boxB)}`);
      await action(pageB, "home", () => pageB.getByTestId("viewport-home").click());
      await action(pageB, "tool", () => pageB.getByTestId("tool-paint").click());
      await action(pageB, "category", () => pageB.getByTestId("category-items").click());
      await action(pageB, "palette", () => pageB.getByTestId("palette-coin").click());
      await arm(pageB, "editor-view-state", { reason: "save", saveStatus: "failed" }, "__conflictB");
      await paintCell(pageB, 12, 4);
      await signal(pageB, "__conflictB");
      await pageB.getByTestId("error-dialog").waitFor({ state: "visible", timeout: 10_000 });
      captures.push({ step: "conflict-dialog", ...(await capture(pageB, `${evidence}/conflict-dialog.png`)) });
      const storedMid = await idbCourses(pageA) as Array<{ id: string; document: CourseV1 }>;
      assert.equal(storedMid.length, 1);
      const kept = storedMid[0];
      assert(kept);
      assert.equal(kept.id, courseA.id);
      assert.equal(kept.document.areas[0]?.tiles.some(tile => tile.x === 10 && tile.y === 5 && tile.kind === "brick"), true);
      assert.equal(kept.document.areas[0]?.tiles.some(tile => tile.x === 12 && tile.y === 4 && tile.kind === "coin"), false);
      await pageB.getByTestId("confirm").click();
      await pageB.getByTestId("error-dialog").waitFor({ state: "hidden", timeout: 10_000 });
      const storedEnd = await idbCourses(pageA) as Array<{ id: string; document: CourseV1 }>;
      assert.equal(storedEnd.length, 2);
      const original = storedEnd.find(row => row.id === courseA.id);
      const copy = storedEnd.find(row => row.id !== courseA.id);
      assert(original && copy);
      assert.equal(original.document.areas[0]?.tiles.some(tile => tile.x === 10 && tile.y === 5 && tile.kind === "brick"), true);
      assert.equal(copy.document.areas[0]?.tiles.some(tile => tile.x === 12 && tile.y === 4 && tile.kind === "coin"), true);
      assert.notEqual(copy.id, original.id);
      captures.push({ step: "save-copy-keeps-both", originalId: original.id, copyId: copy.id });
      await json(`${evidence}/result.json`, {
        captures,
        originalId: original.id,
        copyId: copy.id,
        storedOriginalHasA: true,
        copyHasB: true,
      });
    } finally { await context.close(); }
    assert.deepEqual(errors, []);
    passed = true;
  } finally {
    await browser.close(); browserClosed = true;
    await json(`${evidence}/actions.json`, { passed, origin, errors, browser: browser.version() });
    await json(`${evidence}/cleanup.json`, { browserClosed, browserDisconnected: !browser.isConnected(), contextsClosed: true, pages: 2 });
  }
}
