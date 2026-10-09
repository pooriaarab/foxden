// The extension E2E test: install dist-ext/ in real Firefox, open the Space
// page, drop a CSV, run Python on it, and attack the sandbox. It writes
// artifacts/e2e-<date>.json. Usage: pnpm e2e [--headed].
import { readFileSync } from "node:fs";
import { launch, poll, writeArtifact } from "create-foxkit/e2e";
import { deadProxy, probeCode, startProbe } from "./probe.mjs";

const probe = await startProbe();

const record = { startedAt: new Date().toISOString(), checks: [] };
const check = (name, expected, actual) => record.checks.push({ name, expected, actual, ok: actual === expected });
const csv = readFileSync("e2e/fixtures/sales.csv", "utf8");

// Drop files on the Space drop zone through a real drop event.
const drop = (page, files) =>
  page.evaluate((list) => {
    const data = new DataTransfer();
    for (const [name, text] of list) data.items.add(new File([text], name, { type: "text/csv" }));
    document.getElementById("drop").dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
  }, files);
// Type code, click Run, and return the output once the run ends.
const runCode = async (page, code, limitSeconds = 30) => {
  await page.evaluate(
    (c, s) => {
      document.getElementById("code").value = c;
      document.getElementById("limit").value = String(s);
      document.getElementById("output").dataset.done = "";
      document.getElementById("run").click();
    },
    code,
    limitSeconds,
  );
  return poll(page, () => document.getElementById("output").dataset.done === "1" && document.getElementById("output").textContent, undefined, 90_000);
};
const ready = (page) => poll(page, () => document.body.dataset.ready === "1" && document.getElementById("status").textContent, undefined, 90_000);
const listed = (page) => page.evaluate(() => [...document.querySelectorAll("#files li")].map((li) => li.dataset.path).join(" "));

let fox;
try {
  fox = await launch({ extension: "dist-ext", headless: !process.argv.includes("--headed"), prefs: deadProxy });
  record.firefox = await fox.browser.version();
  const space = await fox.openExtensionPage("space.html");
  record.status = await ready(space);
  record.pyodideLoadMs = await space.evaluate(() => Number(document.body.dataset.loadMs));
  check("E3 isolation", "manifest-sandbox", await space.evaluate(() => document.body.dataset.isolation));
  check("network badge", "Network: off", await space.evaluate(() => document.getElementById("network").textContent));

  await drop(space, [["sales.csv", csv], ["../evil/../name.csv", "a\n1\n"]]);
  await poll(space, () => document.querySelectorAll("#files li").length >= 2);
  check("E1 drop names stay in /drop", "/drop/.._evil_.._name.csv /drop/sales.csv", await listed(space));

  const out = await runCode(space, await space.evaluate(() => document.getElementById("code").defaultValue));
  record.csvOutput = out;
  check("CSV run", true, out.includes("/drop/sales.csv: 4 rows") && out.includes("sum of amount: 400"));
  await poll(space, () => document.querySelector('#files li[data-path="/out/sums.csv"] a[download]') !== null);
  check("output file listed for download", true, (await listed(space)).includes("/out/sums.csv"));

  await space.evaluate(() => {
    document.getElementById("sh-line").value = "grep -c north /drop/sales.csv";
    document.getElementById("output").dataset.done = "";
    document.getElementById("sh").requestSubmit();
  });
  check("shell grep", "2\n", await poll(space, () => document.getElementById("output").dataset.done === "1" && document.getElementById("output").textContent));

  for (const [name, code] of Object.entries(probeCode(probe.host))) {
    const text = await runCode(space, code, 20);
    (record.network ??= {})[name] = text.slice(-160);
    check(`E4 ${name} fails`, true, /error/i.test(text));
  }
  await new Promise((done) => setTimeout(done, 1500));
  check("E4 probe server got no request", "[]", JSON.stringify(probe.hits));

  const started = Date.now();
  check("E4 endless loop stops", true, /time limit/.test(await runCode(space, "while True: pass", 2)));
  record.timeoutStopMs = Date.now() - started;
  check("E4 next run works", true, (await runCode(space, "print(6 * 7)")).includes("42"));

  await space.close();
  const again = await fox.openExtensionPage("space.html");
  await ready(again);
  check("B1 files survive a reload", true, (await listed(again)).includes("/drop/sales.csv"));
} catch (error) {
  record.error = error instanceof Error ? error.message : String(error);
} finally {
  await fox?.close();
  probe.close();
}
record.passed = !record.error && record.checks.length >= 13 && record.checks.every((c) => c.ok);
const path = writeArtifact("artifacts", "e2e", record);
for (const c of record.checks) console.log(`${c.ok ? "ok " : "BAD"} ${c.name}: ${JSON.stringify(c.actual)}`);
console.log(`${record.passed ? "PASS" : "FAIL"}${record.error ? `: ${record.error}` : ""} | Pyodide load ${record.pyodideLoadMs} ms | ${path}`);
process.exitCode = record.passed ? 0 : 1;
