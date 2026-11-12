import os from "node:os";
import path from "node:path";
import picomatch from "picomatch";
import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";
import type { Rule, RuleToolName } from "./types.ts";

const FILE_TOOLS = new Set(["read", "edit", "write"]);

/** A file that a tool call reads or changes. */
export interface ToolTarget {
  /** Absolute path with `/` separators. */
  absolutePath: string;
  /** Path relative to the working directory, only when the file is inside it. */
  relativePath?: string;
}

export function extractTarget(event: ToolCallEvent, cwd: string, home = os.homedir()): ToolTarget | undefined {
  if (!FILE_TOOLS.has(event.toolName)) return undefined;
  const rawPath = (event.input as { path?: unknown }).path;
  if (typeof rawPath !== "string" || rawPath.trim().length === 0) return undefined;
  const withoutAt = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
  return resolveTarget(withoutAt, cwd, home);
}

/** Resolve a path that a command names in `base`. `relativePath` is still relative to the working directory. */
export function resolveTarget(rawPath: string, cwd: string, home = os.homedir(), base = cwd): ToolTarget {
  const expanded = rawPath === "~" || rawPath.startsWith("~/") ? path.join(home, rawPath.slice(1)) : rawPath;
  const absolutePath = path.resolve(base, expanded);
  const relativePath = path.relative(cwd, absolutePath);
  const inside =
    relativePath.length > 0 &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath);
  return inside
    ? { absolutePath: toPosixPath(absolutePath), relativePath: toPosixPath(relativePath) }
    : { absolutePath: toPosixPath(absolutePath) };
}

/** The text that the injection message shows for a target. */
export function targetLabel(target: ToolTarget): string {
  return target.relativePath ?? target.absolutePath;
}

/**
 * A project rule applies only inside the working directory, and its globs are relative to it.
 * A user rule applies to any file. Its globs can be absolute (`/…`), start at the home directory (`~/…`),
 * or be relative: a relative glob matches the path inside the working directory or the absolute path.
 */
export function ruleAppliesToTarget(rule: Rule, target: ToolTarget, home = os.homedir()): boolean {
  if (rule.scope === "repo" && target.relativePath === undefined) return false;
  if (!rule.paths) return true;
  return rule.paths.some((pattern) => patternMatches(pattern, rule, target, home));
}

export function ruleMatchesToolCallEvent(rule: Rule, toolName: string): boolean {
  return !rule.events || rule.events.tool_call.some((name) => name === toolName);
}

/** How a tool call touches a file. A `bash` change can be an edit or a write, so it matches both. */
export type FileAccess = RuleToolName | "change";

export function accessMatchesEvents(rule: Rule, access: FileAccess): boolean {
  if (access === "change") return ruleMatchesToolCallEvent(rule, "edit") || ruleMatchesToolCallEvent(rule, "write");
  return ruleMatchesToolCallEvent(rule, access);
}

function patternMatches(pattern: string, rule: Rule, target: ToolTarget, home: string): boolean {
  const normalized = toPosixPath(pattern).replace(/^\.\//, "");
  if (rule.scope === "repo") return isMatch(target.relativePath ?? "", normalized);
  if (normalized.startsWith("/")) return isMatch(target.absolutePath, normalized);
  if (normalized.startsWith("~/")) {
    // Compare in `~/` form, so glob characters in the home path cannot change the pattern.
    const homePrefix = `${toPosixPath(home)}/`;
    if (!target.absolutePath.startsWith(homePrefix)) return false;
    return isMatch(`~/${target.absolutePath.slice(homePrefix.length)}`, normalized);
  }
  if (target.relativePath !== undefined && isMatch(target.relativePath, normalized)) return true;
  return isMatch(target.absolutePath.replace(/^\//, ""), normalized);
}

function isMatch(candidate: string, pattern: string): boolean {
  return picomatch.isMatch(candidate, pattern, { dot: true });
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}
