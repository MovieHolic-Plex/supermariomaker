import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { parseArgs } from "node:util";
import { chromium } from "playwright-core";
import type { Page } from "playwright-core";
import { audioKeys, effectKeys, musicKeys, SCORES } from "../../src/assets/music";
import { bounded, closeOwnedBrowser, json } from "./support";

// Installed only in isolated QA contexts. Observes the real gallery and browser
// lifecycle; there are no setters, fake sound nodes, or success hooks in the app.
function installObserver(mode: "none" | "constructor" | "resume") {
  const rows: { type: string; detail: unknown }[] = [];
  const lifecycle: { constructed: number; closed: number; gestures: boolean[]; resumes: boolean[] } = { constructed: 0, closed: 0, gestures: [], resumes: [] };
  let pending: Promise<unknown> | null = null;
  const arm = (type: string, match: Record<string, unknown>) => {
    pending = new Promise((resolve, reject) => {
      const listener = (event: Event) => {
        if (!(event instanceof CustomEvent)) return;
        const detail: unknown = event.detail;
        if (typeof detail !== "object" || detail === null || !Object.entries(match).every(([key, value]) => Reflect.get(detail, key) === value)) return;
        clearTimeout(timer); document.removeEventListener(type, listener, true); resolve(detail);
      };
      const timer = setTimeout(() => { document.removeEventListener(type, listener, true); reject(new Error(`Missing audio event: ${type}`)); }, 10_000);
      document.addEventListener(type, listener, true);
    });
  };
  for (const type of ["audio-state", "audio-scheduled", "audio-rendered", "audio-render-error", "audio-cleanup"]) {
    document.addEventListener(type, (event) => { if (event instanceof CustomEvent) rows.push({ type, detail: event.detail }); }, true);
  }
  arm("audio-state", { status: "locked" });
  const boot = pending;
  const Native = AudioContext;
  class ObservedContext extends Native {
    constructor() {
      if (mode === "constructor") throw new DOMException("QA context construction denied", "NotAllowedError");
      super(); lifecycle.constructed++; lifecycle.gestures.push(navigator.userActivation.isActive);
    }
    override resume() {
      lifecycle.resumes.push(navigator.userActivation.isActive);
      return mode === "resume" ? Promise.reject(new DOMException("QA resume denied", "NotAllowedError")) : super.resume();
    }
    override async close() { await super.close(); lifecycle.closed++; }
  }
  Object.defineProperty(globalThis, "AudioContext", { value: ObservedContext });
  Object.defineProperty(globalThis, "__audioQA", { value: { rows, lifecycle, arm, boot, wait: () => pending } });
}
async function signal(page: Page, event: { readonly type: string; readonly match: Readonly<Record<string, unknown>> }, action: () => Promise<unknown>): Promise<unknown> {
  await page.evaluate(`Reflect.get(globalThis, "__audioQA").arm(${JSON.stringify(event.type)}, ${JSON.stringify(event.match)})`);
  const result = page.evaluate<unknown>('Reflect.get(globalThis, "__audioQA").wait()');
  await action();
  return bounded(result, event.type);
}
const stateEvent = (match: Readonly<Record<string, unknown>>) => ({ type: "audio-state", match });
async function capture(page: Page, path: string) {
  const png = await page.screenshot({ path });
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(png.readUInt32BE(16), page.viewportSize()?.width);
  assert.equal(png.readUInt32BE(20), page.viewportSize()?.height);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "No horizontal clipping");
}
async function wav(page: Page, evidence: string, key: typeof audioKeys[number]) {
  await page.getByTestId("audio-export-select").selectOption(key);
  const download = page.waitForEvent("download", { timeout: 10_000 });
  const metrics = await signal(page, { type: "audio-rendered", match: { key } }, () => page.getByTestId("audio-export").click());
  assert(metrics && typeof metrics === "object" && "peak" in metrics && "rms" in metrics && "clippedSamples" in metrics && "schedule" in metrics);
  assert(typeof metrics.peak === "number" && metrics.peak > 0.001 && metrics.peak < 1);
  assert(typeof metrics.rms === "number" && metrics.rms > 0.0001);
  assert.equal(metrics.clippedSamples, 0);
  assert(Array.isArray(metrics.schedule));
  assert.equal(metrics.schedule.length, SCORES[key].notes.length, "Every authored note rendered");
  const file = await download;
  assert.equal(file.suggestedFilename(), `${key}.wav`);
  const path = `${evidence}/wav/${key}.wav`;
  await file.saveAs(path);
  assert.equal(await file.failure(), null);
  const bytes = Buffer.from(await Bun.file(path).arrayBuffer());
  assert.equal(bytes.subarray(0, 4).toString(), "RIFF");
  assert.equal(bytes.subarray(8, 12).toString(), "WAVE");
  assert.equal(bytes.readUInt16LE(22), 1); assert.equal(bytes.readUInt32LE(24), 44100);
  assert.equal(bytes.readUInt16LE(34), 16); assert.equal(bytes.readUInt32LE(40), bytes.length - 44);
  let peak = 0; let nonzero = 0;
  for (let offset = 44; offset < bytes.length; offset += 2) { const value = Math.abs(bytes.readInt16LE(offset)); peak = Math.max(peak, value); if (value > 0) nonzero++; }
  assert(nonzero > 100 && peak > 32 && peak < 32767, "Downloaded PCM is nonempty and unclipped");
  await json(`${evidence}/wav/${key}.json`, { ...metrics, bytes: bytes.length, nonzeroSamples: nonzero, pcmPeak: peak, sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex") });
}

async function scenario(evidence: string, origin: string, mode: "none" | "constructor" | "resume") {
  await mkdir(`${evidence}/wav`, { recursive: true });
  const actions: string[] = [];
  const errors: string[] = [];
  const consoleLog: unknown[] = [];
  const browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, acceptDownloads: true });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { consoleLog.push({ type: message.type(), text: message.text() }); if (message.type() === "error") errors.push(message.text()); });
  page.on("requestfailed", (request) => errors.push(`${request.url()}: ${request.failure()?.errorText}`));
  await context.addInitScript(installObserver, mode);
  let closed = false;
  let cleanup: unknown = null;
  try {
    actions.push(`navigate ${origin}/?qa=audio; failure mode=${mode}`);
    await page.goto(`${origin}/?qa=audio`);
    await bounded(page.evaluate('Reflect.get(globalThis, "__audioQA").boot'), "gallery mount");
    assert.equal(await page.getByTestId("audio-gallery").getAttribute("data-status"), "locked");
    assert.equal(await page.evaluate('Reflect.get(globalThis, "__audioQA").lifecycle.constructed'), 0);
    await capture(page, `${evidence}/locked-1280.png`);
    actions.push("trusted click audio-enable");
    const enabled = await signal(page, stateEvent({ status: mode === "none" ? "ready" : "unavailable" }), () => page.getByTestId("audio-enable").click());
    await json(`${evidence}/activation.json`, enabled);
    if (mode === "none") {
      for (const key of musicKeys) {
        actions.push(`select and play ${key}`);
        await page.getByTestId("theme-select").selectOption(key);
        await signal(page, { type: "audio-scheduled", match: { key } }, () => page.getByTestId("audio-play").click());
        assert.equal(await page.getByTestId("audio-gallery").getAttribute("data-music"), key);
        await capture(page, `${evidence}/music-${key}-1280.png`);
      }
      for (const key of effectKeys) {
        actions.push(`play effect ${key}`);
        await page.getByTestId("audio-stop").click();
        await signal(page, { type: "audio-scheduled", match: { key } }, () => page.getByTestId(`audio-effect-${key}`).click());
      }
      await page.getByTestId("theme-select").selectOption("castle");
      actions.push("mute while playing; assert immediate silence");
      await signal(page, stateEvent({ muted: true, voices: 0 }), () => page.getByTestId("audio-mute").check());
      assert.equal(await page.getByTestId("audio-effect-coin").isDisabled(), true);
      await capture(page, `${evidence}/muted-1280.png`);
      actions.push("unmute; pause; explicit resume");
      await signal(page, stateEvent({ muted: false }), () => page.getByTestId("audio-mute").uncheck());
      await signal(page, stateEvent({ status: "paused", voices: 0 }), () => page.getByTestId("audio-pause").click());
      await capture(page, `${evidence}/paused-1280.png`);
      await signal(page, stateEvent({ status: "ready" }), () => page.getByTestId("audio-enable").click());
      actions.push("keyboard volume Home then ArrowRight = 0.05");
      await page.getByTestId("audio-volume").focus();
      await page.keyboard.press("Home");
      await signal(page, stateEvent({ volume: 0.05 }), () => page.keyboard.press("ArrowRight"));
      await signal(page, stateEvent({ music: null, voices: 0 }), () => page.getByTestId("audio-stop").click());
      await capture(page, `${evidence}/stopped-1280.png`);
      for (const key of audioKeys) { actions.push(`download actual OfflineAudioContext WAV ${key}`); await wav(page, evidence, key); }
      await page.setViewportSize({ width: 1920, height: 1080 });
      await capture(page, `${evidence}/gallery-1920.png`);
    } else {
      actions.push("assert denied sound state; change theme and mute; export still usable");
      assert.equal(await page.getByTestId("audio-play").isDisabled(), true);
      assert.equal(await page.getByTestId("audio-status").isVisible(), true);
      await page.getByTestId("theme-select").selectOption("underwater");
      await page.getByTestId("audio-mute").check();
      assert.equal(await page.getByTestId("theme-select").inputValue(), "underwater");
      await wav(page, evidence, "coin");
      await capture(page, `${evidence}/unavailable-1280.png`);
    }
    actions.push("exit gallery and await exact cleanup event");
    cleanup = await signal(page, { type: "audio-cleanup", match: { voices: 0, urls: 0, frameCancelled: true, listenersAborted: true } }, () => page.getByTestId("audio-exit").click());
    assert.equal(await page.getByTestId("audio-gallery").count(), 0);
    const lifecycle: unknown = await page.evaluate('Reflect.get(globalThis, "__audioQA").lifecycle');
    assert(lifecycle && typeof lifecycle === "object" && "constructed" in lifecycle && "closed" in lifecycle && "gestures" in lifecycle && "resumes" in lifecycle);
    assert.equal(lifecycle.constructed, lifecycle.closed, "Every real context closed");
    assert.deepEqual(lifecycle.gestures, mode === "constructor" ? [] : [true], "Construction requires a real gesture");
    assert(Array.isArray(lifecycle.resumes) && lifecycle.resumes.every((active: unknown) => active === true));
    await json(`${evidence}/audio.json`, { lifecycle, events: await page.evaluate('Reflect.get(globalThis, "__audioQA").rows') });
    assert.deepEqual(errors, []);
    actions.push("PASS all scenario assertions");
  } finally {
    try {
      await json(`${evidence}/versions.json`, { browser: browser.version(), driver: "playwright-core", bun: Bun.version, url: page.isClosed() ? null : page.url(), viewport: page.isClosed() ? null : page.viewportSize() });
    } catch { await json(`${evidence}/versions.json`, { driver: "playwright-core", bun: Bun.version, pageClosed: true }); }
    await closeOwnedBrowser(browser); closed = !browser.isConnected();
    await Promise.all([json(`${evidence}/actions.json`, actions), json(`${evidence}/errors.json`, { errors, consoleLog }), json(`${evidence}/cleanup.json`, { browserClosed: closed, isolatedContextClosed: true, userProfileTouched: false, gallery: cleanup })]);
    assert(closed); assert.deepEqual(errors, []);
  }
}

export const audioGallery = (evidence: string, origin: string): Promise<void> => scenario(evidence, origin, "none");
export async function audioBlocked(evidence: string, origin: string): Promise<void> {
  await scenario(`${evidence}/constructor`, origin, "constructor");
  await scenario(`${evidence}/resume`, origin, "resume");
}

// Standalone core acceptance: actual gallery module, private port 4184. Supplying
// --origin later reuses exactly these scenarios against the integrated app route.
if (import.meta.main) {
  const { values } = parseArgs({ args: Bun.argv.slice(2), options: { evidence: { type: "string" }, origin: { type: "string" } }, strict: true });
  assert(values.evidence, "Required: --evidence DIR");
  let server: ReturnType<typeof Bun.serve> | null = null;
  const origin = values.origin ?? "http://127.0.0.1:4184";
  try {
    if (!values.origin) {
      const build = await Bun.build({ entrypoints: ["src/ui/audio-gallery.ts"], target: "browser", format: "esm" });
      assert(build.success, build.logs.map(String).join("\n"));
      const bundle = build.outputs[0]; assert(bundle);
      await Bun.write(`${values.evidence}/audio-gallery.js`, bundle);
      server = Bun.serve({ hostname: "127.0.0.1", port: 4184, fetch(request) {
        switch (new URL(request.url).pathname) {
          case "/": return new Response('<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><title>사운드 갤러리</title><body style="margin:0;background:#0b1320"><main></main><script type="module">import {mountAudioGallery} from "/audio-gallery.js"; mountAudioGallery(document.querySelector("main"));</script></body></html>', { headers: { "content-type": "text/html; charset=utf-8" } });
          case "/audio-gallery.js": return new Response(bundle, { headers: { "content-type": "text/javascript" } });
          default: return new Response("Not found", { status: 404 });
        }
      } });
    }
    await audioGallery(`${values.evidence}/audio-gallery`, origin);
    await audioBlocked(`${values.evidence}/audio-blocked`, origin);
    console.log("PASS audio core gallery, 23 full WAV cues, constructor/resume denial");
  } finally {
    if (server) {
      await server.stop(true);
      const probe = Bun.serve({ hostname: "127.0.0.1", port: 4184, fetch: () => new Response(null) });
      await probe.stop(true);
    }
    await json(`${values.evidence}/server-cleanup.json`, { ownedServerStopped: server !== null, port: server ? 4184 : null, portFree: server !== null, externalOriginUntouched: Boolean(values.origin) });
  }
}
