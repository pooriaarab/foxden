# foxden-sandbox

[![npm version](https://img.shields.io/npm/v/foxden-sandbox)](https://www.npmjs.com/package/foxden-sandbox)
[![Downloads/month](https://img.shields.io/npm/dm/foxden-sandbox)](https://www.npmjs.com/package/foxden-sandbox)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://opensource.org/license/mit)
[![Types included](https://img.shields.io/badge/types-included-blue)](#runtime-surfaces)

[Setup](#install) · [Quickstart](#run-your-first-python-code) · [API reference](#runtime-surfaces) · [Comparisons](#compare)

foxden-sandbox is an open-source browser code sandbox for developers who run Python over local files.
It pairs Pyodide with an isolated iframe and a worker whose content security policy (CSP) blocks network connections.
The host owns files, snapshots, and timeout recovery.

## Install

```bash
npm i foxden-sandbox pyodide@314.0.7
```

The package declares Node.js 24+ for tooling and includes TypeScript declarations.
Python execution uses browser APIs. Pyodide is its only direct runtime dependency.

foxden installs `pyodide` 314.0.7 next to it. Your page must serve two
folders: the sandbox page from foxden, and three files from Pyodide. Copy them
when you build:

```bash
mkdir -p public/foxden/pyodide
cp -r node_modules/foxden-sandbox/dist/den public/foxden/
cp node_modules/pyodide/pyodide.asm.wasm node_modules/pyodide/python_stdlib.zip node_modules/pyodide/pyodide-lock.json public/foxden/pyodide/
```

Use the Pyodide files of version 314.0.7. The loader inside `den.js` is that
version, and files from another version do not work with it. With pnpm,
`node_modules/pyodide` exists only when you also run `pnpm add pyodide@314.0.7`.

## Run your first Python code

```js
import { idbStore, iframeRuntime, openDen } from "foxden-sandbox";

const den = await openDen({
  name: "notes",
  store: idbStore(),
  runtime: iframeRuntime({ denUrl: "/foxden/den/den.html", pyodideUrl: "/foxden/pyodide/" }),
});

await den.writeFile("/drop/sales.csv", "region,amount\nnorth,10\nsouth,20\n");
const run = await den.run(
  `
import csv
rows = list(csv.DictReader(open("/drop/sales.csv")))
sum(float(row["amount"]) for row in rows)
`,
  { timeoutMs: 5000 },
);
console.log(run.result); // 30.0

const sh = await den.sh("grep north /drop/sales.csv");
console.log(sh.stdout); // north,10
await den.close();
```

Run this in a bundled browser page after the document body exists. The console shows `30.0` and `north,10`.
No environment variables or `.env` file are needed. The default iframe runtime needs browser APIs, so use a browser bundler.

## How it works

```text
Host files/store -> MessageChannel -> isolated iframe -> Pyodide worker
Host files/store <- checked changes <- stdout, stderr, result, changed files
                                  timeout -> terminate and restart worker
```

The host fetches bundled assets before execution. The sandbox page and its worker have `connect-src 'none'`.
The default adapter checks for an opaque origin and absence of extension APIs before it starts.
`auto` selects the manifest sandbox when available, with an iframe sandbox fallback on an isolation failure.
Python variables disappear when a worker restarts; host files survive.

## Why it exists

[Pyodide](https://pyodide.org/en/stable/usage/index.html) supplies Python execution, while [JupyterLite](https://jupyterlite.readthedocs.io/en/stable/quickstart/standalone.html) supplies a notebook application.
foxden-sandbox adds file ownership, sandbox checks, and timeout recovery behind a small library API.
Use it when your application supplies the editor and interface.

## Compare

Scope checked on 2026-10-14 against the linked project documentation. This table compares architecture, not performance.

| Item | foxden-sandbox | [Pyodide](https://pyodide.org/en/stable/usage/index.html) | [JupyterLite](https://jupyterlite.readthedocs.io/en/stable/quickstart/standalone.html) |
|---|---|---|---|
| Scope | File sandbox library | Python runtime | Notebook application |
| Deployment | Static assets you serve | Runtime assets you serve | Static site you serve |
| Configuration | JavaScript API | JavaScript API | Site build configuration |
| Package license | MIT | MPL-2.0 | BSD-3-Clause |

## Coverage

| Surface | Status | Verification |
|---|---|---|
| Pyodide Python standard library | ✓ | Shipped worker adapter |
| Firefox extension manifest sandbox | ✓ | Repository extension E2E suite |
| Website iframe sandbox | ✓ | Repository website E2E suite |
| pandas and NumPy | — | Not bundled |
| Native shell or remote execution | — | Not implemented |

One runtime adapter ships. Two browser isolation modes have repository E2E coverage; no external service credentials are needed.
The Firefox 153 fallback is exercised on newer Firefox, rather than a real Firefox 153 installation.

## Common use cases

1. Firefox extension authors: run model-written Python with local files and a timeout.
2. Next.js developers: serve the assets from `public/` and run CSV transforms in a client page.
3. Python teachers: build browser exercises with the standard library and separate named file sets.
4. Documentation authors: add Pyodide examples to a static site without a code execution server.
5. Test engineers: save snapshots and fork file sets before a destructive Python transform.

## Features

- **File stores:** keep files in memory or IndexedDB; see [the API](#runtime-surfaces).
- **Snapshots:** export, restore, and fork file sets with SHA-256 checks.
- **Timeouts:** restart a worker while retaining host files.
- **Shell helpers:** read files with six commands and pipelines.
- **Isolation:** use [extension or website setup](#integration-guides) with local assets.

## Runtime surfaces

```ts
import { openDen, iframeRuntime, idbStore, memoryStore, runShell, normalizePath,
         encodeSnapshot, decodeSnapshot } from "foxden-sandbox";
```

| Name | What it does |
|---|---|
| `openDen({ name, runtime, store?, snapshot?, maxDenBytes?, killGraceMs? })` | Opens a den and starts its runtime. `name` is 1-64 ASCII letters, digits, `-` or `_`. Rejects with `DenLoadError` when the runtime does not start. One name can be open once per page. |
| `den.run(code, { timeoutMs?, maxOutputBytes? })` | Runs Python. Returns `{ stdout, stderr, result, error, truncated, files, durationMs }`. `result` is the `repr()` of the last expression, or `null`. `error.kind` is `python`, `timeout`, `crashed`, or `storage`. Defaults: 30 s, 1 MiB. |
| `den.sh(command)` | Runs the shell above. Returns `{ stdout, stderr, code, truncated }`. |
| `den.writeFile(path, data)` / `den.readFile(path)` / `den.deleteFile(path)` / `den.list()` | Files under `/drop`, `/out`, and `/work`. A path with `..` throws `PathError`. |
| `den.snapshot()` / `den.restore(bytes)` | Packs all files into bytes with a SHA-256 for each file, and reads them back. Corrupt bytes throw `SnapshotError` and change nothing. Python variables are not in a snapshot. |
| `den.fork({ name })` | Opens a new den with a copy of the files. |
| `den.close()` | Removes the iframe and frees the name. |
| `den.info` | `{ kind, isolation, loadMs }` of the current runtime. |
| `iframeRuntime({ denUrl, pyodideUrl, isolation?, loadTimeoutMs?, container? })` | The default runtime. `isolation` is `"auto"`, `"manifest-sandbox"`, or `"iframe-sandbox"`. |
| `idbStore(dbName?)` / `memoryStore()` | Where the files live between page loads. The default is `memoryStore()`. |

`runtime` accepts an adapter with `start()`, `run(request)`, and `close()`. The shipped adapter is `iframeRuntime`.
Errors are `PathError`, `SnapshotError`, `DenError`, and `DenLoadError`.
The package has no command-line interface (CLI) or Model Context Protocol (MCP) server.

## Shell commands

`den.sh()` runs in the host page. It supports `ls`, `cat`, `head [-n N]`, `wc [-l|-w|-c]`, `grep [-i|-v|-c|-n]`, and `echo`.
Join commands with `|`; single and double quotes are supported. `grep` matches literal text.
Unsupported syntax returns code 2; an unknown command returns code 127. This is not bash.

## Delivery/behavior limits

- Python runs on one WebAssembly thread. No native Python performance benchmark is provided.
- Each den loads its own Pyodide worker. Initial assets include WebAssembly and the Python standard library.
- Only the Python standard library is there. pandas and NumPy are not
  bundled, and the sandbox cannot download packages.
- A timeout kills the worker, so Python variables are lost. Files stay.
- When a run ends, foxden cancels the asyncio tasks that the code started.
  If a task or a JavaScript timer is still alive 200 ms later, the worker
  restarts, and Python variables are lost. Files stay.
- Snapshots hold files only, not Python variables.
- Each run copies every den file to the sandbox and back. Very large dens
  are slow. The default cap is 256 MiB per den.
- Two pages that open the same den name at once both write to IndexedDB. The
  last save wins.
- The AMO policy says add-ons must not "load remote code for execution". It
  does not say if Python that a user or a model writes, run in a bundled
  interpreter, counts. This question is open. foxden bundles Pyodide and
  runs all such code only in the sandbox page.
- The `iframe-sandbox` fallback for Firefox 153 is tested on Firefox 157 with
  the attribute (the website E2E test), not on a real Firefox 153.
- The memory limit is the WebAssembly limit (4 GB). Code that asks for more
  gets a `MemoryError`, but it can use that much RAM before it does.
- The repository E2E suites target Firefox. Other browsers need separate validation.

## Integration guides

- [Firefox extension Python sandbox setup](#firefox-extension-setup)
- [Website Python sandbox setup](#website-setup)
- [Local demo and E2E commands](#demo-extension)

### Firefox extension setup

Copy `den/` and the Pyodide files into your extension, then add this to
`manifest.json`:

```json
{
  "sandbox": { "pages": ["den/den.html"] },
  "content_security_policy": {
    "extension_pages": "script-src 'self'; object-src 'none'",
    "sandbox": "sandbox allow-scripts; default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src blob:; connect-src 'none'"
  }
}
```

`worker-src blob:` is needed because a page with an opaque origin cannot
start a worker from a URL. `den.js` starts it from a string that is part of
the file. `web-ext lint` warns about this CSP, and about the `sandbox` key
when `strict_min_version` is below 154. See `scripts/lint-ext.mjs`.

### Website setup

Serve `den/` and the Pyodide files from your site, and call `iframeRuntime`
with their URLs. foxden uses `iframe-sandbox` there. Serve
`pyodide.asm.wasm` with any content type: the host reads it as bytes.

### Demo extension

`extension/` holds the demo. Its toolbar button opens the Space tab. Drop a
CSV, press Run, and the sample code counts the rows, sums each number column,
and writes `/out/sums.csv` for download. The badge says "Network: off".

```bash
pnpm install
pnpm build && pnpm build:ext   # writes dist-ext/ (about 15 MB)
pnpm e2e                       # the extension in real Firefox
pnpm e2e:web                   # the website case in real Firefox
```

The extension and website end-to-end (E2E) tests block remote traffic with a dead proxy.
They probe network APIs against a local server and expect zero requests.
Artifacts are written to `artifacts/` in the repository.

## Status

The package version is 0.1.3. The 0.x API can change.
[GitHub issues](https://github.com/pooriaarab/foxden/issues) are the support channel.
Public case studies are not yet published. The demo and repository tests provide examples, not production assurances.

## FAQ

### What is foxden-sandbox?

foxden-sandbox is a browser Python sandbox library. Applications supply files and code, then receive outputs and changed file paths.

### Does foxden-sandbox work in Node.js?

foxden-sandbox needs browser APIs for its default iframe runtime. Pure helpers such as `runShell` can run without an iframe.

### Can Python access the network?

foxden-sandbox gives the shipped sandbox page and worker a CSP with `connect-src 'none'`. The host still fetches local runtime assets.

### Which integrations are verified?

foxden-sandbox has repository E2E suites for Firefox extension and website isolation. Other browsers and custom adapters need separate checks.

### Does foxden-sandbox provide a managed code execution service?

foxden-sandbox runs on the reader's device with assets you serve. It provides no managed server or remote execution API.

### How is foxden-sandbox different from Pyodide?

foxden-sandbox uses Pyodide as its Python engine. It adds isolated execution, host-owned files, snapshots, and worker recovery.

### How is foxden-sandbox different from JupyterLite?

foxden-sandbox exposes a library API for your interface. JupyterLite provides a notebook application; see the [comparison](#compare).

### Can I install pandas or run bash?

foxden-sandbox bundles the Python standard library only. Its shell helper supports six read-oriented commands; it cannot run bash or download packages.

### What survives a timeout?

foxden-sandbox retains host files and restarts the worker. Python variables and interpreter state do not survive.

## License

MIT. Pyodide is MPL-2.0. The demo extension ships it unmodified.
