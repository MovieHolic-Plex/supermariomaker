import { describe, expect, test } from "bun:test";
import { assertErrors, bounded, options, origin } from "../scripts/qa/support";
import type { BrowserError } from "../scripts/qa/support";

describe("QA command contract", () => {
  test("parses comma-separated implemented scenarios in requested order", () => {
    expect(options(["--scenario", "boot,boot-error", "--evidence", "artifacts"]))
      .toEqual({ scenarios: ["boot", "boot-error"], evidence: "artifacts" });
  });
  test.each(["audio-gallery", "audio-blocked", "audio-gallery,audio-blocked", "boot,audio-gallery,boot-error,audio-blocked"])("accepts implemented audio integration %s", (scenario) => {
    const parsed = options(["--scenario", scenario, "--evidence", "artifacts"]);
    expect(parsed.scenarios.join(",")).toBe(scenario);
    expect(parsed.evidence).toBe("artifacts");
  });
  test.each(["asset-sheet", "asset-missing", "asset-sheet,asset-missing", "boot,asset-sheet,audio-gallery,asset-missing"])("accepts asset integration %s", (scenario) => {
    const parsed = options(["--scenario", scenario, "--evidence", "artifacts"]);
    expect(parsed.scenarios.join(",")).toBe(scenario);
  });
  test.each(["fixture-load", "fixture-reject", "fixture-load,fixture-reject", "boot,fixture-load,audio-gallery,fixture-reject,asset-sheet"])("accepts fixture integration %s", (scenario) => {
    expect(options(["--scenario", scenario, "--evidence", "artifacts"]).scenarios.join(",")).toBe(scenario);
  });
  test.each(["movement", "movement-edge", "movement,movement-edge", "boot,movement,fixture-load"]) ("accepts movement integration %s", scenario => {
    expect(options(["--scenario", scenario, "--evidence", "artifacts"]).scenarios.join(",")).toBe(scenario);
  });
  test.each(["blocks", "blocks-edge", "blocks,blocks-edge", "movement,blocks-edge"]) ("accepts blocks integration %s", scenario => {
    expect(options(["--scenario", scenario, "--evidence", "artifacts"]).scenarios.join(",")).toBe(scenario);
  });
  test.each(["enemies-ground", "enemies-ground-edge", "enemies-ground,enemies-ground-edge"]) ("accepts live ground integration %s", scenario => {
    expect(options(["--scenario", scenario, "--evidence", "artifacts"]).scenarios.join(",")).toBe(scenario);
  });
  test.each(["editor-shell", "editor-focus", "editor-shell,editor-focus"]) ("accepts editor shell integration %s", scenario => {
    expect(options(["--scenario", scenario, "--evidence", "artifacts"]).scenarios.join(",")).toBe(scenario);
  });
  test.each(["platforms", "platforms-edge", "platforms,platforms-edge"]) ("accepts live platform integration %s", scenario => {
    expect(options(["--scenario", scenario, "--evidence", "artifacts"]).scenarios.join(",")).toBe(scenario);
  });
  test.each(["hazards", "hazards-edge", "hazards,hazards-edge"]) ("accepts live hazard integration %s", scenario => {
    expect(options(["--scenario", scenario, "--evidence", "artifacts"]).scenarios.join(",")).toBe(scenario);
  });
  test.each(["water", "water-edge", "water,water-edge"]) ("accepts live water integration %s", scenario => {
    expect(options(["--scenario", scenario, "--evidence", "artifacts"]).scenarios.join(",")).toBe(scenario);
  });
  test.each(["paint-history", "paint-history-edge", "paint-history,paint-history-edge", "catalog", "catalog-invalid", "catalog,catalog-invalid", "paint-history,catalog"]) ("accepts paint and catalog integration %s", scenario => {
    expect(options(["--scenario", scenario, "--evidence", "artifacts"]).scenarios.join(",")).toBe(scenario);
  });
  test.each(["areas", "areas-edge", "areas,areas-edge", "paint-history,areas"]) ("accepts areas integration %s", scenario => {
    expect(options(["--scenario", scenario, "--evidence", "artifacts"]).scenarios.join(",")).toBe(scenario);
  });
  test.each(["storage", "storage-failure", "storage,storage-failure", "paint-history,storage"]) ("accepts storage integration %s", scenario => {
    expect(options(["--scenario", scenario, "--evidence", "artifacts"]).scenarios.join(",")).toBe(scenario);
  });
  test.each(["goals", "goals-edge", "goals,goals-edge", "areas,goals"]) ("accepts goals integration %s", scenario => {
    expect(options(["--scenario", scenario, "--evidence", "artifacts"]).scenarios.join(",")).toBe(scenario);
  });
  test.each(["selection", "selection-edge", "selection,selection-edge", "paint-history,selection"]) ("accepts selection integration %s", scenario => {
    expect(options(["--scenario", scenario, "--evidence", "artifacts"]).scenarios.join(",")).toBe(scenario);
  });
  test.each(["library", "library-conflict", "library,library-conflict"]) ("accepts library integration %s", scenario => {
    expect(options(["--scenario", scenario, "--evidence", "artifacts"]).scenarios.join(",")).toBe(scenario);
  });
  test.each(["play-isolation", "play-isolation-edge", "play-isolation,play-isolation-edge"]) ("accepts play isolation integration %s", scenario => {
    expect(options(["--scenario", scenario, "--evidence", "artifacts"]).scenarios.join(",")).toBe(scenario);
  });
  test.each(["files", "files-invalid", "schema-roundtrip", "schema-reject", "files,files-invalid,schema-roundtrip,schema-reject"]) ("accepts files integration %s", scenario => {
    expect(options(["--scenario", scenario, "--evidence", "artifacts"]).scenarios.join(",")).toBe(scenario);
  });
  test.each(["samples", "samples-invalid", "samples,samples-invalid"]) ("accepts sample integration %s", scenario => {
    expect(options(["--scenario", scenario, "--evidence", "artifacts"]).scenarios.join(",")).toBe(scenario);
  });
  test.each(["capacity", "capacity-reject", "capacity,capacity-reject"]) ("accepts capacity integration %s", scenario => {
    expect(options(["--scenario", scenario, "--evidence", "artifacts"]).scenarios.join(",")).toBe(scenario);
  });
  test.each(["polish", "polish-regression", "polish,polish-regression"]) ("accepts polish integration %s", scenario => {
    expect(options(["--scenario", scenario, "--evidence", "artifacts"]).scenarios.join(",")).toBe(scenario);
  });
  test.each(["built-flow", "built-failure", "built-flow,built-failure"])("accepts built documentation flow %s", scenario => {
    expect(options(["--scenario", scenario, "--evidence", "artifacts"]).scenarios.join(",")).toBe(scenario);
  });
  test.each(["blocks,blocks", "blocks-edge,unknown", "movement,movement", "movement-edge,unknown", "movement,", "fixture-load,fixture-load", "fixture-reject,unknown", "fixture-load,", "", "asset-sheet,", ",asset-missing", "asset-sheet,asset-sheet", "asset-missing,asset-missing", "asset-sheet,not-a-scenario", "asset-missing,unknown", "unknown", "all", "boot,unknown", "boot,", "boot,boot", "audio-gallery,unknown", "audio-gallery,audio-gallery", "editor-shell,editor-shell", "editor-focus,editor-focus", "editor-shell,unknown", "editor-focus,unknown", "platforms,platforms", "platforms-edge,platforms-edge", "platforms,unknown", "platforms-edge,unknown", "hazards,hazards", "hazards-edge,hazards-edge", "hazards,unknown", "hazards-edge,unknown", "water,water", "water-edge,water-edge", "water,unknown", "water-edge,unknown", "paint-history,paint-history", "catalog,catalog", "paint-history,unknown", "catalog-invalid,unknown", "areas,areas", "areas-edge,areas-edge", "areas,unknown", "areas-edge,unknown", "storage,storage", "storage-failure,storage-failure", "storage,unknown", "storage-failure,unknown", "goals,goals", "goals-edge,goals-edge", "goals,unknown", "goals-edge,unknown", "selection,selection", "selection-edge,selection-edge", "selection,unknown", "selection-edge,unknown", "samples,samples", "samples-invalid,samples-invalid", "samples,unknown", "capacity,capacity", "capacity-reject,capacity-reject", "capacity,unknown", "polish,polish", "polish-regression,polish-regression", "polish,unknown", "built-flow,built-flow", "built-failure,unknown"])("rejects unsupported scenario %s", (scenario) => {
    expect(() => options(["--scenario", scenario, "--evidence", "artifacts"])).toThrow();
  });
  test("rejects missing required flags and misspelled flags", () => {
    expect(() => options(["--scenario", "boot"])).toThrow();
    expect(() => options(["--scenaro", "boot", "--evidence", "artifacts"])).toThrow();
  });
  test("unknown scenario exits nonzero through the real entry point", async () => {
    const evidence = `.omo/evidence/qa-cli-${crypto.randomUUID()}`;
    const child = Bun.spawn([process.execPath, "run", "scripts/qa.ts", "--scenario", "not-a-scenario", "--evidence", evidence],
      { stdout: "pipe", stderr: "pipe" });
    try {
      expect(await bounded(child.exited, "unknown scenario exit")).not.toBe(0);
      expect(await Bun.file(`${evidence}/actions.json`).exists()).toBe(false);
    } finally {
      if (child.exitCode === null) child.kill();
      await child.exited;
    }
  });
});

describe("QA browser error policy", () => {
  const induced: readonly BrowserError[] = [
    { kind: "console", text: "Failed to load resource: net::ERR_FAILED", url: `${origin}/app.js` },
    { kind: "console", text: "Application load failed TypeError: Failed to fetch dynamically imported module", url: `${origin}/` },
  ];
  test("accepts only the asserted deliberate import fault", () => {
    expect(() => assertErrors(induced, "bundle-abort")).not.toThrow();
    expect(() => assertErrors(induced, "none")).toThrow();
    expect(() => assertErrors([], "bundle-abort")).toThrow();
  });
  test.each(["console", "pageerror", "resource"] as const)("unexpected %s fails even beside an induced fault", (kind) => {
    const errors = [...induced, { kind, text: "unexpected defect", url: `${origin}/` }];
    expect(() => assertErrors(errors, "bundle-abort")).toThrow();
  });
  test("a 404 allowance does not hide an unrelated resource failure", () => {
    const error = { kind: "resource", text: "Failed to load resource: 404", url: `${origin}/app.js` } as const;
    expect(() => assertErrors([error], "html-404")).toThrow();
  });
});
