// The messages between the page that opens a den (the host) and the
// sandbox page. Both sides parse what they receive with these functions and
// ignore anything that does not match exactly.

export const PROTOCOL_VERSION = 1;

/** File changes from a run: bytes for a new or changed file, null for a deleted one. */
export type FileChanges = [path: string, body: Uint8Array | null][];

export type RunErrorKind = "python" | "timeout" | "crashed" | "storage";
const ERROR_KINDS: readonly string[] = ["python", "timeout", "crashed", "storage"];

export interface RunRequest {
  id: number;
  code: string;
  /** Every den file, so the sandbox needs no state of its own. */
  files: [path: string, body: Uint8Array][];
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface RunReply {
  id: number;
  stdout: string;
  stderr: string;
  /** `repr()` of the last expression, or null. */
  result: string | null;
  error: { kind: RunErrorKind; message: string } | null;
  truncated: boolean;
  files: FileChanges;
  durationMs: number;
}

/** Sandbox page to host. */
export type DenMessage =
  | { t: "ready"; v: 1; origin: string; extensionApi: boolean; loadMs: number }
  | { t: "load-error"; v: 1; message: string }
  | { t: "reply"; v: 1; reply: RunReply };

/** Host to sandbox page, over the MessagePort. */
export interface HostMessage {
  t: "run";
  v: 1;
  request: RunRequest;
}

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);
const isCount = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0;
const isTime = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x >= 0;
const isFile = (x: unknown, allowNull: boolean) =>
  Array.isArray(x) && x.length === 2 && typeof x[0] === "string" && (x[1] instanceof Uint8Array || (allowNull && x[1] === null));
const isFiles = (x: unknown, allowNull: boolean) => Array.isArray(x) && x.every((f) => isFile(f, allowNull));

function isReply(r: unknown): r is RunReply {
  if (!isObj(r)) return false;
  const error = r.error;
  const errorOk = error === null || (isObj(error) && ERROR_KINDS.includes(error.kind as string) && typeof error.message === "string");
  return (
    isCount(r.id) &&
    typeof r.stdout === "string" &&
    typeof r.stderr === "string" &&
    (r.result === null || typeof r.result === "string") &&
    errorOk &&
    typeof r.truncated === "boolean" &&
    isFiles(r.files, true) &&
    isTime(r.durationMs)
  );
}

/** Parse a message from the sandbox page. Returns null for anything unexpected. */
export function parseDenMessage(data: unknown): DenMessage | null {
  if (!isObj(data) || data.v !== PROTOCOL_VERSION) return null;
  switch (data.t) {
    case "ready":
      return typeof data.origin === "string" && typeof data.extensionApi === "boolean" && isTime(data.loadMs) ? (data as DenMessage) : null;
    case "load-error":
      return typeof data.message === "string" ? (data as DenMessage) : null;
    case "reply":
      return isReply(data.reply) ? (data as DenMessage) : null;
    default:
      return null;
  }
}

/** Parse a message from the host. Returns null for anything unexpected. */
export function parseHostMessage(data: unknown): HostMessage | null {
  if (!isObj(data) || data.v !== PROTOCOL_VERSION || data.t !== "run" || !isObj(data.request)) return null;
  const r = data.request;
  const ok = isCount(r.id) && typeof r.code === "string" && isFiles(r.files, false) && isTime(r.timeoutMs) && isCount(r.maxOutputBytes);
  return ok ? (data as unknown as HostMessage) : null;
}
