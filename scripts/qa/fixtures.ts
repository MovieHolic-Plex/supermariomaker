import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import type { Page } from "playwright-core";
import { parseCourse } from "../../src/level/serialize";
import { bounded, json, viewport } from "./support";

const sha = (bytes: Uint8Array) => Bun.CryptoHasher.hash("sha256", bytes, "hex");
async function arm(page: Page, event: string, match: Readonly<Record<string, string | boolean>> = {}) {
  await page.evaluate(({ event, match }) => {
    Object.defineProperty(globalThis, "__fixtureSignal", { configurable: true, value: new Promise<unknown>(resolve => {
      const listener = (value: Event) => {
        if (!(value instanceof CustomEvent)) throw new Error("Expected state event");
        const detail: unknown = value.detail;
        if (!detail || typeof detail !== "object" || !Object.entries(match).every(([key, expected]) => Reflect.get(detail, key) === expected)) return;
        document.removeEventListener(event, listener, true); resolve(detail);
      };
      document.addEventListener(event, listener, true);
    }) });
  }, { event, match });
}
const signal = (page: Page) => bounded(page.evaluate("globalThis.__fixtureSignal"), "fixture state event");
async function state(page: Page) {
  return page.evaluate(async () => {
    const canvas = document.querySelector('[data-testid="fixture-canvas"]');
    if (!(canvas instanceof HTMLCanvasElement)) throw new Error("Missing actual preview canvas");
    const pixels = canvas.getContext("2d")?.getImageData(0, 0, canvas.width, canvas.height).data;
    if (!pixels) throw new Error("Missing rendered pixels");
    return {
      document: document.querySelector('[data-testid="fixture-snapshot"]')?.textContent,
      areaId: canvas.dataset["areaId"], width: canvas.width, height: canvas.height,
      pixelated: getComputedStyle(canvas).imageRendering,
      canvasSha256: Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", pixels)), byte => byte.toString(16).padStart(2, "0")).join(""),
      colors: new Set(Array.from({ length: pixels.length / 4 }, (_, i) => Array.from(pixels.slice(i * 4, i * 4 + 4)).join(","))).size,
      status: document.querySelector('[data-testid="fixture-gallery"]')?.getAttribute("data-status"),
      code: document.querySelector('[data-testid="fixture-status"]')?.getAttribute("data-code"),
      path: document.querySelector('[data-testid="fixture-status"]')?.getAttribute("data-path"),
      message: document.querySelector('[data-testid="fixture-status"]')?.textContent,
      title: document.querySelector('[data-testid="fixture-title"]')?.textContent,
      counts: document.querySelector('[data-testid="fixture-counts"]')?.textContent,
      camera: document.querySelector('[data-testid="fixture-camera"]')?.textContent,
    };
  });
}
async function capture(page: Page, path: string) {
  const png = await page.screenshot({ path, fullPage: false, animations: "disabled" });
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.deepEqual({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) }, page.viewportSize());
  const pixelsChecked = await page.evaluate(async base64 => {
    const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob());
    const screenshot = document.createElement("canvas"); screenshot.width = image.width; screenshot.height = image.height;
    const context = screenshot.getContext("2d");
    if (!context) throw new Error("Missing screenshot context");
    context.drawImage(image, 0, 0); image.close();
    const live = document.querySelector('[data-testid="fixture-canvas"]');
    if (!(live instanceof HTMLCanvasElement)) throw new Error("Missing live preview");
    const rect = live.getBoundingClientRect();
    if (rect.left < 0 || rect.top < 0 || rect.right > screenshot.width || rect.bottom > screenshot.height) throw new Error("Preview clipped from viewport");
    const actual = live.getContext("2d")?.getImageData(0, 0, 256, 240).data;
    if (!actual || live.width !== 256 || live.height !== 240 || rect.width !== 512 || rect.height !== 480) throw new Error("Unbounded or resized backing store");
    const captured = context.getImageData(Math.round(rect.x), Math.round(rect.y), 512, 480).data;
    for (let y = 0; y < 480; y++) for (let x = 0; x < 512; x++) for (let c = 0; c < 4; c++) {
      if (captured[(y * 512 + x) * 4 + c] !== actual[(Math.floor(y / 2) * 256 + Math.floor(x / 2)) * 4 + c]) throw new Error(`Compositor mismatch ${x},${y},${c}`);
    }
    for (const element of document.querySelectorAll('[data-testid="fixture-gallery"] input, [data-testid="fixture-gallery"] select, [data-testid="fixture-gallery"] button')) {
      const rect = element.getBoundingClientRect();
      if (rect.height < 44 || rect.width < 44 || rect.left < 0 || rect.right > innerWidth) throw new Error("Collapsed or clipped control");
      const label = element.closest("label");
      if (label && (label.getBoundingClientRect().width < 250 || getComputedStyle(label).fontSize !== "16px")) throw new Error("Unreadable control label");
    }
    const status = document.querySelector('[data-testid="fixture-status"]')?.getBoundingClientRect();
    if (!status || status.top < 0 || status.bottom > innerHeight || status.left < 0 || status.right > innerWidth) throw new Error("Status or Korean error clipped from viewport");
    return 256 * 240;
  }, png.toString("base64"));
  return { file: path, width: png.readUInt32BE(16), height: png.readUInt32BE(20), sha256: sha(png), pixelsChecked };
}
/** Delays only delivery of bytes already read by the real File API, never supplies a document or parser result. */
async function gateRead(page: Page, mode: "resolve" | "abort" | "fail") {
  await page.evaluate(mode => {
    const original = File.prototype.arrayBuffer;
    const descriptor = Object.getOwnPropertyDescriptor(File.prototype, "arrayBuffer");
    const release = Promise.withResolvers<void>();
    const ready = Promise.withResolvers<{ bytes: number; sha256: string }>();
    Object.defineProperty(globalThis, "__fixtureReadReady", { configurable: true, value: ready.promise });
    Object.defineProperty(globalThis, "__fixtureReleaseRead", { configurable: true, value: () => release.resolve() });
    Object.defineProperty(File.prototype, "arrayBuffer", { configurable: true, value: async function(this: File) {
      if (descriptor) Object.defineProperty(File.prototype, "arrayBuffer", descriptor); else Reflect.deleteProperty(File.prototype, "arrayBuffer");
      const bytes = await original.call(this);
      ready.resolve({ bytes: bytes.byteLength, sha256: Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("") });
      await release.promise;
      if (mode !== "resolve") throw new DOMException("Deliberate browser file-read fault", mode === "abort" ? "AbortError" : "NotReadableError");
      return bytes;
    } });
  }, mode);
}
async function selectFile(page: Page, path: string) {
  await arm(page, "fixture-read-settled");
  await page.getByTestId("import-course").setInputFiles(resolve(path));
  await signal(page);
}
async function fixtureScenario(evidence: string, origin: string, scenario: "load" | "reject") {
  const browser = await chromium.launch({ channel: "chrome", headless: true, timeout: 10_000 });
  const errors: string[] = [], actions: unknown[] = [], captures: unknown[] = [], documents: unknown[] = [];
  let galleryDisposed = false;
  try {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
    const page = await context.newPage(); page.setDefaultTimeout(10_000);
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    page.on("requestfailed", request => errors.push(`${request.url()} ${request.failure()?.errorText}`));
    await json(`${evidence}/versions.json`, { driver: "playwright-core", channel: "chrome", browser: browser.version(), bun: Bun.version, viewport });
    await page.addInitScript(() => {
      Object.defineProperty(globalThis, "__fixtureMounted", { value: new Promise<void>(resolve => {
        document.addEventListener("fixture-state", () => resolve(), { once: true, capture: true });
      }) });
    });
    await page.goto(`${origin}/?qa=fixture`, { waitUntil: "load" });
    await bounded(page.evaluate("globalThis.__fixtureMounted"), "fixture route mount");
    assert.equal(await page.getByTestId("import-course").getAttribute("type"), "file");
    assert.equal(await page.getByTestId("fixture-canvas").isVisible(), false, "No preview before a valid document");
    const load = async (name: string) => {
      const path = `tests/fixtures/${name}.smb1.json`, bytes = await Bun.file(path).bytes(), parsed = parseCourse(bytes);
      assert(parsed.ok);
      await selectFile(page, path);
      const observed = await state(page);
      assert.equal(observed.status, "loaded"); assert.equal(observed.document, JSON.stringify(parsed.value));
      assert.equal(observed.title, parsed.value.title); assert.equal(observed.areaId, parsed.value.mainAreaId);
      assert.equal(observed.width, 256); assert.equal(observed.height, 240); assert.equal(observed.pixelated, "pixelated"); assert(observed.colors > 1);
      actions.push({ action: "input.setInputFiles", path: resolve(path), bytes: bytes.length, sha256: sha(bytes), status: observed.status });
      documents.push({ name, ...observed }); return parsed.value;
    };
    const initial = await load("new-course");
    if (scenario === "load") {
      captures.push(await capture(page, `${evidence}/new-course-1280.png`));
      const course = await load("all-kinds");
      for (const area of course.areas) {
        await arm(page, "fixture-preview", { areaId: area.id }); await page.getByTestId("fixture-area").selectOption(area.id); await signal(page);
        const observed = await state(page);
        assert.equal(observed.areaId, area.id); assert.equal(observed.document, JSON.stringify(course)); assert(observed.colors > 1);
        assert.equal(await page.getByTestId("fixture-counts").getAttribute("data-tiles"), String(area.tiles.length));
        assert.equal(await page.getByTestId("fixture-counts").getAttribute("data-objects"), String(area.objects.length));
        documents.push({ theme: area.theme, ...observed }); captures.push(await capture(page, `${evidence}/all-kinds-${area.theme}-1280.png`));
        actions.push({ action: "selectOption", areaId: area.id, theme: area.theme });
      }
      await page.setViewportSize({ width: 1920, height: 1080 });
      captures.push(await capture(page, `${evidence}/all-kinds-castle-1920.png`));
      // A valid maximum-sized area exercises camera bounds without constructing dense terrain or a giant canvas.
      const huge = { ...initial, areas: initial.areas.map(area => ({ ...area, width: 4096, height: 128 })) };
      const hugePath = `${evidence}/huge-area.json`; await json(hugePath, huge); await selectFile(page, hugePath);
      assert.equal((await state(page)).status, "loaded");
      for (const axis of ["x", "y"] as const) {
        await arm(page, "fixture-preview");
        await page.getByTestId(`fixture-camera-${axis}`).focus(); await page.keyboard.press("End"); await signal(page);
      }
      assert.equal(await page.getByTestId("fixture-camera-x").inputValue(), "65280"); assert.equal(await page.getByTestId("fixture-camera-y").inputValue(), "1808");
      const observed = await state(page); assert.equal(observed.document, JSON.stringify(huge)); assert.equal(observed.width, 256); assert.equal(observed.height, 240);
      documents.push({ name: "huge-area", ...observed }); captures.push(await capture(page, `${evidence}/huge-area-1920.png`));
      actions.push({ action: "maximum-area input and keyboard End camera", sha256: sha(await Bun.file(hugePath).bytes()), x: 65280, y: 1808 });
    } else {
      const baseline = await state(page);
      const unchanged = async (name: string) => {
        const observed = await state(page);
        for (const key of ["document", "areaId", "canvasSha256", "title", "counts", "camera"] as const) assert.equal(observed[key], baseline[key], `${name}: ${key} must remain unchanged`);
        documents.push({ name, ...observed }); return observed;
      };
      const malformed = `${evidence}/malformed.json`; await Bun.write(malformed, '{"format":');
      for (const path of [malformed, "tests/fixtures/duplicate-id.smb1.json", "tests/fixtures/platform-length-zero.smb1.json"]) {
        const bytes = await Bun.file(path).bytes(), parsed = parseCourse(bytes); assert(!parsed.ok);
        await selectFile(page, path); const observed = await unchanged(path);
        assert.equal(observed.status, "rejected"); assert.equal(observed.code, parsed.error.code); assert.equal(observed.path, parsed.error.path);
        actions.push({ action: "reject input file", path: resolve(path), bytes: bytes.length, sha256: sha(bytes), error: parsed.error });
        captures.push(await capture(page, `${evidence}/${parsed.error.code}-1280.png`));
      }
      for (const mode of ["abort", "fail", "cancel", "stale", "stale-reject", "stale-abort"] as const) {
        const oldPath = mode === "stale-reject" ? "tests/fixtures/duplicate-id.smb1.json" : "tests/fixtures/all-kinds.smb1.json";
        await gateRead(page, mode === "abort" || mode === "stale-abort" ? "abort" : mode === "fail" ? "fail" : "resolve");
        await page.getByTestId("import-course").setInputFiles(resolve(oldPath));
        const receipt = await bounded(page.evaluate("globalThis.__fixtureReadReady"), "native file bytes barrier");
        const bytes = await Bun.file(oldPath).bytes(); assert.deepEqual(receipt, { bytes: bytes.length, sha256: sha(bytes) });
        if (mode === "cancel") {
          await arm(page, "fixture-state", { status: "cancelled" }); await page.getByTestId("fixture-cancel").click(); await signal(page);
        } else if (mode === "stale" || mode === "stale-reject" || mode === "stale-abort") await load("new-course");
        await arm(page, "fixture-read-settled", { name: oldPath.split("/").at(-1) ?? "" });
        await page.evaluate("globalThis.__fixtureReleaseRead()"); const settled = await signal(page);
        assert.deepEqual(settled, { name: oldPath.split("/").at(-1), stale: mode === "cancel" || mode === "stale" || mode === "stale-reject" || mode === "stale-abort" });
        const observed = await unchanged(mode);
        assert.equal(observed.status, mode === "abort" || mode === "fail" ? "rejected" : mode === "cancel" ? "cancelled" : "loaded");
        if (mode === "abort" || mode === "fail") assert.equal(observed.code, mode === "abort" ? "read_aborted" : "read_failed");
        actions.push({ action: mode, realRead: receipt, settled }); captures.push(await capture(page, `${evidence}/${mode}-1280.png`));
      }
      await page.setViewportSize({ width: 1920, height: 1080 }); captures.push(await capture(page, `${evidence}/preserved-1920.png`));
    }
    await gateRead(page, "resolve");
    await page.getByTestId("import-course").setInputFiles(resolve("tests/fixtures/all-kinds.smb1.json"));
    const pendingRead = await bounded(page.evaluate("globalThis.__fixtureReadReady"), "dispose real bytes barrier");
    const pendingBytes = await Bun.file("tests/fixtures/all-kinds.smb1.json").bytes();
    assert.deepEqual(pendingRead, { bytes: pendingBytes.length, sha256: sha(pendingBytes) });
    await arm(page, "fixture-cleanup"); await page.getByTestId("fixture-exit").click();
    assert.deepEqual(await signal(page), { listenersAborted: true, pendingReadsInvalidated: true }); galleryDisposed = true;
    await arm(page, "fixture-read-settled"); await page.evaluate("globalThis.__fixtureReleaseRead()");
    assert.deepEqual(await signal(page), { name: "all-kinds.smb1.json", stale: true });
    actions.push({ action: "dispose with pending real file read", pendingRead, staleResultDiscarded: true });
    assert.equal(await page.getByTestId("fixture-gallery").count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await Promise.all([
      json(`${evidence}/actions.json`, actions), json(`${evidence}/documents.json`, documents), json(`${evidence}/png-manifest.json`, captures), json(`${evidence}/errors.json`, errors),
      json(`${evidence}/cleanup.json`, { galleryDisposed, browserConnected: browser.isConnected(), browserClosed: true, context: "ephemeral", noAppTimersOrObjectURLs: true }),
    ]);
  }
}
export const fixtureLoad = (evidence: string, origin: string) => fixtureScenario(evidence, origin, "load");
export const fixtureReject = (evidence: string, origin: string) => fixtureScenario(evidence, origin, "reject");
