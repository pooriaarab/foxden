// The website E2E test: serve foxden on a plain http page, attack the sandbox
// in real Firefox, write artifacts/e2e-web-<date>.json. Usage: pnpm e2e:web.
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { build } from "esbuild";
import { launch, poll, serve, writeArtifact } from "create-foxkit/e2e";
import { deadProxy, probeCode, startProbe } from "./probe.mjs";

const root = "dist-web";
rmSync(root, { recursive: true, force: true });
mkdirSync(`${root}/pyodide`, { recursive: true });
writeFileSync(`${root}/index.html`, '<!doctype html><meta charset="utf-8"><title>foxden website host</title><script src="host.js"></script>');
cpSync("dist/den", `${root}/den`, { recursive: true });
for (const f of ["pyodide.asm.wasm", "python_stdlib.zip", "pyodide-lock.json"]) cpSync(`node_modules/pyodide/${f}`, `${root}/pyodide/${f}`);
await build({ entryPoints: ["src/index.ts"], bundle: true, format: "iife", globalName: "foxden", outfile: `${root}/host.js`, logLevel: "warning" });

const probe = await startProbe();

const record = { startedAt: new Date().toISOString(), checks: [] };
const check = (name, expected, actual) => record.checks.push({ name, expected, actual, ok: actual === expected });
const site = await serve(root);
let fox;
try {
  fox = await launch({ extension: "dist-ext", headless: !process.argv.includes("--headed"), prefs: deadProxy });
  record.firefox = await fox.browser.version();
  const page = await fox.open(`${site.url}/index.html`);
  await poll(page, () => typeof window.foxden?.openDen === "function");
  const call = (fn, arg) => page.evaluate(fn, arg);

  const opened = await call(async () => {
    const { openDen, iframeRuntime } = window.foxden;
    const runtime = iframeRuntime({ denUrl: "den/den.html", pyodideUrl: "pyodide/" });
    window.dens = { a: await openDen({ name: "a", runtime }), b: await openDen({ name: "b", runtime }) };
    return window.dens.a.info;
  });
  record.pyodideLoadMs = opened.loadMs;
  check("W1/L2 website den loads offline in iframe-sandbox", "iframe-sandbox", opened.isolation);
  const run = (code, opts = {}, den = "a") => call((a) => window.dens[a.den].run(a.code, a.opts), { code, opts, den });

  check("run 1+1", "2", (await run("1+1")).result);
  for (const [name, code] of Object.entries(probeCode(probe.host))) {
    const r = await run(code, { timeoutMs: 20_000 });
    check(`${name} fails`, true, r.error !== null);
  }
  await new Promise((done) => setTimeout(done, 1500));
  check("N1-N4 probe server got no request", "[]", JSON.stringify(probe.hits));

  await call(() => window.dens.a.writeFile("/drop/keep.txt", "kept"));
  const loop = await run("while True: pass", { timeoutMs: 2000 });
  check("T1 infinite loop times out", "timeout", loop.error?.kind);
  check("T1 next run works and files stay", "'kept'", (await run("open('/drop/keep.txt').read()")).result);

  const flood = await run("for i in range(200000): print('x' * 100)", { maxOutputBytes: 10_000, timeoutMs: 60_000 });
  check("O1 output is cut", "10000 true", `${flood.stdout.length} ${flood.truncated}`);


  await run("secret = 42\nopen('/out/a.txt', 'w').write('a')");
  const other = await run("secret", {}, "b");
  check("D7 globals do not cross dens", true, /NameError/.test(other.error?.message ?? ""));
  check("D7 files do not cross dens", "[]", JSON.stringify(await call(() => window.dens.b.list())));

  const spoofed = await call(async () => {
    window.postMessage({ t: "reply", v: 1, reply: { id: 99, stdout: "forged", stderr: "", result: "forged", error: null, truncated: false, files: [], durationMs: 0 } }, "*");
    for (const frame of document.querySelectorAll("iframe")) frame.contentWindow.postMessage({ t: "init", v: 1, assets: {} }, "*", [new MessageChannel().port2]);
    return (await window.dens.a.run("6*7")).result;
  });
  check("X1 fake messages are ignored", "42", spoofed);

  const missing = await call(() =>
    window.foxden.openDen({ name: "missing", runtime: window.foxden.iframeRuntime({ denUrl: "den/den.html", pyodideUrl: "nope/", loadTimeoutMs: 10_000 }) }).then(() => "opened", (e) => e.name),
  );
  check("L1 missing Pyodide files reject", "DenLoadError", missing);
  const forced = await call(() =>
    window.foxden.openDen({ name: "forced", runtime: window.foxden.iframeRuntime({ denUrl: "den/den.html", pyodideUrl: "pyodide/", isolation: "manifest-sandbox" }) }).then(() => "opened", (e) => e.message),
  );
  check("I1 same-origin den page refuses to start", true, /not isolated.*refused to start/.test(forced));
  const memory = await run("blocks = []\nwhile True: blocks.append(bytearray(256 * 1024 ** 2))", { timeoutMs: 60_000 });
  record.memoryError = memory.error;
  check("R1 memory blowup is an error", true, memory.error?.kind === "python" || memory.error?.kind === "crashed");
  check("R1 next run works", "2", (await run("1+1")).result);

  await call(async () => {
    const { openDen, iframeRuntime, idbStore } = window.foxden;
    const den = await openDen({ name: "kept", store: idbStore(), runtime: iframeRuntime({ denUrl: "den/den.html", pyodideUrl: "pyodide/" }) });
    await den.writeFile("/drop/kept.csv", "a,b\n1,2\n");
    await den.close();
  });
  await page.reload();
  await poll(page, () => typeof window.foxden?.openDen === "function");
  const reopened = await call(async () => {
    const { openDen, idbStore } = window.foxden;
    // No Python is needed to read a file back, so this runtime is a stub.
    // It runs in the page, so it cannot move to the outer scope.
    // oxlint-disable-next-line unicorn/consistent-function-scoping
    const runtime = () => ({ start: async () => ({ kind: "none", isolation: "none", loadMs: 0 }), run: async () => ({}), close() {} });
    const den = await openDen({ name: "kept", store: idbStore(), runtime });
    return new TextDecoder().decode(await den.readFile("/drop/kept.csv"));
  });
  check("B1 files survive a page reload", "a,b\n1,2\n", reopened);
} catch (error) {
  record.error = error instanceof Error ? error.message : String(error);
} finally {
  await fox?.close();
  await site.close();
  probe.close();
}
record.passed = !record.error && record.checks.length >= 20 && record.checks.every((c) => c.ok);
const path = writeArtifact("artifacts", "e2e-web", record);
for (const c of record.checks) console.log(`${c.ok ? "ok " : "BAD"} ${c.name}: ${JSON.stringify(c.actual)}`);
console.log(`${record.passed ? "PASS" : "FAIL"}${record.error ? `: ${record.error}` : ""} | Pyodide load ${record.pyodideLoadMs} ms | ${path}`);
process.exitCode = record.passed ? 0 : 1;
