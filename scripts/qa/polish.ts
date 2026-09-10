import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, type Page } from "playwright-core";
import { sampleCourse } from "../../src/level/samples";
import { serializeCourse } from "../../src/level/serialize";
import { fixtureValue } from "../../tests/fixtures/factory";
import { bounded, installBootObserver, json } from "./support";

const sha = (bytes: Uint8Array) => Bun.CryptoHasher.hash("sha256", bytes, "hex");
const sizes = [{ width: 1280, height: 720 }, { width: 1920, height: 1080 }] as const;

async function arm(page: Page, event: string, slot = "__editorSignal") {
  await page.evaluate(({ event, slot }) => {
    Object.defineProperty(globalThis, slot, { configurable: true, value: new Promise<unknown>((resolve, reject) => {
      const listener = (value: Event) => {
        if (!(value instanceof CustomEvent)) return;
        clearTimeout(timer); document.removeEventListener(event, listener, true); resolve(value.detail);
      };
      const timer = setTimeout(() => { document.removeEventListener(event, listener, true); reject(new Error(`Missing ${event}`)); }, 10_000);
      document.addEventListener(event, listener, true);
    }) });
  }, { event, slot });
}
const signal = (page: Page, slot = "__editorSignal") => bounded(page.evaluate(`globalThis.${slot}`), "editor event");

async function capture(page: Page, path: string) {
  const png = await page.screenshot({ path, fullPage: false, animations: "disabled" });
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  return { file: resolve(path), sha256: sha(png), bytes: png.byteLength, viewport: page.viewportSize() };
}

async function openEditor(page: Page, origin: string, title: string) {
  await page.addInitScript(installBootObserver);
  await page.goto(`${origin}/?qa=editor`, { waitUntil: "load" });
  await bounded(page.evaluate(() => Reflect.get(globalThis, "__qaBootReady")), "boot");
  await page.getByTestId("new-course").click();
  await page.getByTestId("course-title").fill(title);
  await arm(page, "normal-editor-ready", "__readySignal");
  await page.getByTestId("create-course").click();
  await signal(page, "__readySignal");
  assert.equal(await page.getByTestId("editor-view").count(), 1);
}

export async function polish(evidence: string, origin: string) {
  await mkdir(evidence, { recursive: true });
  const browser = await chromium.launch({ channel: "chrome", headless: true, timeout: 10_000 });
  const captures: unknown[] = [], errors: string[] = [];
  try {
    await json(`${evidence}/versions.json`, { browser: browser.version(), bun: Bun.version, origin });
    for (const size of sizes) {
      const context = await browser.newContext({ viewport: size, deviceScaleFactor: 1 });
      const page = await context.newPage(); page.setDefaultTimeout(10_000);
      page.on("pageerror", error => errors.push(error.message));
      page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
      await page.addInitScript(installBootObserver);
      await page.goto(`${origin}/?qa=editor`, { waitUntil: "load" });
      await bounded(page.evaluate(() => Reflect.get(globalThis, "__qaBootReady")), "boot");
      captures.push({ mode: "library", ...await capture(page, `${evidence}/library-${size.width}.png`) });
      await page.getByTestId("new-course").click();
      await page.getByTestId("course-title").fill("다듬기");
      await arm(page, "normal-editor-ready", "__readySignal");
      await page.getByTestId("create-course").click();
      await signal(page, "__readySignal");
      const importVisible = await page.getByTestId("import-course-button").evaluate(el => {
        const rect = el.getBoundingClientRect();
        return { text: el.textContent, width: rect.width, height: rect.height, visible: rect.width >= 44 && rect.height >= 44 };
      });
      assert.equal(importVisible.text, "가져오기");
      assert.equal(importVisible.visible, true);
      const properties = await page.getByTestId("properties").evaluate(el => {
        const rect = el.getBoundingClientRect();
        return { left: rect.left, right: rect.right, width: rect.width, inView: rect.left >= 0 && rect.right <= innerWidth };
      });
      assert.equal(properties.inView, true);
      captures.push({ mode: "editor", importVisible, properties, ...await capture(page, `${evidence}/editor-${size.width}.png`) });
      await context.close();
    }
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
    const page = await context.newPage(); page.setDefaultTimeout(10_000);
    const course = sampleCourse("overworld");
    const bytes = new TextEncoder().encode(fixtureValue(serializeCourse(course)));
    await Bun.write(`${evidence}/polish-overworld.smb1.json`, bytes);
    await page.addInitScript(() => {
      Object.defineProperty(globalThis, "__playMounted", { value: new Promise<void>(resolve => {
        document.addEventListener("play-state", () => resolve(), { once: true, capture: true });
      }) });
    });
    await page.goto(`${origin}/?qa=play`, { waitUntil: "load" });
    await bounded(page.evaluate("globalThis.__playMounted"), "play mount");
    await page.getByTestId("import-course").setInputFiles(resolve(`${evidence}/polish-overworld.smb1.json`));
    await page.getByTestId("play-start").click();
    captures.push({ mode: "play", ...await capture(page, `${evidence}/play-1280.png`) });
    await page.keyboard.press("Escape");
    captures.push({ mode: "pause", ...await capture(page, `${evidence}/pause-1280.png`) });
    await page.setViewportSize({ width: 1920, height: 1080 });
    captures.push({ mode: "pause-1080", ...await capture(page, `${evidence}/pause-1920.png`) });
    await context.close();
    assert.deepEqual(errors, []);
    await json(`${evidence}/png-manifest.json`, captures);
  } finally {
    await browser.close();
    await json(`${evidence}/cleanup.json`, { browserClosed: true, errors });
  }
}

export async function polishRegression(evidence: string, origin: string) {
  await mkdir(evidence, { recursive: true });
  const browser = await chromium.launch({ channel: "chrome", headless: true, timeout: 10_000 });
  const errors: string[] = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
    const page = await context.newPage(); page.setDefaultTimeout(10_000);
    page.on("pageerror", error => errors.push(error.message));
    await json(`${evidence}/versions.json`, { browser: browser.version(), origin });
    await openEditor(page, origin, "회귀");
    const focus = await page.getByTestId("course-title").evaluate(el => {
      (el as HTMLElement).focus();
      return { outline: getComputedStyle(el).outlineWidth, korean: document.body.innerText.includes("코스") };
    });
    assert.equal(focus.outline, "3px");
    assert.equal(focus.korean, true);
    const png = await page.screenshot({ path: `${evidence}/regression-1280.png`, animations: "disabled" });
    await json(`${evidence}/actions.json`, { focus, sha256: sha(png), errors });
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await json(`${evidence}/cleanup.json`, { browserClosed: true });
  }
}
