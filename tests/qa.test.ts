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
  test.each(["unknown", "all", "boot,unknown", "boot,", "boot,boot", "audio-gallery,unknown", "audio-gallery,audio-gallery", "polish"])("rejects unsupported scenario %s", (scenario) => {
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
