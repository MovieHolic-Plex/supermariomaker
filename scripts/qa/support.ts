import assert from "node:assert/strict";
import { parseArgs } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

export const origin = "http://127.0.0.1:4173";
export const viewport = { width: 1280, height: 720 } as const;

export function options(args: readonly string[]) {
  const { values } = parseArgs({
    args: [...args], strict: true, allowPositionals: false,
    options: { scenario: { type: "string" }, evidence: { type: "string" } },
  });
  assert(values.scenario && values.evidence, "Required: --scenario ID[,ID...] --evidence DIR");
  const implemented = ["boot", "boot-error", "audio-gallery", "audio-blocked", "asset-sheet", "asset-missing", "fixture-load", "fixture-reject", "movement", "movement-edge", "blocks", "blocks-edge", "enemies-ground", "enemies-ground-edge", "editor-shell", "editor-focus", "platforms", "platforms-edge", "hazards", "hazards-edge"] as const;
  const scenarios = values.scenario.split(",").map((value) => {
    const scenario = implemented.find((id) => id === value);
    assert(scenario, `Unimplemented or unknown scenario: ${value}`);
    return scenario;
  });
  assert.equal(new Set(scenarios).size, scenarios.length, "Duplicate scenario");
  return { scenarios, evidence: values.evidence };
}

export async function bounded<T>(operation: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 10_000);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

export function json(path: string, value: unknown) {
  return Bun.write(path, `${JSON.stringify(value, null, 2)}\n`);
}

export type BrowserError = {
  readonly kind: "console" | "pageerror" | "resource";
  readonly text: string;
  readonly url: string;
};

export function assertErrors(errors: readonly BrowserError[], fault: "none" | "bundle-abort" | "html-404") {
  const unexpected = errors.filter((error) => {
    if (error.kind === "pageerror" || fault === "none") return true;
    switch (fault) {
      case "bundle-abort":
        return !(error.url === `${origin}/app.js` && /Failed to load resource: net::ERR_FAILED/.test(error.text))
          && !(error.kind === "console" && error.text.startsWith("Application load failed "));
      case "html-404":
        // A plain-text 404 document has no inline favicon; Chrome also asks
        // for the default icon. The scenario asserts both actual HTTP statuses.
        return !([`${origin}/missing.html`, `${origin}/favicon.ico`].includes(error.url)
          && /Failed to load resource:.*404/.test(error.text));
      default: {
        const exhaustive: never = fault;
        throw new Error(`Unexpected fault: ${exhaustive}`);
      }
    }
  });
  assert.deepEqual(unexpected, [], "Unexpected browser errors");
  if (fault === "bundle-abort") {
    assert.equal(errors.filter((error) => error.text.startsWith("Application load failed ")).length, 1,
      "Aborted bundle must reach the inline import error handler exactly once");
  }
}

// Injected before navigation, not shipped in the app. Observes real DOM startup,
// including fast imports, without polling or a product mutation/success hook.
export function installBootObserver() {
  Object.defineProperty(globalThis, "__qaBootReady", { value: new Promise<void>((resolve, reject) => {
    const observer = new MutationObserver(() => {
      if (document.querySelector('[data-testid="library"], [data-testid="error-dialog"] [data-testid="retry"]')) {
        observer.disconnect();
        clearTimeout(timer);
        resolve();
      }
    });
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error("App startup did not render")); }, 10_000);
    observer.observe(document, { childList: true, subtree: true });
  }) });
}

export async function assertPortFree() {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 4173, fetch: () => new Response(null) });
  await probe.stop(true);
}

/** TASK6's proven native Chrome launch/teardown, made available to new scenarios
 * without changing the independently owned movement scenario. No daily-driver profile.
 */
export async function nativeChrome(evidence: string) {
  const profile = await mkdtemp(resolve(evidence, "chrome-profile-"));
  const args = ["--no-first-run", "--no-default-browser-check", "--force-device-scale-factor=1",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
    "--disable-features=CalculateNativeWinOcclusion"];
  const child = Bun.spawn(["C:/Program Files/Google/Chrome/Application/chrome.exe", `--user-data-dir=${profile}`,
    "--remote-debugging-port=0", ...args, "about:blank"], { stdout: "ignore", stderr: "pipe" });
  await json(`${evidence}/resources.json`, { pid: child.pid, profile, args, port: "native ephemeral CDP", state: "registered" });
  const ready = Promise.withResolvers<string>();
  const stderr = (async () => {
    let text = "";
    for await (const chunk of child.stderr) {
      text += new TextDecoder().decode(chunk);
      const endpoint = /DevTools listening on (ws:\/\/[^\s]+)/.exec(text)?.[1]; if (endpoint) ready.resolve(endpoint);
    }
    ready.reject(new Error("Native Chrome exited before DevTools readiness")); return text;
  })();
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | null = null;
  const close = async () => {
    let terminationRequested = false;
    try {
      if (browser?.isConnected()) await (await browser.newBrowserCDPSession()).send("Browser.close");
    } finally {
      // Close CDP before joining the native child. Explicitly terminate our owned
      // launcher if still present; cleanup must not depend on Chrome background shutdown timing.
      if (browser) await browser.close();
      if (child.exitCode === null) { terminationRequested = true; child.kill(); }
      await bounded(child.exited, "owned Chrome termination");
      await Bun.write(`${evidence}/chrome-stderr.txt`, await stderr);
      await rm(profile, { recursive: true });
      await json(`${evidence}/native-cleanup.json`, { pid: child.pid, exitCode: child.exitCode, terminationRequested,
        profileRemoved: !existsSync(profile), browserConnected: browser?.isConnected() ?? false });
    }
  };
  try {
    browser = await chromium.connectOverCDP(await bounded(ready.promise, "native Chrome DevTools stderr event"), { timeout: 10_000 });
    const context = browser.contexts()[0]; assert(context, "Native isolated default context");
    return { browser, context, close };
  } catch (error) { await close(); throw error; }
}
