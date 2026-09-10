import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, type Page } from "playwright-core";
import type { EditorViewState } from "../../src/ui/editor";
import { COURSE_LIMITS, type CourseV1 } from "../../src/level/types";
import { authoredContentEqual, parseCourse, serializeCourse } from "../../src/level/serialize";
import { bounded, installBootObserver, json } from "./support";

const sha = (bytes: Uint8Array) => Bun.CryptoHasher.hash("sha256", bytes, "hex");
interface Snapshot { readonly state: EditorViewState; readonly course: CourseV1 }
async function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(`({state:globalThis.__qa.getState(),course:globalThis.__qa.getCourseSnapshot()})`);
}
async function capture(page: Page, path: string) {
  const png = await page.screenshot({ path, fullPage: false, animations: "disabled" });
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  return { file: resolve(path), sha256: sha(png), bytes: png.byteLength };
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

async function openEditor(page: Page, origin: string, title = "파일 교환") {
  await page.addInitScript(installBootObserver);
  await page.goto(`${origin}/?qa=editor`, { waitUntil: "load" });
  await bounded(page.evaluate(() => Reflect.get(globalThis, "__qaBootReady")), "boot");
  await page.getByTestId("new-course").click();
  await page.getByTestId("course-title").fill(title);
  await arm(page, "normal-editor-ready", {}, "__readySignal");
  await page.getByTestId("create-course").click();
  await signal(page, "__readySignal");
  assert.equal(await page.getByTestId("editor-view").count(), 1);
}

async function downloadExport(page: Page, evidence: string, name: string) {
  const wait = page.waitForEvent("download", { timeout: 10_000 });
  await page.getByTestId("export-course").click();
  const download = await wait;
  const path = `${evidence}/${name}`;
  await download.saveAs(path);
  const bytes = await Bun.file(path).bytes();
  assert(bytes.byteLength > 0);
  return { path: resolve(path), bytes, parsed: JSON.parse(new TextDecoder().decode(bytes)) as CourseV1 };
}

async function withPage(evidence: string, origin: string, run: (page: Page) => Promise<unknown>) {
  await mkdir(evidence, { recursive: true });
  const browser = await chromium.launch({ channel: "chrome", headless: true, timeout: 10_000 });
  const errors: string[] = [];
  let passed = false, browserClosed = false;
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, acceptDownloads: true });
    try {
      const page = await context.newPage(); page.setDefaultTimeout(10_000);
      page.on("pageerror", error => errors.push(error.message));
      page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
      page.on("requestfailed", request => errors.push(`${request.url()}: ${request.failure()?.errorText}`));
      await run(page);
    } finally { await context.close(); }
    assert.deepEqual(errors, []); passed = true;
  } finally {
    await browser.close(); browserClosed = true;
    await json(`${evidence}/actions.json`, { passed, origin, errors, browser: browser.version() });
    await json(`${evidence}/cleanup.json`, { browserClosed, browserDisconnected: !browser.isConnected(), contextsClosed: true });
  }
}

async function idbIds(page: Page) {
  return page.evaluate(async () => {
    const request = indexedDB.open("smb1-maker", 1);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onerror = () => reject(request.error ?? new Error("IDB open failed"));
      request.onsuccess = () => resolve(request.result);
    });
    try {
      const tx = db.transaction("courses", "readonly");
      const got = tx.objectStore("courses").getAll();
      const rows = await new Promise<Array<{ id: string }>>((resolve, reject) => {
        got.onerror = () => reject(got.error ?? new Error("IDB getAll failed"));
        got.onsuccess = () => resolve((got.result as Array<{ id: string }>) ?? []);
      });
      return rows.map(row => row.id);
    } finally { db.close(); }
  });
}

export async function files(evidence: string, origin: string) {
  const captures: unknown[] = [];
  await withPage(evidence, origin, async page => {
    await openEditor(page, origin, "보관함 원본");
    const original = await snapshot(page);
    captures.push({ step: "before-export", ...(await capture(page, `${evidence}/before-export.png`)) });
    const exported = await downloadExport(page, evidence, "library-export.smb1.json");
    captures.push({ step: "exported-bytes", file: exported.path, bytes: exported.bytes.byteLength, sha256: sha(exported.bytes) });
    const idsBefore = await idbIds(page);
    await arm(page, "editor-view-state", { reason: "course" }, "__import1");
    await page.getByTestId("import-course").setInputFiles(exported.path);
    await signal(page, "__import1");
    const first = await snapshot(page);
    assert.notEqual(first.course.id, original.course.id);
    assert.equal(authoredContentEqual({ ...first.course, id: original.course.id, revision: original.course.revision }, original.course), true);
    captures.push({ step: "imported-once", ...(await capture(page, `${evidence}/imported-once.png`)) });
    await arm(page, "editor-view-state", { reason: "course" }, "__import2");
    await page.getByTestId("import-course").setInputFiles(exported.path);
    await signal(page, "__import2");
    const second = await snapshot(page);
    assert.notEqual(second.course.id, first.course.id);
    assert.notEqual(second.course.id, original.course.id);
    assert.equal(authoredContentEqual({ ...second.course, id: first.course.id, revision: first.course.revision }, first.course), true);
    const ids = await idbIds(page);
    assert.equal(new Set([...idsBefore, first.course.id, second.course.id]).size, ids.length);
    captures.push({ step: "imported-twice", firstId: first.course.id, secondId: second.course.id, ids });
    await json(`${evidence}/result.json`, { captures, originalId: original.course.id, importedIds: [first.course.id, second.course.id] });
  });
}

export async function filesInvalid(evidence: string, origin: string) {
  const captures: unknown[] = [];
  await withPage(evidence, origin, async page => {
    await openEditor(page, origin, "유지될 문서");
    const before = await snapshot(page);
    const beforeIds = await idbIds(page);
    const truncated = `${evidence}/truncated.json`;
    await Bun.write(truncated, "{");
    await page.getByTestId("import-course").setInputFiles(resolve(truncated));
    await page.getByTestId("error-dialog").waitFor({ state: "visible", timeout: 10_000 });
    captures.push({ step: "truncated", ...(await capture(page, `${evidence}/truncated.png`)) });
    await page.getByTestId("cancel").click();
    assert.equal((await snapshot(page)).course.id, before.course.id);
    await page.getByTestId("import-course").setInputFiles(resolve("tests/fixtures/unknown-version.smb1.json"));
    await page.getByTestId("error-dialog").waitFor({ state: "visible", timeout: 10_000 });
    captures.push({ step: "unknown-version", ...(await capture(page, `${evidence}/unknown-version.png`)) });
    await page.getByTestId("cancel").click();
    const oversized = `${evidence}/too-large.smb1.json`;
    await Bun.write(oversized, "x".repeat(COURSE_LIMITS.fileBytes + 1));
    await page.getByTestId("import-course").setInputFiles(resolve(oversized));
    await page.getByTestId("error-dialog").waitFor({ state: "visible", timeout: 10_000 });
    captures.push({ step: "too-large", ...(await capture(page, `${evidence}/too-large.png`)) });
    await page.getByTestId("cancel").click();
    const after = await snapshot(page);
    assert.equal(after.course.id, before.course.id);
    assert.equal(authoredContentEqual(after.course, before.course), true);
    assert.deepEqual(await idbIds(page), beforeIds);
    await json(`${evidence}/result.json`, { captures, unchangedId: before.course.id });
  });
}

export async function schemaRoundtrip(evidence: string, origin: string) {
  const captures: unknown[] = [];
  await withPage(evidence, origin, async page => {
    await openEditor(page, origin);
    const fixturePath = resolve("tests/fixtures/all-kinds.smb1.json");
    const fixture = parseCourse(await Bun.file(fixturePath).bytes());
    assert(fixture.ok);
    await arm(page, "editor-view-state", { reason: "course" }, "__imported");
    await page.getByTestId("import-course").setInputFiles(fixturePath);
    await signal(page, "__imported");
    captures.push({ step: "imported-all-kinds", ...(await capture(page, `${evidence}/imported-all-kinds.png`)) });
    const exported = await downloadExport(page, evidence, "all-kinds-export.smb1.json");
    const parsed = parseCourse(exported.bytes);
    assert(parsed.ok);
    const imported = (await snapshot(page)).course;
    assert.notEqual(parsed.value.id, fixture.value.id);
    assert.equal(parsed.value.revision, imported.revision);
    assert.deepEqual(parsed.value.areas, imported.areas);
    assert.equal(authoredContentEqual({ ...parsed.value, id: fixture.value.id, revision: fixture.value.revision }, fixture.value), true);
    const serialized = serializeCourse(parsed.value); assert(serialized.ok);
    captures.push({ step: "exported-all-kinds", file: exported.path, sha256: sha(exported.bytes) });
    await json(`${evidence}/result.json`, { captures, fixtureId: fixture.value.id, importedId: imported.id, exportedId: parsed.value.id });
  });
}

export async function schemaReject(evidence: string, origin: string) {
  const captures: unknown[] = [];
  await withPage(evidence, origin, async page => {
    await openEditor(page, origin);
    const before = await snapshot(page);
    await page.getByTestId("import-course").setInputFiles(resolve("tests/fixtures/duplicate-id.smb1.json"));
    await page.getByTestId("error-dialog").waitFor({ state: "visible", timeout: 10_000 });
    captures.push({ step: "duplicate-id-rejected", ...(await capture(page, `${evidence}/duplicate-id-rejected.png`)) });
    const after = await snapshot(page);
    assert.equal(after.course.id, before.course.id);
    assert.equal(authoredContentEqual(after.course, before.course), true);
    await json(`${evidence}/result.json`, { captures, unchanged: true });
  });
}
