// Runs web-ext lint on dist-ext/ and fails on any error or warning, except
// the ones below. Each one is expected and has a reason. A new warning, or
// one of these for another key, still fails.
import { spawnSync } from "node:child_process";

const allowed = [
  // We set strict_min_version 153 (the ESR) and feature-detect the sandbox
  // key of Firefox 154. On 153 the key is ignored and the den page falls
  // back to the sandbox attribute (docs/failure-modes.md I1).
  (w) => w.code.endsWith("UNSUPPORTED_BY_MIN_VERSION") && /support for "(sandbox|sandbox\.pages|content_security_policy\.sandbox)"\.$/.test(w.description),
  // The sandbox CSP has worker-src blob:. The den page starts its worker from
  // a bundled string, because an opaque origin cannot load a worker by URL.
  // Nothing in it is remote, and connect-src 'none' blocks all network.
  (w) => w.code === "MANIFEST_CSP" && w.message.startsWith('"content_security_policy.sandbox"'),
];

const lint = spawnSync("pnpm", ["exec", "web-ext", "lint", "-s", "dist-ext", "-o", "json"], { encoding: "utf8" });
const report = JSON.parse(lint.stdout.slice(lint.stdout.indexOf("{")));
const blocking = [...report.errors, ...report.warnings.filter((w) => !allowed.some((ok) => ok(w)))];
for (const w of report.warnings) if (!blocking.includes(w)) console.log(`allowed ${w.code}: ${w.description}`);
for (const p of blocking) console.error(`${p.code} ${p.file ?? ""}: ${p.message} ${p.description ?? ""}`);
console.log(`web-ext lint: ${report.errors.length} errors, ${report.warnings.length} warnings (${blocking.length} blocking), ${report.notices.length} notices`);
process.exitCode = blocking.length > 0 ? 1 : 0;
