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

const COMMAND_SEPARATORS = new Set(["&&", "||", ";", ";;", "|", "|&", "&"]);
const WRITE_REDIRECTS = new Set([">", ">>", ">|", "&>", "&>>"]);
// A command line can name many words. Checking each one on disk costs a stat call.
export const MAX_READ_CANDIDATES = 64;

/** Commands that run another command, with their options that take a value. */
const WRAPPERS = new Map<string, string[]>([
  ["sudo", ["-u", "-g", "-U", "-C", "-h", "-p", "-r", "-t", "-D", "-R", "-T"]],
  ["env", ["-u", "-C", "-S", "--unset", "--chdir", "--split-string"]],
  ["command", []],
  ["nohup", []],
  ["time", ["-f", "-o", "--format", "--output"]],
  ["rtk", []],
]);
// Marks a word that shell-quote parsed as an unquoted glob, so it never counts as a literal path.
const GLOB_MARK = "\u0000";

const COPY_VALUE_OPTIONS = ["-t", "-S", "--target-directory", "--suffix"];
const INSTALL_VALUE_OPTIONS = [...COPY_VALUE_OPTIONS, "-m", "-o", "-g", "--mode", "--owner", "--group"];
const TOUCH_VALUE_OPTIONS = ["-r", "-d", "-t", "--reference", "--date"];

/**
 * Find the files that a bash command changes or reads, without running it.
 * Write detection covers only explicit forms: redirections, `tee`, `touch`, `sed -i`, `perl -i`, `cp`, `mv`, and `install`.
 * A miss is better than a false write, because a write can pause the whole command.
 * Code inside a heredoc, or in a script that the command runs, is not read.
 */
export async function extractBashTargets(command: string, cwd: string, home = os.homedir()): Promise<BashTargets> {
  const tokens: ParseEntry[] = [];
  // shell-quote reads `#` to the end of its input, so each line is parsed alone to keep the commands after a comment line.
  for (const line of logicalLines(withoutHeredocBodies(command))) {
    try {
      tokens.push(...parse(line, (name) => process.env[name] ?? `$${name}`), { op: ";" });
    } catch {
      // shell-quote rejects some expansions, such as `${}`. The command then counts as unknown.
      return { writes: [], reads: [] };
    }
  }

  const writes = new Map<string, ToolTarget>();
  const readCandidates: Array<{ word: string; base: string }> = [];
  let directory = cwd;
  const subshellDirectories: string[] = [];
  let words: string[] = [];

  const addWrite = (word: string, base: string) => {
    if (!isPathWord(word) || word.startsWith("/dev/")) return;
    const target = resolveTarget(word, cwd, home, base);
    writes.set(target.absolutePath, target);
  };

  const finishCommand = async () => {
    const [name, ...args] = withoutWrappers(words);
    words = [];
    if (name === undefined) return;
    if (name === "cd") {
      const destination = args.find((arg) => !arg.startsWith("-"));
      if (args.length === 0) directory = home;
      else if (destination) directory = resolveTarget(destination, cwd, home, directory).absolutePath;
      return;
    }
    const { written, readOnly } = await commandFiles(path.basename(name), args, directory, home);
    for (const word of written) addWrite(word, directory);
    for (const word of readOnly) {
      if (isPathWord(word) && !word.startsWith("-")) readCandidates.push({ word, base: directory });
    }
  };

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (typeof token === "string") {
      words.push(token);
      continue;
    }
    if (!token || "comment" in token) continue;
    if (!("op" in token)) continue;
    if (token.op === "glob") {
      words.push(`${GLOB_MARK}${token.pattern}`);
      continue;
    }
    const next = tokens[index + 1];
    if (token.op === "(") {
      await finishCommand();
      subshellDirectories.push(directory);
    } else if (token.op === ")") {
      await finishCommand();
      // A `cd` inside a subshell does not move the commands after it.
      directory = subshellDirectories.pop() ?? directory;
    } else if (COMMAND_SEPARATORS.has(token.op)) {
      await finishCommand();
    } else if (WRITE_REDIRECTS.has(token.op) && typeof next === "string") {
      addWrite(next, directory);
      index++;
    } else if (token.op === "<" && typeof next === "string") {
      readCandidates.push({ word: next, base: directory });
      index++;
    } else if (token.op === ">&" && typeof next === "string") {
      if (!/^\d+$/.test(next)) addWrite(next, directory);
      index++;
    } else if ((token.op === "<<" || token.op === "<<<") && typeof next === "string") {
      // The heredoc delimiter or the here-string is text, not a file.
      index++;
    }
  }
  await finishCommand();

  const reads = new Map<string, ToolTarget>();
  for (const { word, base } of readCandidates.slice(0, MAX_READ_CANDIDATES)) {
    const target = resolveTarget(word, cwd, home, base);
    if (writes.has(target.absolutePath) || reads.has(target.absolutePath)) continue;
    if (await isFile(target.absolutePath)) reads.set(target.absolutePath, target);
  }
  return { writes: [...writes.values()], reads: [...reads.values()] };
}

/** The files that one simple command changes, and the other arguments that can name files that it reads. */
async function commandFiles(
  name: string,
  args: string[],
  directory: string,
  home: string,
): Promise<{ written: string[]; readOnly: string[] }> {
  const notWritten = (written: string[]) => ({ written, readOnly: args.filter((arg) => !written.includes(arg)) });
  switch (name) {
    case "tee":
      return notWritten(operands(args, []).files);
    case "touch":
      return notWritten(operands(args, TOUCH_VALUE_OPTIONS).files);
    case "sed":
      return notWritten(inPlaceFiles(args, (arg) => arg.startsWith("-i") || arg.startsWith("--in-place"), ["-e", "-f"], ["-l"]));
    case "perl":
      // `-M` and `-I` take an attached value, so `-Mstrict` is not `-i`.
      return notWritten(inPlaceFiles(args, (arg) => /^-[a-zA-HJ-LN-Z]*i/.test(arg), ["-e", "-E"], []));
    case "cp":
    case "mv":
      return notWritten(await copyDestinations(args, COPY_VALUE_OPTIONS, directory, home));
    case "install":
      if (args.includes("-d") || args.includes("--directory")) return notWritten([]);
      return notWritten(await copyDestinations(args, INSTALL_VALUE_OPTIONS, directory, home));
    default:
      return notWritten([]);
  }
}

/** Split arguments into option values and operands. `valueOptions` take the next argument as their value. */
function operands(args: string[], valueOptions: string[]): { files: string[]; values: Map<string, string> } {
  const files: string[] = [];
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? "";
    if (arg === "--") {
      files.push(...args.slice(index + 1));
      break;
    }
    if (valueOptions.includes(arg)) {
      values.set(arg, args[index + 1] ?? "");
      index++;
      continue;
    }
    const [longName, longValue] = arg.split("=", 2);
    if (longValue !== undefined && longName && valueOptions.includes(longName)) {
      values.set(longName, longValue);
      continue;
    }
    if (!arg.startsWith("-")) files.push(arg);
  }
  return { files, values };
}

/** Files of an in-place editor. Without a script option, the first operand is the script. */
function inPlaceFiles(
  args: string[],
  isInPlaceFlag: (arg: string) => boolean,
  scriptOptions: string[],
  otherValueOptions: string[],
): string[] {
  if (!args.some(isInPlaceFlag)) return [];
  const { files, values } = operands(args, [...scriptOptions, ...otherValueOptions]);
  return scriptOptions.some((option) => values.has(option)) ? files : files.slice(1);
}

/** The files that `cp`, `mv`, or `install` creates: inside a target directory, or the last operand. */
async function copyDestinations(args: string[], valueOptions: string[], directory: string, home: string): Promise<string[]> {
  const { files, values } = operands(args, valueOptions);
  const targetDirectory = values.get("-t") ?? values.get("--target-directory");
  if (targetDirectory !== undefined) return files.map((source) => path.posix.join(targetDirectory, path.posix.basename(source)));
  if (files.length < 2) return [];
  const destination = files.at(-1) ?? "";
  const sources = files.slice(0, -1);
  const intoDirectory =
    destination.endsWith("/") ||
    sources.length > 1 ||
    (await isDirectory(path.resolve(directory, destination.replace(/^~(?=\/|$)/, home))));
  return intoDirectory ? sources.map((source) => path.posix.join(destination, path.posix.basename(source))) : [destination];
}

/** Drop variable assignments and commands such as `sudo -u root`, to reach the command that runs. */
function withoutWrappers(words: string[]): string[] {
  let index = 0;
  while (index < words.length) {
    const word = words[index] ?? "";
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
      index++;
      continue;
    }
    const valueOptions = WRAPPERS.get(word);
    if (valueOptions === undefined) break;
    index++;
    while (index < words.length && (words[index] ?? "").startsWith("-")) {
      index += valueOptions.includes(words[index] ?? "") ? 2 : 1;
    }
  }
  return words.slice(index);
}

/** A word that can be a literal path. `$` stays in a word only when the variable is unknown. */
function isPathWord(word: string): boolean {
  return word.length > 0 && !word.includes(GLOB_MARK) && !word.includes("$") && !/^\d+$/.test(word);
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
    for (const match of line.matchAll(/(?<!<)<<(?!<)(-?)\s*(['"]?)([^\s'"<>|;&()]+)\2/g)) {
      delimiters.push({ word: match[3] ?? "", stripTabs: match[1] === "-" });
    }
  }
  return output.join("\n");
}

/** Lines of the command, with `\` line continuations joined. */
function logicalLines(command: string): string[] {
  return command
    .replace(/\\\n/g, " ")
    .split("\n")
    .filter((line) => line.trim().length > 0);
}
