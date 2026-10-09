# Failure modes

This file lists every way foxden can fail that we know of. Each row has a test.
We write the row and its test before the code, and commit them first.

Most rows have an E2E check in real Firefox (`pnpm e2e`). A row has an
isolated test in `tests/` only when the E2E test cannot reach the failure.

## Paths (`src/paths.ts`)

A den holds files under three folders: `/drop` (input), `/out` (output) and
`/work` (scratch). Paths come from the user, from Python code in the sandbox,
and from snapshot files. All three are untrusted.

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| P1 | A path uses `..` to leave `/drop`, for example `/drop/../etc/passwd` | `PathError`. No file is read or written. | `tests/paths.test.ts` |
| P2 | A path is relative (`data.csv`) or outside the three folders (`/etc/x`, `/tmp/x`) | `PathError` | `tests/paths.test.ts` |
| P3 | A path holds a NUL byte, a backslash, or a `.` segment | `PathError` | `tests/paths.test.ts` |
| P4 | A path names a folder, not a file (`/drop`, `/drop/`) | `PathError` | `tests/paths.test.ts` |
| P5 | A path is very long (over 1024 characters) or not a string | `PathError` | `tests/paths.test.ts` |
| P6 | A path has repeated slashes (`/drop//a.csv`) | It becomes `/drop/a.csv`, so two spellings cannot name two files | `tests/paths.test.ts` |

## Snapshots (`src/snapshot.ts`)

`den.snapshot()` returns bytes. `den.restore(bytes)` and `openDen({ snapshot })`
read them back. The bytes can come from disk, from another person, or from an
attacker.

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| S1 | The bytes are not a snapshot (wrong magic, empty, random) | `SnapshotError`. The den does not change. | `tests/snapshot.test.ts` |
| S2 | The bytes are cut short at any point | `SnapshotError` | `tests/snapshot.test.ts` |
| S3 | One byte of a file body is changed | `SnapshotError` that names the file (SHA-256 check) | `tests/snapshot.test.ts` |
| S4 | The header is not valid JSON, or has the wrong version | `SnapshotError` | `tests/snapshot.test.ts` |
| S5 | The header names a path with `..` or outside the den folders | `SnapshotError`. Path rules P1-P5 apply. | `tests/snapshot.test.ts` |
| S6 | The header lists the same path two times | `SnapshotError` | `tests/snapshot.test.ts` |
| S7 | The header claims a size larger than the bytes, or a huge header length | `SnapshotError`, with no large allocation first | `tests/snapshot.test.ts` |
| S8 | Extra bytes follow the last file | `SnapshotError` | `tests/snapshot.test.ts` |
| S9 | A good snapshot round-trips | Same paths and the same bytes come back, including empty and binary files | `tests/snapshot.test.ts` |

## Shell (`src/shell.ts`)

`den.sh(command)` runs a small shell-like command language over the den
files. It is not a real shell: it has `ls`, `cat`, `head`, `wc`, `grep` and
`echo`, joined by `|`. It runs in the caller's page, not in the sandbox, so it
must never run user text as code and must never hang.

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| SH1 | The command is not one of the six | Exit code 127 and `command not found` on stderr | `tests/shell.test.ts` |
| SH2 | The line uses syntax we do not have (`;`, `&&`, `>`, `<`, `$`, backticks, `*`) | Exit code 2 and `not supported` on stderr. No part of the line runs. | `tests/shell.test.ts` |
| SH3 | A file does not exist | Exit code 1 and `No such file` on stderr. Other files in the same command still print. | `tests/shell.test.ts` |
| SH4 | An argument uses `..` to leave the den folders | Exit code 1 and the path error on stderr. Nothing is read. | `tests/shell.test.ts` |
| SH5 | The output is very large (`cat` of a big file) | stdout stops at `maxOutputBytes` and `truncated` is true | `tests/shell.test.ts` |
| SH6 | A grep pattern looks like a slow regular expression (`(a+)+$`) | grep matches it as plain text, so it cannot hang the page | `tests/shell.test.ts` |
| SH7 | A quote is not closed | Exit code 2 and an error on stderr | `tests/shell.test.ts` |
| SH8 | An option has a bad value (`head -n x`) or is unknown | Exit code 2 and an error on stderr | `tests/shell.test.ts` |

## Messages (`src/protocol.ts`)

The page that opens a den and the sandbox page talk only by `postMessage`.
Each side reads the other side's messages as untrusted data.

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| M1 | A message is not an object, has the wrong version, or an unknown type | The parser returns `null` and the message is ignored | `tests/protocol.test.ts` |
| M2 | A message has a field of the wrong type (a file body that is not bytes, a string where a number goes) | `null`, ignored | `tests/protocol.test.ts` |

## The den (`src/den.ts`)

The den object keeps the files, sends runs to a runtime, and saves the files
to a store. The runtime is an adapter: foxden ships the sandboxed iframe
runtime, and tests use a fake one.

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| D1 | Code runs past `timeoutMs` and the runtime does not answer | After `timeoutMs` plus a grace time, `run` returns `error.kind: "timeout"`. The den drops that runtime, starts a new one, and keeps the files from before the run. | `tests/den.test.ts`, E2E |
| D2 | The runtime reports a crash (for example out of memory) | `run` returns `error.kind: "crashed"`, the files from before the run stay, and the next run works | `tests/den.test.ts`, E2E |
| D3 | The sandbox sends back a file path with `..` or outside the den folders | The den drops that file and says so on stderr. No file outside the den changes. | `tests/den.test.ts` |
| D4 | The sandbox sends back more bytes than `maxDenBytes` | The den keeps the old files and returns `error.kind: "storage"` | `tests/den.test.ts` |
| D5 | The runtime cannot load (missing or broken Pyodide files, offline with no bundle) | `openDen` rejects with `DenLoadError`, and the name can be opened again | `tests/den.test.ts`, E2E |
| D6 | The same den name is opened two times in one page | The second `openDen` rejects with `DenError` | `tests/den.test.ts` |
| D7 | Two dens are open at once | Each has its own files, store entry and runtime. A write in one does not show in the other. | `tests/den.test.ts`, E2E |
| D8 | A method is called after `close()` | It rejects with `DenError`. A second `close()` does nothing. | `tests/den.test.ts` |
| D9 | Two runs are started at once | They run one after the other, in call order | `tests/den.test.ts` |
| D10 | `restore()` gets corrupt snapshot bytes | It rejects with `SnapshotError` and the files do not change | `tests/den.test.ts` |
| D11 | A fork changes its files | The source den does not change | `tests/den.test.ts` |
| D12 | The store cannot save (disk full, quota) | `writeFile` rejects and the den keeps its old files | `tests/den.test.ts` |
| D13 | The sandbox sends back stdout larger than `maxOutputBytes` | The den cuts it and sets `truncated` | `tests/den.test.ts` |
| D14 | The den name is empty, too long, or has odd characters | `openDen` rejects with `DenError` | `tests/den.test.ts` |

## The sandbox page and worker (`src/page/`, `src/iframe-runtime.ts`)

Code runs in a worker inside `den.html`. The page has an opaque origin and a
CSP with `connect-src 'none'`. These rows run in real Firefox:
`e2e/web.mjs` uses a normal web page (the website case), and `e2e/run.mjs`
uses the demo extension.

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| N1 | Code calls `fetch` | It fails. The local probe server gets no request. | E2E |
| N2 | Code uses `XMLHttpRequest` | It fails. No request arrives. | E2E |
| N3 | Code opens a `WebSocket` | It fails. No connection arrives. | E2E |
| N4 | Code uses `EventSource`, dynamic `import()`, or a nested worker that fetches | It fails. No request arrives. | E2E |
| T1 | Code loops forever | The sandbox page kills the worker at `timeoutMs`. `run` returns `timeout`, the next run works, and the files stay. | E2E |
| O1 | Code prints without end | Output stops at `maxOutputBytes` and `truncated` is true. The worker does not run out of memory. | E2E |
| T2 | Code starts an asyncio task, or a JavaScript timer, and the run returns while it still runs | The worker cancels pending asyncio tasks before it collects files. If a task or a timer is still alive after that, the sandbox page restarts the worker (Python variables are lost, files stay) and says so on stderr. A later run never commits a file that leftover work wrote. | E2E (`e2e/web.mjs`) |
| T3 | A run leaves no background work | Python variables stay for the next run (no needless restart) | E2E (`e2e/web.mjs`) |
| L2 | The machine is offline | Pyodide loads anyway: every file comes from the host origin. The E2E test runs with all remote network sent to a dead proxy. | E2E |
| W1 | foxden runs on a normal website, not in an extension | The den works in an `iframe-sandbox` iframe with the `<meta>` CSP | E2E (`e2e/web.mjs`) |
| V1 | The last expression is a float, a string, or another Python value that JavaScript would change (`30.0` becomes `30`) | `result` is the Python `repr()` of the value, made in Python. `None` gives `null`. | E2E (`e2e/web.mjs`) |
| L1 | The Pyodide files are missing (wrong `pyodideUrl`, no bundle) | `openDen` rejects with `DenLoadError` and does not hang | E2E |
| I1 | The den page is not isolated (same origin as the host, or extension APIs present, as on Firefox 153 without the `sandbox` key) | The den page refuses to start before it loads Pyodide. Forced `manifest-sandbox` rejects with `not isolated`. `auto` falls back to `iframe-sandbox`. | E2E |
| X1 | Another window posts a fake reply to the host, or a second `init` to the den page | Both are ignored. Only the MessagePort from the first `init` counts. | E2E |
| R1 | Code asks for more memory than WebAssembly can give | `run` returns an error (`MemoryError` or `crashed`), and the next run works | E2E |

## The IndexedDB store (`src/idb-store.ts`)

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| B1 | The page reloads or the browser restarts | `openDen` with `idbStore()` gets the same files back | E2E |
| B2 | IndexedDB is not there (Node, a sandboxed frame, some private modes) | `idbStore()` calls reject with a `DenError` that says so, so `openDen` fails before it starts a runtime | `tests/idb-store.test.ts` |

## The demo extension (`extension/`)

The Space page is a tab where a person drops files and runs Python.
`e2e/run.mjs` drives it in real Firefox and writes `artifacts/e2e-<date>.json`.

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| E1 | A dropped file name holds `/`, `\` or `..` | The file is saved under `/drop` with those characters replaced | E2E |
| E2 | The extension build has no Pyodide files or no `den/` folder | `pnpm build:ext` stops with an error that names the missing file | E2E (the build runs first) |
| E3 | The `sandbox` manifest key does not work in this Firefox | The Space page shows the isolation it got. The E2E test expects `manifest-sandbox` on Firefox 154+. | E2E |
| E4 | Code in the Space page tries the network, or loops forever | Rows N1 and T1 hold inside the extension too | E2E |
