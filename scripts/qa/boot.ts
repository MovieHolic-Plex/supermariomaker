import assert from "node:assert/strict";
import { assertErrors, bounded, installBootObserver, json, origin, viewport } from "./support";
import type { BrowserError } from "./support";

async function capture(view: Bun.WebView, path: string, size: { readonly width: number; readonly height: number }) {
  assert.deepEqual(await view.evaluate('({width: innerWidth, height: innerHeight})'), size, "Actual CSS viewport");
  const png = await view.screenshot({ encoding: "buffer" });
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(png.readUInt32BE(16), size.width, "PNG viewport width");
  assert.equal(png.readUInt32BE(20), size.height, "PNG viewport height");
  await Bun.write(path, png);
}

export async function boot(evidence: string) {
  const actions: string[] = [];
  const errors: BrowserError[] = [];
  const consoleLog: unknown[] = [];
  const view = new Bun.WebView({
    ...viewport, backend: "chrome", dataStore: "ephemeral",
    console(type, ...args) {
      consoleLog.push({ type, args });
      if (type === "error") errors.push({ kind: "console", text: args.map(String).join(" "), url: view.url });
    },
  });
  try {
    await bounded(view.navigate("about:blank"), "native browser startup");
    // On Windows the constructor initially sizes the outer Chrome window;
    // resize applies the actual content viewport (otherwise 1258x622 here).
    await view.resize(viewport.width, viewport.height);
    await view.cdp("Runtime.enable");
    await view.cdp("Log.enable");
    // Use the standard EventTarget contract: Bun 1.4.1's DOM-aware generic
    // overload incorrectly describes MessageEvent as its constructor type.
    const events: EventTarget = view;
    events.addEventListener("Runtime.exceptionThrown", (event) => {
      assert(event instanceof MessageEvent);
      const data: unknown = event.data;
      errors.push({ kind: "pageerror", text: JSON.stringify(data), url: view.url });
    });
    events.addEventListener("Log.entryAdded", (event) => {
      assert(event instanceof MessageEvent);
      const data: unknown = event.data;
      assert(data && typeof data === "object" && "entry" in data);
      const entry = data.entry;
      assert(entry && typeof entry === "object" && "level" in entry);
      consoleLog.push(entry);
      if (entry.level === "error") errors.push({ kind: "resource", text: JSON.stringify(entry), url: view.url });
    });
    const version = await view.cdp("Browser.getVersion");
    await json(`${evidence}/versions.json`, { driver: "Bun.WebView", bun: Bun.version, version, viewport });
    await view.cdp("Page.addScriptToEvaluateOnNewDocument", { source: `(${installBootObserver.toString()})()` });
    actions.push(`navigate ${origin}/`);
    await bounded(view.navigate(`${origin}/`), "boot navigation");
    await bounded(view.evaluate('Reflect.get(globalThis, "__qaBootReady")'), "boot DOM");
    assert.equal(await view.evaluate('document.querySelector("[data-testid=library]")?.checkVisibility()'), true);
    await capture(view, `${evidence}/library-1280.png`, viewport);
    actions.push("click new-course");
    await view.click('[data-testid="new-course"]');
    actions.push("type course-title: 첫 코스");
    await view.type("첫 코스");
    assert.equal(await view.evaluate('document.querySelector("input")?.value'), "첫 코스");
    await capture(view, `${evidence}/new-course-1280.png`, viewport);
    actions.push("click create-course");
    await view.click('[data-testid="create-course"]');
    assert.equal(await view.evaluate('document.querySelector("[data-testid=editor-canvas]")?.checkVisibility()'), true);
    assert.equal(await view.evaluate('document.querySelector("[data-testid=course-title]")?.value'), "첫 코스");
    assert.equal(await view.evaluate('document.title'), "첫 코스 | 코스 메이커");
    assert.equal(await view.evaluate('document.querySelector("[data-testid=library]")'), null);
    await capture(view, `${evidence}/editor-1280.png`, viewport);
    actions.push("resize 1920x1080");
    await view.resize(1920, 1080);
    await capture(view, `${evidence}/editor-1920.png`, { width: 1920, height: 1080 });
    assertErrors(errors, "none");
    actions.push("PASS editor visible; input title preserved; zero unexpected browser errors");
  } finally {
    view.close();
    Bun.WebView.closeAll();
    await assert.rejects(async () => view.evaluate("document.title"), /closed/i);
    await Promise.all([
      json(`${evidence}/actions.json`, { url: `${origin}/`, viewport, actions }),
      json(`${evidence}/console.json`, { console: consoleLog, errors }),
      json(`${evidence}/cleanup.json`, { viewClosed: true, browserCloseAllCalled: true, dataStore: "ephemeral" }),
    ]);
    assertErrors(errors, "none");
  }
}
