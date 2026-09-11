import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, type Page } from "playwright-core";
import { sampleCourse } from "../../src/level/samples";
import { serializeCourse } from "../../src/level/serialize";
import { bounded, closeOwnedBrowser, installBootObserver, json } from "./support";

const sha = (bytes: Uint8Array) => Bun.CryptoHasher.hash("sha256", bytes, "hex");

async function capture(page: Page, path: string) {
  const png = await page.screenshot({ path, fullPage: false, animations: "disabled" });
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  return { file: resolve(path), sha256: sha(png), bytes: png.byteLength };
}

const signal = (page: Page, slot: string) => bounded(page.evaluate(`globalThis.${slot}`), slot);

async function armReason(page: Page, slot: string, reason: string) {
  await page.evaluate(({ slot, reason }) => {
    Object.defineProperty(globalThis, slot, { configurable: true, value: new Promise<unknown>((resolve, reject) => {
      const listener = (value: Event) => {
        if (!(value instanceof CustomEvent) || (value.detail as { reason?: string } | undefined)?.reason !== reason) return;
        clearTimeout(timer);
        document.removeEventListener("editor-view-state", listener, true);
        resolve(value.detail);
      };
      const timer = setTimeout(() => {
        document.removeEventListener("editor-view-state", listener, true);
        reject(new Error(`Missing editor reason ${reason}`));
      }, 10_000);
      document.addEventListener("editor-view-state", listener, true);
    }) });
  }, { slot, reason });
}

async function armTitle(page: Page, slot: string, title: string) {
  await page.evaluate(({ slot, title }) => {
    Object.defineProperty(globalThis, slot, { configurable: true, value: new Promise<string>((resolve, reject) => {
      const listener = () => {
        const input = document.querySelector('[data-testid="course-title"]');
        if (input instanceof HTMLInputElement && input.value === title) {
          clearTimeout(timer);
          document.removeEventListener("editor-view-state", listener, true);
          resolve(input.value);
        }
      };
      const timer = setTimeout(() => {
        document.removeEventListener("editor-view-state", listener, true);
        reject(new Error(`Missing title ${title}`));
      }, 10_000);
      document.addEventListener("editor-view-state", listener, true);
    }) });
  }, { slot, title });
}

async function armSavedAfterDirty(page: Page, slot: string) {
  await page.evaluate((slot) => {
    Object.defineProperty(globalThis, slot, { configurable: true, value: new Promise<unknown>((resolve, reject) => {
      let dirty = false;
      const listener = (value: Event) => {
        if (!(value instanceof CustomEvent)) return;
        const status = (value.detail as { saveStatus?: string } | undefined)?.saveStatus;
        if (status === "dirty") dirty = true;
        if (dirty && status === "saved") {
          clearTimeout(timer);
          document.removeEventListener("editor-view-state", listener, true);
          resolve(value.detail);
        }
      };
      const timer = setTimeout(() => {
        document.removeEventListener("editor-view-state", listener, true);
        reject(new Error("Missing saved-after-dirty"));
      }, 10_000);
      document.addEventListener("editor-view-state", listener, true);
    }) });
  }, slot);
}

async function armPlay(page: Page, slot: string, mode: string) {
  await page.evaluate(({ slot, mode }) => {
    Object.defineProperty(globalThis, slot, { configurable: true, value: new Promise<unknown>((resolve, reject) => {
      const listener = (value: Event) => {
        if (!(value instanceof CustomEvent)) return;
        if ((value.detail as { mode?: string } | undefined)?.mode !== mode) return;
        clearTimeout(timer);
        document.removeEventListener("play-state", listener, true);
        resolve(value.detail);
      };
      const timer = setTimeout(() => {
        document.removeEventListener("play-state", listener, true);
        reject(new Error(`Missing play ${mode}`));
      }, 10_000);
      document.addEventListener("play-state", listener, true);
    }) });
  }, { slot, mode });
}

async function armDialog(page: Page, slot: string) {
  await page.evaluate((slot) => {
    Object.defineProperty(globalThis, slot, { configurable: true, value: new Promise<string>((resolve, reject) => {
      const observer = new MutationObserver(() => {
        const el = document.querySelector('[data-testid="error-dialog"]');
        if (el instanceof HTMLElement && !el.hidden) {
          observer.disconnect();
          clearTimeout(timer);
          resolve(el.textContent ?? "");
        }
      });
      const timer = setTimeout(() => { observer.disconnect(); reject(new Error("error-dialog did not appear")); }, 10_000);
      observer.observe(document.body, { childList: true, subtree: true });
    }) });
  }, slot);
}

async function cellScreen(page: Page, cellX: number, cellY: number) {
  await armReason(page, "__home", "home");
  await page.getByTestId("viewport-home").click();
  await signal(page, "__home");
  const status = await page.getByTestId("viewport-status").textContent();
  const parsed = /카메라 ([-\d.]+), ([-\d.]+) · (\d+)×/.exec(status ?? "");
  assert(parsed, `viewport-status ${status}`);
  const viewX = Number(parsed[1]), viewY = Number(parsed[2]), zoom = Number(parsed[3]);
  const box = await page.getByTestId("editor-canvas").boundingBox();
  assert(box);
  return {
    x: box.x + (cellX * 16 + 8 - viewX) * zoom,
    y: box.y + (cellY * 16 + 8 - viewY) * zoom,
  };
}

async function paintBrick(page: Page) {
  await armReason(page, "__tool", "tool");
  await page.getByTestId("tool-paint").click();
  await signal(page, "__tool");
  await armReason(page, "__palette", "palette");
  await page.getByTestId("palette-brick").click();
  await signal(page, "__palette");
  const point = await cellScreen(page, 8, 8);
  await armSavedAfterDirty(page, "__painted");
  await armReason(page, "__paintStart", "paint-start");
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await signal(page, "__paintStart");
  await armReason(page, "__paintCommit", "paint-commit");
  await page.mouse.up();
  const committed = await signal(page, "__paintCommit") as { lastOutcome?: string };
  assert.equal(committed.lastOutcome, "committed");
  await signal(page, "__painted");
}

async function openNewCourse(page: Page, origin: string, title: string) {
  await page.addInitScript(installBootObserver);
  await page.goto(`${origin}/`, { waitUntil: "load" });
  await bounded(page.evaluate(() => Reflect.get(globalThis, "__qaBootReady")), "library boot");
  assert.equal(await page.getByTestId("library").count(), 1);
  await page.getByTestId("new-course").click();
  await page.getByTestId("course-title").fill(title);
  await page.getByTestId("create-course").click();
  await page.getByTestId("editor-canvas").waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(await page.getByTestId("course-title").inputValue(), title);
}

async function withPage(evidence: string, origin: string, run: (page: Page) => Promise<unknown>) {
  await mkdir(evidence, { recursive: true });
  const browser = await chromium.launch({ channel: "chrome", headless: true, timeout: 10_000 });
  const errors: string[] = [];
  let passed = false, browserClosed = false;
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, acceptDownloads: true });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(10_000);
      page.on("pageerror", error => errors.push(error.message));
      page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
      page.on("requestfailed", request => errors.push(`${request.url()}: ${request.failure()?.errorText}`));
      await run(page);
    } finally { await context.close(); }
    assert.deepEqual(errors, []);
    passed = true;
  } finally {
    await closeOwnedBrowser(browser);
    browserClosed = true;
    await json(`${evidence}/actions.json`, { passed, origin, errors, browser: browser.version() });
    await json(`${evidence}/cleanup.json`, { browserClosed, browserDisconnected: !browser.isConnected(), contextsClosed: true });
  }
}

/** README happy path on built preview `/`: new course, import sample JSON, paint, play, return, export. */
export async function builtFlow(evidence: string, origin: string) {
  const captures: unknown[] = [];
  const serialized = serializeCourse(sampleCourse("overworld"));
  assert.equal(serialized.ok, true);
  if (!serialized.ok) throw new Error("sample serialize");
  const samplePath = `${evidence}/solbaram.smb1.json`;
  await Bun.write(samplePath, serialized.value);
  await withPage(evidence, origin, async page => {
    await openNewCourse(page, origin, "README 샘플");
    captures.push({ step: "new-course", ...(await capture(page, `${evidence}/new-course.png`)) });
    await armTitle(page, "__imported", "솔바람 능선");
    await page.getByTestId("import-course").setInputFiles(resolve(samplePath));
    await signal(page, "__imported");
    assert.equal(await page.getByTestId("course-title").inputValue(), "솔바람 능선");
    captures.push({ step: "sample-open", ...(await capture(page, `${evidence}/sample-open.png`)) });
    await paintBrick(page);
    captures.push({ step: "painted", ...(await capture(page, `${evidence}/painted.png`)) });
    await armPlay(page, "__playing", "PLAYING");
    await page.getByTestId("play-start").click();
    await signal(page, "__playing");
    await page.getByTestId("game-canvas").waitFor({ state: "visible", timeout: 10_000 });
    captures.push({ step: "play", ...(await capture(page, `${evidence}/play.png`)) });
    await armPlay(page, "__paused", "PAUSED");
    await page.getByTestId("game-canvas").focus();
    await page.keyboard.press("Escape");
    await signal(page, "__paused");
    await page.getByTestId("return-editor").click();
    await page.getByTestId("editor-canvas").waitFor({ state: "visible", timeout: 10_000 });
    assert.equal(await page.getByTestId("play-overlay").count(), 0);
    captures.push({ step: "return-editor", ...(await capture(page, `${evidence}/return-editor.png`)) });
    const wait = page.waitForEvent("download", { timeout: 10_000 });
    await page.getByTestId("export-course").click();
    const download = await wait;
    const exported = `${evidence}/exported.smb1.json`;
    await download.saveAs(exported);
    const bytes = await Bun.file(exported).bytes();
    assert(bytes.byteLength > 0);
    captures.push({ step: "export", file: resolve(exported), bytes: bytes.byteLength, sha256: sha(bytes) });
    await json(`${evidence}/result.json`, { captures, sample: resolve(samplePath), title: "솔바람 능선" });
  });
}

/** README malformed-file recovery: current work stays after a bad import. */
export async function builtFailure(evidence: string, origin: string) {
  const captures: unknown[] = [];
  await withPage(evidence, origin, async page => {
    const title = "문서 검증 코스";
    await openNewCourse(page, origin, title);
    await paintBrick(page);
    captures.push({ step: "before-bad-import", ...(await capture(page, `${evidence}/before-bad-import.png`)) });
    const truncated = `${evidence}/truncated.json`;
    await Bun.write(truncated, "{");
    await armDialog(page, "__badImport");
    await page.getByTestId("import-course").setInputFiles(resolve(truncated));
    const message = await signal(page, "__badImport");
    assert.equal(typeof message, "string");
    assert.match(String(message), /올바른 JSON이 아닙니다/);
    captures.push({ step: "malformed", message, ...(await capture(page, `${evidence}/malformed.png`)) });
    await page.getByTestId("cancel").click();
    assert.equal(await page.getByTestId("course-title").inputValue(), title);
    assert.equal(await page.getByTestId("editor-canvas").count(), 1);
    captures.push({ step: "survived", title, ...(await capture(page, `${evidence}/survived.png`)) });
    await json(`${evidence}/result.json`, { captures, keptTitle: title });
  });
}
