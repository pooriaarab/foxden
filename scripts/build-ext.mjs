// Builds extension/ into dist-ext/: esbuild bundles each script, the other
// files are copied, and the sandbox page (dist/den/) and the Pyodide files
// are added, so the extension loads nothing from the network. It stops when
// a file is missing, or when the manifest version is not the package.json
// version, so AMO signs the version that npm publishes.
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { build } from "esbuild";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const manifest = JSON.parse(readFileSync("extension/manifest.json", "utf8"));
if (manifest.version !== pkg.version) {
  console.error(`extension/manifest.json has version ${manifest.version}, but package.json has ${pkg.version}. Make them equal.`);
  process.exit(1);
}
const pyodide = JSON.parse(readFileSync("node_modules/pyodide/package.json", "utf8"));
const needed = ["dist/den/den.html", "dist/den/den.js", ...["pyodide.asm.wasm", "python_stdlib.zip", "pyodide-lock.json"].map((f) => `node_modules/pyodide/${f}`)];
const missing = needed.filter((f) => !existsSync(f));
if (missing.length > 0) {
  console.error(`Missing ${missing.join(", ")}. Run pnpm install and pnpm build first.`);
  process.exit(1);
}

rmSync("dist-ext", { recursive: true, force: true });
const files = readdirSync("extension");
await build({
  entryPoints: files.filter((f) => f.endsWith(".js")).map((f) => `extension/${f}`),
  outdir: "dist-ext",
  bundle: true,
  format: "iife",
  target: "firefox153",
  logLevel: "warning",
});
// amo-metadata.json is the AMO listing, not a part of the add-on.
for (const file of files.filter((f) => !f.endsWith(".js") && f !== "amo-metadata.json")) cpSync(`extension/${file}`, `dist-ext/${file}`, { recursive: true });
cpSync("dist/den", "dist-ext/den", { recursive: true });
for (const file of needed.slice(2)) cpSync(file, `dist-ext/pyodide/${file.split("/").pop()}`);
writeFileSync("dist-ext/pyodide/NOTICE.txt", `Pyodide ${pyodide.version}, unmodified, from the npm package "pyodide".\nLicense: MPL-2.0. Source: https://github.com/pyodide/pyodide\n`);
console.log(`Built dist-ext/ (version ${pkg.version}, Pyodide ${pyodide.version}).`);
