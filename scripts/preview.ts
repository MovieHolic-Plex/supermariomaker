const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 4173,
  routes: {
    "/": () => new Response(Bun.file("dist/index.html")),
    "/app.js": () => new Response(Bun.file("dist/app.js")),
    "/style.css": () => new Response(Bun.file("dist/style.css")),
  },
  fetch() {
    return new Response("Not Found\n", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  },
});
console.log(`READY ${server.url}`);
process.on("SIGTERM", async () => { await server.stop(true); process.exit(0); });
process.on("SIGINT", async () => { await server.stop(true); process.exit(0); });
