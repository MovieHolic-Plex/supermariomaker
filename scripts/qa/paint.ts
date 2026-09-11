import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, type Page } from "playwright-core";
import type { EditorViewState } from "../../src/ui/editor";
import type { CourseV1, TileCell } from "../../src/level/types";
import { CATALOG_CATEGORIES, OBJECT_CATALOG, SPAWNED_CATALOG, TILE_CATALOG } from "../../src/level/catalog";
import { serializeCourse } from "../../src/level/serialize";
import { createNormalEditor } from "./editor";
import { bounded, closeOwnedBrowser, json } from "./support";

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
async function clickTestId(page: Page, id: string, reason: string) {
  await action(page, reason, () => page.getByTestId(id).evaluate(element => {
    if (!(element instanceof HTMLElement)) throw new Error("Missing "+element);
    element.scrollIntoView({ block: "nearest" });
    element.click();
  }));
}
async function box(page: Page) {
  const bounds = await page.getByTestId("editor-canvas").boundingBox(); assert(bounds);
  return { ...bounds, left: bounds.x, top: bounds.y };
}
async function cellPoint(page: Page, x: number, y: number) {
  const bounds = await box(page), state = (await snapshot(page)).state;
  return { x: bounds.x + (x * 16 + 8 - state.viewport.x) * state.viewport.zoom, y: bounds.y + (y * 16 + 8 - state.viewport.y) * state.viewport.zoom };
}
function areaTiles(course: CourseV1): readonly TileCell[] {
  const area = course.areas.find(item => item.id === course.mainAreaId); assert(area);
  return area.tiles;
}
function tileAt(course: CourseV1, x: number, y: number) {
  return areaTiles(course).find(tile => tile.x === x && tile.y === y);
}
async function cellPixel(page: Page, x: number, y: number) {
  return page.evaluate(({ x, y }) => {
    const canvas = document.querySelector('[data-testid="editor-canvas"]');
    if (!(canvas instanceof HTMLCanvasElement)) throw new Error("Editor canvas missing");
    const qa = Reflect.get(globalThis, "__qa") as { getState(): EditorViewState };
    const state = qa.getState();
    const sx = Math.floor((x * 16 + 8 - state.viewport.x) * state.viewport.zoom * state.dpr);
    const sy = Math.floor((y * 16 + 8 - state.viewport.y) * state.viewport.zoom * state.dpr);
    const pixel = canvas.getContext("2d")?.getImageData(sx, sy, 1, 1).data;
    if (!pixel) throw new Error("Missing cell pixel");
    return [pixel[0], pixel[1], pixel[2], pixel[3]];
  }, { x, y });
}
async function capture(page: Page, path: string) {
  const png = await page.screenshot({ path, fullPage: false, animations: "disabled" });
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  return { file: resolve(path), sha256: sha(png), bytes: png.byteLength };
}
async function writeSnapshot(course: CourseV1, path: string) {
  const serialized = serializeCourse(course); assert(serialized.ok);
  await Bun.write(path, serialized.value);
  return { file: resolve(path), sha256: sha(new TextEncoder().encode(serialized.value)), bytes: serialized.value.length };
}

async function withEditor(evidence: string, origin: string, run: (page: Page) => Promise<unknown>) {
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
      const creation = await createNormalEditor(page, origin);
      actions.push(creation);
      await run(page);
    } finally { await context.close(); }
    assert.deepEqual(errors, []); passed = true;
  } finally {
    await closeOwnedBrowser(browser); browserClosed = true;
    await json(`${evidence}/actions.json`, { passed, origin, errors, actions, browser: browser.version() });
    await json(`${evidence}/cleanup.json`, { browserClosed, browserDisconnected: !browser.isConnected(), contextsClosed: true });
  }
}

async function paintStroke(page: Page, cells: readonly { x: number; y: number }[]) {
  const origin = cells[0]; assert(origin);
  const start = await cellPoint(page, origin.x, origin.y);
  await action(page, "pointer", () => page.mouse.move(start.x, start.y));
  await action(page, "paint-start", () => page.mouse.down());
  for (const cell of cells.slice(1)) {
    const point = await cellPoint(page, cell.x, cell.y);
    await action(page, "paint-extend", () => page.mouse.move(point.x, point.y));
  }
}

export async function paintHistory(evidence: string, origin: string) {
  const captures: unknown[] = [];
  await withEditor(evidence, origin, async page => {
    const before = await snapshot(page);
    assert.equal(await page.getByTestId("tool-paint").isEnabled(), true);
    assert.equal(await page.getByTestId("undo").isDisabled(), true);
    await action(page, "tool", () => page.getByTestId("tool-paint").click());
    await action(page, "palette", () => page.getByTestId("palette-brick").click());
    const stroke = Array.from({ length: 10 }, (_, i) => ({ x: 10 + i, y: 5 }));
    const emptyPixel = await cellPixel(page, 10, 5);
    await paintStroke(page, stroke);
    await action(page, "paint-commit", () => page.mouse.up());
    const painted = await snapshot(page);
    for (const cell of stroke) assert.deepEqual(tileAt(painted.course, cell.x, cell.y), { x: cell.x, y: cell.y, kind: "brick", content: "none" });
    assert.equal(painted.state.undoCount, 1); assert.equal(painted.state.redoCount, 0); assert.equal(painted.state.dirty, true);
    assert.equal(painted.state.lastOutcome, "committed");
    const paintedPixel = await cellPixel(page, 10, 5);
    assert.notDeepEqual(paintedPixel, emptyPixel);
    captures.push({ step: "painted-stroke", pixel: paintedPixel, ...(await capture(page, `${evidence}/paint-stroke.png`)) });
    await action(page, "undo", () => page.getByTestId("undo").click());
    const undone = await snapshot(page);
    for (const cell of stroke) assert.equal(tileAt(undone.course, cell.x, cell.y), undefined);
    assert.deepEqual(undone.course, before.course);
    assert.equal(undone.state.undoCount, 0); assert.equal(undone.state.redoCount, 1); assert.equal(undone.state.dirty, false);
    assert.deepEqual(await cellPixel(page, 10, 5), emptyPixel);
    captures.push({ step: "undo-clears-stroke", pixel: await cellPixel(page, 10, 5), ...(await capture(page, `${evidence}/paint-undo.png`)) });
    await action(page, "redo", () => page.getByTestId("redo").click());
    const redone = await snapshot(page);
    for (const cell of stroke) assert.deepEqual(tileAt(redone.course, cell.x, cell.y), { x: cell.x, y: cell.y, kind: "brick", content: "none" });
    assert.equal(redone.state.undoCount, 1); assert.equal(redone.state.redoCount, 0);
    assert.deepEqual(await cellPixel(page, 10, 5), paintedPixel);
    captures.push({ step: "redo-restores-stroke", pixel: await cellPixel(page, 10, 5), ...(await capture(page, `${evidence}/paint-redo.png`)) });
    await action(page, "tool", () => page.getByTestId("tool-fill").click());
    await action(page, "palette", () => page.getByTestId("palette-hard").click());
    const fillOrigin = await cellPoint(page, 10, 6), fillCorner = await cellPoint(page, 12, 8);
    await action(page, "pointer", () => page.mouse.move(fillOrigin.x, fillOrigin.y));
    await action(page, "paint-start", () => page.mouse.down());
    await action(page, "paint-extend", () => page.mouse.move(fillCorner.x, fillCorner.y));
    const preview = await snapshot(page);
    assert.equal(preview.state.preview?.cells, 9); assert.equal(preview.state.preview?.outOfBounds, false);
    const previewPixel = await cellPixel(page, 11, 7);
    assert.notDeepEqual(previewPixel, emptyPixel);
    captures.push({ step: "fill-preview", pixel: previewPixel, preview: preview.state.preview, ...(await capture(page, `${evidence}/fill-preview.png`)) });
    await action(page, "paint-commit", () => page.mouse.up());
    const filled = await snapshot(page);
    for (let x = 10; x <= 12; x++) for (let y = 6; y <= 8; y++) assert.deepEqual(tileAt(filled.course, x, y), { x, y, kind: "hard" });
    assert.equal(filled.state.undoCount, 2);
    captures.push({ step: "fill-committed", ...(await capture(page, `${evidence}/fill-commit.png`)) });
    await action(page, "tool", () => page.getByTestId("tool-erase").click());
    await paintStroke(page, [{ x: 10, y: 6 }, { x: 11, y: 6 }]);
    await action(page, "paint-commit", () => page.mouse.up());
    const erased = await snapshot(page);
    assert.equal(tileAt(erased.course, 10, 6), undefined);
    assert.equal(tileAt(erased.course, 11, 6), undefined);
    assert.deepEqual(tileAt(erased.course, 12, 6), { x: 12, y: 6, kind: "hard" });
    assert.equal(erased.state.undoCount, 3);
    captures.push({ step: "erase-stroke", ...(await capture(page, `${evidence}/erase.png`)) });
    const file = await writeSnapshot(erased.course, `${evidence}/current.smb1.json`);
    await json(`${evidence}/result.json`, { captures, snapshot: file, undoCount: erased.state.undoCount, dirty: erased.state.dirty });
  });
}

export async function paintHistoryEdge(evidence: string, origin: string) {
  const captures: unknown[] = [];
  await withEditor(evidence, origin, async page => {
    await action(page, "tool", () => page.getByTestId("tool-paint").click());
    await action(page, "palette", () => page.getByTestId("palette-brick").click());
    await paintStroke(page, [{ x: 8, y: 4 }, { x: 9, y: 4 }]);
    await action(page, "paint-commit", () => page.mouse.up());
    await page.getByTestId("editor-canvas").focus();
    await action(page, "undo", () => page.keyboard.press("Control+Z"));
    const undone = await snapshot(page);
    assert.equal(tileAt(undone.course, 8, 4), undefined);
    assert.equal(undone.state.redoCount, 1);
    const beforeCancel = undone.course;
    const start = await cellPoint(page, 8, 3), next = await cellPoint(page, 10, 3);
    await action(page, "pointer", () => page.mouse.move(start.x, start.y));
    await action(page, "paint-start", () => page.mouse.down());
    await action(page, "paint-extend", () => page.mouse.move(next.x, next.y));
    await action(page, "paint-cancel", () => page.keyboard.press("Escape"));
    await page.mouse.up();
    const cancelled = await snapshot(page);
    assert.deepEqual(cancelled.course, beforeCancel);
    assert.equal(cancelled.state.redoCount, 1);
    assert.equal(cancelled.state.lastOutcome, "cancelled");
    assert.equal(cancelled.state.undoCount, 0);
    captures.push({ step: "escape-cancels-drag", ...(await capture(page, `${evidence}/cancel.png`)) });
    await action(page, "palette", () => page.getByTestId("palette-ground").click());
    const ground = await cellPoint(page, 2, 13);
    await action(page, "pointer", () => page.mouse.move(ground.x, ground.y));
    await action(page, "paint-start", () => page.mouse.down());
    await action(page, "paint-commit", () => page.mouse.up());
    const noop = await snapshot(page);
    assert.equal(noop.state.lastOutcome, "noop");
    assert.equal(noop.state.redoCount, 1);
    assert.equal(noop.state.undoCount, 0);
    assert.deepEqual(noop.course, beforeCancel);
    await action(page, "tool", () => page.getByTestId("tool-fill").click());
    await action(page, "palette", () => page.getByTestId("palette-hard").click());
    const originCell = await cellPoint(page, 10, 12), outside = await cellPoint(page, 12, 20);
    await action(page, "pointer", () => page.mouse.move(originCell.x, originCell.y));
    await action(page, "paint-start", () => page.mouse.down());
    await action(page, "paint-extend", () => page.mouse.move(outside.x, outside.y));
    const preview = await snapshot(page);
    assert.equal(preview.state.preview?.clipped, true);
    assert.equal(preview.state.preview?.outOfBounds, true);
    assert((preview.state.preview?.cells ?? 0) > 0);
    captures.push({ step: "fill-oob-preview", preview: preview.state.preview, ...(await capture(page, `${evidence}/fill-oob-preview.png`)) });
    await action(page, "paint-commit", () => page.mouse.up());
    const rejected = await snapshot(page);
    assert.equal(rejected.state.lastOutcome, "rejected");
    assert.deepEqual(rejected.course, beforeCancel);
    assert.equal(rejected.state.redoCount, 1);
    await action(page, "redo", () => page.keyboard.press("Control+Y"));
    const restored = await snapshot(page);
    assert.deepEqual(tileAt(restored.course, 8, 4), { x: 8, y: 4, kind: "brick", content: "none" });
    captures.push({ step: "redo-survived-cancel-noop-reject", ...(await capture(page, `${evidence}/redo-retained.png`)) });
    await writeSnapshot(restored.course, `${evidence}/current.smb1.json`);
    await json(`${evidence}/result.json`, { captures, redoRetained: true });
  });
}

export async function catalogScenario(evidence: string, origin: string) {
  const seen: unknown[] = [];
  await withEditor(evidence, origin, async page => {
    await action(page, "tool", () => page.getByTestId("tool-paint").click());
    let tileIndex = 0;
    for (const [category] of Object.entries(CATALOG_CATEGORIES)) {
      await clickTestId(page, `category-${category}`, "category");
      const kinds = [
        ...Object.entries(TILE_CATALOG).filter(([, entry]) => entry.category === category).map(([kind]) => kind),
        ...Object.entries(OBJECT_CATALOG).filter(([, entry]) => entry.category === category).map(([kind]) => kind),
        ...Object.entries(SPAWNED_CATALOG).filter(([, entry]) => entry.category === category).map(([kind]) => kind),
      ];
      for (const kind of kinds) {
        await clickTestId(page, `palette-${kind}`, "palette");
        assert.equal(await page.getByTestId("preview-kind").getAttribute("data-kind"), kind);
        const entry = kind in TILE_CATALOG ? TILE_CATALOG[kind as keyof typeof TILE_CATALOG]
          : kind in OBJECT_CATALOG ? OBJECT_CATALOG[kind as keyof typeof OBJECT_CATALOG]
          : SPAWNED_CATALOG[kind as keyof typeof SPAWNED_CATALOG];
        if (kind in TILE_CATALOG) {
          const cell = { x: 6 + tileIndex, y: 4 };
          await paintStroke(page, [cell]);
          await action(page, "paint-commit", () => page.mouse.up());
          const painted = tileAt((await snapshot(page)).course, cell.x, cell.y);
          assert(painted); assert.equal(painted.kind, kind);
          tileIndex += 1;
          seen.push({ kind, category, placeable: entry.placeable, cell, serializedKind: painted.kind });
        } else {
          seen.push({ kind, category, placeable: entry.placeable, preview: kind });
        }
      }
    }
    assert.equal(seen.length, Object.keys(TILE_CATALOG).length + Object.keys(OBJECT_CATALOG).length + Object.keys(SPAWNED_CATALOG).length);
    const current = await snapshot(page);
    const file = await writeSnapshot(current.course, `${evidence}/current.smb1.json`);
    await capture(page, `${evidence}/catalog.png`);
    await json(`${evidence}/result.json`, { kinds: seen, snapshot: file, tileKindsPainted: tileIndex });
  });
}

export async function catalogInvalid(evidence: string, origin: string) {
  await withEditor(evidence, origin, async page => {
    const before = await snapshot(page);
    await clickTestId(page, "category-devices", "category");
    await clickTestId(page, "palette-platform", "palette");
    assert.equal(await page.getByTestId("preview-kind").getAttribute("data-kind"), "platform");
    assert.equal(await page.getByTestId("property-length").inputValue(), "3");
    await page.getByTestId("property-length").fill("0");
    assert.equal(await page.getByTestId("property-error").textContent(), "invalid_value:$.areas[0].objects[1].props.length");
    const afterDraft = await snapshot(page);
    assert.deepEqual(afterDraft.course, before.course);
    await clickTestId(page, "category-projectiles", "category");
    await clickTestId(page, "palette-fireball", "palette");
    await action(page, "tool", () => page.getByTestId("tool-paint").click());
    const point = await cellPoint(page, 15, 5);
    await action(page, "pointer", () => page.mouse.move(point.x, point.y));
    await action(page, "point", () => page.mouse.click(point.x, point.y));
    const afterSpawned = await snapshot(page);
    assert.deepEqual(afterSpawned.course, before.course);
    assert.equal(tileAt(afterSpawned.course, 15, 5), undefined);
    await capture(page, `${evidence}/catalog-invalid.png`);
    const file = await writeSnapshot(afterSpawned.course, `${evidence}/current.smb1.json`);
    await json(`${evidence}/result.json`, { propertyError: "invalid_value:$.areas[0].objects[1].props.length", documentUnchanged: true, snapshot: file });
  });
}
