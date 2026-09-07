import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { assertErrors, installBootObserver, json, origin, viewport } from "./support";
import type { BrowserError } from "./support";

export async function bootError(evidence: string) {
  // WebView has no BrowserContext API. Playwright supplies independently scoped
  // init scripts and request routes for these faults without touching a profile.
  const browser = await chromium.launch({ channel: "chrome", headless: true, timeout: 10_000 });
  const contexts: { branch: string; contextClosed: boolean; pagesClosed: boolean }[] = [];
  try {
    await json(`${evidence}/versions.json`, { driver: "playwright-core", version: browser.version(), viewport });
    for (const branch of ["indexeddb-absent", "indexeddb-denied", "canvas-unavailable", "audio-unavailable", "bundle-abort", "html-404"] as const) {
      const context = await browser.newContext({ viewport, serviceWorkers: "block" });
      const receipt = { branch, contextClosed: false, pagesClosed: false };
      contexts.push(receipt);
      context.on("close", () => { receipt.contextClosed = true; });
      const actions: string[] = [];
      const errors: BrowserError[] = [];
      const consoleLog: unknown[] = [];
      const responses = new Map<string, number>();
      const pages = [];
      let completed = false;
      try {
        const page = await context.newPage();
        pages.push(page);
        page.setDefaultTimeout(10_000);
        page.on("response", (response) => responses.set(response.url(), response.status()));
        page.on("console", (message) => {
          consoleLog.push({ type: message.type(), text: message.text(), location: message.location() });
          if (message.type() === "error") errors.push({ kind: "console", text: message.text(), url: message.location().url });
        });
        page.on("pageerror", (error) => errors.push({ kind: "pageerror", text: error.message, url: page.url() }));
        if (branch !== "html-404") await context.addInitScript(installBootObserver);
        switch (branch) {
          case "indexeddb-absent":
            await context.addInitScript(() => Object.defineProperty(globalThis, "indexedDB", { value: undefined }));
            break;
          case "indexeddb-denied":
            await context.addInitScript(() => Object.defineProperty(globalThis, "indexedDB", {
              get() { throw new DOMException("QA storage access denied", "SecurityError"); },
            }));
            break;
          case "canvas-unavailable":
            await context.addInitScript(() => { HTMLCanvasElement.prototype.getContext = () => null; });
            break;
          case "audio-unavailable":
            await context.addInitScript(() => Object.defineProperty(globalThis, "AudioContext", { value: undefined }));
            break;
          case "bundle-abort":
            await context.route(`${origin}/app.js`, (route) => route.abort("failed"));
            break;
          case "html-404":
            break;
        }
        const url = `${origin}/${branch === "html-404" ? "missing.html" : ""}`;
        actions.push(`Given isolated context: ${branch}`, `navigate ${url}`);
        const response = await page.goto(url, { waitUntil: "load" });
        if (branch === "html-404") {
          assert.equal(response?.status(), 404);
          assert.match(response?.headers()["content-type"] ?? "", /text\/plain/);
          assert.equal(await page.locator("body").innerText(), "Not Found\n");
          // Playwright omits Chromium's automatic favicon response events.
          // Assert its real controlled 404 over HTTP rather than blanket-ignore it.
          const favicon = await fetch(`${origin}/favicon.ico`, { signal: AbortSignal.timeout(10_000) });
          assert.equal(favicon.status, 404);
          responses.set(`${origin}/favicon.ico`, favicon.status);
        } else {
          assert.equal(response?.status(), 200);
          await page.evaluate(() => Reflect.get(globalThis, "__qaBootReady"));
          assert.equal(await page.getByTestId("error-dialog").isVisible(), true);
          assert.equal(await page.getByTestId("retry").isEnabled(), true);
          await page.screenshot({ path: `${evidence}/${branch}-error.png` });
          switch (branch) {
            case "canvas-unavailable":
              assert.equal(await page.getByTestId("new-course").count(), 0);
              break;
            case "bundle-abort": {
              assert.equal(await page.getByTestId("library").count(), 0);
              assertErrors(errors, "bundle-abort");
              await context.unroute(`${origin}/app.js`);
              const navigation = page.waitForEvent("load");
              actions.push("unroute app.js; click retry");
              await page.getByTestId("retry").click();
              await navigation;
              await page.evaluate(() => Reflect.get(globalThis, "__qaBootReady"));
              assert.equal(await page.getByTestId("library").isVisible(), true);
              assert.equal(await page.getByTestId("error-dialog").count(), 0);
              break;
            }
            default:
              assert.equal(await page.getByTestId("library").isVisible(), true,
                `${branch}: storage/audio failure must not prevent opening the shell`);
              actions.push("click new-course; fill course-title: 첫 코스; click create-course");
              await page.getByTestId("new-course").click();
              await page.getByTestId("course-title").fill("첫 코스");
              await page.getByTestId("create-course").click();
              assert.equal(await page.getByTestId("editor-canvas").isVisible(), true);
              assert.equal(await page.locator(".workspace h1").textContent(), "첫 코스");
              assert.equal(await page.getByTestId("error-dialog").isVisible(), true);
          }
        }
        await page.screenshot({ path: `${evidence}/${branch}-result.png` });
        completed = true;
      } finally {
        try {
          for (const page of pages) {
            if (!page.isClosed()) await page.screenshot({ path: `${evidence}/${branch}-final.png` });
          }
        } finally {
          await context.close();
          receipt.pagesClosed = pages.every((page) => page.isClosed());
          try {
            if (completed) {
              if (branch === "html-404") {
                for (const error of errors) assert.equal(responses.get(error.url), 404);
              }
              assertErrors(errors, branch === "bundle-abort" || branch === "html-404" ? branch : "none");
              actions.push("PASS asserted real visible outcome and console error policy through context close");
            }
          } finally {
            await Promise.all([
              json(`${evidence}/${branch}-actions.json`, { viewport, actions }),
              json(`${evidence}/${branch}-console.json`, { console: consoleLog, errors, responses: [...responses] }),
            ]);
          }
        }
      }
    }
  } finally {
    await browser.close();
    await json(`${evidence}/cleanup.json`, { contexts, browserDisconnected: !browser.isConnected() });
    assert(contexts.every((context) => context.contextClosed && context.pagesClosed));
    assert.equal(browser.isConnected(), false);
  }
}
