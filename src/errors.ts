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
