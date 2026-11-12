import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse, type ParseEntry } from "shell-quote";
import { resolveTarget, type ToolTarget } from "./matching.ts";

export interface BashTargets {
  /** Files that the command changes. */
  writes: ToolTarget[];
  /** Existing files that the command names and does not change. */
  reads: ToolTarget[];
}

const COMMAND_SEPARATORS = new Set(["&&", "||", ";", ";;", "|", "|&", "&", "(", ")"]);
const WRITE_REDIRECTS = new Set([">", ">>", ">|", "&>", "&>>"]);
const PREFIX_COMMANDS = new Set(["sudo", "command", "env", "nohup", "time", "rtk"]);
// A command line can name many words. Checking each one on disk costs a stat call.
const MAX_READ_CANDIDATES = 64;

/**
 * Find the files that a bash command changes or reads, without running it.
 * Write detection covers only explicit forms: redirections, `tee`, `sed -i`, `perl -i`, `cp`, `mv`, `install`, and `touch`.
 * A miss is better than a false write, because a write can pause the whole command.
 * Code inside a heredoc is not read, so a script that it writes or runs stays unknown.
 */
export async function extractBashTargets(command: string, cwd: string, home = os.homedir()): Promise<BashTargets> {
  let tokens: ParseEntry[];
  try {
    tokens = parse(toSingleLine(withoutHeredocBodies(command)), (name) => process.env[name] ?? `$${name}`);
  } catch {
    // shell-quote rejects some expansions, such as `${}`. The command then counts as unknown.
    return { writes: [], reads: [] };
  }
  const writes = new Map<string, ToolTarget>();
  const readCandidates: Array<{ word: string; directory: string }> = [];
  let directory = cwd;

  const addWrite = (word: string, base: string) => {
    if (!isPathWord(word) || word.startsWith("/dev/")) return;
    const target = resolveTarget(word, cwd, home, base);
    writes.set(target.absolutePath, target);
  };

  for (const simple of splitCommands(tokens)) {
    const words: string[] = [];
    for (let index = 0; index < simple.length; index++) {
      const token = simple[index];
      if (typeof token === "string") {
        words.push(token);
        continue;
      }
      if (!token || !("op" in token)) continue;
      const next = simple[index + 1];
      if (WRITE_REDIRECTS.has(token.op) && typeof next === "string") {
        addWrite(next, directory);
        index++;
      } else if (token.op === "<" && typeof next === "string") {
        readCandidates.push({ word: next, directory });
        index++;
      } else if (token.op === ">&" && typeof next === "string") {
        if (!/^\d+$/.test(next)) addWrite(next, directory);
        index++;
      } else if ((token.op === "<<" || token.op === "<<<") && typeof next === "string") {
        // The heredoc delimiter or the here-string is text, not a file.
        index++;
      }
    }
    const [name, ...args] = stripPrefixes(words);
    if (name === undefined) continue;

    if (name === "cd") {
      const destination = args.find((arg) => !arg.startsWith("-"));
      if (args.length === 0) directory = home;
      else if (destination) directory = resolveTarget(destination, cwd, home, directory).absolutePath;
      continue;
    }

    const written = await intoDirectories(writtenFiles(name, args), name, args, directory, home);
    for (const word of written) addWrite(word, directory);
    for (const word of args) {
      if (!written.includes(word) && isPathWord(word)) readCandidates.push({ word, directory });
    }
  }

  const reads = new Map<string, ToolTarget>();
  for (const { word, directory: base } of readCandidates.slice(0, MAX_READ_CANDIDATES)) {
    const target = resolveTarget(word, cwd, home, base);
    if (writes.has(target.absolutePath) || reads.has(target.absolutePath)) continue;
    if (await isFile(target.absolutePath)) reads.set(target.absolutePath, target);
  }
  return { writes: [...writes.values()], reads: [...reads.values()] };
}

function writtenFiles(name: string, args: string[]): string[] {
  const operands = args.filter((arg) => !arg.startsWith("-"));
  switch (path.basename(name)) {
    case "tee":
    case "touch":
      return operands;
    case "sed":
      return inPlaceFiles(args, (arg) => arg === "-i" || arg.startsWith("-i") || arg.startsWith("--in-place"), ["-e", "-f"]);
    case "perl":
      return inPlaceFiles(args, (arg) => /^-[a-zA-Z]*i/.test(arg), ["-e", "-E"]);
    case "cp":
    case "mv":
    case "install":
      return copyDestinations(operands);
    default:
      return [];
  }
}

/** Files of an in-place editor. Without a script option, the first operand is the script. */
function inPlaceFiles(args: string[], isInPlaceFlag: (arg: string) => boolean, scriptOptions: string[]): string[] {
  if (!args.some(isInPlaceFlag)) return [];
  const operands: string[] = [];
  let hasScriptOption = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? "";
    if (scriptOptions.includes(arg)) {
      hasScriptOption = true;
      index++;
    } else if (!arg.startsWith("-")) {
      operands.push(arg);
    }
  }
  return hasScriptOption ? operands : operands.slice(1);
}

function copyDestinations(operands: string[]): string[] {
  if (operands.length < 2) return [];
  const destination = operands.at(-1) ?? "";
  const sources = operands.slice(0, -1);
  // A destination that ends with `/` is a directory, and each source lands inside it.
  if (destination.endsWith("/") || sources.length > 1) {
    return sources.map((source) => path.posix.join(destination, path.posix.basename(source)));
  }
  return [destination];
}

/** `cp a.ts dir` writes `dir/a.ts` when `dir` is an existing directory. */
async function intoDirectories(written: string[], name: string, args: string[], directory: string, home: string): Promise<string[]> {
  if (!["cp", "mv", "install"].includes(path.basename(name)) || written.length !== 1) return written;
  const destination = written[0] ?? "";
  if (!(await isDirectory(path.resolve(directory, destination.replace(/^~(?=\/|$)/, home))))) return written;
  const source = args.filter((arg) => !arg.startsWith("-")).at(0) ?? "";
  return [path.posix.join(destination, path.posix.basename(source))];
}

function splitCommands(tokens: ParseEntry[]): ParseEntry[][] {
  const commands: ParseEntry[][] = [[]];
  for (const token of tokens) {
    if (typeof token === "object" && token !== null && "comment" in token) continue;
    if (typeof token === "object" && token !== null && "op" in token && COMMAND_SEPARATORS.has(token.op)) {
      commands.push([]);
      continue;
    }
    commands.at(-1)?.push(token);
  }
  return commands.filter((command) => command.length > 0);
}

function stripPrefixes(words: string[]): string[] {
  let start = 0;
  while (start < words.length) {
    const word = words[start] ?? "";
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || PREFIX_COMMANDS.has(word)) start++;
    else break;
  }
  return words.slice(start);
}

function isPathWord(word: string): boolean {
  return word.length > 0 && !word.startsWith("-") && !word.includes("$") && !/^\d+$/.test(word);
}

async function isDirectory(absolutePath: string): Promise<boolean> {
  try {
    return (await stat(absolutePath)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(absolutePath: string): Promise<boolean> {
  try {
    return (await stat(absolutePath)).isFile();
  } catch {
    return false;
  }
}

/** Drop the body lines of each heredoc, so their text is not read as commands. */
function withoutHeredocBodies(command: string): string {
  const output: string[] = [];
  const delimiters: Array<{ word: string; stripTabs: boolean }> = [];
  for (const line of command.split("\n")) {
    const pending = delimiters[0];
    if (pending) {
      const candidate = pending.stripTabs ? line.replace(/^\t+/, "") : line;
      if (candidate === pending.word) delimiters.shift();
      continue;
    }
    output.push(line);
    for (const match of line.matchAll(/<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/g)) {
      delimiters.push({ word: match[3] ?? "", stripTabs: match[1] === "-" });
    }
  }
  return output.join("\n");
}

function toSingleLine(command: string): string {
  return command.replace(/\\\n/g, " ").replace(/\n/g, " ; ");
}
