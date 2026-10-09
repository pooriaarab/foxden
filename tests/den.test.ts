// Failure modes D1-D9 and D12-D14 in docs/failure-modes.md, with a fake runtime.
import { describe, expect, it } from "vitest";
import { type DenRuntime, memoryStore, openDen, type DenStore } from "../src/den.js";
import type { RunReply, RunRequest } from "../src/protocol.js";

const enc = new TextEncoder();
const text = (b: Uint8Array) => new TextDecoder().decode(b);
type Handler = (req: RunRequest, n: number) => Partial<RunReply> | Promise<Partial<RunReply>>;

// A runtime that answers with `handler`. `started` and `closed` count calls.
function fake(handler: Handler = () => ({}), opts: { failStart?: boolean } = {}) {
  const stats = { started: 0, closed: 0, runs: [] as RunRequest[] };
  let n = 0;
  const factory = (): DenRuntime => ({
    async start() {
      stats.started += 1;
      if (opts.failStart) throw new Error("pyodide.asm.wasm: 404");
      return { kind: "fake", isolation: "none", loadMs: 1 };
    },
    async run(req) {
      stats.runs.push(req);
      const r = await handler(req, n++);
      return { id: req.id, stdout: "", stderr: "", result: null, error: null, truncated: false, files: [], durationMs: 1, ...r };
    },
    close() {
      stats.closed += 1;
    },
  });
  return { factory, stats };
}
let seq = 0;
const name = () => `den-${++seq}`;
const never = () => new Promise<Partial<RunReply>>(() => {});

describe("den", () => {
  it("runs code, sends the files, and applies changed files", async () => {
    const { factory, stats } = fake(() => ({ stdout: "hi\n", result: "2", files: [["/out/r.txt", enc.encode("done")]] }));
    const den = await openDen({ name: name(), runtime: factory });
    await den.writeFile("/drop/a.csv", "x,y\n");
    const r = await den.run("print('hi')");
    expect(r).toMatchObject({ stdout: "hi\n", result: "2", error: null, files: ["/out/r.txt"] });
    expect(stats.runs[0]!.files.map(([p]) => p)).toEqual(["/drop/a.csv"]);
    expect(text(await den.readFile("/out/r.txt"))).toBe("done");
    await den.close();
  });

  it("D1: a run that never answers times out, the runtime restarts, files stay", async () => {
    const { factory, stats } = fake((_r, n) => (n === 0 ? never() : { stdout: "after" }));
    const den = await openDen({ name: name(), runtime: factory, killGraceMs: 50 });
    await den.writeFile("/drop/keep.txt", "kept");
    const started = Date.now();
    const r = await den.run("while True: pass", { timeoutMs: 100 });
    expect(r.error?.kind).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(2000);
    expect(stats.closed).toBe(1);
    expect(stats.started).toBe(2);
    expect((await den.run("1")).stdout).toBe("after");
    expect(text(await den.readFile("/drop/keep.txt"))).toBe("kept");
    await den.close();
  });

  it("D2: a crash keeps the files and the next run works", async () => {
    const { factory } = fake((_r, n) => (n === 0 ? { error: { kind: "crashed", message: "out of memory" }, files: [["/out/x", enc.encode("half")]] } : { stdout: "ok" }));
    const den = await openDen({ name: name(), runtime: factory });
    const r = await den.run("x = bytearray(10**10)");
    expect(r.error?.kind).toBe("crashed");
    expect(await den.list()).toEqual([]);
    expect((await den.run("1")).stdout).toBe("ok");
    await den.close();
  });

  it("D3: bad paths from the sandbox are dropped", async () => {
    const { factory } = fake(() => ({ files: [["/out/../../etc/passwd", enc.encode("x")], ["/tmp/x", enc.encode("x")], ["/out/fine.txt", enc.encode("ok")]] }));
    const den = await openDen({ name: name(), runtime: factory });
    const r = await den.run("...");
    expect((await den.list()).map((f) => f.path)).toEqual(["/out/fine.txt"]);
    expect(r.stderr).toMatch(/ignored a file with a bad path/);
    await den.close();
  });

  it("D4: more bytes than maxDenBytes are refused", async () => {
    const { factory } = fake(() => ({ files: [["/out/big", new Uint8Array(2000)]] }));
    const den = await openDen({ name: name(), runtime: factory, maxDenBytes: 1000 });
    await den.writeFile("/drop/a", "a");
    const r = await den.run("...");
    expect(r.error?.kind).toBe("storage");
    expect((await den.list()).map((f) => f.path)).toEqual(["/drop/a"]);
    await expect(den.writeFile("/drop/b", new Uint8Array(1500))).rejects.toThrow(/maxDenBytes/);
    await den.close();
  });

  it("D5: a load failure rejects with DenLoadError and frees the name", async () => {
    const n = name();
    await expect(openDen({ name: n, runtime: fake(undefined, { failStart: true }).factory })).rejects.toMatchObject({ name: "DenLoadError" });
    const den = await openDen({ name: n, runtime: fake().factory });
    await den.close();
  });

  it("D6: the same name cannot be open two times", async () => {
    const n = name();
    const den = await openDen({ name: n, runtime: fake().factory });
    await expect(openDen({ name: n, runtime: fake().factory })).rejects.toMatchObject({ name: "DenError" });
    await den.close();
    await (await openDen({ name: n, runtime: fake().factory })).close();
  });

  it("D7: two dens do not share files or store entries", async () => {
    const store = memoryStore();
    const a = await openDen({ name: name(), runtime: fake().factory, store });
    const b = await openDen({ name: name(), runtime: fake().factory, store });
    await a.writeFile("/drop/secret.txt", "a only");
    expect(await b.list()).toEqual([]);
    await expect(b.readFile("/drop/secret.txt")).rejects.toThrow(/No such file/);
    await a.close();
    await b.close();
  });

  it("files persist in the store across close and open", async () => {
    const store = memoryStore();
    const n = name();
    const a = await openDen({ name: n, runtime: fake().factory, store });
    await a.writeFile("/drop/a.txt", "saved");
    await a.close();
    const again = await openDen({ name: n, runtime: fake().factory, store });
    expect(text(await again.readFile("/drop/a.txt"))).toBe("saved");
    await again.close();
  });

  it("D8: methods after close reject, and close twice is fine", async () => {
    const { factory, stats } = fake();
    const den = await openDen({ name: name(), runtime: factory });
    await den.close();
    await den.close();
    expect(stats.closed).toBe(1);
    await expect(den.run("1")).rejects.toMatchObject({ name: "DenError" });
    await expect(den.writeFile("/drop/a", "a")).rejects.toMatchObject({ name: "DenError" });
  });

  it("D9: runs started at once run in call order", async () => {
    const order: string[] = [];
    const { factory } = fake(async (req) => {
      await new Promise((r) => setTimeout(r, req.code === "slow" ? 50 : 1));
      order.push(req.code);
      return {};
    });
    const den = await openDen({ name: name(), runtime: factory });
    await Promise.all([den.run("slow"), den.run("fast")]);
    expect(order).toEqual(["slow", "fast"]);
    await den.close();
  });

  it("D12: a store that cannot save leaves the files as they were", async () => {
    const inner = memoryStore();
    let full = false;
    const store: DenStore = { ...inner, save: async (n, f) => (full ? Promise.reject(new Error("QuotaExceededError")) : inner.save(n, f)) };
    const den = await openDen({ name: name(), runtime: fake().factory, store });
    await den.writeFile("/drop/a.txt", "one");
    full = true;
    await expect(den.writeFile("/drop/a.txt", "two")).rejects.toThrow(/Quota/);
    expect(text(await den.readFile("/drop/a.txt"))).toBe("one");
    await den.close();
  });

  it("D13: stdout over maxOutputBytes is cut", async () => {
    const { factory } = fake(() => ({ stdout: "y".repeat(5000), stderr: "e".repeat(5000) }));
    const den = await openDen({ name: name(), runtime: factory });
    const r = await den.run("...", { maxOutputBytes: 100 });
    expect(r.stdout.length).toBe(100);
    expect(r.stderr.length).toBeLessThanOrEqual(100);
    expect(r.truncated).toBe(true);
    await den.close();
  });

  it("D14: bad den names are refused", async () => {
    for (const n of ["", "a".repeat(65), "../x", "a b", "ü"]) {
      await expect(openDen({ name: n, runtime: fake().factory })).rejects.toMatchObject({ name: "DenError" });
    }
  });
});
