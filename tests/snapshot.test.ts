// Failure modes S1-S9 in docs/failure-modes.md.
import { describe, expect, it } from "vitest";
import { SnapshotError } from "../src/errors.js";
import { decodeSnapshot, encodeSnapshot } from "../src/snapshot.js";

const enc = new TextEncoder();
const files = new Map<string, Uint8Array>([
  ["/drop/sales.csv", enc.encode("region,amount\nnorth,10\nsouth,20\n")],
  ["/out/empty.txt", new Uint8Array(0)],
  ["/work/bin.dat", Uint8Array.from({ length: 300 }, (_, i) => i % 256)],
]);

const sha = async (b: Uint8Array) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", b as Uint8Array<ArrayBuffer>))].map((x) => x.toString(16).padStart(2, "0")).join("");

// Builds raw snapshot bytes from any header, so tests can forge bad ones.
function raw(header: unknown, body: Uint8Array, headerLength?: number): Uint8Array {
  const h = enc.encode(typeof header === "string" ? header : JSON.stringify(header));
  const out = new Uint8Array(12 + h.length + body.length);
  out.set(enc.encode("FDNSNAP1"), 0);
  new DataView(out.buffer).setUint32(8, headerLength ?? h.length);
  out.set(h, 12);
  out.set(body, 12 + h.length);
  return out;
}
async function goodHeader(path = "/drop/a.txt", body = enc.encode("hello")) {
  return { header: { v: 1, name: "t", files: [{ path, size: body.length, sha256: await sha(body) }] }, body };
}
const rejects = (bytes: Uint8Array) => expect(decodeSnapshot(bytes)).rejects.toThrow(SnapshotError);

describe("snapshots", () => {
  it("S9: round-trips names, paths and bytes", async () => {
    const back = await decodeSnapshot(await encodeSnapshot("den-1", files));
    expect(back.name).toBe("den-1");
    expect([...back.files.keys()].sort()).toEqual([...files.keys()].sort());
    for (const [p, b] of files) expect(back.files.get(p)).toEqual(b);
  });
  it("S1: rejects bytes that are not a snapshot", async () => {
    await rejects(new Uint8Array(0));
    await rejects(enc.encode("PK\x03\x04 not a snapshot at all"));
    await rejects(Uint8Array.from({ length: 64 }, (_, i) => (i * 37) % 256));
  });
  it("S2: rejects a snapshot cut short at any point", async () => {
    const good = await encodeSnapshot("den-1", files);
    for (let n = 0; n < good.length; n += 7) await rejects(good.slice(0, n));
    await rejects(good.slice(0, good.length - 1));
  });
  it("S3: rejects a changed file byte and names the file", async () => {
    const good = await encodeSnapshot("den-1", files);
    const bad = good.slice();
    bad[bad.length - 1] = (bad[bad.length - 1]! + 1) % 256;
    await expect(decodeSnapshot(bad)).rejects.toThrow(/\/work\/bin\.dat/);
  });
  it("S4: rejects a header that is not JSON or has the wrong version", async () => {
    const { header, body } = await goodHeader();
    await rejects(raw("{not json", body));
    await rejects(raw({ ...header, v: 2 }, body));
    await rejects(raw({ ...header, files: "x" }, body));
    await rejects(raw(null, body));
  });
  it("S5: rejects header paths that leave the den folders", async () => {
    for (const p of ["/drop/../../etc/passwd", "/etc/passwd", "relative.txt", "/drop"]) {
      const { header, body } = await goodHeader(p);
      await rejects(raw(header, body));
    }
  });
  it("S6: rejects a path listed two times", async () => {
    const { header, body } = await goodHeader();
    const twice = { ...header, files: [header.files[0], header.files[0]] };
    await rejects(raw(twice, new Uint8Array([...body, ...body])));
  });
  it("S7: rejects sizes larger than the bytes and huge header lengths", async () => {
    const { header, body } = await goodHeader();
    await rejects(raw({ ...header, files: [{ ...header.files[0], size: 1e12 }] }, body));
    await rejects(raw({ ...header, files: [{ ...header.files[0], size: -1 }] }, body));
    await rejects(raw(header, body, 0xffffffff));
  });
  it("S8: rejects extra bytes after the last file", async () => {
    const good = await encodeSnapshot("den-1", files);
    await rejects(new Uint8Array([...good, 0]));
  });
});
