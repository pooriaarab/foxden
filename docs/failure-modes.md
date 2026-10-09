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
