import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, type Locator, type Page } from "playwright-core";
import type { EditorViewState } from "../../src/ui/editor";
import type { CourseV1, PlacedObject } from "../../src/level/types";
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
async function box(page: Page) {
  const bounds = await page.getByTestId("editor-canvas").boundingBox(); assert(bounds);
  return { ...bounds, left: bounds.x, top: bounds.y };
}
async function worldPoint(page: Page, x: number, y: number) {
  const bounds = await box(page), state = (await snapshot(page)).state;
  return { x: bounds.x + (x - state.viewport.x) * state.viewport.zoom, y: bounds.y + (y - state.viewport.y) * state.viewport.zoom };
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
function areaOf(course: CourseV1) {
  const area = course.areas.find(item => item.id === course.mainAreaId); assert(area); return area;
}
function pipesOf(course: CourseV1): readonly PlacedObject[] {
  return areaOf(course).objects.filter(object => object.kind === "pipe");
}
function objectsByKind(course: CourseV1, kind: PlacedObject["kind"]): readonly PlacedObject[] {
  return areaOf(course).objects.filter(object => object.kind === kind);
}

async function assertFullyInViewport(page: Page, locator: Locator, name: string) {
  const bounds = await locator.boundingBox();
  assert(bounds, `${name} has no bounding box`);
  const viewport = page.viewportSize();
  assert(viewport, `${name} missing viewport`);
  assert(bounds.width > 0 && bounds.height > 0, `${name} empty box`);
  assert(
    bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width && bounds.y + bounds.height <= viewport.height,
    `${name} not fully in viewport: ${JSON.stringify(bounds)} vs ${JSON.stringify(viewport)}`,
  );
  return bounds;
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

async function placeLinkedPipes(page: Page) {
  await action(page, "command", () => page.getByTestId("place-pipe").click());
  await action(page, "command", () => page.getByTestId("place-pipe").click());
  const withPipes = await snapshot(page);
  const pipes = pipesOf(withPipes.course);
  assert.equal(pipes.length, 2);
  const first = pipes[0], second = pipes[1];
  assert(first && second);
  await page.getByTestId("pipe-link-a").selectOption(`${withPipes.course.mainAreaId}:${first.id}`);
  await page.getByTestId("pipe-link-b").selectOption(`${withPipes.course.mainAreaId}:${second.id}`);
  await action(page, "command", () => page.getByTestId("pipe-link-apply").click());
  const linked = await snapshot(page);
  const linkedPipes = pipesOf(linked.course);
  assert(linkedPipes.every(pipe => pipe.kind === "pipe" && pipe.props.destination));
  return linked;
}

export async function selection(evidence: string, origin: string) {
  const captures: unknown[] = [];
  await withEditor(evidence, origin, async page => {
    assert.equal(await page.getByTestId("tool-select").isEnabled(), true);
    assert.equal(await page.getByTestId("export-course").isEnabled(), true);
    assert.equal(await page.getByTestId("play-start").isEnabled(), true);
    const linked = await placeLinkedPipes(page);
    const originals = pipesOf(linked.course);
    const a = originals[0], b = originals[1];
    assert(a && b && a.kind === "pipe" && b.kind === "pipe");
    await action(page, "tool", () => page.getByTestId("tool-select").click());
    const start = await worldPoint(page, Math.min(a.x, b.x) - 24, Math.min(a.y, b.y) - 48);
    const end = await worldPoint(page, Math.max(a.x, b.x) + 24, Math.max(a.y, b.y) + 8);
    await action(page, "pointer", () => page.mouse.move(start.x, start.y));
    await action(page, "marquee-start", () => page.mouse.down());
    await action(page, "marquee-extend", () => page.mouse.move(end.x, end.y));
    const marquee = await snapshot(page);
    assert.equal(marquee.state.tool, "select");
    captures.push({ step: "marquee-over-pipes", selection: marquee.state.selection, ...(await capture(page, `${evidence}/marquee.png`)) });
    await action(page, "marquee-commit", () => page.mouse.up());
    const selected = await snapshot(page);
    assert.deepEqual([...selected.state.selection.objectIds].sort(), [a.id, b.id].sort());
    await page.getByTestId("editor-canvas").focus();
    await action(page, "copy", () => page.keyboard.press("Control+C"));
    const pasteAt = await worldPoint(page, 264, 208);
    await action(page, "pointer", () => page.mouse.move(pasteAt.x, pasteAt.y));
    await action(page, "paste", () => page.keyboard.press("Control+V"));
    const pasted = await snapshot(page);
    const afterPipes = pipesOf(pasted.course);
    assert.equal(afterPipes.length, 4);
    const copies = afterPipes.filter(pipe => pipe.id !== a.id && pipe.id !== b.id);
    assert.equal(copies.length, 2);
    const copyA = copies.find(pipe => pipe.kind === "pipe" && pipe.x === copies.reduce((min, item) => Math.min(min, item.x), Infinity));
    const copyB = copies.find(pipe => pipe !== copyA);
    assert(copyA && copyB && copyA.kind === "pipe" && copyB.kind === "pipe");
    assert.notEqual(copyA.id, a.id); assert.notEqual(copyB.id, b.id);
    assert.equal(objectById(pasted.course, a.id)?.x, a.x);
    assert.equal(objectById(pasted.course, b.id)?.x, b.x);
    assert(copyA.props.destination?.pipeId === copyB.id || copyB.props.destination?.pipeId === copyA.id);
    assert.equal(objectById(pasted.course, a.id)?.kind === "pipe" ? objectById(pasted.course, a.id) && a.kind === "pipe" && (objectById(pasted.course, a.id) as typeof a).props.destination?.pipeId : null, a.props.destination?.pipeId);
    captures.push({ step: "paste-new-ids", pastedIds: copies.map(item => item.id), ...(await capture(page, `${evidence}/paste.png`)) });
    const handle = await worldPoint(page, a.x, a.y - 16);
    await action(page, "pointer", () => page.mouse.move(handle.x, handle.y));
    await action(page, "move-start", () => page.mouse.down());
    const movedTo = await worldPoint(page, a.x + 32, a.y - 16);
    await action(page, "move-extend", () => page.mouse.move(movedTo.x, movedTo.y));
    await action(page, "move-commit", () => page.mouse.up());
    const moved = await snapshot(page);
    assert.equal(objectById(moved.course, a.id)?.x, a.x + 32);
    assert.equal(objectById(moved.course, b.id)?.x, b.x + 32);
    captures.push({ step: "drag-move", from: { a: a.x, b: b.x }, to: { a: objectById(moved.course, a.id)?.x, b: objectById(moved.course, b.id)?.x }, ...(await capture(page, `${evidence}/move.png`)) });
    await action(page, "undo", () => page.keyboard.press("Control+Z"));
    const undoneMove = await snapshot(page);
    assert.equal(objectById(undoneMove.course, a.id)?.x, a.x);
    await page.getByTestId("course-timer").fill("0");
    await action(page, "command", () => page.getByTestId("course-timer").press("Enter"));
    assert.equal((await snapshot(page)).course.timerSeconds, 0);
    assert.equal((await snapshot(page)).state.undoCount, (await snapshot(page)).state.undoCount);
    const afterZero = await snapshot(page);
    assert.equal(afterZero.course.timerSeconds, 0);
    const undoAfterZero = afterZero.state.undoCount;
    await page.getByTestId("course-timer").fill("30");
    await action(page, "command", () => page.getByTestId("course-timer").press("Enter"));
    assert.equal((await snapshot(page)).course.timerSeconds, 30);
    assert.equal((await snapshot(page)).state.undoCount, undoAfterZero + 1);
    await page.getByTestId("course-timer").fill("999");
    await action(page, "command", () => page.getByTestId("course-timer").press("Enter"));
    const timed = await snapshot(page);
    assert.equal(timed.course.timerSeconds, 999);
    await page.getByTestId("course-title").fill("선택 코스");
    await action(page, "command", () => page.getByTestId("course-title").press("Enter"));
    assert.equal((await snapshot(page)).course.title, "선택 코스");
    await action(page, "place-mode", () => page.getByTestId("place-start").click());
    const startAt = await worldPoint(page, 104, 200);
    await action(page, "pointer", () => page.mouse.move(startAt.x, startAt.y));
    await action(page, "command", () => page.mouse.click(startAt.x, startAt.y));
    const started = await snapshot(page);
    assert.equal(started.course.start.x, 104);
    assert.equal(started.course.start.y, 208);
    await action(page, "place-mode", () => page.getByTestId("place-flag").click());
    const flagAt = await worldPoint(page, 240, 200);
    await action(page, "pointer", () => page.mouse.move(flagAt.x, flagAt.y));
    await action(page, "command", () => page.mouse.click(flagAt.x, flagAt.y));
    const withFlag = await snapshot(page);
    const flags = objectsByKind(withFlag.course, "flagGoal");
    assert(flags.some(flag => flag.x === 240 && flag.y === 208));
    captures.push({ step: "start-goal-placed", start: withFlag.course.start, flags: flags.map(flag => ({ id: flag.id, x: flag.x, y: flag.y })), ...(await capture(page, `${evidence}/start-goal.png`)) });
    const file = await writeSnapshot(withFlag.course, `${evidence}/current.smb1.json`);
    await json(`${evidence}/result.json`, { captures, snapshot: file, originals: [a.id, b.id], copies: copies.map(item => item.id), timer: withFlag.course.timerSeconds });
  });
}

function objectById(course: CourseV1, id: string): PlacedObject | undefined {
  for (const area of course.areas) {
    const found = area.objects.find(item => item.id === id);
    if (found) return found;
  }
  return undefined;
}

export async function selectionEdge(evidence: string, origin: string) {
  const captures: unknown[] = [];
  await withEditor(evidence, origin, async page => {
    const before = await snapshot(page);
    await page.getByTestId("course-timer").fill("29");
    assert.equal(await page.getByTestId("course-timer").inputValue(), "29");
    const error = page.getByTestId("course-timer-error");
    assert.equal(await error.isVisible(), true);
    assert.match(await error.textContent() ?? "", /invalid_value:\$\.timerSeconds/);
    assert.equal(await page.getByTestId("course-timer").getAttribute("aria-invalid"), "true");
    assert.equal(await page.getByTestId("course-timer").evaluate(node => node.classList.contains("editor-field-invalid")), true);
    const timerBox = await assertFullyInViewport(page, page.getByTestId("course-timer"), "course-timer");
    const errorBox = await assertFullyInViewport(page, error, "course-timer-error");
    assert(errorBox.y + 0.5 >= timerBox.y, "timer error must sit with the field");
    const previewed = await snapshot(page);
    assert.equal(previewed.course.timerSeconds, before.course.timerSeconds);
    assert.equal(previewed.state.undoCount, before.state.undoCount);
    captures.push({
      step: "timer-29-preview-no-write",
      timer: previewed.course.timerSeconds,
      errorInViewport: true,
      timerBox,
      errorBox,
      ...(await capture(page, `${evidence}/timer-invalid.png`)),
    });
    await action(page, "tool", () => page.getByTestId("tool-paint").click());
    await action(page, "category", () => page.getByTestId("category-enemies").click());
    await action(page, "palette", () => page.getByTestId("palette-goomba").click());
    const spawn = await worldPoint(page, 16, 208);
    await action(page, "pointer", () => page.mouse.move(spawn.x, spawn.y));
    await action(page, "command", () => page.mouse.click(spawn.x, spawn.y));
    const withGoomba = await snapshot(page);
    const goomba = objectsByKind(withGoomba.course, "goomba")[0];
    assert(goomba);
    assert.equal(goomba.x, 16);
    await action(page, "tool", () => page.getByTestId("tool-select").click());
    const clickGoomba = await worldPoint(page, goomba.x, goomba.y - 8);
    await action(page, "pointer", () => page.mouse.move(clickGoomba.x, clickGoomba.y));
    await action(page, "marquee-start", () => page.mouse.down());
    await action(page, "marquee-commit", () => page.mouse.up());
    assert.deepEqual((await snapshot(page)).state.selection.objectIds, [goomba.id]);
    await page.getByTestId("editor-canvas").focus();
    await action(page, "copy", () => page.keyboard.press("Control+C"));
    const oob = await worldPoint(page, -16, 208);
    await action(page, "pointer", () => page.mouse.move(oob.x, oob.y));
    const generation = (await snapshot(page)).state.undoCount;
    const beforePaste = (await snapshot(page)).course;
    await action(page, "paste", () => page.keyboard.press("Control+V"));
    const rejected = await snapshot(page);
    assert.equal(rejected.state.lastOutcome, "rejected");
    assert.equal(rejected.state.undoCount, generation);
    assert.equal(objectsByKind(rejected.course, "goomba").length, 1);
    assert.deepEqual(objectById(rejected.course, goomba.id), goomba);
    captures.push({ step: "paste-oob-rejected", undoCount: rejected.state.undoCount, ...(await capture(page, `${evidence}/paste-oob.png`)) });
    const linked = await placeLinkedPipes(page);
    const pair = pipesOf(linked.course);
    const left = pair[0]; assert(left && left.kind === "pipe");
    const originPipes = pair.map(item => item.id);
    await action(page, "tool", () => page.getByTestId("tool-select").click());
    const one = await worldPoint(page, left.x, left.y - 16);
    await action(page, "pointer", () => page.mouse.move(one.x, one.y));
    await action(page, "marquee-start", () => page.mouse.down());
    await action(page, "marquee-commit", () => page.mouse.up());
    await page.getByTestId("editor-canvas").focus();
    await action(page, "copy", () => page.keyboard.press("Control+C"));
    const safe = await worldPoint(page, 320, 208);
    await action(page, "pointer", () => page.mouse.move(safe.x, safe.y));
    await action(page, "paste", () => page.keyboard.press("Control+V"));
    const partial = await snapshot(page);
    const extra = pipesOf(partial.course).filter(pipe => !originPipes.includes(pipe.id));
    assert.equal(extra.length, 1);
    const copy = extra[0];
    assert(copy && copy.kind === "pipe");
    assert.equal(copy.props.destination, undefined);
    const still = objectById(partial.course, left.id);
    assert(still && still.kind === "pipe" && still.props.destination);
    await page.getByTestId("editor-canvas").focus();
    await action(page, "delete", () => page.keyboard.press("Delete"));
    const afterDelete = await snapshot(page);
    assert.equal(afterDelete.state.selection.objectIds.length, 0);
    await action(page, "place-mode", () => page.getByTestId("place-castle").click());
    const castleAt = await worldPoint(page, 192, 192);
    await action(page, "pointer", () => page.mouse.move(castleAt.x, castleAt.y));
    await action(page, "command", () => page.mouse.click(castleAt.x, castleAt.y));
    const withCastle = await snapshot(page);
    const castles = objectsByKind(withCastle.course, "castleGoal");
    assert(castles.some(item => item.x === 192));
    captures.push({ step: "external-link-cleared-and-castle", copyId: copy.id, ...(await capture(page, `${evidence}/external-link.png`)) });
    assert.notEqual(beforePaste, withCastle.course);
    await writeSnapshot(withCastle.course, `${evidence}/current.smb1.json`);
    await json(`${evidence}/result.json`, { captures, timerUnchangedAt29: true, oobRejected: true });
  });
}
