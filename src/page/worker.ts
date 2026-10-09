// The den worker. It loads Pyodide from bytes the host sent (it has no
// network) and runs one request at a time over the files in the request.
import { loadPyodide, type PyodideAPI } from "pyodide";
import createPyodideModule from "pyodide/pyodide.asm.mjs";
import type { FileChanges, RunReply, RunRequest } from "../protocol.js";
import { DEN_FOLDERS } from "../paths.js";

export interface Assets {
  wasm: ArrayBuffer;
  stdlib: ArrayBuffer;
  lock: unknown;
}
export type WorkerIn = { t: "load"; assets: Assets } | { t: "run"; request: RunRequest };
export type WorkerOut = { t: "loaded"; loadMs: number } | { t: "load-failed"; message: string } | { t: "reply"; reply: RunReply };

const scope = self as unknown as {
  addEventListener: (type: "message", fn: (e: MessageEvent<WorkerIn>) => void) => void;
  postMessage: (m: WorkerOut) => void;
  fetch: typeof fetch;
};
let py: PyodideAPI;

async function load(assets: Assets) {
  const started = performance.now();
  // Pyodide asks fetch() for these two files. Serve them from the bytes the
  // host sent, then put the real fetch back so code meets the page CSP.
  const realFetch = scope.fetch;
  scope.fetch = (async (url: RequestInfo | URL) => {
    const name = String(url).split("/").pop();
    if (name === "pyodide.asm.wasm") return new Response(assets.wasm, { headers: { "content-type": "application/wasm" } });
    if (name === "python_stdlib.zip") return new Response(assets.stdlib);
    throw new TypeError(`foxden: the worker does not fetch ${String(url)}`);
  }) as typeof fetch;
  try {
    py = await loadPyodide({ indexURL: "https://foxden.invalid/", createPyodideModule, lockFileContents: assets.lock as never, fullStdLib: false } as never);
  } finally {
    scope.fetch = realFetch;
  }
  for (const folder of DEN_FOLDERS) {
    py.FS.mkdirTree(folder);
    py.FS.mount(py.FS.filesystems.MEMFS, {}, folder);
  }
  return performance.now() - started;
}

function walk(dir: string, out: Map<string, Uint8Array>) {
  for (const name of py.FS.readdir(dir) as string[]) {
    if (name === "." || name === "..") continue;
    const path = `${dir}/${name}`;
    const mode = py.FS.stat(path).mode;
    if (py.FS.isDir(mode)) walk(path, out);
    else if (py.FS.isFile(mode)) out.set(path, py.FS.readFile(path) as Uint8Array);
  }
}

// Collect output up to `max` characters and count what is dropped, so a
// print loop cannot fill the memory of the worker.
function sink(max: number) {
  const decoder = new TextDecoder();
  const state = { text: "", dropped: 0 };
  return {
    state,
    write(buffer: Uint8Array) {
      const room = max - state.text.length;
      const chunk = decoder.decode(buffer, { stream: true });
      if (room > 0) state.text += chunk.slice(0, room);
      state.dropped += Math.max(0, chunk.length - Math.max(room, 0));
      return buffer.length;
    },
  };
}

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

async function run(req: RunRequest): Promise<RunReply> {
  const started = performance.now();
  // A fresh in-memory file system per folder drops what the last run left.
  py.FS.chdir("/");
  for (const folder of DEN_FOLDERS) {
    py.FS.unmount(folder);
    py.FS.mount(py.FS.filesystems.MEMFS, {}, folder);
  }
  const before = new Map(req.files);
  for (const [path, body] of req.files) {
    py.FS.mkdirTree(path.slice(0, path.lastIndexOf("/")));
    py.FS.writeFile(path, body);
  }
  py.FS.chdir("/work");
  const out = sink(req.maxOutputBytes);
  const err = sink(req.maxOutputBytes);
  py.setStdout(out);
  py.setStderr(err);
  let result: string | null = null;
  let error: RunReply["error"] = null;
  try {
    const value: unknown = await py.runPythonAsync(req.code);
    if (value !== undefined) result = String(py.globals.get("repr")(value));
    if (value && typeof (value as { destroy?: () => void }).destroy === "function") (value as { destroy: () => void }).destroy();
  } catch (e) {
    // A PythonError is the code's own exception. Anything else (for example
    // a Pyodide fatal error after out of memory) means this worker is broken.
    const kind = e instanceof Error && e.name === "PythonError" ? "python" : "crashed";
    error = { kind, message: e instanceof Error ? e.message : String(e) };
  }
  const after = new Map<string, Uint8Array>();
  for (const folder of DEN_FOLDERS) walk(folder, after);
  const files: FileChanges = [];
  for (const [path, body] of after) if (!before.has(path) || !same(before.get(path)!, body)) files.push([path, body]);
  for (const path of before.keys()) if (!after.has(path)) files.push([path, null]);
  const truncated = out.state.dropped > 0 || err.state.dropped > 0;
  return { id: req.id, stdout: out.state.text, stderr: err.state.text, result, error, truncated, files, durationMs: performance.now() - started };
}

scope.addEventListener("message", (e) => {
  const m = e.data;
  if (m.t === "load") {
    load(m.assets).then(
      (loadMs) => scope.postMessage({ t: "loaded", loadMs }),
      (error: unknown) => scope.postMessage({ t: "load-failed", message: error instanceof Error ? error.message : String(error) }),
    );
  } else if (m.t === "run") {
    void run(m.request).then((reply) => scope.postMessage({ t: "reply", reply }));
  }
});
