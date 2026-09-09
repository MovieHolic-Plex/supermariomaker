import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "playwright-core";
import { bounded, json } from "./support";

interface Owner { readonly hwnd: string; readonly pid: number; readonly windowClass?: string; readonly visible?: boolean }
interface Row {
  readonly source: string; readonly kind: string; readonly raw?: string;
  readonly data: { readonly owner?: Owner; readonly foreground?: Owner; readonly trusted?: boolean; readonly id?: string; readonly error?: string };
}
interface Signal { readonly promise: Promise<{ readonly ok: boolean; readonly row?: Row; readonly error?: string }>; cancel(): void }
type Watch = (label: string, predicate: (row: Row) => boolean) => Signal;
type Log = (kind: string, data?: unknown) => void;
interface Acquisition {
  readonly target: Owner;
  readonly helper: { command(op: "sample"): Promise<Owner>; command(op: "click", fields: Owner): Promise<unknown> };
  readonly launchedForeground: Signal; readonly waitEvent: Watch;
  readonly boundary: () => Promise<{ readonly focused: boolean; readonly hidden: boolean }>;
  readonly log: Log;
}
function requireEvent(result: Awaited<Signal["promise"]>): Row {
  assert(result.ok && result.row, result.error ?? "Native observer cancelled"); return result.row;
}
/** Native ownership alone is not DOM focus: unchanged ownership still needs the guarded content click. */
export async function acquireOwnedPage({ target, helper, launchedForeground, waitEvent, boundary, log }: Acquisition) {
  const matches = (owner: Owner | undefined) => owner?.hwnd === target.hwnd && owner.pid === target.pid;
  const before = await helper.command("sample"), domBefore = await boundary();
  let changed = !matches(before);
  let nativeRow: Row | undefined;
  const native = waitEvent("acquisition native", row => {
    if (row.source !== "win32" || row.kind !== "foreground-event") return false;
    if (!matches(row.data.owner)) changed = true;
    if (!matches(row.data.owner) || !matches(row.data.foreground)) return false;
    nativeRow = row;
    return true;
  });
  const dom = !domBefore.focused ? waitEvent("acquisition DOM focus", row => row.source === "browser" && row.kind === "dom-focus" && row.data.trusted === true) : null;
  try {
    const result = await helper.command("click", target); log("acquisition-click-result", { result, before, domBefore });
    if (dom) requireEvent(await dom.promise);
    const after = await helper.command("sample"); assert(matches(after), "Fresh native owner after actual client click");
    const ack = nativeRow ?? (changed ? null : requireEvent(await launchedForeground.promise));
    if (ack) assert(matches(ack.data.owner) && matches(ack.data.foreground), "Matching native event and callback-current identity");
    const acquired = await boundary(); assert(acquired.focused && !acquired.hidden, "Acquisition requires actually focused and visible DOM");
    log("initial-acquisition-confirmed", { before, after, ack, acquired,
      nativeProof: nativeRow ? "new event + fresh sample" : changed ? "fresh sample after actual client click" : "subscribed launch + fresh sample" });
    return acquired;
  } finally { native.cancel(); dom?.cancel(); launchedForeground.cancel(); }
}

/** Windows-only disposable ownership registry; no user window mutation or focus emulation. */
export async function startNativeFocus(evidence: string) {
  const trace: unknown[] = [], listeners = new Map<(row: Row) => void, () => void>();
  const log: Log = (kind, data = null) => { trace.push({ source: "harness", kind, data, wallMs: Date.now() }); };
  const receive = (row: Row) => { trace.push({ ...row, receivedWallMs: Date.now() }); for (const listener of [...listeners.keys()]) listener(row); };
  const waitEvent: Watch = (label, predicate) => {
    const deferred = Promise.withResolvers<Awaited<Signal["promise"]>>(); let settled = false;
    const listener = (row: Row) => { if (predicate(row)) finish({ ok: true, row }); };
    const timer = setTimeout(() => finish({ ok: false, error: `Timed out: ${label}` }), 10_000);
    function finish(value: Awaited<Signal["promise"]>) {
      if (settled) return; settled = true; clearTimeout(timer); listeners.delete(listener); log("observer-settled", { label, value }); deferred.resolve(value);
    }
    const cancel = () => finish({ ok: false }); listeners.set(listener, cancel); log("observer-armed", { label });
    return { promise: deferred.promise, cancel };
  };
  log("temporary-directory-register", { prefix: join(tmpdir(), "movement-hook-") });
  const temporary = await mkdtemp(join(tmpdir(), "movement-hook-"));
  const exit = Promise.withResolvers<unknown>();
  const ready = waitEvent("native message loop", row => row.kind === "message-loop-ready");
  const args = ["powershell.exe", "-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-File", fileURLToPath(new URL("./movement-native.ps1", import.meta.url))];
  log("helper-register-before", { args, temporary, exitSubscribedAtSpawn: true });
  const child = Bun.spawn(args, { windowsHide: true, stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, TEMP: temporary, TMP: temporary },
    onExit(proc, exitCode, signalCode, error) { const result = { pid: proc.pid, exitCode, signalCode, error: error ? String(error) : null }; log("helper-exit", result); exit.resolve(result); },
  });
  log("helper-created", { pid: child.pid });
  const stdout = (async () => {
    let text = "";
    for await (const chunk of child.stdout) {
      text += new TextDecoder().decode(chunk); let newline;
      while ((newline = text.indexOf(String.fromCharCode(10))) >= 0) {
        const raw = text.slice(0, newline).trim(); text = text.slice(newline + 1);
        if (raw) { const row: Row = JSON.parse(raw); receive({ ...row, raw }); }
      }
    }
    assert.equal(text.trim(), "", "Complete native JSON lines");
  })();
  const stderr = new Response(child.stderr).text(); let sequence = 0;
  const command = async <T,>(op: string, fields: object = {}): Promise<T> => {
    const id = `native-${++sequence}`;
    const reply = waitEvent(`${id} ${op}`, row => ["reply", "command-error"].includes(row.kind) && row.data.id === id);
    log("native-command-send", { id, op, ...fields }); child.stdin.write(JSON.stringify({ id, op, ...fields }) + String.fromCharCode(10)); await child.stdin.flush();
    const row = requireEvent(await reply.promise); if (row.kind === "command-error") throw new Error(row.data.error);
    assert(row.raw);
    // Our versioned helper is a trusted internal protocol; op determines the result type.
    const parsed: { readonly data: { readonly result: T } } = JSON.parse(row.raw); return parsed.data.result;
  };
  const stop = async () => {
    try {
      await command("stop"); child.stdin.end(); await bounded(exit.promise, "native helper exit event");
    } finally {
      if (child.exitCode === null) { child.kill(); await bounded(exit.promise, "native helper termination event"); }
      await stdout; await Bun.write(`${evidence}/native-helper-stderr.txt`, await stderr);
      for (const cancel of [...listeners.values()]) cancel();
      await rm(temporary, { recursive: true }); log("helper-cleanup", { pid: child.pid, temporary, temporaryRemoved: !existsSync(temporary), listeners: listeners.size });
      await json(`${evidence}/native-focus-trace.json`, trace);
    }
  };
  try { requireEvent(await ready.promise); } catch (error) { await stop(); throw error; }
  let target: Owner | undefined, neutral: Owner | undefined, launch: Signal | undefined;
  const boundary = (page: Page) => page.evaluate(() => ({ focused: document.hasFocus(), hidden: document.hidden }));
  const acquire = async (page: Page) => {
    assert(target && launch);
    return acquireOwnedPage({ target, helper: { command }, launchedForeground: launch, waitEvent, boundary: () => boundary(page), log });
  };
  return {
    log, command, stop,
    watchLaunch(pid: () => number) { launch = waitEvent("owned Chrome launch", row => row.kind === "foreground-event" && row.data.owner?.pid === pid()); },
    async prepare(page: Page, pid: number) {
      await page.exposeBinding("movementNativeRecord", (_source, row: Row) => receive(row));
      const install = () => {
        const emit: (row: unknown) => Promise<void> = Reflect.get(globalThis, "movementNativeRecord");
        for (const event of ["focus", "blur"]) window.addEventListener(event, value => {
          void emit({ source: "browser", kind: `dom-${event}`, wallMs: Date.now(), focused: document.hasFocus(), hidden: document.hidden, data: { trusted: value.isTrusted } });
        });
      };
      await page.addInitScript(install); await page.evaluate(install);
      const result = await command<{ readonly windows: readonly Owner[] }>("windows", { pid });
      const candidates = result.windows.filter(owner => owner.windowClass === "Chrome_WidgetWin_1" && owner.visible);
      assert.equal(candidates.length, 1); target = candidates[0]; assert(target);
      log("owned-browser-window", target); await acquire(page);
      neutral = await command<Owner>("neutral"); log("owned-neutral", neutral);
      assert.deepEqual(await boundary(page), { focused: true, hidden: false });
    },
    acquire,
    async blur(page: Page) {
      assert(target && neutral);
      assert.deepEqual(await boundary(page), { focused: true, hidden: false });
      const before = await command<Owner>("sample"); assert.equal(before.hwnd, target.hwnd); assert.equal(before.pid, target.pid);
      const destination = neutral;
      const native = waitEvent("neutral foreground", row => row.kind === "foreground-event" && row.data.owner?.hwnd === destination.hwnd && row.data.owner.pid === destination.pid);
      const dom = waitEvent("actual trusted DOM blur", row => row.source === "browser" && row.kind === "dom-blur" && row.data.trusted === true);
      try {
        await command("click", destination); const ack = requireEvent(await native.promise); requireEvent(await dom.promise);
        assert.equal(ack.data.foreground?.hwnd, destination.hwnd); assert.equal(ack.data.foreground?.pid, destination.pid);
        const after = await command<Owner>("sample"); assert.equal(after.hwnd, destination.hwnd); assert.equal(after.pid, destination.pid);
        assert.deepEqual(await boundary(page), { focused: false, hidden: false }); log("trusted-native-blur-confirmed", { before, after, ack });
      } finally { native.cancel(); dom.cancel(); }
    },
    async restore() { const result = await command<{ readonly remaining: number }>("restore"); assert.equal(result.remaining, 0); },
    async verifyExited(pids: readonly number[]) { const result = await command<{ readonly live: readonly number[] }>("alive", { pids }); assert.deepEqual(result.live, []); log("browser-pids-absent", { pids, result }); },
  };
}
