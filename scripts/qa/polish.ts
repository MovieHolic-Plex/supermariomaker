import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, type Page } from "playwright-core";
import { serializeCourse } from "../../src/level/serialize";
import { createGoalPlayFixture } from "../../tests/fixtures/goals";
import { createWaterFixture } from "../../tests/fixtures/water";
import { fixtureValue } from "../../tests/fixtures/factory";
import { bounded, closeOwnedBrowser, installBootObserver, json } from "./support";

const sha = (bytes: Uint8Array) => Bun.CryptoHasher.hash("sha256", bytes, "hex");
const sizes = [{ width: 1280, height: 720 }, { width: 1920, height: 1080 }] as const;

async function arm(page: Page, event: string, slot = "__editorSignal", match: Readonly<Record<string, unknown>> = {}) {
  await page.evaluate(({ event, slot, match }) => {
    Object.defineProperty(globalThis, slot, { configurable: true, value: new Promise<unknown>((resolve, reject) => {
      const listener = (value: Event) => {
        if (!(value instanceof CustomEvent) || !Object.entries(match).every(([key, expected]) => Reflect.get(value.detail, key) === expected)) return;
        clearTimeout(timer); document.removeEventListener(event, listener, true); resolve(value.detail);
      };
      const timer = setTimeout(() => { document.removeEventListener(event, listener, true); reject(new Error(`Missing ${event}`)); }, 10_000);
      document.addEventListener(event, listener, true);
    }) });
  }, { event, slot, match });
}
const signal = (page: Page, slot = "__editorSignal") => bounded(page.evaluate(`globalThis.${slot}`), "editor event");
async function action(page: Page, reason: string, run: () => Promise<unknown>, slot = "__editorSignal") {
  await arm(page, "editor-view-state", slot, { reason });
  await run();
  await signal(page, slot);
}

async function capture(page: Page, path: string) {
  const png = await page.screenshot({ path, fullPage: false, animations: "disabled" });
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  return { file: resolve(path), sha256: sha(png), bytes: png.byteLength, viewport: page.viewportSize() };
}

async function captureMode(page: Page, evidence: string, mode: string, captures: unknown[]) {
  for (const size of sizes) {
    if (page.viewportSize()?.width !== size.width || page.viewportSize()?.height !== size.height) {
      await action(page, "resize", () => page.setViewportSize(size), "__resize");
    }
    captures.push({ mode, ...await capture(page, `${evidence}/${mode}-${size.width}.png`) });
  }
  if (page.viewportSize()?.width !== 1280) await action(page, "resize", () => page.setViewportSize({ width: 1280, height: 720 }), "__resizeHome");
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

async function armPlay(page: Page, slot: string, match: Readonly<{ mode?: string; music?: string; ending?: string; phase?: string }>) {
  await page.evaluate(({ slot, match }) => {
    Object.defineProperty(globalThis, slot, { configurable: true, value: new Promise<unknown>((resolve, reject) => {
      const listener = (value: Event) => {
        if (!(value instanceof CustomEvent)) return;
        const detail = value.detail as { mode?: string; audio?: { music?: string | null }; runtime?: { ending?: { kind?: string; phase?: string } } };
        if (match.mode && detail.mode !== match.mode) return;
        if (match.music && detail.audio?.music !== match.music) return;
        if (match.ending && detail.runtime?.ending?.kind !== match.ending) return;
        if (match.phase && detail.runtime?.ending?.phase !== match.phase) return;
        clearTimeout(timer); document.removeEventListener("play-state", listener, true); resolve(detail);
      };
      const timer = setTimeout(() => { document.removeEventListener("play-state", listener, true); reject(new Error(`Missing play ${JSON.stringify(match)}`)); }, 10_000);
      document.addEventListener("play-state", listener, true);
    }) });
  }, { slot, match });
}

async function importCourse(page: Page, path: string) {
  await arm(page, "editor-view-state", "__imported", { reason: "course" });
  await page.getByTestId("import-course").setInputFiles(resolve(path));
  await signal(page, "__imported");
}

async function cellPoint(page: Page, x: number, y: number) {
  const bounds = await page.getByTestId("editor-canvas").boundingBox();
  assert(bounds);
  const state = await page.evaluate(() => (globalThis as unknown as { __qa: { getState: () => { viewport: { x: number; y: number; zoom: number } } } }).__qa.getState());
  return { x: bounds.x + (x * 16 + 8 - state.viewport.x) * state.viewport.zoom, y: bounds.y + (y * 16 + 8 - state.viewport.y) * state.viewport.zoom };
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
      const hiddenInput = await page.getByTestId("import-course").evaluate(el => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return { width: rect.width, height: rect.height, opacity: style.opacity, pointerEvents: style.pointerEvents, type: (el as HTMLInputElement).type };
      });
      assert.equal(hiddenInput.type, "file");
      assert.equal(hiddenInput.pointerEvents, "none");
      assert.equal(hiddenInput.width < 44 || hiddenInput.height < 44 || hiddenInput.opacity === "0", true);
      const properties = await page.getByTestId("properties").evaluate(el => {
        const rect = el.getBoundingClientRect();
        return { left: rect.left, right: rect.right, width: rect.width, inView: rect.left >= 0 && rect.right <= innerWidth };
      });
      assert.equal(properties.inView, true);
      captures.push({ mode: "editor", importVisible, hiddenInput, properties, ...await capture(page, `${evidence}/editor-${size.width}.png`) });
      await context.close();
    }

    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
    const page = await context.newPage(); page.setDefaultTimeout(10_000);
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    await openEditor(page, origin, "다듬기 모드");

    const currentSave = await page.getByTestId("save-status").getAttribute("data-status");
    if (currentSave !== "saved") {
      await arm(page, "editor-view-state", "__savedInitial", { reason: "save", saveStatus: "saved" });
      await signal(page, "__savedInitial");
    }
    await captureMode(page, evidence, "saved", captures);
    await action(page, "tool", () => page.getByTestId("tool-paint").click(), "__tool");
    await action(page, "home", () => page.getByTestId("viewport-home").click(), "__homePaint");
    const air = await cellPoint(page, 10, 5);
    await page.mouse.move(air.x - 48, air.y - 48);
    let dirtyCaptured = false;
    await page.exposeBinding("__qaAfterDirty", async () => {
      if (dirtyCaptured) return;
      dirtyCaptured = true;
      assert.equal(await page.getByTestId("save-status").getAttribute("data-status"), "dirty");
      await captureMode(page, evidence, "dirty", captures);
    });
    await arm(page, "editor-view-state", "__savedAgain", { reason: "save", saveStatus: "saved" });
    await action(page, "pointer", () => page.mouse.move(air.x, air.y), "__pointer");
    await action(page, "paint-start", () => page.mouse.down(), "__paintStart");
    await action(page, "paint-commit", () => page.mouse.up(), "__paintCommit");
    await signal(page, "__savedAgain");
    assert.equal(dirtyCaptured, true);

    await arm(page, "editor-view-state", "__home", { reason: "home" });
    await page.getByTestId("viewport-home").click();
    await signal(page, "__home");
    const ground = await cellPoint(page, 2, 13);
    await arm(page, "editor-view-state", "__hover", { reason: "pointer" });
    await page.mouse.move(ground.x, ground.y);
    await signal(page, "__hover");
    await page.getByTestId("play-cursor").click();
    await page.getByTestId("error-dialog").waitFor({ state: "visible", timeout: 10_000 });
    const spawnText = await page.getByTestId("error-dialog").innerText();
    assert.match(spawnText, /시작 위치가 단단한 지형과 겹칩니다/);
    assert.equal(await page.getByTestId("error-dialog").getAttribute("data-error-kind"), "start_blocked");
    await captureMode(page, evidence, "dialog-spawn", captures);
    await page.getByTestId("cancel").click();

    await page.getByTestId("import-course").setInputFiles(resolve("tests/fixtures/duplicate-id.smb1.json"));
    await page.getByTestId("error-dialog").waitFor({ state: "visible", timeout: 10_000 });
    const idText = await page.getByTestId("error-dialog").innerText();
    assert.match(idText, /코스 전체에서 ID는 고유해야 합니다/);
    assert.equal(await page.getByTestId("error-dialog").getAttribute("data-error-kind"), "duplicate_id");
    await captureMode(page, evidence, "dialog-duplicate-id", captures);
    await page.getByTestId("cancel").click();

    await page.getByTestId("import-course").setInputFiles(resolve("tests/fixtures/unknown-version.smb1.json"));
    await page.getByTestId("error-dialog").waitFor({ state: "visible", timeout: 10_000 });
    const valueText = await page.getByTestId("error-dialog").innerText();
    assert.match(valueText, /지원하지 않는 값입니다/);
    assert.equal(await page.getByTestId("error-dialog").getAttribute("data-error-kind"), "unsupported_version");
    await captureMode(page, evidence, "dialog-unsupported-value", captures);
    await page.getByTestId("cancel").click();

    const water = createWaterFixture("swim");
    await Bun.write(`${evidence}/polish-water.smb1.json`, new TextEncoder().encode(fixtureValue(serializeCourse(water))));
    await importCourse(page, `${evidence}/polish-water.smb1.json`);
    await armPlay(page, "__swimPlay", { mode: "PLAYING", music: "underwater" });
    await page.getByTestId("play-sandbox").click();
    const swimPlay = await bounded(page.evaluate("globalThis.__swimPlay"), "swim play") as { audio?: { music: string | null } };
    assert.equal(swimPlay.audio?.music, "underwater");
    await captureMode(page, evidence, "swim", captures);
    await arm(page, "editor-view-state", "__fromSwim");
    await page.getByTestId("return-editor").click();
    await signal(page, "__fromSwim");

    const flag = createGoalPlayFixture("flag");
    await Bun.write(`${evidence}/polish-flag.smb1.json`, new TextEncoder().encode(fixtureValue(serializeCourse(flag))));
    await importCourse(page, `${evidence}/polish-flag.smb1.json`);
    await armPlay(page, "__flagPlay", { mode: "PLAYING", music: "overworld" });
    await page.getByTestId("play-start").click();
    const playing = await bounded(page.evaluate("globalThis.__flagPlay"), "flag play") as { audio?: { music: string | null } };
    assert.equal(playing.audio?.music, "overworld");
    await captureMode(page, evidence, "play", captures);
    await armPlay(page, "__paused", { mode: "PAUSED" });
    await page.keyboard.press("Escape");
    await bounded(page.evaluate("globalThis.__paused"), "pause");
    await captureMode(page, evidence, "pause", captures);
    await armPlay(page, "__resumed", { mode: "PLAYING" });
    await page.getByTestId("resume").click();
    await bounded(page.evaluate("globalThis.__resumed"), "resume");
    await page.getByTestId("game-canvas").focus();
    await armPlay(page, "__cleared", { mode: "CLEARED" });
    await page.keyboard.down("ArrowRight");
    await bounded(page.evaluate("globalThis.__cleared"), "clear");
    await page.keyboard.up("ArrowRight");
    const clearText = await page.getByTestId("clear-dialog").innerText();
    assert.match(clearText, /클리어/);
    await captureMode(page, evidence, "clear", captures);
    await arm(page, "editor-view-state", "__fromClear");
    await page.getByTestId("return-editor").click();
    await signal(page, "__fromClear");

    const castle = createGoalPlayFixture("castle");
    await Bun.write(`${evidence}/polish-castle.smb1.json`, new TextEncoder().encode(fixtureValue(serializeCourse(castle))));
    await importCourse(page, `${evidence}/polish-castle.smb1.json`);
    await armPlay(page, "__castlePlay", { mode: "PLAYING" });
    await page.getByTestId("play-start").click();
    await bounded(page.evaluate("globalThis.__castlePlay"), "castle play");
    await armPlay(page, "__castleFall", { ending: "castle", phase: "fall" });
    await page.keyboard.down("ArrowRight");
    await bounded(page.evaluate("globalThis.__castleFall"), "castle fall");
    await page.keyboard.up("ArrowRight");
    await armPlay(page, "__castlePaused", { mode: "PAUSED" });
    await page.keyboard.press("Escape");
    await bounded(page.evaluate("globalThis.__castlePaused"), "castle pause");
    await captureMode(page, evidence, "castle-ending", captures);
    await arm(page, "editor-view-state", "__fromCastle");
    await page.getByTestId("return-editor").click();
    await signal(page, "__fromCastle");

    const pit = createGoalPlayFixture("death-tie");
    await Bun.write(`${evidence}/polish-death.smb1.json`, new TextEncoder().encode(fixtureValue(serializeCourse(pit))));
    await importCourse(page, `${evidence}/polish-death.smb1.json`);
    await armPlay(page, "__pitPlay", { mode: "PLAYING" });
    await page.getByTestId("play-start").click();
    await bounded(page.evaluate("globalThis.__pitPlay"), "pit play");
    await page.getByTestId("game-canvas").focus();
    await armPlay(page, "__dead", { mode: "DEAD" });
    await page.keyboard.down("ArrowRight");
    await bounded(page.evaluate("globalThis.__dead"), "death");
    await page.keyboard.up("ArrowRight");
    assert.equal(await page.getByTestId("retry").evaluate(el => (el as HTMLButtonElement).hidden), false);
    await captureMode(page, evidence, "death", captures);

    await context.close();
    assert.deepEqual(errors, []);
    await json(`${evidence}/png-manifest.json`, captures);
  } finally {
    await closeOwnedBrowser(browser);
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
    await closeOwnedBrowser(browser);
    await json(`${evidence}/cleanup.json`, { browserClosed: true });
  }
}
