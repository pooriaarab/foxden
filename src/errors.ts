// The error classes foxden throws. Each has a stable `name`, so callers can
// check `error.name` across realms (for example an extension page and a tab).

class FoxdenError extends Error {
  constructor(name: string, message: string) {
    super(message);
    this.name = name;
  }
}

/** A path is not a file path inside /drop, /out or /work. */
export class PathError extends FoxdenError {
  constructor(message: string) {
    super("PathError", message);
  }
}

/** Snapshot bytes are corrupt, cut short, or forged. */
export class SnapshotError extends FoxdenError {
  constructor(message: string) {
    super("SnapshotError", message);
  }
}

/** A den is used in a wrong way: a bad name, a name already open, or a closed den. */
export class DenError extends FoxdenError {
  constructor(message: string) {
    super("DenError", message);
  }
}

/** The runtime could not start, for example because Pyodide files are missing. */
export class DenLoadError extends FoxdenError {
  constructor(message: string) {
    super("DenLoadError", message);
  }
}
