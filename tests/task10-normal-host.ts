import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { bounded, installBootObserver, json } from "../scripts/qa/support";
import { editorShellScenario, editorFocusScenario } from "../scripts/qa/editor";
import { hostRegressions } from "./task10-host-regression";

// Private immutable build of the REAL normal entry, never the editor-only host or shared dist.
const evidence = Bun.argv[2];
assert(evidence, "Pass a fresh evidence directory");
await mkdir(evidence, { recursive: true });
const inputs: Record<string, string> = {};
const sources = new Map<string, string>();
for await (const path of new Bun.Glob("src/**/*.{ts,css}").scan(".")) {
  const text = await Bun.file(path).text(); sources.set(resolve(path), text);
  inputs[path] = Bun.CryptoHasher.hash("sha256", text, "hex");
  await Bun.write(`${evidence}/source/${path}`, text);
}
for (const path of ["scripts/qa/editor.ts", "scripts/qa/editor-host.ts", "scripts/qa/support.ts", "tests/task10-normal-host.ts", "tests/task10-host-regression.ts", "tests/viewport.test.ts", "index.html", "tsconfig.json", "package.json"]) {
  inputs[path] = Bun.CryptoHasher.hash("sha256", await Bun.file(path).bytes(), "hex");
}
const build = await Bun.build({ entrypoints: ["src/main.ts"], target: "browser", format: "esm", minify: true, plugins: [{ name: "task10-frozen-inputs", setup(builder) {
  builder.onLoad({ filter: /\.ts$/ }, args => {
    const contents = sources.get(resolve(args.path)); assert(contents !== undefined, `Unfrozen browser input ${args.path}`);
    return { contents, loader: "ts" };
  });
} }] });
assert(build.success, JSON.stringify(build.logs));
const output = build.outputs[0]; assert(output);
const javascript = await output.text(), html = await Bun.file("index.html").text(), css = sources.get(resolve("src/style.css")); assert(css);
await Bun.write(`${evidence}/app.js`, javascript);
await Bun.write(`${evidence}/index.html`, html);
await Bun.write(`${evidence}/style.css`, css);
await json(`${evidence}/build.json`, { inputs, entry: "src/main.ts", sha256: Bun.CryptoHasher.hash("sha256", javascript, "hex"), frozenInMemorySources: true, sharedDistUntouched: true });
const disposal = Promise.withResolvers<unknown>();
const server = Bun.serve({ hostname: "127.0.0.1", port: 4185, async fetch(request) {
  switch (new URL(request.url).pathname) {
    case "/__task10_cleanup": disposal.resolve(await request.json()); return new Response(null, { status: 204 });
    case "/": return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
    case "/app.js": return new Response(javascript, { headers: { "content-type": "text/javascript; charset=utf-8" } });
    case "/style.css": return new Response(css, { headers: { "content-type": "text/css; charset=utf-8" } });
    default: return new Response("Not Found\n", { status: 404 });
  }
} });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let passed = false;
const errors: string[] = [];
try {
  browser = await chromium.launch({ channel: "chrome", headless: true, timeout: 10_000 });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  try {
    const page = await context.newPage(); page.setDefaultTimeout(10_000);
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    await page.addInitScript(installBootObserver);
    await page.goto("http://127.0.0.1:4185/", { waitUntil: "load" });
    await bounded(page.evaluate(() => Reflect.get(globalThis, "__qaBootReady")), "normal boot");
    await page.screenshot({ path: `${evidence}/library.png` });
    await page.getByTestId("new-course").click();
    await page.getByTestId("course-title").fill("첫 코스");
    await page.screenshot({ path: `${evidence}/new-course.png` });
    await page.getByTestId("create-course").click();
    await page.screenshot({ path: `${evidence}/created-course.png` });
    const baseline = await page.evaluate(() => {
      const canvas = document.querySelector('[data-testid="editor-canvas"]');
      return { title: document.title, text: document.body.innerText, editorViews: document.querySelectorAll('[data-testid="editor-view"]').length,
        canvas: canvas instanceof HTMLCanvasElement ? { width: canvas.width, height: canvas.height, alpha: canvas.getContext("2d")?.getImageData(0, 0, 1, 1).data[3] } : null };
    });
    await json(`${evidence}/actions.json`, { url: page.url(), browser: browser.version(), actions: ["navigate /", "click new-course", "fill course-title: 첫 코스", "click create-course"], baseline, errors });
    assert.deepEqual(errors, []);
    assert.equal(baseline.editorViews, 1, "Normal New Course must mount the actual editor view, not a placeholder canvas");
    assert.equal(await page.evaluate('"__qa" in globalThis'), false, "Normal / must not expose QA observations");
  } finally { await context.close(); }
  if (Bun.argv[3] === "--full") {
    await editorShellScenario(`${evidence}/editor-shell`, "http://127.0.0.1:4185");
    await editorFocusScenario(`${evidence}/editor-focus`, "http://127.0.0.1:4185");
    await hostRegressions(browser, evidence, "http://127.0.0.1:4185", disposal.promise);
  }
  passed = true;
  console.log(`PASS normal host ${Bun.argv[3] ?? "causal assertion"} -> ${evidence}`);
} finally {
  try { await browser?.close(); } finally {
    await server.stop(true);
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 4185, fetch: () => new Response(null) }); await probe.stop(true);
    await json(`${evidence}/cleanup.json`, { passed, browserClosed: !browser?.isConnected(), contextsClosed: true, serverStopped: true, port4185Free: true, port4173Untouched: true });
  }
}
