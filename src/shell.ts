// A small shell-like command language over den files: ls, cat, head, wc,
// grep and echo, joined by |. It is not a real shell. It never runs user
// text as code, and grep matches plain text only, so a pattern cannot hang
// the page that calls it.
import { normalizePath } from "./paths.js";

export interface ShellResult {
  stdout: string;
  stderr: string;
  /** 0 = success, 1 = a file or match problem, 2 = bad usage, 127 = unknown command. */
  code: number;
  /** True when stdout or stderr was cut at maxOutputBytes. */
  truncated: boolean;
}

export interface ShellOptions {
  /** The most characters of stdout (and of stderr) to keep. Default 1 MiB. */
  maxOutputBytes?: number;
}

type Files = ReadonlyMap<string, Uint8Array>;
interface Step {
  out: string;
  err: string;
  code: number;
}
class Usage extends Error {}

const UNSUPPORTED = /[;&<>$`*?(){}]/;
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

function tokenize(line: string): string[][] {
  const commands: string[][] = [[]];
  let word: string | null = null;
  let quote: string | null = null;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null;
      else word += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      word ??= "";
    } else if (/\s/.test(ch) || ch === "|") {
      if (word !== null) commands.at(-1)!.push(word);
      word = null;
      if (ch === "|") commands.push([]);
    } else if (UNSUPPORTED.test(ch)) {
      throw new Usage(`foxden sh: ${ch} is not supported. foxden sh has only ls, cat, head, wc, grep, echo and |. Quote special characters.`);
    } else {
      word = (word ?? "") + ch;
    }
  }
  if (quote) throw new Usage("foxden sh: a quote is not closed.");
  if (word !== null) commands.at(-1)!.push(word);
  if (commands.some((c) => c.length === 0)) throw new Usage("foxden sh: an empty command is not supported.");
  return commands;
}

// Split leading options from the other arguments. `spec` maps each allowed
// flag to true when it takes a value.
function options(name: string, args: string[], spec: Record<string, boolean>): { flags: Map<string, string>; rest: string[] } {
  const flags = new Map<string, string>();
  let i = 0;
  while (i < args.length && /^-./.test(args[i]!)) {
    const flag = args[i]!;
    if (!(flag in spec)) throw new Usage(`${name}: unknown option ${flag}`);
    if (spec[flag]) {
      const value = args[i + 1];
      if (value === undefined) throw new Usage(`${name}: ${flag} needs a value`);
      flags.set(flag, value);
      i += 2;
    } else {
      flags.set(flag, "");
      i += 1;
    }
  }
  return { flags, rest: args.slice(i) };
}

// Read each named file, or stdin when there are none. Missing and bad paths
// go to stderr and set code 1; the other files still count.
function inputs(name: string, paths: string[], files: Files, stdin: string): { texts: [string, string][]; err: string } {
  if (paths.length === 0) return { texts: [["", stdin]], err: "" };
  const texts: [string, string][] = [];
  let err = "";
  for (const raw of paths) {
    try {
      const path = normalizePath(raw);
      const body = files.get(path);
      if (body) texts.push([path, decode(body)]);
      else err += `${name}: ${path}: No such file\n`;
    } catch (error) {
      err += `${name}: ${(error as Error).message}\n`;
    }
  }
  return { texts, err };
}

const lines = (text: string) => (text === "" ? [] : text.replace(/\n$/, "").split("\n"));

function ls(args: string[], files: Files): Step {
  if (args.length === 0) return { out: "drop/\nout/\nwork/\n", err: "", code: 0 };
  let out = "";
  let err = "";
  for (const raw of args) {
    if (files.has(raw)) {
      out += `${raw}\n`;
      continue;
    }
    let folder: string;
    try {
      folder = normalizePath(`${raw.replace(/\/+$/, "")}/_`).slice(0, -1);
    } catch (error) {
      err += `ls: ${(error as Error).message}\n`;
      continue;
    }
    const names = new Set<string>();
    for (const path of files.keys()) {
      if (!path.startsWith(folder)) continue;
      const [first, ...more] = path.slice(folder.length).split("/");
      names.add(more.length > 0 ? `${first}/` : first!);
    }
    out += [...names].toSorted().map((n) => `${n}\n`).join("");
  }
  return { out, err, code: err ? 1 : 0 };
}

function head(args: string[], files: Files, stdin: string): Step {
  const { flags, rest } = options("head", args, { "-n": true });
  const count = Number(flags.get("-n") ?? "10");
  if (!Number.isInteger(count) || count < 0) throw new Usage(`head: ${flags.get("-n")} is not a line count`);
  const { texts, err } = inputs("head", rest, files, stdin);
  const out = texts.map(([, t]) => lines(t).slice(0, count).map((l) => `${l}\n`).join("")).join("");
  return { out, err, code: err ? 1 : 0 };
}

function wc(args: string[], files: Files, stdin: string): Step {
  const { flags, rest } = options("wc", args, { "-l": false, "-w": false, "-c": false });
  const { texts, err } = inputs("wc", rest, files, stdin);
  const out = texts
    .map(([path, text]) => {
      const counts = { "-l": lines(text).length, "-w": text.split(/\s+/).filter(Boolean).length, "-c": new TextEncoder().encode(text).length };
      const shown = flags.size > 0 ? [...flags.keys()].map((f) => counts[f as keyof typeof counts]) : Object.values(counts);
      return `${[...shown, ...(path ? [path] : [])].join(" ")}\n`;
    })
    .join("");
  return { out, err, code: err ? 1 : 0 };
}

function grep(args: string[], files: Files, stdin: string): Step {
  const { flags, rest } = options("grep", args, { "-i": false, "-v": false, "-c": false, "-n": false });
  const [pattern, ...paths] = rest;
  if (pattern === undefined) throw new Usage("grep: a pattern is needed");
  const fold = (s: string) => (flags.has("-i") ? s.toLowerCase() : s);
  const needle = fold(pattern);
  const { texts, err } = inputs("grep", paths, files, stdin);
  let out = "";
  let matched = 0;
  for (const [path, text] of texts) {
    const prefix = texts.length > 1 ? `${path}:` : "";
    const hits = lines(text)
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => fold(line).includes(needle) !== flags.has("-v"));
    matched += hits.length;
    if (flags.has("-c")) out += `${prefix}${hits.length}\n`;
    else out += hits.map(({ line, n }) => `${prefix}${flags.has("-n") ? `${n}:` : ""}${line}\n`).join("");
  }
  return { out, err, code: err || matched === 0 ? 1 : 0 };
}

function step(command: string[], files: Files, stdin: string): Step {
  const [name, ...args] = command as [string, ...string[]];
  switch (name) {
    case "ls":
      return ls(args, files);
    case "cat": {
      const { texts, err } = inputs("cat", args, files, stdin);
      return { out: texts.map(([, t]) => t).join(""), err, code: err ? 1 : 0 };
    }
    case "head":
      return head(args, files, stdin);
    case "wc":
      return wc(args, files, stdin);
    case "grep":
      return grep(args, files, stdin);
    case "echo":
      return { out: `${args.join(" ")}\n`, err: "", code: 0 };
    default:
      return { out: "", err: `foxden sh: ${name}: command not found\n`, code: 127 };
  }
}

/** Run one command line over the den files. It never throws for bad input. */
export function runShell(line: string, files: Files, opts: ShellOptions = {}): ShellResult {
  const max = opts.maxOutputBytes ?? 1024 * 1024;
  let stdout = "";
  let stderr = "";
  let code = 0;
  try {
    for (const command of tokenize(line)) {
      const result = step(command, files, stdout);
      stdout = result.out;
      stderr += result.err;
      code = result.code;
    }
  } catch (error) {
    if (!(error instanceof Usage)) throw error;
    return { stdout: "", stderr: `${error.message}\n`, code: 2, truncated: false };
  }
  const truncated = stdout.length > max || stderr.length > max;
  return { stdout: stdout.slice(0, max), stderr: stderr.slice(0, max), code, truncated };
}
