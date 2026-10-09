// Builds the sandbox page into dist/den/: den.html, and den.js with the
// worker (and the Pyodide loader) inside it as a string. The sandbox page
// starts the worker from that string, because a page with an opaque origin
// cannot load a worker from a URL.
import { copyFileSync, mkdirSync } from "node:fs";
import { build } from "esbuild";

const common = { bundle: true, target: "firefox153", platform: "browser", logLevel: "warning" };
const worker = await build({ ...common, entryPoints: ["src/page/worker.ts"], format: "esm", write: false, external: ["node:*", "ws"] });
mkdirSync("dist/den", { recursive: true });
await build({
  ...common,
  entryPoints: ["src/page/den-page.ts"],
  format: "iife",
  outfile: "dist/den/den.js",
  define: { FOXDEN_WORKER_SOURCE: JSON.stringify(worker.outputFiles[0].text) },
});
copyFileSync("src/page/den.html", "dist/den/den.html");
console.log("Built dist/den/ (den.html, den.js).");
