// The sandbox page. The host sends one "init" message with a MessagePort and
// the Pyodide files. Code runs in a worker that dies when a run times out.
import { parseDenMessage, parseHostMessage, type DenMessage, type RunReply, type RunRequest } from "../protocol.js";
import type { Assets, WorkerIn, WorkerOut } from "./worker.js";

declare const FOXDEN_WORKER_SOURCE: string;

const g = globalThis as { browser?: { runtime?: { id?: unknown } }; chrome?: { runtime?: { id?: unknown } } };
const extensionApi = typeof g.browser?.runtime?.id === "string" || typeof g.chrome?.runtime?.id === "string";
let port: MessagePort | null = null;
let assets: Assets;
let worker: Worker;
let ready: Promise<number>;
let current: { id: number; timer: ReturnType<typeof setTimeout>; done: (reply: RunReply) => void } | null = null;
let queue: Promise<unknown> = Promise.resolve();

const send = (m: DenMessage) => port?.postMessage(m);
const failed = (id: number, kind: "timeout" | "crashed", message: string): RunReply => ({
  id, stdout: "", stderr: "", result: null, error: { kind, message }, truncated: false, files: [], durationMs: 0,
});

function finish(reply: RunReply) {
  if (!current || reply.id !== current.id) return;
  clearTimeout(current.timer);
  const { done } = current;
  current = null;
  done(reply);
}

function spawn(): Promise<number> {
  const url = URL.createObjectURL(new Blob([FOXDEN_WORKER_SOURCE], { type: "text/javascript" }));
  worker = new Worker(url, { type: "module" });
  const loading = new Promise<number>((resolve, reject) => {
    worker.addEventListener("message", (e: MessageEvent<WorkerOut>) => {
      const m = e.data;
      if (m?.t === "loaded") resolve(m.loadMs);
      else if (m?.t === "load-failed") reject(new Error(m.message));
      else if (m?.t === "reply" && parseDenMessage({ t: "reply", v: 1, reply: m.reply })) {
        finish(m.reply);
        // A crash, or work that outlived the run, needs a fresh worker.
        if (m.reply.error?.kind === "crashed" || m.restart) restart();
      }
    });
    worker.addEventListener("error", (e) => {
      e.preventDefault();
      const message = `The Python worker stopped: ${e.message || "unknown error"}`;
      reject(new Error(message));
      if (current) finish(failed(current.id, "crashed", message));
      restart();
    });
  });
  worker.postMessage({ t: "load", assets } satisfies WorkerIn);
  void loading.finally(() => URL.revokeObjectURL(url)).catch(() => {});
  return loading;
}

function restart() {
  worker.terminate();
  ready = spawn();
  ready.catch(() => {});
}

async function run(request: RunRequest): Promise<RunReply> {
  try {
    await ready;
  } catch (error) {
    return failed(request.id, "crashed", `Pyodide did not load again: ${(error as Error).message}`);
  }
  return new Promise((done) => {
    const timer = setTimeout(() => {
      finish(failed(request.id, "timeout", `The code ran for more than ${request.timeoutMs} ms and was stopped.`));
      restart();
    }, request.timeoutMs);
    current = { id: request.id, timer, done };
    worker.postMessage({ t: "run", request } satisfies WorkerIn);
  });
}

window.addEventListener("message", (e) => {
  const data = e.data as { t?: unknown; v?: unknown; assets?: Partial<Assets> } | null;
  if (port || e.source !== window.parent || data?.t !== "init" || data.v !== 1 || !e.ports[0]) return;
  port = e.ports[0];
  // Firefox 153 ignores the manifest sandbox key, and a host can forget the
  // sandbox attribute. Either way this page would share an origin or hold
  // extension APIs, so it stops here.
  if (self.origin !== "null" || extensionApi) {
    send({ t: "load-error", v: 1, message: `not isolated: the den page has origin ${self.origin} and extension API ${extensionApi}, so it refused to start.` });
    return;
  }
  const a = data.assets;
  if (!(a?.wasm instanceof ArrayBuffer) || !(a.stdlib instanceof ArrayBuffer)) {
    send({ t: "load-error", v: 1, message: "The init message has no Pyodide files." });
    return;
  }
  assets = { wasm: a.wasm, stdlib: a.stdlib, lock: a.lock };
  ready = spawn();
  ready.then(
    (loadMs) => send({ t: "ready", v: 1, origin: self.origin, extensionApi, loadMs }),
    (error: Error) => send({ t: "load-error", v: 1, message: `Pyodide did not load: ${error.message}` }),
  );
  port.addEventListener("message", (m) => {
    const msg = parseHostMessage(m.data);
    if (!msg) return;
    const next = queue.then(() => run(msg.request)).then((reply) => send({ t: "reply", v: 1, reply }));
    queue = next.catch(() => {});
  });
  port.start();
});
