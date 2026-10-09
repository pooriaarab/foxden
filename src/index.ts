// The public API of foxden.
export { PathError, SnapshotError } from "./errors.js";
export { DEN_FOLDERS, normalizePath } from "./paths.js";
export { type DenMessage, type FileChanges, type HostMessage, parseDenMessage, parseHostMessage, PROTOCOL_VERSION, type RunReply, type RunRequest } from "./protocol.js";
export { runShell, type ShellOptions, type ShellResult } from "./shell.js";
export { decodeSnapshot, encodeSnapshot } from "./snapshot.js";
