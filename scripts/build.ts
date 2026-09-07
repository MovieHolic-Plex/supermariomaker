import { mkdir } from "node:fs/promises";

await mkdir("dist", { recursive: true });
const result = await Bun.build({
  entrypoints: ["src/main.ts"],
  outdir: "dist",
  naming: "app.js",
  target: "browser",
  format: "esm",
  minify: true,
});
if (!result.success) throw new AggregateError(result.logs, "Browser build failed");
await Promise.all([
  Bun.write("dist/index.html", Bun.file("index.html")),
  Bun.write("dist/style.css", Bun.file("src/style.css")),
]);
console.log("Built dist/index.html, dist/app.js, dist/style.css");
