import { createHash } from "node:crypto";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Type from "typebox";
import { Compile } from "typebox/compile";
import { parseDocument } from "yaml";
import type { DiscoveryResult, Rule, RuleDiagnostic, RuleEvents, RuleScope, RuleToolName } from "./types.ts";

const FRONTMATTER_RE = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const RULE_TOOL_NAMES = new Set<RuleToolName>(["read", "edit", "write"]);

const RULE_SOURCE_SCHEMA = Type.Object({
  scope: Type.Union([Type.Literal("repo"), Type.Literal("user")]),
  kind: Type.Union([Type.Literal("pi"), Type.Literal("agents"), Type.Literal("claude")]),
});

const RULE_CONFIG_SCHEMA = Type.Object({
  enabled: Type.Optional(Type.Boolean()),
  sources: Type.Array(RULE_SOURCE_SCHEMA),
});

const RULE_CONFIG_VALIDATOR = Compile(RULE_CONFIG_SCHEMA);

export type RuleSource = Type.Static<typeof RULE_SOURCE_SCHEMA>;

export const DEFAULT_RULE_SOURCES: RuleSource[] = [
  { scope: "repo", kind: "pi" },
  { scope: "repo", kind: "agents" },
  { scope: "repo", kind: "claude" },
  { scope: "user", kind: "pi" },
  { scope: "user", kind: "agents" },
  { scope: "user", kind: "claude" },
];

interface RuleRoot {
  directory: string;
  label: string;
  scope: RuleScope;
}

interface DiscoveryOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  sources?: RuleSource[];
  /** Put before the label of each project rule, to name a project other than the working directory. */
  labelPrefix?: string;
}

export interface RuleConfigResult {
  enabled: boolean;
  sources: RuleSource[];
  configPath?: string;
  diagnostic?: RuleDiagnostic;
}

type ParseResult = { rule: Rule } | { diagnostic: RuleDiagnostic };

export async function loadRuleConfig(cwd: string, options: DiscoveryOptions = {}): Promise<RuleConfigResult> {
  const home = options.home ?? os.homedir();
  const env = options.env ?? process.env;
  const piCodingAgentDirectory = resolvePiCodingAgentDirectory(env, home);
  const candidates = [path.join(cwd, ".pi", "rules.json"), path.join(piCodingAgentDirectory, "rules.json")];

  for (const configPath of candidates) {
    let content: string;
    try {
      content = await readFile(configPath, "utf8");
    } catch (error) {
      const code = getErrorCode(error);
      if (code === "ENOENT") continue;
      return invalidConfig(configPath, labelPath(configPath, cwd, home), `unreadable: ${code}`);
    }

    let value: unknown;
    try {
      value = JSON.parse(content);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return invalidConfig(configPath, labelPath(configPath, cwd, home), `invalid JSON: ${message}`);
    }

    if (!RULE_CONFIG_VALIDATOR.Check(value)) {
      const [first] = RULE_CONFIG_VALIDATOR.Errors(value);
      const reason = first ? `${first.instancePath || "/"}: ${first.message}` : "schema validation failed";
      return invalidConfig(configPath, labelPath(configPath, cwd, home), reason);
    }

    return {
      enabled: value.enabled ?? true,
      sources: value.sources,
      configPath,
    };
  }

  return { enabled: true, sources: DEFAULT_RULE_SOURCES };
}

export async function discoverRules(cwd: string, options: DiscoveryOptions = {}): Promise<DiscoveryResult> {
  const home = options.home ?? os.homedir();
  const env = options.env ?? process.env;
  const roots = await withoutUserAliases(
    (options.sources ?? DEFAULT_RULE_SOURCES).map((source) => resolveRuleRoot(source, cwd, env, home)),
  );

  const rules: Rule[] = [];
  const diagnostics: RuleDiagnostic[] = [];
  const names = new Set<string>();

  for (const root of roots) {
    const files = await findMarkdownFiles(root.directory);
    for (const relativePath of files) {
      const name = path.basename(relativePath, ".md");
      if (names.has(name)) continue;
      names.add(name);

      const sourcePath = path.join(root.directory, ...relativePath.split("/"));
      const prefix = root.scope === "repo" ? (options.labelPrefix ?? "") : "";
      const sourceLabel = `${prefix}${root.label}/${relativePath}`;
      const parsed = await parseRuleFile(sourcePath, sourceLabel, root.scope);
      if ("rule" in parsed) {
        if (root.scope === "repo") parsed.rule.projectRoot = path.resolve(cwd);
        rules.push(parsed.rule);
      } else {
        diagnostics.push(parsed.diagnostic);
      }
    }
  }

  return { rules, diagnostics };
}

export async function parseRuleFile(sourcePath: string, sourceLabel: string, scope: RuleScope): Promise<ParseResult> {
  let content: string;
  try {
    content = await readFile(sourcePath, "utf8");
  } catch (error) {
    const code = getErrorCode(error);
    return { diagnostic: { sourceLabel, reason: `unreadable: ${code}` } };
  }

  const frontmatter = content.match(FRONTMATTER_RE);
  if (!frontmatter) {
    if (/^\uFEFF?---(?:\r?\n|$)/.test(content)) {
      return { diagnostic: { sourceLabel, reason: "unclosed frontmatter" } };
    }
    const body = content.replace(/^\uFEFF/, "");
    return { rule: { id: sourcePath, sourcePath, sourceLabel, scope, body, hash: hashContent(content) } };
  }

  let raw: unknown;
  try {
    const document = parseDocument(frontmatter[1] ?? "", { logLevel: "silent" });
    if (document.errors.length > 0) {
      return {
        diagnostic: {
          sourceLabel,
          reason: `invalid YAML: ${document.errors[0]?.message ?? "unknown error"}`,
        },
      };
    }
    raw = document.toJS();
  } catch (error) {
    return {
      diagnostic: {
        sourceLabel,
        reason: `invalid YAML: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }
  if (raw !== null && (typeof raw !== "object" || Array.isArray(raw))) {
    return { diagnostic: { sourceLabel, reason: "frontmatter must be a mapping" } };
  }

  const record = (raw ?? {}) as Record<string, unknown>;
  const paths = normalizeStringList(record.paths, "paths", "glob");
  if (paths && "reason" in paths) {
    return { diagnostic: { sourceLabel, reason: paths.reason } };
  }
  const events = normalizeRuleEvents(record.events);
  if (events && "reason" in events) {
    return { diagnostic: { sourceLabel, reason: events.reason } };
  }
  const skills = normalizeStringList(record.skills, "skills", "skill name");
  if (skills && "reason" in skills) {
    return { diagnostic: { sourceLabel, reason: skills.reason } };
  }
  const timing = record.timing;
  if (timing !== undefined && timing !== "before" && timing !== "after") {
    return { diagnostic: { sourceLabel, reason: "timing must be before or after" } };
  }

  const body = content.slice(frontmatter[0].length);
  const rule: Rule = { id: sourcePath, sourcePath, sourceLabel, scope, body, hash: hashContent(content) };
  if (paths) rule.paths = paths;
  if (events) rule.events = events;
  if (skills) rule.skills = skills;
  if (timing) rule.timing = timing;
  return { rule };
}

async function findMarkdownFiles(directory: string, ancestors = new Set<string>()): Promise<string[]> {
  let entries;
  let resolvedDirectory: string;
  try {
    resolvedDirectory = await realpath(directory);
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") return [];
    throw error;
  }

  // ponytail: track current ancestry only; permits aliases while stopping symlink cycles.
  if (ancestors.has(resolvedDirectory)) return [];
  const nextAncestors = new Set(ancestors).add(resolvedDirectory);
  const files: string[] = [];
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    let isDirectory = entry.isDirectory();
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      try {
        const target = await stat(entryPath);
        isDirectory = target.isDirectory();
        isFile = target.isFile();
      } catch (error) {
        if (getErrorCode(error) === "ENOENT" && entry.name.endsWith(".md")) files.push(entry.name);
        else if (getErrorCode(error) !== "ENOENT") throw error;
        continue;
      }
    }
    if (isDirectory) {
      const nested = await findMarkdownFiles(entryPath, nextAncestors);
      files.push(...nested.map((relativePath) => `${entry.name}/${relativePath}`));
      continue;
    }
    if (isFile && entry.name.endsWith(".md")) files.push(entry.name);
  }
  return files;
}

function resolvePiCodingAgentDirectory(env: NodeJS.ProcessEnv, home: string): string {
  return env.PI_CODING_AGENT_DIR || path.join(env.PI_CONFIG_DIR || path.join(home, ".pi"), "agent");
}

/** Every standard rule directory for a working directory, also the ones that `rules.json` turns off. */
export function standardRuleDirectories(cwd: string, options: { env?: NodeJS.ProcessEnv; home?: string } = {}): string[] {
  const home = options.home ?? os.homedir();
  const env = options.env ?? process.env;
  return DEFAULT_RULE_SOURCES.map((source) => resolveRuleRoot(source, cwd, env, home).directory);
}

function resolveRuleRoot(source: RuleSource, cwd: string, env: NodeJS.ProcessEnv, home: string): RuleRoot {
  if (source.scope === "repo") {
    return { directory: path.join(cwd, `.${source.kind}`, "rules"), label: `.${source.kind}/rules`, scope: "repo" };
  }

  if (source.kind === "pi") {
    const directory = path.join(resolvePiCodingAgentDirectory(env, home), "rules");
    return { directory, label: labelDirectory(directory, home), scope: "user" };
  }
  if (source.kind === "agents") {
    return { directory: path.join(home, ".agents", "rules"), label: "~/.agents/rules", scope: "user" };
  }

  const directory = path.join(env.CLAUDE_CONFIG_DIR || path.join(home, ".claude"), "rules");
  return { directory, label: labelDirectory(directory, home), scope: "user" };
}

/**
 * Drop a project root that is a user root, such as `.agents/rules` when pi starts in the home directory.
 * Its rules then load once, from the user root, with user scope.
 */
async function withoutUserAliases(roots: RuleRoot[]): Promise<RuleRoot[]> {
  const realDirectories = await Promise.all(roots.map((root) => realDirectory(root.directory)));
  const userDirectories = new Set(
    roots.flatMap((root, index) => (root.scope === "user" ? [realDirectories[index]] : [])),
  );
  return roots.filter((root, index) => root.scope === "user" || !userDirectories.has(realDirectories[index]));
}

async function realDirectory(directory: string): Promise<string> {
  try {
    return await realpath(directory);
  } catch {
    return path.resolve(directory);
  }
}

function invalidConfig(configPath: string, sourceLabel: string, reason: string): RuleConfigResult {
  return { enabled: false, sources: [], configPath, diagnostic: { sourceLabel, reason } };
}

function labelPath(target: string, cwd: string, home: string): string {
  const relative = path.relative(cwd, target);
  if (relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
    return relative.split(path.sep).join("/");
  }
  return labelDirectory(target, home);
}

function normalizeRuleEvents(raw: unknown): RuleEvents | { reason: string } | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { reason: "events must be a mapping of Pi event names to filters" };
  }

  const record = raw as Record<string, unknown>;
  const unsupported = Object.keys(record).filter((name) => name !== "tool_call");
  if (unsupported.length > 0) {
    return { reason: `events contains unsupported Pi event: ${unsupported.join(", ")}` };
  }
  const toolNames = normalizeStringList(record.tool_call, "events.tool_call", "tool name");
  if (!toolNames) return { reason: "events must include tool_call" };
  if ("reason" in toolNames) return toolNames;
  if (!toolNames.every((name): name is RuleToolName => RULE_TOOL_NAMES.has(name as RuleToolName))) {
    return { reason: "events.tool_call supports only read, edit, or write" };
  }
  return { tool_call: toolNames };
}

function normalizeStringList(
  raw: unknown,
  field: string,
  item: string,
): string[] | { reason: string } | undefined {
  if (raw === undefined) return undefined;
  const values = typeof raw === "string" ? [raw] : raw;
  if (!Array.isArray(values) || !values.every((value) => typeof value === "string")) {
    return { reason: `${field} must be a string or string list` };
  }
  const normalized = values.map((value) => value.trim());
  if (normalized.length === 0 || normalized.some((value) => value.length === 0)) {
    return { reason: `${field} must contain at least one non-empty ${item}` };
  }
  return [...new Set(normalized)];
}

function labelDirectory(directory: string, home: string): string {
  const relative = path.relative(home, directory);
  if (relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
    return `~/${relative.split(path.sep).join("/")}`;
  }
  return directory.split(path.sep).join("/");
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function getErrorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return "EUNKNOWN";
}
