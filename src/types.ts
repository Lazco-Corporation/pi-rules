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
  /** Hash of the body, so a changed rule file can be told apart from the copy the model already has. */
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
}

export interface RuleInjectionDetails {
  injectionId: string;
  rules: InjectedRule[];
  sources: string[];
  targets: Record<string, string[]>;
  skills: string[];
}

export interface PendingRule {
  rule: Rule;
  targets: Set<string>;
}
