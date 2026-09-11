// Regenerate docs/screenshots/*.png against a running preview (`bun run preview`).
// Uses the same isolated native-Chrome CDP driver as the QA suite; no test hooks.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Page } from "playwright-core";
import { serializeCourse } from "../src/level/serialize";
import { sampleCourse } from "../src/level/samples";
import { THEMES } from "../src/level/types";
import { bounded, nativeChrome } from "./qa/support";

const origin = process.env["PREVIEW_ORIGIN"] ?? "http://127.0.0.1:4173";
const outDir = resolve("docs/screenshots");
const viewport = { width: 1600, height: 900 };

async function armEditorState(page: Page, slot: string) {
  await page.evaluate(name => {
    Object.defineProperty(globalThis, name, { configurable: true, value: new Promise<void>(done => {
      document.addEventListener("editor-view-state", () => done(), { once: true, capture: true });
    }) });
  }, slot);
}
const editorSettled = (page: Page, slot: string) => bounded(page.evaluate(`globalThis.${slot}`), "editor-view-state");

async function armPlayState(page: Page, slot: string) {
  await page.evaluate(name => {
    Object.defineProperty(globalThis, name, { configurable: true, value: new Promise<void>(done => {
      document.addEventListener("play-state", () => done(), { once: true, capture: true });
    }) });
  }, slot);
}
const playSettled = (page: Page, slot: string) => bounded(page.evaluate(`globalThis.${slot}`), "play-state");

async function hold(page: Page, ms: number, ...keys: string[]) {
  for (const key of keys) await page.keyboard.down(key);
  await page.waitForTimeout(ms);
  for (const key of keys) await page.keyboard.up(key);
}

const tmp = await mkdtemp(resolve(tmpdir(), "readme-shots-"));
await mkdir(outDir, { recursive: true });
const fixtures = new Map<string, string>();
for (const theme of THEMES) {
  const serialized = serializeCourse(sampleCourse(theme));
  assert(serialized.ok, `sample ${theme} must serialize`);
  const file = resolve(tmp, `${theme}.smb1.json`);
  await Bun.write(file, serialized.value);
  fixtures.set(theme, file);
}

const native = await nativeChrome(tmp);
const page = native.context.pages()[0] ?? await native.context.newPage();
page.setDefaultTimeout(10_000);
try {
  await page.setViewportSize(viewport);
  await page.bringToFront();

  // Library with a real course listed: create, import a sample, return.
  await page.goto(`${origin}/`, { waitUntil: "load" });
  await page.getByTestId("library").waitFor({ state: "visible" });
  await page.getByTestId("new-course").click();
  await page.getByTestId("course-title").fill("오버월드 샘플");
  await armEditorState(page, "__shot_editor1");
  await page.getByTestId("create-course").click();
  await editorSettled(page, "__shot_editor1");
  await armEditorState(page, "__shot_editor2");
  await page.getByTestId("import-course").setInputFiles(fixtures.get("overworld")!);
  await editorSettled(page, "__shot_editor2");
  await page.getByTestId("editor-canvas").waitFor({ state: "visible" });
  await page.getByTestId("viewport-home").click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${outDir}/editor.png` });

  // Playtest overlay in the real editor flow.
  await armPlayState(page, "__shot_play");
  await page.getByTestId("play-start").click();
  await playSettled(page, "__shot_play");
  const canvas = page.getByTestId("game-canvas");
  await canvas.waitFor({ state: "visible" });
  await canvas.focus();
  await hold(page, 900, "ArrowRight", "ShiftLeft");
  await page.keyboard.press("Space");
  await page.waitForTimeout(350);
  await canvas.screenshot({ path: `${outDir}/play-overworld.png` });
  await page.screenshot({ path: `${outDir}/playtest.png` });
  await page.keyboard.up("ArrowRight");

  // Back to the library, now populated.
  await page.getByTestId("return-editor").click();
  await page.waitForTimeout(300);
  await page.getByTestId("open-library").click();
  await page.getByTestId("course-list").waitFor({ state: "visible" });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${outDir}/library.png` });

  // Theme gameplay stills via the play route.
  for (const theme of ["underwater", "castle", "underground"] as const) {
    await page.goto(`${origin}/?qa=play`, { waitUntil: "load" });
    const input = page.getByTestId("import-course");
    await input.setInputFiles(fixtures.get(theme)!);
    const start = page.getByTestId("play-start");
    await start.waitFor({ state: "visible" });
    await page.waitForFunction(() => !(document.querySelector('[data-testid="play-start"]') as HTMLButtonElement).disabled);
    await armPlayState(page, `__shot_${theme}`);
    await start.click();
    await playSettled(page, `__shot_${theme}`);
    const game = page.getByTestId("game-canvas");
    await game.waitFor({ state: "visible" });
    await game.focus();
    if (theme === "underwater") {
      await page.keyboard.press("Space");
      await page.waitForTimeout(250);
      await page.keyboard.press("Space");
      await hold(page, 600, "ArrowRight");
    } else {
      await hold(page, 900, "ArrowRight", "ShiftLeft");
      await page.keyboard.press("Space");
      await page.waitForTimeout(300);
    }
    await game.screenshot({ path: `${outDir}/play-${theme}.png` });
  }

  // Full sprite inventory.
  await page.goto(`${origin}/?qa=assets`, { waitUntil: "load" });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${outDir}/sprites.png` });

  console.log("screenshots written to", outDir);
} finally {
  await native.close();
  await rm(tmp, { recursive: true, force: true });
}
