// The den: a named set of files plus a runtime that runs code over them.
// The den object owns the files. The runtime (by default a sandboxed iframe
// with Pyodide) gets a copy for each run and sends back what changed, so a
// runtime that hangs or crashes can be thrown away without losing files.
import { DenError, DenLoadError, PathError } from "./errors.js";
import { normalizePath } from "./paths.js";
import type { FileChanges, RunErrorKind, RunReply, RunRequest } from "./protocol.js";

export interface RuntimeInfo {
  /** The adapter, for example "pyodide-iframe". */
  kind: string;
  /** How the runtime is cut off from the page, for example "manifest-sandbox". */
  isolation: string;
  loadMs: number;
}

/** A runtime adapter. foxden ships iframeRuntime; other adapters can plug in here. */
export interface DenRuntime {
  start(): Promise<RuntimeInfo>;
  run(request: RunRequest): Promise<RunReply>;
  close(): void;
}

/** Where a den keeps its files between page loads. */
export interface DenStore {
  load(name: string): Promise<Map<string, Uint8Array> | null>;
  save(name: string, files: ReadonlyMap<string, Uint8Array>): Promise<void>;
  remove(name: string): Promise<void>;
}

export interface OpenDenOptions {
  /** 1-64 characters: ASCII letters, digits, - and _. */
  name: string;
  /** Makes a new runtime. The den calls it again after a timeout. */
  runtime: () => DenRuntime;
  /** Default: memoryStore(). Use idbStore() to keep files across page loads. */
  store?: DenStore;
  /** The most bytes all files of the den can hold. Default 256 MiB. */
  maxDenBytes?: number;
  /** How long past timeoutMs to wait for the runtime before the den kills it. Default 5000. */
  killGraceMs?: number;
}

export interface RunOptions {
  /** Default 30000. */
  timeoutMs?: number;
  /** The most characters of stdout and of stderr to keep. Default 1 MiB. */
  maxOutputBytes?: number;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  result: string | null;
  error: { kind: RunErrorKind; message: string } | null;
  truncated: boolean;
  /** Paths that the run created, changed or deleted. */
  files: string[];
  durationMs: number;
}

export interface Den {
  readonly name: string;
  readonly info: RuntimeInfo;
  run(code: string, options?: RunOptions): Promise<RunResult>;
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
  deleteFile(path: string): Promise<void>;
  list(): Promise<{ path: string; size: number }[]>;
  close(): Promise<void>;
}

const NAME = /^[A-Za-z0-9_-]{1,64}$/;
const open = new Set<string>();
const size = (files: ReadonlyMap<string, Uint8Array>) => [...files.values()].reduce((sum, b) => sum + b.length, 0);

/** A store that keeps files in memory only. */
export function memoryStore(): DenStore {
  const dens = new Map<string, Map<string, Uint8Array>>();
  return {
    load: async (name) => (dens.has(name) ? new Map(dens.get(name)) : null),
    save: async (name, files) => void dens.set(name, new Map(files)),
    remove: async (name) => void dens.delete(name),
  };
}

/** Open a den by name. It loads the stored files and starts the runtime. */
export async function openDen(options: OpenDenOptions): Promise<Den> {
  const { name } = options;
  if (typeof name !== "string" || !NAME.test(name)) throw new DenError(`The den name ${JSON.stringify(name)} must be 1-64 ASCII letters, digits, - or _.`);
  if (open.has(name)) throw new DenError(`The den ${name} is already open in this page. Close it first.`);
  open.add(name);
  try {
    const store = options.store ?? memoryStore();
    const files = (await store.load(name)) ?? new Map<string, Uint8Array>();
    const runtime = options.runtime();
    let info: RuntimeInfo;
    try {
      info = await runtime.start();
    } catch (error) {
      runtime.close();
      throw new DenLoadError(`The den runtime did not start: ${error instanceof Error ? error.message : String(error)}`);
    }
    return new DenImpl(options, store, files, runtime, info);
  } catch (error) {
    open.delete(name);
    throw error;
  }
}

class DenImpl implements Den {
  readonly name: string;
  info: RuntimeInfo;
  #files: Map<string, Uint8Array>;
  #runtime: DenRuntime | null;
  #queue: Promise<unknown> = Promise.resolve();
  #closed = false;
  #nextId = 1;
  readonly #maxBytes: number;
  readonly #graceMs: number;

  constructor(
    readonly options: OpenDenOptions,
    readonly store: DenStore,
    files: Map<string, Uint8Array>,
    runtime: DenRuntime,
    info: RuntimeInfo,
  ) {
    this.name = options.name;
    this.#files = files;
    this.#runtime = runtime;
    this.info = info;
    this.#maxBytes = options.maxDenBytes ?? 256 * 1024 * 1024;
    this.#graceMs = options.killGraceMs ?? 5000;
  }

  #check() {
    if (this.#closed) throw new DenError(`The den ${this.name} is closed.`);
  }

  // Run fn after every earlier run and write, so changes apply in call order.
  #enqueue<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#closed) return Promise.reject(new DenError(`The den ${this.name} is closed.`));
    const next = this.#queue.then(fn);
    this.#queue = next.catch(() => {});
    return next;
  }

  // Save first, then switch, so a failed save leaves the den as it was.
  async #commit(files: Map<string, Uint8Array>) {
    if (size(files) > this.#maxBytes) throw new DenError(`The den ${this.name} would hold more than maxDenBytes (${this.#maxBytes} bytes).`);
    await this.store.save(this.name, files);
    this.#files = files;
  }

  async #liveRuntime(): Promise<DenRuntime> {
    if (this.#runtime) return this.#runtime;
    const runtime = this.options.runtime();
    try {
      this.info = await runtime.start();
    } catch (error) {
      runtime.close();
      throw new DenLoadError(`The den runtime did not restart: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.#runtime = runtime;
    return runtime;
  }

  run(code: string, options: RunOptions = {}): Promise<RunResult> {
    return this.#enqueue(async () => {
      if (typeof code !== "string") throw new DenError("run() needs the code as a string.");
      const timeoutMs = options.timeoutMs ?? 30_000;
      const max = options.maxOutputBytes ?? 1024 * 1024;
      const request: RunRequest = { id: this.#nextId++, code, files: [...this.#files], timeoutMs, maxOutputBytes: max };
      const started = Date.now();
      const runtime = await this.#liveRuntime();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<null>((done) => {
        timer = setTimeout(() => done(null), timeoutMs + this.#graceMs);
      });
      const reply = await Promise.race([runtime.run(request), late]).finally(() => clearTimeout(timer));
      if (!reply) {
        runtime.close();
        this.#runtime = null;
        await this.#liveRuntime().catch(() => {});
        return this.#result({ error: { kind: "timeout", message: `The code ran for more than ${timeoutMs} ms and was stopped.` } }, max, started);
      }
      const keep = reply.error === null || reply.error.kind === "python";
      const { files, changed, notes } = keep ? this.#apply(reply.files) : { files: this.#files, changed: [], notes: "" };
      try {
        if (changed.length > 0) await this.#commit(files);
      } catch (error) {
        return this.#result({ ...reply, files: [], error: { kind: "storage", message: (error as Error).message } }, max, started);
      }
      return this.#result({ ...reply, stderr: reply.stderr + notes, files: changed }, max, started);
    });
  }

  #apply(changes: FileChanges) {
    const files = new Map(this.#files);
    const changed: string[] = [];
    let notes = "";
    for (const [raw, body] of changes) {
      let path: string;
      try {
        path = normalizePath(raw);
      } catch (error) {
        notes += `foxden: ignored a file with a bad path: ${(error as PathError).message}\n`;
        continue;
      }
      if (body) files.set(path, body);
      else files.delete(path);
      changed.push(path);
    }
    return { files, changed, notes };
  }

  #result(r: Partial<Omit<RunReply, "files">> & { files?: string[] }, max: number, started: number): RunResult {
    const stdout = r.stdout ?? "";
    const stderr = r.stderr ?? "";
    return {
      stdout: stdout.slice(0, max),
      stderr: stderr.slice(0, max),
      result: r.result ?? null,
      error: r.error ?? null,
      truncated: (r.truncated ?? false) || stdout.length > max || stderr.length > max,
      files: r.files ?? [],
      durationMs: r.durationMs ?? Date.now() - started,
    };
  }

  async writeFile(path: string, data: string | Uint8Array): Promise<void> {
    const p = normalizePath(path);
    const body = typeof data === "string" ? new TextEncoder().encode(data) : data.slice();
    return this.#enqueue(() => this.#commit(new Map(this.#files).set(p, body)));
  }

  async readFile(path: string): Promise<Uint8Array> {
    this.#check();
    const p = normalizePath(path);
    const body = this.#files.get(p);
    if (!body) throw new DenError(`${p}: No such file in den ${this.name}.`);
    return body.slice();
  }

  async deleteFile(path: string): Promise<void> {
    const p = normalizePath(path);
    return this.#enqueue(async () => {
      const files = new Map(this.#files);
      files.delete(p);
      await this.#commit(files);
    });
  }

  async list() {
    this.#check();
    return [...this.#files].map(([path, body]) => ({ path, size: body.length })).toSorted((a, b) => (a.path < b.path ? -1 : 1));
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#runtime?.close();
    this.#runtime = null;
    open.delete(this.name);
  }
}
