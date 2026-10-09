// Path rules for den files. Every path that crosses a trust boundary (user,
// sandbox, snapshot) goes through normalizePath before foxden uses it.
import { PathError } from "./errors.js";

/** The folders a den can hold files in. */
export const DEN_FOLDERS = ["/drop", "/out", "/work"] as const;

const MAX_PATH = 1024;

/**
 * Return the one canonical spelling of a den file path, or throw PathError.
 * Repeated slashes collapse. `.`, `..`, NUL and backslash are refused, so a
 * path can never leave its folder.
 */
export function normalizePath(path: unknown): string {
  if (typeof path !== "string") throw new PathError(`A path must be a string, not ${typeof path}.`);
  if (path.length > MAX_PATH) throw new PathError(`A path must be ${MAX_PATH} characters or fewer.`);
  if (path.includes("\0") || path.includes("\\")) throw new PathError(`The path ${JSON.stringify(path)} holds a NUL byte or a backslash.`);
  if (!path.startsWith("/")) throw new PathError(`The path ${JSON.stringify(path)} must start with /drop/, /out/ or /work/.`);
  if (path.endsWith("/")) throw new PathError(`The path ${JSON.stringify(path)} names a folder, not a file.`);
  const parts = path.split("/").filter((part) => part !== "");
  if (parts.some((part) => part === "." || part === "..")) throw new PathError(`The path ${JSON.stringify(path)} holds a . or .. segment.`);
  const folder = `/${parts[0] ?? ""}`;
  if (!(DEN_FOLDERS as readonly string[]).includes(folder)) {
    throw new PathError(`The path ${JSON.stringify(path)} must start with /drop/, /out/ or /work/.`);
  }
  if (parts.length < 2) throw new PathError(`The path ${JSON.stringify(path)} names a folder, not a file.`);
  return `/${parts.join("/")}`;
}
