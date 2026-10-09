// Failure modes SH1-SH8 in docs/failure-modes.md, and the commands that must work.
import { describe, expect, it } from "vitest";
import { runShell } from "../src/shell.js";

const enc = new TextEncoder();
const files = new Map<string, Uint8Array>([
  ["/drop/sales.csv", enc.encode("region,amount\nnorth,10\nsouth,20\nNorth,5\n")],
  ["/drop/notes/readme.txt", enc.encode("one two three\n")],
  ["/out/report.txt", enc.encode("total 35\n")],
]);
const sh = (line: string, maxOutputBytes?: number) => runShell(line, files, maxOutputBytes ? { maxOutputBytes } : {});

describe("runShell commands", () => {
  it("ls lists the den folders and the files in a folder", () => {
    expect(sh("ls")).toMatchObject({ code: 0, stdout: "drop/\nout/\nwork/\n" });
    expect(sh("ls /drop")).toMatchObject({ code: 0, stdout: "notes/\nsales.csv\n" });
    expect(sh("ls /work").stdout).toBe("");
  });
  it("cat, head and wc read files", () => {
    expect(sh("cat /out/report.txt").stdout).toBe("total 35\n");
    expect(sh("head -n 2 /drop/sales.csv").stdout).toBe("region,amount\nnorth,10\n");
    expect(sh("wc -l /drop/sales.csv").stdout).toBe("4 /drop/sales.csv\n");
    expect(sh("wc /drop/notes/readme.txt").stdout).toBe("1 3 14 /drop/notes/readme.txt\n");
  });
  it("grep supports -i, -v, -c and -n, and exits 1 on no match", () => {
    expect(sh("grep north /drop/sales.csv").stdout).toBe("north,10\n");
    expect(sh("grep -i north /drop/sales.csv").stdout).toBe("north,10\nNorth,5\n");
    expect(sh("grep -c -v north /drop/sales.csv").stdout).toBe("3\n");
    expect(sh("grep -n south /drop/sales.csv").stdout).toBe("3:south,20\n");
    expect(sh("grep east /drop/sales.csv").code).toBe(1);
  });
  it("pipes join commands, and quotes keep spaces", () => {
    expect(sh("cat /drop/sales.csv | grep -i north | wc -l").stdout).toBe("2\n");
    expect(sh("echo 'a b' \"c|d\" | grep 'a b'").stdout).toBe("a b c|d\n");
  });
});

describe("runShell failure modes", () => {
  it("SH1: unknown command", () => {
    const r = sh("rm -rf /drop");
    expect(r.code).toBe(127);
    expect(r.stderr).toMatch(/rm: command not found/);
  });
  it("SH2: syntax we do not have runs nothing", () => {
    for (const line of ["cat /drop/sales.csv; ls", "ls && ls", "echo a > /out/x", "cat < /drop/sales.csv", "echo $HOME", "echo `ls`", "cat /drop/*.csv"]) {
      const r = sh(line);
      expect(r.code, line).toBe(2);
      expect(r.stderr, line).toMatch(/not supported/);
      expect(r.stdout, line).toBe("");
    }
  });
  it("SH3: a missing file is an error, other files still print", () => {
    const r = sh("cat /drop/nope.csv /out/report.txt");
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/\/drop\/nope\.csv: No such file/);
    expect(r.stdout).toBe("total 35\n");
  });
  it("SH4: .. cannot leave the den folders", () => {
    for (const line of ["cat /drop/../out/report.txt", "head /etc/passwd", "ls /drop/..", "grep a ../x"]) {
      const r = sh(line);
      expect(r.code, line).toBe(1);
      expect(r.stdout, line).toBe("");
    }
  });
  it("SH5: big output is cut at maxOutputBytes", () => {
    const big = new Map([["/drop/big.txt", enc.encode("x".repeat(100_000))]]);
    const r = runShell("cat /drop/big.txt", big, { maxOutputBytes: 1000 });
    expect(r.stdout.length).toBe(1000);
    expect(r.truncated).toBe(true);
    expect(sh("cat /out/report.txt").truncated).toBe(false);
  });
  it("SH6: grep patterns are plain text", () => {
    const evil = new Map([["/drop/a.txt", enc.encode(`${"a".repeat(5000)}!\n(a+)+$ literal\n`)]]);
    const started = Date.now();
    const r = runShell("grep '(a+)+$' /drop/a.txt", evil);
    expect(Date.now() - started).toBeLessThan(500);
    expect(r.stdout).toBe("(a+)+$ literal\n");
  });
  it("SH7: an open quote is an error", () => {
    const r = sh("grep 'north /drop/sales.csv");
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/quote/);
  });
  it("SH8: bad option values and unknown options", () => {
    for (const line of ["head -n x /drop/sales.csv", "head -n /drop/sales.csv", "wc -z /drop/sales.csv", "grep -P a /drop/sales.csv", "grep"]) {
      expect(sh(line).code, line).toBe(2);
    }
  });
});
