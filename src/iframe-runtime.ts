// The default runtime: Pyodide in a sandboxed iframe. The host fetches the
// Pyodide files and sends them over, because the sandbox has no network.
import type { DenRuntime, RuntimeInfo } from "./den.js";
import { parseDenMessage, type RunReply, type RunRequest } from "./protocol.js";

export interface IframeRuntimeOptions {
  /** URL of den.html (from foxden/dist/den/). */
  denUrl: string | URL;
  /** URL of a folder with pyodide.asm.wasm, python_stdlib.zip and pyodide-lock.json. */
  pyodideUrl: string | URL;
  /**
   * "manifest-sandbox": a plain iframe of a page in the manifest `sandbox` key (Firefox 154+).
   * "iframe-sandbox": an iframe with `sandbox="allow-scripts"` (websites, Firefox 153).
   * "auto" (default): manifest-sandbox when the extension lists den.html there, else iframe-sandbox.
   */
  isolation?: Isolation | "auto";
  /** Default 60000. */
  loadTimeoutMs?: number;
  /** Where to put the hidden iframe. Default document.body. */
  container?: HTMLElement;
}

export type Isolation = "manifest-sandbox" | "iframe-sandbox";
type Assets = { wasm: ArrayBuffer; stdlib: ArrayBuffer; lock: unknown };

const cache = new Map<string, Promise<Assets>>();

async function get(base: URL, name: string): Promise<Response> {
  const response = await fetch(new URL(name, base));
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
  return response;
}

function assets(base: URL): Promise<Assets> {
  let pending = cache.get(base.href);
  if (!pending) {
    pending = Promise.all([get(base, "pyodide.asm.wasm"), get(base, "python_stdlib.zip"), get(base, "pyodide-lock.json")]).then(
      async ([wasm, stdlib, lock]) => ({ wasm: await wasm.arrayBuffer(), stdlib: await stdlib.arrayBuffer(), lock: (await lock.json()) as unknown }),
    );
    pending.catch(() => cache.delete(base.href));
    cache.set(base.href, pending);
  }
  return pending;
}

function inManifestSandbox(den: URL): boolean {
  if (location.protocol !== "moz-extension:" || den.origin !== location.origin) return false;
  const g = globalThis as { browser?: { runtime?: { getManifest?: () => { sandbox?: { pages?: unknown } } } } };
  const pages = g.browser?.runtime?.getManifest?.().sandbox?.pages;
  return Array.isArray(pages) && pages.some((p) => typeof p === "string" && new URL(p, `${location.origin}/`).pathname === den.pathname);
}

function within<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

class IframeRuntime implements DenRuntime {
  #frame: HTMLIFrameElement | null = null;
  #port: MessagePort | null = null;
  readonly #pending = new Map<number, (reply: RunReply) => void>();

  constructor(readonly options: IframeRuntimeOptions) {}

  async start(): Promise<RuntimeInfo> {
    const den = new URL(this.options.denUrl, location.href);
    const mode = this.options.isolation ?? "auto";
    const first: Isolation = mode === "auto" ? (inManifestSandbox(den) ? "manifest-sandbox" : "iframe-sandbox") : mode;
    try {
      return await this.#open(den, first);
    } catch (error) {
      // Firefox 153 ignores the manifest sandbox key, so the den page refuses
      // to start there. In auto mode, try again with the sandbox attribute.
      if (mode !== "auto" || first !== "manifest-sandbox" || !String((error as Error).message).startsWith("not isolated")) throw error;
      this.close();
      return this.#open(den, "iframe-sandbox");
    }
  }

  async #open(den: URL, isolation: Isolation): Promise<RuntimeInfo> {
    const timeout = this.options.loadTimeoutMs ?? 60_000;
    const started = performance.now();
    const files = await assets(new URL(this.options.pyodideUrl, location.href));
    const frame = document.createElement("iframe");
    this.#frame = frame;
    if (isolation === "iframe-sandbox") frame.setAttribute("sandbox", "allow-scripts");
    frame.hidden = true;
    frame.title = "foxden sandbox";
    frame.src = den.href;
    const loaded = new Promise((done) => frame.addEventListener("load", done, { once: true }));
    (this.options.container ?? document.body).append(frame);
    const { port1, port2 } = new MessageChannel();
    this.#port = port1;
    const ready = new Promise<{ origin: string; extensionApi: boolean }>((resolve, reject) => {
      port1.addEventListener("message", (e) => {
        const m = parseDenMessage(e.data);
        if (m?.t === "ready") resolve(m);
        else if (m?.t === "load-error") reject(new Error(m.message));
        else if (m?.t === "reply") {
          this.#pending.get(m.reply.id)?.(m.reply);
          this.#pending.delete(m.reply.id);
        }
      });
      port1.start();
    });
    await within(loaded, timeout, `${den.href} did not load in ${timeout} ms.`);
    frame.contentWindow?.postMessage({ t: "init", v: 1, assets: files }, "*", [port2]);
    const m = await within(ready, timeout, `Pyodide did not load in ${timeout} ms.`);
    if (m.origin !== "null" || m.extensionApi) throw new Error(`not isolated: the den page has origin ${m.origin}.`);
    return { kind: "pyodide-iframe", isolation, loadMs: Math.round(performance.now() - started) };
  }

  run(request: RunRequest): Promise<RunReply> {
    return new Promise((done) => {
      this.#pending.set(request.id, done);
      this.#port?.postMessage({ t: "run", v: 1, request });
    });
  }

  close(): void {
    this.#port?.close();
    this.#frame?.remove();
    this.#port = null;
    this.#frame = null;
    this.#pending.clear();
  }
}

/** A runtime factory for openDen: Pyodide in a sandboxed iframe with no network. */
export function iframeRuntime(options: IframeRuntimeOptions): () => DenRuntime {
  return () => new IframeRuntime(options);
}
