// The snapshot file format. A snapshot holds the files of one den.
//
//   bytes 0-7    "FDNSNAP1"
//   bytes 8-11   header length N, unsigned 32-bit big-endian
//   next N bytes header, UTF-8 JSON: { v: 1, name, files: [{ path, size, sha256 }] }
//   the rest     the file bodies, in header order, with no gaps
//
// decodeSnapshot checks every length before it reads, checks each SHA-256,
// and runs each path through normalizePath. Python globals are not saved.
import { PathError, SnapshotError } from "./errors.js";
import { normalizePath } from "./paths.js";

const MAGIC = "FDNSNAP1";
const MAX_HEADER = 16 * 1024 * 1024;

interface Entry {
  path: string;
  size: number;
  sha256: string;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Pack the files of a den into snapshot bytes. */
export async function encodeSnapshot(name: string, files: ReadonlyMap<string, Uint8Array>): Promise<Uint8Array> {
  const entries: Entry[] = [];
  for (const [path, body] of files) entries.push({ path: normalizePath(path), size: body.length, sha256: await sha256(body) });
  const header = new TextEncoder().encode(JSON.stringify({ v: 1, name, files: entries }));
  const total = entries.reduce((sum, e) => sum + e.size, 12 + header.length);
  const out = new Uint8Array(total);
  out.set(new TextEncoder().encode(MAGIC), 0);
  new DataView(out.buffer).setUint32(8, header.length);
  out.set(header, 12);
  let at = 12 + header.length;
  for (const body of files.values()) {
    out.set(body, at);
    at += body.length;
  }
  return out;
}

function parseHeader(text: string): { name: string; files: Entry[] } {
  let header: unknown;
  try {
    header = JSON.parse(text);
  } catch {
    throw new SnapshotError("The snapshot header is not valid JSON.");
  }
  if (typeof header !== "object" || header === null) throw new SnapshotError("The snapshot header is not an object.");
  const { v, name, files } = header as Record<string, unknown>;
  if (v !== 1) throw new SnapshotError(`The snapshot version is ${String(v)}. This foxden reads version 1.`);
  if (typeof name !== "string" || !Array.isArray(files)) throw new SnapshotError("The snapshot header has no name or no file list.");
  for (const e of files as unknown[]) {
    const { path, size, sha256: hash } = (e ?? {}) as Record<string, unknown>;
    if (typeof path !== "string" || typeof hash !== "string" || !Number.isSafeInteger(size) || (size as number) < 0) {
      throw new SnapshotError("A snapshot file entry has a bad path, size or hash.");
    }
  }
  return { name, files: files as Entry[] };
}

/** Read snapshot bytes back into a name and a file map, or throw SnapshotError. */
export async function decodeSnapshot(bytes: Uint8Array): Promise<{ name: string; files: Map<string, Uint8Array> }> {
  if (!(bytes instanceof Uint8Array) || bytes.length < 12) throw new SnapshotError("The bytes are too short to be a snapshot.");
  if (new TextDecoder().decode(bytes.subarray(0, 8)) !== MAGIC) throw new SnapshotError("The bytes are not a foxden snapshot.");
  const headerLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(8);
  if (headerLength > MAX_HEADER || 12 + headerLength > bytes.length) throw new SnapshotError("The snapshot header length is larger than the snapshot.");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(12, 12 + headerLength));
  } catch {
    throw new SnapshotError("The snapshot header is not valid UTF-8.");
  }
  const header = parseHeader(text);
  const files = new Map<string, Uint8Array>();
  let at = 12 + headerLength;
  for (const entry of header.files) {
    let path: string;
    try {
      path = normalizePath(entry.path);
    } catch (error) {
      throw new SnapshotError(`The snapshot holds a bad path: ${(error as PathError).message}`);
    }
    if (files.has(path)) throw new SnapshotError(`The snapshot lists ${path} two times.`);
    if (entry.size > bytes.length - at) throw new SnapshotError(`The snapshot is cut short inside ${path}.`);
    const body = bytes.slice(at, at + entry.size);
    at += entry.size;
    if ((await sha256(body)) !== entry.sha256) throw new SnapshotError(`The bytes of ${path} do not match their SHA-256 hash.`);
    files.set(path, body);
  }
  if (at !== bytes.length) throw new SnapshotError(`The snapshot has ${bytes.length - at} extra bytes after the last file.`);
  return { name: header.name, files };
}
