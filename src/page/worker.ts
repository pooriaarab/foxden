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
export type WorkerOut = { t: "loaded"; loadMs: number } | { t: "load-failed"; message: string } | { t: "reply"; reply: RunReply; restart: boolean };

const scope = self as unknown as {
  addEventListener: (type: "message", fn: (e: MessageEvent<WorkerIn>) => void) => void;
  postMessage: (m: WorkerOut) => void;
  fetch: typeof fetch;
  setTimeout: typeof setTimeout;
  setInterval: typeof setInterval;
  clearTimeout: typeof clearTimeout;
  clearInterval: typeof clearInterval;
};
let py: PyodideAPI;
let runCode: (code: string, globals: unknown, collect: () => void) => Promise<string | undefined>;
let pendingTasks: () => number;

// Runs the code in the den globals and makes repr() in Python, before
// Pyodide turns the value into a JavaScript one (30.0 would become 30).
// When the code ends, it collects the files at once, before any task the
// code started can run again, and then cancels those tasks.
const RUNNER = `
import asyncio
from pyodide.code import eval_code_async
async def run(code, ns, collect):
    try:
        value = await eval_code_async(code, ns)
        return None if value is None else repr(value)
    finally:
        collect()
        me = asyncio.current_task()
        for task in asyncio.all_tasks():
            if task is not me:
                task.cancel()
def pending():
    return sum(1 for task in asyncio.all_tasks(asyncio.get_event_loop()) if not task.done())
`;

// Track the timers that code sets (js.setTimeout, js.setInterval), so the
// worker knows when work is still waiting to run after a run ends.
const timers = new Set<unknown>();
const realSetTimeout = scope.setTimeout.bind(scope);
const realClearTimeout = scope.clearTimeout.bind(scope);
const realSetInterval = scope.setInterval.bind(scope);
const realClearInterval = scope.clearInterval.bind(scope);
scope.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
  const id = realSetTimeout((...a: unknown[]) => {
    timers.delete(id);
    fn(...a);
  }, ms, ...args);
  timers.add(id);
  return id;
}) as typeof setTimeout;
scope.setInterval = ((fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
  const id = realSetInterval(fn, ms, ...args);
  timers.add(id);
  return id;
}) as typeof setInterval;
scope.clearTimeout = ((id?: number) => {
  timers.delete(id);
  realClearTimeout(id);
}) as typeof clearTimeout;
scope.clearInterval = ((id?: number) => {
  timers.delete(id);
  realClearInterval(id);
}) as typeof clearInterval;

// Wait up to 200 ms for cancelled tasks and timers to end. True when work is
// still alive after that, so the worker must restart.
async function lingering(): Promise<boolean> {
  for (let i = 0; i < 10; i++) {
    if (pendingTasks() === 0 && timers.size === 0) return false;
    await new Promise((done) => realSetTimeout(done, 20));
  }
  return true;
}

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
  const helper = py.toPy({});
  py.runPython(RUNNER, { globals: helper });
  runCode = helper.get("run");
  pendingTasks = helper.get("pending");
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

async function run(req: RunRequest): Promise<{ reply: RunReply; restart: boolean }> {
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
  const after = new Map<string, Uint8Array>();
  let collected = false;
  const collect = () => {
    collected = true;
    for (const folder of DEN_FOLDERS) walk(folder, after);
  };
  try {
    result = (await runCode(req.code, py.globals, collect)) ?? null;
  } catch (e) {
    // A PythonError is the code's own exception. Anything else (for example
    // a Pyodide fatal error after out of memory) means this worker is broken.
    const kind = e instanceof Error && e.name === "PythonError" ? "python" : "crashed";
    error = { kind, message: e instanceof Error ? e.message : String(e) };
  }
  if (!collected) collect();
  const restart = error?.kind !== "crashed" && (await lingering());
  if (restart) err.write(new TextEncoder().encode("\nfoxden: work that the code started was still running after the run, so the worker restarted. Python variables are lost; files stay.\n"));
  const files: FileChanges = [];
  for (const [path, body] of after) if (!before.has(path) || !same(before.get(path)!, body)) files.push([path, body]);
  for (const path of before.keys()) if (!after.has(path)) files.push([path, null]);
  const truncated = out.state.dropped > 0 || err.state.dropped > 0;
  const reply = { id: req.id, stdout: out.state.text, stderr: err.state.text, result, error, truncated, files, durationMs: performance.now() - started };
  return { reply, restart };
}

scope.addEventListener("message", (e) => {
  const m = e.data;
  if (m.t === "load") {
    load(m.assets).then(
      (loadMs) => scope.postMessage({ t: "loaded", loadMs }),
      (error: unknown) => scope.postMessage({ t: "load-failed", message: error instanceof Error ? error.message : String(error) }),
    );
  } else if (m.t === "run") {
    void run(m.request).then(({ reply, restart }) => scope.postMessage({ t: "reply", reply, restart }));
  }
});
