import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { boot } from "./qa/boot";
import { bootError } from "./qa/boot-error";
import { audioGallery, audioBlocked } from "./qa/audio";
import { assetSheet, assetMissing } from "./qa/assets";
import { fixtureLoad, fixtureReject } from "./qa/fixtures";
import { movement, movementEdge } from "./qa/movement";
import { blocks, blocksEdge } from "./qa/blocks";
import { enemiesGround, enemiesGroundEdge } from "./qa/enemies-ground";
import { editorShellScenario, editorFocusScenario } from "./qa/editor";
import { platforms, platformsEdge } from "./qa/platforms";
import { hazards, hazardsEdge } from "./qa/hazards";
import { water, waterEdge } from "./qa/water";
import { catalogInvalid, catalogScenario, paintHistory, paintHistoryEdge } from "./qa/paint";
import { areas, areasEdge } from "./qa/areas";
import { storage, storageFailure } from "./qa/storage";
import { goals, goalsEdge } from "./qa/goals";
import { selection, selectionEdge } from "./qa/selection";
import { assertPortFree, bounded, json, options, origin } from "./qa/support";

const { scenarios, evidence: root } = options(Bun.argv.slice(2));
let evidence = root;
for (let attempt = 2; await Bun.file(`${evidence}/actions.json`).exists(); attempt++) {
  evidence = `${root}/attempt-${attempt}`;
}
await mkdir(evidence, { recursive: true });
const actions: unknown[] = [];
let passed = false;
let portFree = false;
let preview: ReturnType<typeof Bun.spawn> | undefined;
let previewExit: number | null = null;
try {
  await assertPortFree();
  // Rebuild every invocation, so a stale dist can never be accepted as QA proof.
  const build = Bun.spawn([process.execPath, "run", "build"], {
    stdout: Bun.file(`${evidence}/build.txt`), stderr: "pipe",
  });
  try {
    const stderr = new Response(build.stderr).text();
    assert.equal(await bounded(build.exited, "fresh build"), 0, await stderr);
  } finally {
    if (build.exitCode === null) build.kill();
    await build.exited;
  }
  actions.push({ command: "bun run build", exitCode: 0, cwd: process.cwd() });
  const server = Bun.spawn([process.execPath, "run", "scripts/preview.ts"], {
    stdout: "pipe", stderr: Bun.file(`${evidence}/preview-stderr.txt`),
  });
  preview = server;
  const ready = (async () => {
    const reader = server.stdout.getReader();
    let output = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) throw new Error(`Preview exited before READY: ${output}`);
        output += new TextDecoder().decode(value);
        if (output.includes(`READY ${origin}/`)) {
          await Bun.write(`${evidence}/preview.txt`, output);
          return;
        }
      }
    } finally {
      reader.releaseLock();
    }
  })();
  await bounded(ready, "preview READY stdout event");
  actions.push({ command: "bun run scripts/preview.ts", pid: server.pid, ready: origin });
  const http: unknown[] = [];
  for (const [route, path] of [["/", "dist/index.html"], ["/app.js", "dist/app.js"], ["/style.css", "dist/style.css"]]) {
    assert(route && path);
    const response = await fetch(`${origin}${route}`, { signal: AbortSignal.timeout(10_000) });
    assert.equal(response.status, 200);
    const served = new Uint8Array(await response.arrayBuffer());
    assert.deepEqual(served, await Bun.file(path).bytes(), `Preview must serve fresh ${path}`);
    http.push({ route, status: response.status, contentType: response.headers.get("content-type"),
      file: resolve(path), bytes: served.length, sha256: new Bun.CryptoHasher("sha256").update(served).digest("hex") });
  }
  const source = await fetch(`${origin}/src/main.ts`, { signal: AbortSignal.timeout(10_000) });
  assert.equal(source.status, 404, "Preview must not expose source");
  await json(`${evidence}/http.json`, http);
  for (const scenario of scenarios) {
    const directory = `${evidence}/${scenario}`;
    await mkdir(directory, { recursive: true });
    switch (scenario) {
      case "boot": await boot(directory); break;
      case "boot-error": await bootError(directory); break;
      case "audio-gallery": await audioGallery(directory, origin); break;
      case "audio-blocked": await audioBlocked(directory, origin); break;
      case "asset-sheet": await assetSheet(directory, origin); break;
      case "asset-missing": await assetMissing(directory, origin, "/app.js"); break;
      case "fixture-load": await fixtureLoad(directory, origin); break;
      case "fixture-reject": await fixtureReject(directory, origin); break;
      case "movement": await movement(directory, origin); break;
      case "movement-edge": await movementEdge(directory, origin); break;
      case "blocks": await blocks(directory, origin); break;
      case "blocks-edge": await blocksEdge(directory, origin); break;
      case "enemies-ground": await enemiesGround(directory, origin); break;
      case "enemies-ground-edge": await enemiesGroundEdge(directory, origin); break;
      case "editor-shell": await editorShellScenario(directory, origin); break;
      case "editor-focus": await editorFocusScenario(directory, origin); break;
      case "platforms": await platforms(directory, origin); break;
      case "platforms-edge": await platformsEdge(directory, origin); break;
      case "hazards": await hazards(directory, origin); break;
      case "hazards-edge": await hazardsEdge(directory, origin); break;
      case "water": await water(directory, origin); break;
      case "water-edge": await waterEdge(directory, origin); break;
      case "paint-history": await paintHistory(directory, origin); break;
      case "paint-history-edge": await paintHistoryEdge(directory, origin); break;
      case "catalog": await catalogScenario(directory, origin); break;
      case "catalog-invalid": await catalogInvalid(directory, origin); break;
      case "areas": await areas(directory, origin); break;
      case "areas-edge": await areasEdge(directory, origin); break;
      case "storage": await storage(directory, origin); break;
      case "storage-failure": await storageFailure(directory, origin); break;
      case "goals": await goals(directory, origin); break;
      case "goals-edge": await goalsEdge(directory, origin); break;
      case "selection": await selection(directory, origin); break;
      case "selection-edge": await selectionEdge(directory, origin); break;
      default: { const exhaustive: never = scenario; throw new Error(`Unimplemented scenario: ${exhaustive}`); }
    }
    actions.push({ scenario, status: "PASS", evidence: directory });
  }
  passed = true;
  console.log(`PASS ${scenarios.join(",")} -> ${evidence}`);
} catch (error) {
  await json(`${evidence}/failure.json`, { message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : null });
  throw error;
} finally {
  try {
    if (preview) {
      if (preview.exitCode === null) preview.kill();
      previewExit = await bounded(preview.exited, "preview process teardown");
    }
    await assertPortFree();
    portFree = true;
  } finally {
    await Promise.all([
      json(`${evidence}/actions.json`, { passed, scenarios, actions }),
      json(`${evidence}/cleanup.json`, { previewPid: preview?.pid ?? null, previewExit, port: 4173, portFree,
        browserReceipts: scenarios.flatMap((scenario) => scenario === "audio-blocked"
          ? [`${scenario}/constructor/cleanup.json`, `${scenario}/resume/cleanup.json`]
          : scenario === "asset-sheet" ? [`${scenario}/browser-cleanup.json`]
          : scenario === "asset-missing" ? [`${scenario}/fault-cleanup.json`]
          : [`${scenario}/cleanup.json`]) }),
    ]);
  }
}
