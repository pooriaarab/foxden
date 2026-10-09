// Failure modes M1-M2 in docs/failure-modes.md.
import { describe, expect, it } from "vitest";
import { parseDenMessage, parseHostMessage } from "../src/protocol.js";

const reply = {
  id: 1, stdout: "", stderr: "", result: null, error: null, truncated: false, durationMs: 3,
  files: [["/out/a.txt", new Uint8Array([1])], ["/out/gone.txt", null]],
};
const run = { id: 1, code: "1+1", files: [["/drop/a.csv", new Uint8Array([65])]], timeoutMs: 1000, maxOutputBytes: 100 };

describe("parseDenMessage", () => {
  it("accepts the three message types", () => {
    expect(parseDenMessage({ t: "ready", v: 1, origin: "null", extensionApi: false, loadMs: 10 })).not.toBeNull();
    expect(parseDenMessage({ t: "load-error", v: 1, message: "x" })).not.toBeNull();
    expect(parseDenMessage({ t: "reply", v: 1, reply })).not.toBeNull();
    expect(parseDenMessage({ t: "reply", v: 1, reply: { ...reply, error: { kind: "timeout", message: "x" } } })).not.toBeNull();
  });
  it("M1: ignores non-objects, other versions and unknown types", () => {
    for (const m of [null, undefined, "ready", 1, [], { t: "ready", v: 2, origin: "null", extensionApi: false, loadMs: 1 }, { t: "boom", v: 1 }]) {
      expect(parseDenMessage(m)).toBeNull();
    }
  });
  it("M2: ignores fields of the wrong type", () => {
    const bad = [
      { t: "ready", v: 1, origin: 5, extensionApi: false, loadMs: 1 },
      { t: "load-error", v: 1 },
      { t: "reply", v: 1, reply: { ...reply, id: "1" } },
      { t: "reply", v: 1, reply: { ...reply, stdout: 7 } },
      { t: "reply", v: 1, reply: { ...reply, files: [["/out/a", "text"]] } },
      { t: "reply", v: 1, reply: { ...reply, files: [[42, new Uint8Array()]] } },
      { t: "reply", v: 1, reply: { ...reply, files: "x" } },
      { t: "reply", v: 1, reply: { ...reply, error: { kind: "other", message: "x" } } },
    ];
    for (const m of bad) expect(parseDenMessage(m), JSON.stringify(m)).toBeNull();
  });
});

describe("parseHostMessage", () => {
  it("accepts a run and rejects bad ones (M1, M2)", () => {
    expect(parseHostMessage({ t: "run", v: 1, request: run })).not.toBeNull();
    expect(parseHostMessage({ t: "run", v: 1, request: { ...run, code: 5 } })).toBeNull();
    expect(parseHostMessage({ t: "run", v: 1, request: { ...run, timeoutMs: -1 } })).toBeNull();
    expect(parseHostMessage({ t: "run", v: 1, request: { ...run, files: [["/drop/a", null]] } })).toBeNull();
    expect(parseHostMessage({ t: "eval", v: 1, request: run })).toBeNull();
  });
});
