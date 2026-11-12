import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getAgentDir, ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { discoverRules, type RuleSource } from "./discovery.ts";
import type { Rule, RuleDiagnostic } from "./types.ts";

/**
 * The project rules of git projects outside the working directory, for the files that the agent touches there.
 * A project counts only when pi trusts it, because its rules reach the model as instructions.
 */
export class OtherProjects {
  private readonly trusted = new Map<string, boolean>();
  private readonly rulesByRoot = new Map<string, Rule[]>();
  private readonly trustStore: Pick<ProjectTrustStore, "get">;
  private readonly home: string;

  constructor(trustStore: Pick<ProjectTrustStore, "get"> = new ProjectTrustStore(getAgentDir()), home = os.homedir()) {
    this.trustStore = trustStore;
    this.home = home;
  }

  /** The rules of the trusted project that holds `absolutePath`, or none when it is the working project. */
  async rulesFor(
    absolutePath: string,
    cwd: string,
    sources: RuleSource[],
  ): Promise<{ rules: Rule[]; diagnostics: RuleDiagnostic[] }> {
    const root = await findProjectRoot(path.dirname(absolutePath));
    if (!root || isInside(path.resolve(cwd), root) || !this.isTrusted(root)) return { rules: [], diagnostics: [] };
    const discovery = await discoverRules(root, { sources, home: this.home, labelPrefix: `${labelDirectory(root, this.home)}/` });
    const rules = discovery.rules.filter((rule) => rule.scope === "repo");
    this.rulesByRoot.set(root, rules);
    return { rules, diagnostics: discovery.diagnostics };
  }

  /** The rules of every project that this session loaded so far, to find changed versions. */
  knownRules(): Rule[] {
    return [...this.rulesByRoot.values()].flat();
  }

  clear(): void {
    this.trusted.clear();
    this.rulesByRoot.clear();
  }

  private isTrusted(root: string): boolean {
    let trusted = this.trusted.get(root);
    if (trusted === undefined) {
      trusted = this.trustStore.get(root) === true;
      this.trusted.set(root, trusted);
    }
    return trusted;
  }
}

/** The nearest directory at or above `directory` that holds `.git`. */
export async function findProjectRoot(directory: string): Promise<string | undefined> {
  for (let current = path.resolve(directory); ; current = path.dirname(current)) {
    if (await exists(path.join(current, ".git"))) return current;
    if (path.dirname(current) === current) return undefined;
  }
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function labelDirectory(directory: string, home: string): string {
  const relative = path.relative(home, directory);
  if (relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)) return `~/${relative.split(path.sep).join("/")}`;
  return directory.split(path.sep).join("/");
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}
