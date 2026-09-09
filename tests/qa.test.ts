import { describe, expect, test } from "bun:test";
import { assertErrors, bounded, options, origin } from "../scripts/qa/support";
import type { BrowserError } from "../scripts/qa/support";

describe("QA command contract", () => {
  test("parses comma-separated implemented scenarios in requested order", () => {
    // Given CLI inputs; when parsed; then preserve the machine-consumed values.
    expect(options(["--scenario", "boot,boot-error", "--evidence", "artifacts"]))
      .toEqual({ scenarios: ["boot", "boot-error"], evidence: "artifacts" });
  });
  test.each(["audio-gallery", "audio-blocked", "audio-gallery,audio-blocked", "boot,audio-gallery,boot-error,audio-blocked"])("accepts implemented audio integration %s", (scenario) => {
    // Given real CLI IDs; when parsed; then route all audio scenarios in requested order.
    const parsed = options(["--scenario", scenario, "--evidence", "artifacts"]);
    expect(parsed.scenarios.join(",")).toBe(scenario);
    expect(parsed.evidence).toBe("artifacts");
  });
  test.each(["asset-sheet", "asset-missing", "asset-sheet,asset-missing", "boot,asset-sheet,audio-gallery,asset-missing"])("accepts asset integration %s", (scenario) => {
    const parsed = options(["--scenario", scenario, "--evidence", "artifacts"]);
    expect(parsed.scenarios.join(",")).toBe(scenario);
  });
  test.each(["fixture-load", "fixture-reject", "fixture-load,fixture-reject", "boot,fixture-load,audio-gallery,fixture-reject,asset-sheet"])("accepts fixture integration %s", (scenario) => {
    // Given real incremental scenario IDs; when parsed; then preserve routing order.
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
  test.each(["blocks,blocks", "blocks-edge,unknown", "movement,movement", "movement-edge,unknown", "movement,", "catalog", "catalog-invalid", "fixture-load,fixture-load", "fixture-reject,unknown", "fixture-load,", "fixture-reject,catalog", "", "asset-sheet,", ",asset-missing", "asset-sheet,asset-sheet", "asset-missing,asset-missing", "asset-sheet,built-flow", "asset-missing,unknown", "unknown", "all", "boot,unknown", "boot,", "boot,boot", "audio-gallery,unknown", "audio-gallery,audio-gallery", "polish", "editor-shell,editor-shell", "editor-focus,editor-focus", "editor-shell,unknown", "editor-focus,unknown", "platforms,platforms", "platforms-edge,platforms-edge", "platforms,unknown", "platforms-edge,unknown", "hazards,hazards", "hazards-edge,hazards-edge", "hazards,unknown", "hazards-edge,unknown", "water,water", "water-edge,water-edge", "water,unknown", "water-edge,unknown"])("rejects unsupported scenario %s", (scenario) => {
    expect(() => options(["--scenario", scenario, "--evidence", "artifacts"])).toThrow();
  });
  test("rejects missing required flags and misspelled flags", () => {
    expect(() => options(["--scenario", "boot"])).toThrow();
    expect(() => options(["--scenaro", "boot", "--evidence", "artifacts"])).toThrow();
  });
  test("unknown scenario exits nonzero through the real entry point", async () => {
    // Given a future/unimplemented registry ID; when invoking QA; then fail closed.
    const evidence = `.omo/evidence/qa-cli-${crypto.randomUUID()}`;
    const child = Bun.spawn([process.execPath, "run", "scripts/qa.ts", "--scenario", "built-flow", "--evidence", evidence],
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
