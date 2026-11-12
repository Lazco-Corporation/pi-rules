export type RuleToolName = "read" | "edit" | "write";

/** `repo` rules come from the project and apply inside it. `user` rules come from the home directory and apply to any file. */
export type RuleScope = "repo" | "user";

export interface RuleEvents {
  tool_call: RuleToolName[];
}

export interface Rule {
  id: string;
  sourcePath: string;
  sourceLabel: string;
  scope: RuleScope;
  body: string;
  /** Hash of the whole file, so a changed rule can be told apart from the version that the model has. */
  hash: string;
  paths?: string[];
  events?: RuleEvents;
  skills?: string[];
}

export interface RuleDiagnostic {
  sourceLabel: string;
  reason: string;
}

export interface DiscoveryResult {
  rules: Rule[];
  diagnostics: RuleDiagnostic[];
}

export interface InjectedRule {
  id: string;
  hash: string;
  label: string;
}

export interface RemovedRule {
  id: string;
  label: string;
}

export interface RuleInjectionDetails {
  injectionId: string;
  /** Rules that this message loads, also new versions of rules that the model has. */
  rules: InjectedRule[];
  /** Rules whose file is gone. The message tells the model to stop following them. */
  removed: RemovedRule[];
  sources: string[];
  /** The labels in `sources` that replace an earlier version. */
  updated: string[];
  targets: Record<string, string[]>;
  skills: string[];
}

export interface DueRule extends PendingRule {
  updated: boolean;
}

export interface PendingRule {
  rule: Rule;
  targets: Set<string>;
}
