import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";
import type { Page } from "playwright-core";
import { GALLERY_PAGES } from "../../src/render/asset-gallery";
import { ASSET_KEYS, PIXELS, WORLD_THEMES, WORLD_PALETTES } from "../../src/assets/pixels";
import { getFrame, THEME_BACKGROUNDS } from "../../src/assets/manifest";
import { bounded, json } from "./support";

function observeGallery() {
  Object.defineProperty(globalThis, "__assetReady", { value: new Promise<void>(resolve => {
    document.addEventListener("asset-gallery-page", () => resolve(), { once: true });
  }) });
}
async function selectPage(page: Page, id: string) {
  await page.evaluate(() => {
    Object.defineProperty(globalThis, "__assetPage", { configurable: true, value: new Promise<void>(resolve => {
      document.addEventListener("asset-gallery-page", () => resolve(), { once: true });
    }) });
  });
  await page.getByTestId("assets-page").selectOption(id);
  await bounded(page.evaluate("globalThis.__assetPage"), `gallery page ${id}`);
}
async function capture(page: Page, path: string) {
  const png = await page.screenshot({ path, fullPage: false, animations: "disabled" });
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  assert.deepEqual({ width, height }, page.viewportSize());
  // Compare screenshot compositor pixels with each actual Canvas backing store.
  const compositedPixels = await bounded(page.evaluate(async base64 => {
    const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob());
    const canvas = document.createElement("canvas");
    canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Screenshot context unavailable");
    context.drawImage(image, 0, 0); image.close();
    let pixels = 0;
    for (const live of document.querySelectorAll("section canvas")) {
      if (!(live instanceof HTMLCanvasElement)) throw new Error("Expected canvas");
      const rect = live.getBoundingClientRect();
      if (rect.left < 0 || rect.top < 0 || rect.right > canvas.width || rect.bottom > canvas.height) throw new Error("Clipped screenshot canvas");
      const actual = live.getContext("2d")?.getImageData(0, 0, live.width, live.height).data;
      if (!actual) throw new Error("Live canvas unavailable");
      const captured = context.getImageData(Math.round(rect.x), Math.round(rect.y), live.width, live.height).data;
      for (let i = 0; i < actual.length; i++) if (actual[i] !== captured[i]) throw new Error(`Screenshot compositing mismatch ${i} at ${rect.x},${rect.y}`);
      pixels += live.width * live.height;
    }
    return pixels;
  }, png.toString("base64")), "screenshot compositing");
  return { file: path, width, height, sha256: Bun.CryptoHasher.hash("sha256", png, "hex"), compositedPixels };
}
export async function assetSheet(evidence: string, origin: string) {
  await mkdir(evidence, { recursive: true });
  const browser = await chromium.launch({ channel: "chrome", headless: true, timeout: 10_000 });
  const errors: string[] = [];
  const captures = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    page.on("requestfailed", request => errors.push(`${request.url()} ${request.failure()?.errorText}`));
    await page.addInitScript(observeGallery);
    await page.goto(`${origin}/?qa=assets`, { waitUntil: "load", timeout: 10_000 });
    await bounded(page.evaluate("globalThis.__assetReady"), "gallery mount");
    for (const sheet of GALLERY_PAGES) {
      await selectPage(page, sheet.id);
      const sources = sheet.keys.map(key => ({ key, ...PIXELS[key], palette: WORLD_PALETTES[getFrame(key).palette === "world" ? sheet.theme : "overworld"] }));
      const checkedPixels = await page.evaluate(({ sources, background }) => {
        let pixels = 0;
        for (const source of sources) for (const scale of [1, 4]) {
          const canvas = document.querySelector(`canvas[data-key="${source.key}"][data-scale="${scale}"]`);
          if (!(canvas instanceof HTMLCanvasElement)) throw new Error(`Missing frame ${source.key}`);
          if (getComputedStyle(canvas).imageRendering !== "pixelated") throw new Error("Non-pixelated canvas");
          const data = canvas.getContext("2d")?.getImageData(0, 0, canvas.width, canvas.height).data;
          if (!data) throw new Error("Missing canvas pixels");
          const left = (canvas.width - source.width * scale) / 2;
          const top = canvas.height - 4 - source.height * scale;
          const palette: Readonly<Record<string, string>> = source.palette;
          for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
            const sx = Math.floor((x - left) / scale), sy = Math.floor((y - top) / scale);
            const symbol = sx >= 0 && sx < source.width && sy >= 0 && sy < source.height ? source.rows[sy]?.[sx] : ".";
            const hex = symbol === "." ? background : palette[symbol ?? "."];
            if (!hex) throw new Error("Palette gap");
            const offset = (y * canvas.width + x) * 4;
            for (let channel = 0; channel < 4; channel++) {
              const expected = channel === 3 ? 255 : Number.parseInt(hex.slice(1 + channel * 2, 3 + channel * 2), 16);
              if (data[offset + channel] !== expected) throw new Error(`${source.key} ${scale}x pixel ${x},${y},${channel}`);
            }
            pixels++;
          }
        }
        return pixels;
      }, { sources, background: THEME_BACKGROUNDS[sheet.theme] });
      captures.push({ id: sheet.id, theme: sheet.theme, keys: sheet.keys, scales: [1, 4], checkedPixels,
        ...await capture(page, join(evidence, `${sheet.id}.png`)) });
    }
    for (const theme of WORLD_THEMES) for (const scale of [1, 4]) {
      const id = `scene-${theme}-${scale}`;
      await page.setViewportSize({ width: 1280, height: scale === 4 ? 1200 : 720 });
      await selectPage(page, id);
      captures.push({ id, theme, keys: [], scales: [scale], checkedPixels: 0,
        ...await capture(page, join(evidence, `${id}.png`)) });
    }
    assert.equal(captures.length, GALLERY_PAGES.length + WORLD_THEMES.length * 2);
    assert.deepEqual(errors, []);
    await json(join(evidence, "capture-manifest.json"), { status: "PASS", origin, browser: browser.version(),
      inventory: ASSET_KEYS.length, frameThemeScalePreviews: ASSET_KEYS.length * WORLD_THEMES.length * 2, captures, errors,
      visualReview: "Pending independent image-capable reviewer; pixel/compositor assertions are not aesthetic approval." });
  } finally {
    await json(join(evidence, "browser-errors.json"), errors);
    await browser.close();
    await json(join(evidence, "browser-cleanup.json"), { browserClosed: true, contextsIsolated: true, serverOwned: false });
  }
}

// The private 4183 harness imports /gallery.js; normal app QA passes /app.js.
export async function assetMissing(evidence: string, origin: string, entryPath = "/gallery.js") {
  await mkdir(evidence, { recursive: true });
  const browser = await chromium.launch({ channel: "chrome", headless: true, timeout: 10_000 });
  const errors: { kind: string; text: string; url: string }[] = [];
  const aborted: string[] = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();
    page.on("pageerror", error => errors.push({ kind: "page", text: error.message, url: page.url() }));
    page.on("console", message => { if (message.type() === "error") errors.push({ kind: "console", text: message.text(), url: message.location().url }); });
    page.on("requestfailed", request => errors.push({ kind: "request", text: request.failure()?.errorText ?? "", url: request.url() }));
    await page.addInitScript(() => {
      Object.defineProperty(globalThis, "__assetFailure", { value: new Promise<void>(resolve => {
        const observer = new MutationObserver(() => {
          if (document.querySelector('[data-testid="error-dialog"] [data-testid="retry"]')) { observer.disconnect(); resolve(); }
        });
        observer.observe(document, { childList: true, subtree: true });
      }) });
    });
    await page.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (url.origin === origin && url.pathname === entryPath) {
        aborted.push(url.href); await route.abort("failed");
      } else await route.continue();
    });
    await page.goto(`${origin}/?qa=assets`, { waitUntil: "load", timeout: 10_000 });
    await bounded(page.evaluate("globalThis.__assetFailure"), "inline bundle failure");
    assert.deepEqual(aborted, [`${origin}${entryPath}`], "Abort must hit the selected actual entry bundle exactly once");
    assert.equal(await page.getByTestId("error-dialog").isVisible(), true);
    assert.equal(await page.getByTestId("retry").isVisible(), true);
    const failure = await capture(page, join(evidence, "asset-missing.png"));
    assert.equal(errors.filter(error => error.kind === "console" && error.text.startsWith("Application load failed ")).length, 1);
    assert.deepEqual(errors.filter(error => !(error.url === aborted[0] && /ERR_FAILED/.test(error.text))
      && !(error.kind === "console" && error.text.startsWith("Application load failed "))), []);
    const faultErrorCount = errors.length;
    await page.unrouteAll();
    await page.addInitScript(observeGallery);
    const navigation = page.waitForEvent("load", { timeout: 10_000 });
    await page.getByTestId("retry").click();
    await navigation;
    await bounded(page.evaluate("globalThis.__assetReady"), "retry gallery mount");
    assert.equal(await page.getByTestId("asset-gallery").isVisible(), true);
    const recovery = await capture(page, join(evidence, "asset-recovered.png"));
    assert.equal(errors.length, faultErrorCount, "Recovery must not introduce browser errors");
    await json(join(evidence, "fault.json"), { status: "PASS", origin, entryPath, browser: browser.version(), aborted, errors, failure, recovery });
  } finally {
    await browser.close();
    await json(join(evidence, "fault-cleanup.json"), { browserClosed: true, serverOwned: false });
  }
}
