// Failure modes P1-P6 in docs/failure-modes.md.
import { describe, expect, it } from "vitest";
import { PathError } from "../src/errors.js";
import { normalizePath } from "../src/paths.js";

const bad = (path: unknown) => expect(() => normalizePath(path), String(path)).toThrow(PathError);

describe("normalizePath", () => {
  it("P1: rejects .. anywhere in the path", () => {
    for (const p of ["/drop/../etc/passwd", "/drop/a/../../out/x", "/out/..", "/drop/..%2F/x/..", "/work/a/.."]) bad(p);
  });
  it("P2: rejects relative paths and paths outside the den folders", () => {
    for (const p of ["data.csv", "drop/a.csv", "/etc/passwd", "/tmp/x", "/dropx/a", "/home/pyodide/a", "~/a"]) bad(p);
  });
  it("P3: rejects NUL, backslash and . segments", () => {
    for (const p of ["/drop/a\0.csv", "/drop\\..\\x", "/drop/./a.csv", "/drop/a\\b"]) bad(p);
  });
  it("P4: rejects folder paths", () => {
    for (const p of ["/drop", "/drop/", "/out/sub/", "/", ""]) bad(p);
  });
  it("P5: rejects very long paths and non-strings", () => {
    bad(`/drop/${"a".repeat(1100)}`);
    for (const p of [undefined, null, 42, {}, ["/drop/a"]]) bad(p);
  });
  it("P6: collapses repeated slashes so one file has one name", () => {
    expect(normalizePath("/drop//a.csv")).toBe("/drop/a.csv");
    expect(normalizePath("//out///sub//r.txt")).toBe("/out/sub/r.txt");
  });
  it("accepts normal paths in each den folder", () => {
    for (const p of ["/drop/sales.csv", "/out/report.txt", "/work/a/b/c.py", "/drop/name with space.csv", "/drop/ünï.txt"]) {
      expect(normalizePath(p)).toBe(p);
    }
  });
});
