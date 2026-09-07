import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { bounded } from "./support";

// A real, finite LSP roundtrip for hosts whose agent LSP proxy cannot discover
// worktree-local binaries. Uses the same pinned tsserver as tsc, not a fallback
// compiler, ignored error codes, or a replacement for strict typechecking.
const server = Bun.spawn([process.execPath, "node_modules/typescript-language-server/lib/cli.mjs", "--stdio"], {
  stdin: "pipe", stdout: "pipe", stderr: "pipe",
});
const stderr = new Response(server.stderr).text();
const requests = new Map<number, ReturnType<typeof Promise.withResolvers<unknown>>>();
let nextId = 0;

function send(message: unknown) {
  const body = JSON.stringify(message);
  server.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  server.stdin.flush();
}

function request(method: string, params: unknown) {
  const id = ++nextId;
  const result = Promise.withResolvers<unknown>();
  requests.set(id, result);
  send({ jsonrpc: "2.0", id, method, params });
  return bounded(result.promise, method);
}

const messages = (async () => {
  let buffer = Buffer.alloc(0);
  for await (const chunk of server.stdout) {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const boundary = buffer.indexOf("\r\n\r\n");
      if (boundary < 0) break;
      const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, boundary).toString())?.[1]);
      assert(Number.isFinite(length), "Invalid LSP frame");
      if (buffer.length < boundary + 4 + length) break;
      const message: unknown = JSON.parse(buffer.subarray(boundary + 4, boundary + 4 + length).toString());
      buffer = buffer.subarray(boundary + 4 + length);
      assert(message && typeof message === "object");
      if ("id" in message && typeof message.id === "number") {
        if ("method" in message) {
          assert.equal(message.method, "window/workDoneProgress/create");
          send({ jsonrpc: "2.0", id: message.id, result: null });
        } else if ("error" in message) {
          requests.get(message.id)?.reject(new Error(JSON.stringify(message.error)));
        } else if ("result" in message) {
          requests.get(message.id)?.resolve(message.result);
        }
      }
    }
  }
})();

try {
  const initialized = await request("initialize", {
    processId: process.pid, rootUri: pathToFileURL(`${process.cwd()}/`).href,
    capabilities: { textDocument: { publishDiagnostics: {} } },
    initializationOptions: { tsserver: { path: resolve("node_modules/typescript/lib/tsserver.js") } },
  });
  console.log(JSON.stringify({ server: initialized }));
  send({ jsonrpc: "2.0", method: "initialized", params: {} });
  const results: { file: string; diagnostics: readonly unknown[] }[] = [];
  for (const pattern of ["src/**/*.ts", "scripts/**/*.ts", "tests/**/*.ts"]) {
    for await (const file of new Bun.Glob(pattern).scan(".")) {
      const uri = pathToFileURL(resolve(file)).href;
      send({ jsonrpc: "2.0", method: "textDocument/didOpen", params: {
        textDocument: { uri, languageId: "typescript", version: 1, text: await Bun.file(file).text() },
      } });
      // Explicit completed requests avoid mistaking an initial empty push
      // publication for completed semantic analysis (and Windows URI casing).
      const diagnostics: unknown[] = [];
      for (const command of ["syntacticDiagnosticsSync", "semanticDiagnosticsSync"]) {
        const response = await request("workspace/executeCommand", {
          command: "typescript.tsserverRequest", arguments: [command, { file: uri }, { expectsResult: true }],
        });
        assert(response && typeof response === "object" && "body" in response && Array.isArray(response.body));
        diagnostics.push(...response.body);
      }
      results.push({ file, diagnostics });
      console.log(JSON.stringify({ file, diagnostics }));
    }
  }
  assert(results.every((result) => result.diagnostics.length === 0), "LSP reported diagnostics; see output above");
  await request("shutdown", null);
  send({ jsonrpc: "2.0", method: "exit" });
  assert.equal(await bounded(server.exited, "language server exit"), 0);
} finally {
  if (server.exitCode === null) server.kill();
  const exitCode = await server.exited;
  await messages;
  const errors = await stderr;
  if (errors) console.error(errors);
  console.log(JSON.stringify({ cleanup: { languageServerPid: server.pid, exitCode } }));
}
