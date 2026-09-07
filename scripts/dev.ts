const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 4173,
  routes: {
    "/": () => new Response(Bun.file("index.html")),
    "/style.css": () => new Response(Bun.file("src/style.css")),
    "/app.js": async () => {
      const result = await Bun.build({ entrypoints: ["src/main.ts"], target: "browser", format: "esm" });
      const output = result.outputs[0];
      if (!result.success || !output) {
        console.error("Browser build failed", result.logs);
        return new Response("Browser build failed\n", { status: 500 });
      }
      return new Response(output, { headers: { "Content-Type": "text/javascript", "Cache-Control": "no-store" } });
    },
  },
  fetch() { return new Response("Not Found\n", { status: 404 }); },
});
console.log(`READY ${server.url}`);
process.on("SIGTERM", async () => { await server.stop(true); process.exit(0); });
process.on("SIGINT", async () => { await server.stop(true); process.exit(0); });
