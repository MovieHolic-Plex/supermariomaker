import assert from "node:assert/strict";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright-core";
import { createNormalEditor } from "../scripts/qa/editor";
import { bounded, installBootObserver, json } from "../scripts/qa/support";

async function arm(page: Page, event: string, field: string, expected: string) {
  await page.evaluate(({ event, field, expected }) => {
    Object.defineProperty(globalThis, "__routeSignal", { configurable: true, value: new Promise<void>((resolve, reject) => {
      const listener = (value: Event) => {
        if (!(value instanceof CustomEvent) || Reflect.get(value.detail, field) !== expected) return;
        clearTimeout(timer); document.removeEventListener(event, listener); resolve();
      };
      const timer = setTimeout(() => { document.removeEventListener(event, listener); reject(new Error(`Missing ${event}`)); }, 10_000);
      document.addEventListener(event, listener);
    }) });
  }, { event, field, expected });
}
const signal = (page: Page) => bounded(page.evaluate("globalThis.__routeSignal"), "route event");

/** Relevant startup faults and preserved gallery entry points, no native window or shared port. */
export async function hostRegressions(browser: Browser, evidence: string, baseUrl: string, disposed: Promise<unknown>) {
  const receipts: unknown[] = [];
  for (const branch of ["indexeddb-absent", "indexeddb-denied", "audio-unavailable", "canvas-unavailable", "clone-unavailable", "resize-unavailable", "uuid-unavailable", "uuid-failure", "bundle-abort", "html-404"] as const) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const errors: string[] = [];
    try {
      const page = await context.newPage(); page.setDefaultTimeout(10_000);
      page.on("pageerror", error => errors.push(error.message));
      page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
      if (branch !== "html-404") await page.addInitScript(installBootObserver);
      switch (branch) {
        case "indexeddb-absent": await page.addInitScript(() => Object.defineProperty(globalThis, "indexedDB", { value: undefined })); break;
        case "indexeddb-denied": await page.addInitScript(() => Object.defineProperty(globalThis, "indexedDB", { get() { throw new DOMException("QA denied", "SecurityError"); } })); break;
        case "audio-unavailable": await page.addInitScript(() => Object.defineProperty(globalThis, "AudioContext", { value: undefined })); break;
        case "canvas-unavailable": await page.addInitScript(() => { HTMLCanvasElement.prototype.getContext = () => null; }); break;
        case "clone-unavailable": await page.addInitScript(() => Object.defineProperty(globalThis, "structuredClone", { value: undefined })); break;
        case "resize-unavailable": await page.addInitScript(() => Object.defineProperty(globalThis, "ResizeObserver", { value: undefined })); break;
        case "uuid-unavailable": await page.addInitScript(() => Object.defineProperty(crypto, "randomUUID", { value: undefined })); break;
        case "uuid-failure": await page.addInitScript(() => {
          const original = crypto.randomUUID.bind(crypto); let fail = true;
          Object.defineProperty(crypto, "randomUUID", { value: () => { if (fail) { fail = false; throw new DOMException("QA entropy denied", "OperationError"); } return original(); } });
        }); break;
        case "bundle-abort": await context.route(`${baseUrl}/app.js`, route => route.abort("failed")); break;
        case "html-404": break;
      }
      const response = await page.goto(`${baseUrl}/${branch === "html-404" ? "missing.html" : ""}`, { waitUntil: "load" });
      if (branch === "html-404") {
        assert.equal(response?.status(), 404); assert.equal(await page.locator("body").innerText(), "Not Found\n");
      } else {
        await bounded(page.evaluate(() => Reflect.get(globalThis, "__qaBootReady")), branch);
        if (branch !== "uuid-failure") {
          assert(await page.getByTestId("error-dialog").isVisible()); assert(await page.getByTestId("retry").isEnabled());
        }
        if (["indexeddb-absent", "indexeddb-denied", "audio-unavailable", "uuid-failure"].includes(branch)) {
          await page.getByTestId("new-course").click(); await page.getByTestId("course-title").fill("첫 코스"); await page.getByTestId("create-course").click();
          if (branch === "uuid-failure") {
            assert(await page.getByTestId("create-error").isVisible()); assert.equal(await page.getByTestId("editor-view").count(), 0);
            await page.getByTestId("create-course").click();
          }
          assert(await page.getByTestId("editor-view").isVisible()); assert.equal(await page.getByTestId("course-title").inputValue(), "첫 코스");
          assert(await page.getByTestId("export-course").isDisabled());
          if (branch !== "uuid-failure") assert(await page.getByTestId("error-dialog").isVisible());
          assert.equal(await page.evaluate('"__qa" in globalThis'), false);
          await page.screenshot({ path: `${evidence}/${branch}-editor.png` });
          assert(await page.getByTestId("editor-status").evaluate(element => element.getBoundingClientRect().bottom <= innerHeight));
        } else if (branch === "bundle-abort") {
          assert.equal(await page.getByTestId("library").count(), 0);
          await context.unroute(`${baseUrl}/app.js`);
          const loaded = page.waitForEvent("load"); await page.getByTestId("retry").click(); await loaded;
          await bounded(page.evaluate(() => Reflect.get(globalThis, "__qaBootReady")), "bundle retry");
          assert(await page.getByTestId("library").isVisible());
        } else assert.equal(await page.getByTestId("new-course").count(), 0);
      }
      if (branch === "bundle-abort") {
        assert.equal(errors.filter(error => error.startsWith("Application load failed")).length, 1);
        assert(errors.every(error => error.startsWith("Application load failed") || error === "Failed to load resource: net::ERR_FAILED"));
      } else if (branch === "html-404") assert(errors.every(error => /Failed to load resource:.*404/.test(error)));
      else assert.deepEqual(errors, []);
      receipts.push({ branch, errors, passed: true });
    } finally { await context.close(); }
  }
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  try {
    const page = await context.newPage(); page.setDefaultTimeout(10_000);
    await page.addInitScript(installBootObserver); await page.goto(`${baseUrl}/`, { waitUntil: "load" });
    await bounded(page.evaluate(() => Reflect.get(globalThis, "__qaBootReady")), "title boundary boot");
    await page.getByTestId("new-course").click(); await page.getByTestId("course-title").fill("   "); await page.getByTestId("create-course").click();
    assert.equal(await page.getByTestId("editor-view").count(), 0);
    assert.equal(await page.getByTestId("course-title").evaluate(element => element instanceof HTMLInputElement && element.validity.valid), false);
    const title = '<img src=x onerror="throw 1">';
    await page.getByTestId("course-title").fill(title); await page.getByTestId("create-course").click();
    assert.equal(await page.getByTestId("course-title").inputValue(), title); assert.equal(await page.locator("img").count(), 0);
    assert.equal(await page.evaluate('"__qa" in globalThis'), false);
    assert.deepEqual(await page.evaluate(() => indexedDB.databases()), [], "Opening a view must not write or open a library database");
    receipts.push({ branch: "title-validity-text-safety-no-storage-or-qa", passed: true });
  } finally { await context.close(); }
  for (const route of ["audio", "assets", "fixture", "play"] as const) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const errors: string[] = [];
    try {
      const page = await context.newPage(); page.setDefaultTimeout(10_000);
      page.on("pageerror", error => errors.push(error.message)); page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
      await page.goto(`${baseUrl}/?qa=${route}`, { waitUntil: "load" });
      const id = route === "audio" ? "audio-gallery" : route === "assets" ? "asset-sheet" : "fixture-gallery";
      await page.evaluate(id => new Promise<void>((resolve, reject) => {
        const ready = () => document.querySelector(`[data-testid="${id}"]`);
        if (ready()) { resolve(); return; }
        const observer = new MutationObserver(() => { if (ready()) { clearTimeout(timer); observer.disconnect(); resolve(); } });
        const timer = setTimeout(() => { observer.disconnect(); reject(new Error(`Missing ${id}`)); }, 10_000);
        observer.observe(document, { childList: true, subtree: true });
      }), id);
      assert(await page.getByTestId(id).isVisible()); assert.equal(await page.getByTestId("editor-view").count(), 0);
      if (route === "assets") {
        await page.getByTestId("assets-next").click(); assert.equal(await page.getByTestId("asset-sheet").getAttribute("data-page"), "overworld-02");
      } else if (route === "audio") {
        await page.getByTestId("theme-select").selectOption("castle"); assert.equal(await page.getByTestId("theme-select").inputValue(), "castle");
      } else {
        await arm(page, "fixture-state", "status", "loaded");
        await page.getByTestId("import-course").setInputFiles(resolve("tests/fixtures/new-course.smb1.json")); await signal(page);
        assert(await page.getByTestId("fixture-canvas").isVisible());
        if (route === "play") {
          await arm(page, "play-state", "mode", "PLAYING"); await page.getByTestId("play-start").click(); await signal(page);
          assert(await page.getByTestId("game-canvas").isVisible());
          await arm(page, "play-state", "mode", "PAUSED"); await page.getByTestId("pause").click(); await signal(page);
          assert(await page.getByTestId("resume").isVisible());
          await arm(page, "play-state", "mode", "READY"); await page.getByTestId("return-editor").click(); await signal(page);
        }
      }
      assert.deepEqual(errors, []); receipts.push({ route, errors, passed: true });
    } finally { await context.close(); }
  }
  const disposalContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  try {
    const page = await disposalContext.newPage(); await createNormalEditor(page, baseUrl);
    // A keepalive beacon survives realm destruction; a Playwright binding does not.
    await page.evaluate(`void globalThis.__qa.nextState(()=>false).then(()=>navigator.sendBeacon("/__task10_cleanup",JSON.stringify({unexpectedResolve:true})),error=>navigator.sendBeacon("/__task10_cleanup",JSON.stringify({error:error.message,qaRemoved:!("__qa" in globalThis),views:document.querySelectorAll('[data-testid="editor-view"]').length})))`);
    await page.goto(`${baseUrl}/?qa=assets`, { waitUntil: "load" });
    assert.deepEqual(await bounded(disposed, "natural pagehide cleanup"), { error: "Editor host disposed", qaRemoved: true, views: 0 });
    receipts.push({ branch: "natural-pagehide-disposes-view-qa-and-pending-subscription", passed: true });
  } finally { await disposalContext.close(); }
  await json(`${evidence}/regressions.json`, receipts);
  return receipts;
}
