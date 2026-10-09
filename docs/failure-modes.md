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
