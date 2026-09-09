import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, type Page } from "playwright-core";
import type { EditorViewState } from "../../src/ui/editor";
import type { CourseV1 } from "../../src/level/types";
import { serializeCourse, parseCourse } from "../../src/level/serialize";
import { screenToWorld } from "../../src/editor/viewport";
import { getFrame, type AssetKey } from "../../src/assets/manifest";
import { rasterizeFrame } from "../../src/render/assets";
import { createNewCourse, TILE_CATALOG } from "../../src/level/catalog";
import { bounded, installBootObserver, json } from "./support";

const PRIVATE_PORT = 4185;
const sha = (bytes: Uint8Array) => Bun.CryptoHasher.hash("sha256", bytes, "hex");
interface Snapshot { readonly state: EditorViewState; readonly course: CourseV1; readonly proposals: readonly unknown[] }
async function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(`({state:globalThis.__qa.getState(),course:globalThis.__qa.getCourseSnapshot(),proposals:globalThis.__qa.getProposals()})`);
}
async function arm(page: Page, event: string, match: Readonly<Record<string, unknown>> = {}) {
  await page.evaluate(({ event, match }) => {
    Object.defineProperty(globalThis, "__editorSignal", { configurable: true, value: new Promise<unknown>((resolve, reject) => {
      const listener = (value: Event) => {
        if (!(value instanceof CustomEvent) || !Object.entries(match).every(([key, expected]) => Reflect.get(value.detail, key) === expected)) return;
        clearTimeout(timer); document.removeEventListener(event, listener, true); resolve(value.detail);
      };
      const timer = setTimeout(() => { document.removeEventListener(event, listener, true); reject(new Error(`Missing ${event}: ${JSON.stringify(match)}`)); }, 10_000);
      document.addEventListener(event, listener, true);
    }) });
  }, { event, match });
}
const signal = (page: Page) => bounded(page.evaluate("globalThis.__editorSignal"), "exact editor event");
async function action(page: Page, reason: string, run: () => Promise<unknown>): Promise<void> {
  await arm(page, "editor-view-state", { reason }); await run(); await signal(page);
}
async function box(page: Page) {
  const bounds = await page.getByTestId("editor-canvas").boundingBox(); assert(bounds);
  return { ...bounds, left: bounds.x, top: bounds.y };
}
function closePoint(actual: Readonly<{ x: number; y: number }>, expected: Readonly<{ x: number; y: number }>) {
  assert(Math.abs(actual.x - expected.x) < 0.000001, `X ${actual.x} != ${expected.x}`);
  assert(Math.abs(actual.y - expected.y) < 0.000001, `Y ${actual.y} != ${expected.y}`);
}
async function capture(page: Page, path: string) {
  const layout = await page.evaluate(() => {
    const ids = ["editor-toolbar", "editor-tools", "editor-palette", "editor-stage", "properties", "editor-status"];
    const panels = ids.map(id => {
      const element = document.querySelector(`[data-testid="${id}"]`); if (!element) throw new Error(`Missing ${id}`);
      const rect = element.getBoundingClientRect();
      if (rect.left < 0 || rect.top < 0 || rect.right > innerWidth || rect.bottom > innerHeight || rect.width < 100 || rect.height < 40) throw new Error(`Clipped panel ${id}: ${JSON.stringify(rect)}`);
      return { id, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    });
    for (const [i, a] of panels.entries()) for (const b of panels.slice(i + 1)) {
      if (Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 0.1 && Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 0.1) throw new Error(`Panel overlap ${a.id}/${b.id}`);
    }
    const canvas = document.querySelector('[data-testid="editor-canvas"]');
    if (!(canvas instanceof HTMLCanvasElement)) throw new Error("Actual editor canvas missing");
    const rect = canvas.getBoundingClientRect();
    if (canvas.width !== Math.round(rect.width * devicePixelRatio) || canvas.height !== Math.round(rect.height * devicePixelRatio)) throw new Error("DPR applied incorrectly");
    const pixels = canvas.getContext("2d")?.getImageData(0, 0, canvas.width, canvas.height).data;
    if (!pixels) throw new Error("Canvas has no pixels");
    const colors = new Set<number>(); for (let i = 0; i < pixels.length; i += 4) colors.add((pixels[i] ?? 0) * 65536 + (pixels[i + 1] ?? 0) * 256 + (pixels[i + 2] ?? 0));
    if (colors.size < 12) throw new Error(`Editor scene lacks actual pixel artwork: ${colors.size} colors`);
    const checkbox = document.querySelector('[data-testid="viewport-grid"]');
    if (!checkbox || checkbox.getBoundingClientRect().width !== 18 || checkbox.getBoundingClientRect().height !== 18) throw new Error("Boot styles changed the approved grid checkbox geometry");
    const targets: unknown[] = [];
    for (const element of document.querySelectorAll('.editor-view button, .editor-view select, .editor-view input:not([type="checkbox"]), .editor-grid-toggle')) {
      const rect = element.getBoundingClientRect();
      if (rect.width < 44 || rect.height < 44) throw new Error(`Small target ${element.getAttribute("data-testid")}: ${rect.width}x${rect.height}`);
      targets.push({ id: element.getAttribute("data-testid"), width: rect.width, height: rect.height });
    }
    for (const selector of [".editor-stage-caption", ".editor-title-label", ".editor-status", ".editor-categories"]) {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element || element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1) throw new Error(`Overflowing static label ${selector}`);
    }
    const hidden = document.createElement("div"); hidden.hidden = true; hidden.textContent = "hidden probe"; document.querySelector(".editor-view")?.append(hidden);
    const hiddenDisplay = getComputedStyle(hidden).display; hidden.remove(); if (hiddenDisplay !== "none") throw new Error("Hidden CSS overridden");
    if (document.documentElement.scrollHeight > innerHeight || document.documentElement.scrollWidth > innerWidth) throw new Error("Page-level overflow");
    return { panels, targets, colors: colors.size, dpr: devicePixelRatio, backing: { width: canvas.width, height: canvas.height }, pixelated: getComputedStyle(canvas).imageRendering, font: getComputedStyle(canvas).fontFamily };
  });
  const png = await page.screenshot({ path, fullPage: false, animations: "disabled" });
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  const viewport = page.viewportSize(); assert(viewport);
  assert.equal(png.readUInt32BE(16), viewport.width * layout.dpr); assert.equal(png.readUInt32BE(20), viewport.height * layout.dpr);
  const compositorPixels = await page.evaluate(async base64 => {
    const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob());
    const screenshot = document.createElement("canvas"); screenshot.width = image.width; screenshot.height = image.height;
    const context = screenshot.getContext("2d"), live = document.querySelector('[data-testid="editor-canvas"]');
    if (!context || !(live instanceof HTMLCanvasElement)) throw new Error("Screenshot comparison canvas missing");
    context.drawImage(image, 0, 0); image.close();
    const rect = live.getBoundingClientRect(), actual = live.getContext("2d")?.getImageData(0, 0, live.width, live.height).data;
    if (!actual) throw new Error("Live image data missing");
    const captured = context.getImageData(Math.round(rect.x * devicePixelRatio), Math.round(rect.y * devicePixelRatio), live.width, live.height).data;
    for (let i = 0; i < actual.length; i++) if (actual[i] !== captured[i]) throw new Error(`PNG compositor differs from live editor at byte ${i}`);
    return actual.length / 4;
  }, png.toString("base64"));
  return { file: resolve(path), width: png.readUInt32BE(16), height: png.readUInt32BE(20), sha256: sha(png), viewport, layout, compositorPixels };
}

async function verifyRenderedPixels(page: Page) {
  await action(page, "grid", () => page.getByTestId("viewport-grid").uncheck());
  const { course, state } = await snapshot(page), area = course.areas.find(area => area.id === state.areaId); assert(area);
  const samples: { x: number; y: number; rgba: number[] }[] = [];
  const sprites: { key: AssetKey; x: number; y: number }[] = area.tiles.filter(tile => tile.x < 21).map(tile => ({ key: TILE_CATALOG[tile.kind].assetKey, x: tile.x * 16 + 8, y: tile.y * 16 + 16 }));
  for (const object of area.objects) if (object.kind === "pipe") sprites.push({ key: "decor.pipeCap", x: object.x, y: object.y - (object.props.height - 1) * 16 });
  if (course.start.areaId === area.id) sprites.push({ key: "mario.small.idle", x: course.start.x, y: course.start.y });
  for (const sprite of sprites) {
    const frame = getFrame(sprite.key), pixels = rasterizeFrame(sprite.key, area.theme);
    for (let y = 0; y < frame.height; y++) for (let x = 0; x < frame.width; x++) {
      const offset = (y * frame.width + x) * 4;
      if (pixels[offset + 3] !== 255) continue;
      const wx = sprite.x - frame.anchor.x + x + 0.5, wy = sprite.y - frame.anchor.y + y + 0.5;
      // The editor's area outline intentionally overlays edge pixels; compare atlas art in the interior.
      if (wx < 1 || wy < 1 || wx > area.width * 16 - 1 || wy > area.height * 16 - 1) continue;
      const sx = (wx - state.viewport.x) * state.viewport.zoom * state.dpr;
      const sy = (wy - state.viewport.y) * state.viewport.zoom * state.dpr;
      if (sx < 0 || sy < 0 || sx >= state.size.width * state.dpr || sy >= state.size.height * state.dpr) continue;
      samples.push({ x: Math.floor(sx), y: Math.floor(sy), rgba: Array.from(pixels.slice(offset, offset + 4)) });
    }
  }
  assert(samples.length > 1000, "Pixel proof needs real visible tile and sprite samples");
  await page.evaluate(samples => {
    const canvas = document.querySelector('[data-testid="editor-canvas"]'); if (!(canvas instanceof HTMLCanvasElement)) throw new Error("Editor canvas missing");
    const context = canvas.getContext("2d"); if (!context) throw new Error("Editor context missing");
    for (const sample of samples) {
      const actual = context.getImageData(sample.x, sample.y, 1, 1).data;
      if (!sample.rgba.every((value, channel) => actual[channel] === value)) throw new Error(`Production atlas pixel mismatch at ${sample.x},${sample.y}: ${actual} vs ${sample.rgba}`);
    }
  }, samples);
  await action(page, "grid", () => page.getByTestId("viewport-grid").check());
  return { action: "production-atlas-pixels-at-world-coordinates", samples: samples.length, dpr: state.dpr, includesPipeCapAcrossChunkSeam: area.objects.some(object => object.kind === "pipe" && object.x === 256) };
}

/** Reusable against a real mounted editor; no route/QA registry writes or product mutations. */
export async function editorShell(page: Page, evidence: string, resizeToReference = true) {
  const actions: unknown[] = [], captures: unknown[] = [];
  const original = await snapshot(page);
  for (const id of ["tool-paint", "tool-erase", "tool-fill", "tool-select", "undo", "redo", "play-start", "export-course"]) assert(await page.getByTestId(id).isDisabled(), `${id} must not imply implemented authoring`);
  let bounds = await box(page);
  let point = { x: Math.floor(bounds.x + bounds.width * 0.4), y: Math.floor(bounds.y + bounds.height * 0.55) };
  await action(page, "pointer", () => page.mouse.move(point.x, point.y));
  let before = (await snapshot(page)).state;
  await action(page, "pan-start", () => page.mouse.down({ button: "middle" }));
  await action(page, "pan", () => page.mouse.move(point.x + 72, point.y - 40));
  await action(page, "pan-end", () => page.mouse.up({ button: "middle" }));
  let after = (await snapshot(page)).state;
  closePoint(after.viewport, { x: before.viewport.x - 72 / before.viewport.zoom, y: before.viewport.y + 40 / before.viewport.zoom });
  assert.equal(after.panning, false); actions.push({ action: "middle-drag", before: before.viewport, after: after.viewport });
  await action(page, "space", () => page.keyboard.down("Space"));
  before = after;
  await action(page, "pan-start", () => page.mouse.down());
  await action(page, "pan", () => page.mouse.move(point.x + 40, point.y - 16));
  await action(page, "pan-end", () => page.mouse.up());
  await action(page, "input-clear", () => page.keyboard.up("Space"));
  after = (await snapshot(page)).state;
  closePoint(after.viewport, { x: before.viewport.x + 32 / before.viewport.zoom, y: before.viewport.y - 24 / before.viewport.zoom });
  actions.push({ action: "Space-left-drag", before: before.viewport, after: after.viewport });
  for (const zoom of [1, 2, 4, 8, 2] as const) {
    bounds = await box(page); point = { x: Math.floor(bounds.x + bounds.width * 0.37), y: Math.floor(bounds.y + bounds.height * 0.61) };
    await action(page, "pointer", () => page.mouse.move(point.x, point.y));
    before = (await snapshot(page)).state; const anchor = screenToWorld(point, before.viewport, bounds);
    await action(page, "zoom", () => page.getByTestId(`zoom-${zoom}`).click());
    after = (await snapshot(page)).state;
    assert.equal(after.viewport.zoom, zoom); closePoint(screenToWorld(point, after.viewport, bounds), anchor);
    assert.equal(await page.getByTestId(`zoom-${zoom}`).getAttribute("aria-pressed"), "true");
    actions.push({ action: `zoom-control-${zoom}`, pointer: point, worldAnchor: anchor, viewport: after.viewport });
  }
  await action(page, "pointer", () => page.mouse.move(point.x, point.y));
  before = (await snapshot(page)).state;
  await action(page, "zoom", () => page.mouse.wheel(0, -120));
  after = (await snapshot(page)).state; assert.equal(after.viewport.zoom, 4);
  closePoint(screenToWorld(point, after.viewport, bounds), screenToWorld(point, before.viewport, bounds));
  actions.push({ action: "real-wheel-pointer-zoom", before: before.viewport, after: after.viewport });
  await page.getByTestId("editor-canvas").focus();
  await action(page, "zoom", () => page.keyboard.press("2"));
  await action(page, "home", () => page.keyboard.press("Home"));
  before = (await snapshot(page)).state;
  await action(page, "key-pan", () => page.keyboard.press("ArrowRight"));
  after = (await snapshot(page)).state; closePoint(after.viewport, { x: before.viewport.x + 16, y: before.viewport.y });
  await action(page, "home", () => page.getByTestId("viewport-home").click());
  actions.push({ action: "canvas-focused-keyboard-zoom-home-pan", after: after.viewport });
  // A real click supplies the same cell used by rendering's cursor highlight, without editing the Course.
  bounds = await box(page); before = (await snapshot(page)).state;
  const world = { x: 8 * 16 + 8, y: 13 * 16 + 8 };
  point = { x: bounds.x + (world.x - before.viewport.x) * before.viewport.zoom, y: bounds.y + (world.y - before.viewport.y) * before.viewport.zoom };
  await action(page, "point", () => page.mouse.click(point.x, point.y));
  const inspected = await snapshot(page);
  assert.deepEqual(inspected.state.hoveredCell, { x: 8, y: 13 });
  assert.deepEqual(inspected.proposals.at(-1), { kind: "canvas-point", areaId: original.course.mainAreaId, world, cell: { x: 8, y: 13 } });
  actions.push({ action: "canvas-hit", world, cell: inspected.state.hoveredCell });
  for (const [category, kind] of [["terrain", "question"], ["items", "coin"], ["devices", "pipe"], ["goals", "flagGoal"], ["enemies", "goomba"], ["projectiles", "fireball"]]) {
    await action(page, "category", () => page.getByTestId(`category-${category}`).click());
    await action(page, "palette", () => page.getByTestId(`palette-${kind}`).click());
    assert.equal((await snapshot(page)).state.paletteKind, kind); assert.equal(await page.getByTestId("preview-kind").getAttribute("data-kind"), kind);
    actions.push({ action: "categorized-palette-preview", category, kind });
  }
  await action(page, "category", () => page.getByTestId("category-terrain").click());
  await action(page, "palette", () => page.getByTestId("palette-question").click());
  assert.deepEqual((await snapshot(page)).course, original.course, "Pan, zoom, clicks, palette and keyboard cannot mutate document");
  actions.push(await verifyRenderedPixels(page));
  captures.push(await capture(page, `${evidence}/editor-${page.viewportSize()?.width}.png`));
  if (resizeToReference) {
    await action(page, "resize", () => page.setViewportSize({ width: 1920, height: 1080 }));
    await action(page, "home", () => page.getByTestId("viewport-home").click());
    captures.push(await capture(page, `${evidence}/editor-1920.png`));
    actions.push({ action: "responsive-real-viewport-resize", from: { width: 1280, height: 720 }, to: { width: 1920, height: 1080 } });
  }
  await json(`${evidence}/shell.json`, { actions, captures, final: await snapshot(page) });
  return { actions, captures };
}

/** Native form focus proof, separate for later normal-app registration. */
export async function editorFocus(page: Page, evidence: string) {
  const before = await snapshot(page);
  await page.getByTestId("course-title").click();
  await action(page, "title-draft", () => page.getByTestId("course-title").fill("한글 제목 "));
  await page.keyboard.type("wasdz 1248");
  // Keyboard APIs complete after their real input events; the final value is asserted, not time-polled.
  await page.keyboard.press("Home"); await page.keyboard.press("ArrowRight"); await page.keyboard.press("End");
  const after = await snapshot(page);
  assert.equal(await page.getByTestId("course-title").inputValue(), "한글 제목 wasdz 1248");
  assert.equal(after.state.titleDraft, "한글 제목 wasdz 1248");
  assert.deepEqual(after.course, before.course); assert.deepEqual(after.state.viewport, before.state.viewport); assert.equal(after.state.panning, false);
  assert.equal(await page.getByTestId("course-title").evaluate(element => element === document.activeElement), true);
  assert(after.proposals.some(value => value && typeof value === "object" && "kind" in value && value.kind === "title-draft"));
  // Space released in a field cannot remain latched when canvas is clicked afterwards.
  const bounds = await box(page), point = { x: bounds.x + 180, y: bounds.y + 180 };
  await action(page, "point", () => page.mouse.click(point.x, point.y));
  await action(page, "pointer", () => page.mouse.move(point.x + 40, point.y + 24));
  assert.deepEqual((await snapshot(page)).state.viewport, before.state.viewport);
  await page.getByTestId("course-title").focus();
  const focusStyle = await page.getByTestId("course-title").evaluate(element => ({ outline: getComputedStyle(element).outlineStyle, outlineWidth: getComputedStyle(element).outlineWidth }));
  assert.notEqual(focusStyle.outline, "none"); assert.equal(focusStyle.outlineWidth, "3px");
  const captureResult = await capture(page, `${evidence}/editor-title-focus-${page.viewportSize()?.width}.png`);
  const result = { before, after: await snapshot(page), focusStyle, capture: captureResult, actions: ["focus real title input", "type Korean and wasdz Space 1248", "Home/ArrowRight/End stay native", "click and move canvas with no stale Space drag", "document and camera unchanged"] };
  await json(`${evidence}/focus.json`, result); return result;
}

/** Real normal route + real form, shared by the owned scenarios and isolated integration runner. */
export async function createNormalEditor(page: Page, baseUrl: string) {
  await page.addInitScript(installBootObserver);
  await page.goto(`${baseUrl}/?qa=editor`, { waitUntil: "load" });
  await bounded(page.evaluate(() => Reflect.get(globalThis, "__qaBootReady")), "normal app startup");
  assert.equal(await page.getByTestId("library").isVisible(), true);
  assert.equal(await page.evaluate('"__qa" in globalThis'), false, "No QA view exists before creation");
  await page.getByTestId("new-course").click();
  await page.getByTestId("course-title").fill("  첫 코스  ");
  await arm(page, "normal-editor-ready");
  await page.getByTestId("create-course").click(); await signal(page);
  assert.equal(await page.getByTestId("editor-view").count(), 1, "Normal New Course must mount the actual editor view, not a placeholder canvas");
  assert.equal(await page.getByTestId("library").count(), 0);
  assert.equal(await page.getByTestId("course-title").inputValue(), "첫 코스");
  assert.equal(await page.title(), "첫 코스 | 코스 메이커");
  const current = await snapshot(page), area = current.course.areas[0]; assert(area);
  const goal = area.objects[0]; assert(goal);
  const expected = createNewCourse({ courseId: current.course.id, areaId: area.id, goalId: goal.id }); assert(expected.ok);
  assert.deepEqual(current.course, { ...expected.value, title: "첫 코스" }, "Form title plus the exact catalog seed, without a duplicate schema");
  assert(parseCourse(JSON.stringify(current.course)).ok);
  assert.equal(await page.getByTestId("game-canvas").count(), 0);
  const api = await page.evaluate(`({ frozen:Object.isFrozen(globalThis.__qa), keys:Object.keys(globalThis.__qa), setter:Object.getOwnPropertyDescriptor(globalThis,"__qa").set !== undefined })`);
  assert.deepEqual(api, { frozen: true, keys: ["getState", "getCourseSnapshot", "getProposals", "nextState"], setter: false });
  // Subscribe through the shipped bounded, one-shot observation API BEFORE the real action.
  await page.evaluate(`Object.defineProperty(globalThis,"__hostSignal",{configurable:true,value:globalThis.__qa.nextState(state=>state.reason==="home")})`);
  await action(page, "home", () => page.getByTestId("viewport-home").click());
  const observed: EditorViewState = await bounded(page.evaluate("globalThis.__hostSignal"), "QA one-shot home observation");
  assert.deepEqual(observed.viewport, (await snapshot(page)).state.viewport);
  await page.evaluate('Reflect.deleteProperty(globalThis,"__hostSignal")');
  return { url: page.url(), actions: ["navigate normal /?qa=editor (observation flag only)", "click new-course", "fill initial title", "click create-course", "assert validated catalog seed and entered title", "observe one-shot real Home action"], initial: current };
}

async function normalScenario(evidence: string, baseUrl: string, scenario: "editor-shell" | "editor-focus") {
  await mkdir(evidence, { recursive: true });
  const browser = await chromium.launch({ channel: "chrome", headless: true, timeout: 10_000 });
  const sessions: unknown[] = [], errors: string[] = [], cleanup: { dpr: number; closed: boolean }[] = [];
  let passed = false;
  try {
    for (const dpr of [1, 2]) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: dpr });
      const receipt = { dpr, closed: false }; cleanup.push(receipt);
      try {
        const page = await context.newPage(); page.setDefaultTimeout(10_000);
        page.on("pageerror", error => errors.push(error.message));
        page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
        page.on("requestfailed", request => errors.push(`${request.url()}: ${request.failure()?.errorText}`));
        const creation = await createNormalEditor(page, baseUrl);
        for (const size of [{ width: 1280, height: 720 }, { width: 1920, height: 1080 }]) {
          if (size.width !== page.viewportSize()?.width) {
            await action(page, "resize", () => page.setViewportSize(size));
            await action(page, "home", () => page.getByTestId("viewport-home").click());
          }
          const directory = `${evidence}/dpr-${dpr}/${size.width}`; await mkdir(directory, { recursive: true });
          const result = scenario === "editor-shell" ? await editorShell(page, directory, false) : await editorFocus(page, directory);
          sessions.push({ dpr, viewport: size, browser: browser.version(), creation, result });
        }
      } finally { await context.close(); receipt.closed = true; }
    }
    assert.deepEqual(errors, []); passed = true;
  } finally {
    await browser.close();
    await json(`${evidence}/actions.json`, { passed, scenario, baseUrl, sessions, errors });
    await json(`${evidence}/cleanup.json`, { contexts: cleanup, browserDisconnected: !browser.isConnected(), observationResourcesReleasedWithContexts: cleanup.every(item => item.closed) });
  }
}
// Central registry owner can import these without starting a private server or writing shared dist.
export const editorShellScenario = (evidence: string, baseUrl: string) => normalScenario(evidence, baseUrl, "editor-shell");
export const editorFocusScenario = (evidence: string, baseUrl: string) => normalScenario(evidence, baseUrl, "editor-focus");

async function privateProof(evidence: string) {
  await mkdir(evidence, { recursive: true });
  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>에디터 코어 · 비공개 검증</title><link rel="icon" href="data:,"><style>html,body{margin:0;height:100%;overflow:hidden}body{font:12px "Malgun Gothic",system-ui,sans-serif;background:#fffcf5}.private-bar{box-sizing:border-box;height:48px;display:flex;align-items:center;gap:16px;padding:0 16px;border-bottom:1px solid #d7dcd9}.private-bar label{display:flex;align-items:center;gap:12px}.private-bar input{font:inherit;min-height:44px;width:330px}.private-bar input::file-selector-button,.private-bar button{font:inherit;min-height:44px;padding:8px 12px;border:1px solid #b9c0bc;border-radius:4px;background:#f8f5ed}.private-bar button{margin-left:auto}#editor-root{height:calc(100% - 48px)}</style></head><body><div class="private-bar"><strong>PRIVATE · EDITOR CORE</strong><label>검증 파일<input data-testid="import-course" type="file" accept=".json"></label><output data-testid="private-import-status">보기 전용 · 문서 저장 안 함</output><button data-testid="private-close" type="button">뷰 닫기</button></div><div id="editor-root"></div><script type="module" src="/editor.js"></script></body></html>`;
  const seed = parseCourse(await Bun.file("tests/fixtures/new-course.smb1.json").bytes()); assert(seed.ok);
  const fixture = serializeCourse({ ...seed.value, title: "첫 모험 · 초록 들판", areas: seed.value.areas.map(area => ({ ...area,
    tiles: [...area.tiles, ...[7, 8, 9, 10, 18, 19, 20].map((x, index) => ({ x, y: 9, kind: index === 1 || index === 5 ? "question" : "brick", content: index === 1 || index === 5 ? "coin" : "none" })), ...[13, 14, 15].map(x => ({ x, y: 7, kind: "coin" }))],
    objects: [...area.objects,
      { id: "00000000-0000-4000-8000-000000000010", kind: "pipe", x: 256, y: 208, props: { height: 3, entrance: "down" } },
      { id: "00000000-0000-4000-8000-000000000011", kind: "goomba", x: 176, y: 208, props: {} },
      { id: "00000000-0000-4000-8000-000000000012", kind: "koopa", x: 368, y: 208, props: { color: "green" } },
      { id: "00000000-0000-4000-8000-000000000013", kind: "spring", x: 464, y: 208, props: {} },
    ],
  })) }); assert(fixture.ok);
  await Bun.write(`${evidence}/scene.smb1.json`, fixture.value);
  let server: ReturnType<typeof Bun.serve> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let passed = false, browserClosed = false, portFree = false;
  const errors: string[] = [], sessions: unknown[] = [];
  try {
    const build = await Bun.build({ entrypoints: ["scripts/qa/editor-host.ts"], target: "browser", format: "esm", minify: true });
    await json(`${evidence}/build.json`, { success: build.success, logs: build.logs, entry: "scripts/qa/editor-host.ts" });
    assert(build.success, "Private actual-view bundle build failed"); const output = build.outputs[0]; assert(output);
    const javascript = await output.text(); await Bun.write(`${evidence}/editor.js`, javascript); await Bun.write(`${evidence}/index.html`, html);
    server = Bun.serve({ hostname: "127.0.0.1", port: PRIVATE_PORT, fetch(request) {
      switch (new URL(request.url).pathname) {
        case "/": return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
        case "/editor.js": return new Response(javascript, { headers: { "content-type": "text/javascript; charset=utf-8" } });
        case "/fixture.json": return new Response(Bun.file("tests/fixtures/new-course.smb1.json"), { headers: { "content-type": "application/json" } });
        default: return new Response("Not found", { status: 404 });
      }
    } });
    browser = await chromium.launch({ channel: "chrome", headless: true, timeout: 10_000 });
    for (const dpr of [1, 2]) {
      const directory = `${evidence}/dpr-${dpr}`; await mkdir(directory, { recursive: true });
      const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: dpr });
      try {
        const page = await context.newPage(); page.setDefaultTimeout(10_000);
        page.on("pageerror", error => errors.push(error.message)); page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
        page.on("requestfailed", request => errors.push(`${request.url()}: ${request.failure()?.errorText}`));
        await page.addInitScript(() => {
          Object.defineProperty(globalThis, "__editorReady", { value: new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("Private editor did not mount")), 10_000);
            document.addEventListener("private-editor-ready", () => { clearTimeout(timer); resolve(); }, { once: true });
          }) });
        });
        const url = `http://127.0.0.1:${PRIVATE_PORT}/?qa=editor-private`;
        await page.goto(url, { waitUntil: "load" }); await bounded(page.evaluate("globalThis.__editorReady"), "actual private editor mount");
        await arm(page, "private-editor-import", { ok: true });
        await page.getByTestId("import-course").setInputFiles(resolve(`${evidence}/scene.smb1.json`)); await signal(page);
        const loaded = parseCourse(fixture.value); assert(loaded.ok); assert.deepEqual((await snapshot(page)).course, loaded.value);
        const shell = await editorShell(page, directory), focus = await editorFocus(page, directory);
        // Dispose/re-mount through visible host controls; observe detached root for stale listeners.
        await page.evaluate(() => {
          const element = document.querySelector('[data-testid="editor-view"]'); if (!element) throw new Error("Missing editor before disposal");
          let count = 0; element.addEventListener("editor-view-state", () => count++);
          Object.defineProperty(globalThis, "__detachedEventCount", { configurable: true, get: () => count });
        });
        await arm(page, "private-editor-mount", { mounted: false }); await page.getByTestId("private-close").click(); await signal(page);
        const disposedCount: number = await page.evaluate("globalThis.__detachedEventCount");
        // Move focus off the native close/reopen button: Space would correctly activate that button.
        await page.mouse.click(640, 400);
        await page.keyboard.press("Space"); await page.keyboard.press("4");
        await arm(page, "private-editor-mount", { mounted: true }); await page.getByTestId("private-close").click(); await signal(page);
        await page.getByTestId("editor-canvas").focus(); await action(page, "key-pan", () => page.keyboard.press("ArrowRight"));
        assert.equal(await page.evaluate("globalThis.__detachedEventCount"), disposedCount, "Disposed view must receive no new state events");
        assert.deepEqual((await snapshot(page)).course, loaded.value);
        sessions.push({ dpr, url, browser: browser.version(), shell, focus: { actions: focus.actions, capture: focus.capture }, dispose: { detachedEventsAfterClose: disposedCount, detachedEventsAfterRemount: await page.evaluate("globalThis.__detachedEventCount") } });
      } finally { await context.close(); }
    }
    assert.deepEqual(errors, [], "Unexpected browser errors"); passed = true;
  } catch (error) {
    await json(`${evidence}/failure.json`, { message: String(error), stack: error instanceof Error ? error.stack : null }); throw error;
  } finally {
    try { if (browser) { await browser.close(); browserClosed = true; } }
    finally {
      if (server) await server.stop(true);
      const probe = Bun.serve({ hostname: "127.0.0.1", port: PRIVATE_PORT, fetch: () => new Response(null) }); await probe.stop(true); portFree = true;
      await Promise.all([
        json(`${evidence}/manifest.json`, { passed, scope: "editor viewport CORE only; no normal-app or central QA registration", port: PRIVATE_PORT, errors, sessions, scene: { file: resolve(`${evidence}/scene.smb1.json`), sha256: sha(await Bun.file(`${evidence}/scene.smb1.json`).bytes()) }, imageAdjudication: "PNG evidence only; parent local vision review required" }),
        json(`${evidence}/cleanup.json`, { browserClosed, contextsClosed: true, ownedServerStopped: server !== undefined, port: PRIVATE_PORT, portFree, normalPort4173Untouched: true }),
      ]);
    }
  }
  console.log(`PASS private editor shell/focus DPR 1/2 -> ${evidence}`);
}
if (import.meta.main) await privateProof(Bun.argv[2] ?? ".omo/evidence/smb1-level-maker/task-10/core/browser");
