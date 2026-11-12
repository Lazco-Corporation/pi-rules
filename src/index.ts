import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  stripFrontmatter,
  type ExtensionAPI,
  type ExtensionContext,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { DEFAULT_RULE_SOURCES, discoverRules, loadRuleConfig, type RuleSource } from "./discovery.ts";
import { extractTarget, ruleAppliesToTarget, ruleMatchesToolCallEvent, targetLabel } from "./matching.ts";
import { addInjection, collectInjectedState, CUSTOM_MESSAGE_TYPE, type InjectedState } from "./state.ts";
import type { PendingRule, Rule, RuleInjectionDetails } from "./types.ts";

export { CUSTOM_MESSAGE_TYPE };

export interface RuleInjection {
  customType: typeof CUSTOM_MESSAGE_TYPE;
  content: string;
  display: true;
  details: RuleInjectionDetails;
}

export function makeExtension() {
  return (pi: ExtensionAPI): void => {
    let config: { enabled: boolean; sources: RuleSource[] } = { enabled: true, sources: DEFAULT_RULE_SOURCES };
    let rules: Rule[] = [];
    let reportWarning = (message: string): void => {
      process.stderr.write(`${message}\n`);
    };
    const availableSkills = new Map<string, Skill>();
    // Matches from the tool calls of the current turn. They load when the turn ends.
    const pendingRules = new Map<string, PendingRule>();
    // Injections sent with pi.sendMessage that pi has not written to the session yet.
    const inFlight = new Map<string, RuleInjectionDetails>();
    // Building the projection walks the whole branch, and parallel tool calls share one leaf.
    let cachedBranch: { leafId: string | null; state: InjectedState } | undefined;

    pi.registerMessageRenderer<RuleInjectionDetails>(CUSTOM_MESSAGE_TYPE, (message, { expanded }, theme) => {
      const details = message.details;
      const sourceLines = (details?.sources ?? ["(unknown)"]).map((source) => `↳ ${source}`).join("\n");
      const skillLines = (details?.skills ?? []).map((skill) => `↳ ${skill}`).join("\n");
      const summary = `Loaded rules:\n${sourceLines}${skillLines ? `\nLoaded skills:\n${skillLines}` : ""}`;
      if (!expanded) {
        return new Text(theme.fg("muted", summary), 0, 0);
      }

      const targetLines = details?.sources
        .map((source) => {
          const targets = details.targets[source] ?? [];
          return targets.length > 0 ? `${source} → ${targets.join(", ")}` : `${source} → unconditional`;
        })
        .join("\n");
      const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content, null, 2);
      return new Text(
        `${theme.fg("accent", "Loaded rules:")}\n${theme.fg("muted", sourceLines)}\n\n${theme.fg("dim", targetLines ?? "")}\n\n${content}`,
        0,
        0,
      );
    });

    const reloadConfig = async (cwd: string): Promise<void> => {
      const result = await loadRuleConfig(cwd);
      config = { enabled: result.enabled, sources: result.sources };
      if (result.diagnostic) {
        reportWarning(`[pi-rules] invalid config ${result.diagnostic.sourceLabel}: ${result.diagnostic.reason}`);
      }
    };

    const reloadRules = async (cwd: string): Promise<Rule[]> => {
      const discovery = await discoverRules(cwd, { sources: config.sources });
      for (const diagnostic of discovery.diagnostics) {
        reportWarning(`[pi-rules] skipped ${diagnostic.sourceLabel}: ${diagnostic.reason}`);
      }
      return discovery.rules;
    };

    const withInFlight = (base: InjectedState): InjectedState => {
      for (const injectionId of base.injectionIds) inFlight.delete(injectionId);
      if (inFlight.size === 0) return base;
      const merged: InjectedState = {
        rules: new Map(base.rules),
        skills: new Set(base.skills),
        injectionIds: new Set(base.injectionIds),
      };
      for (const details of inFlight.values()) addInjection(merged, details);
      return merged;
    };

    const branchState = (ctx: ExtensionContext): InjectedState => {
      const leafId = ctx.sessionManager.getLeafId();
      if (cachedBranch?.leafId !== leafId) {
        cachedBranch = { leafId, state: collectInjectedState(ctx.sessionManager.buildSessionProjection().entries) };
      }
      return withInFlight(cachedBranch.state);
    };

    // Takes the matches of this turn and adds every unconditional rule that the model does not have.
    const takeDueRules = (state: InjectedState): PendingRule[] => {
      const due = [...pendingRules.values()].filter((entry) => !state.rules.has(entry.rule.id));
      pendingRules.clear();
      for (const rule of rules) {
        if (isScoped(rule) || state.rules.has(rule.id)) continue;
        if (!due.some((entry) => entry.rule.id === rule.id)) due.push({ rule, targets: new Set<string>() });
      }
      return due;
    };

    const buildInjection = async (entries: PendingRule[], state: InjectedState): Promise<RuleInjection> => {
      const skillBlocks = await loadSkillBlocks(entries, availableSkills, state.skills, reportWarning);
      return createInjection(entries, skillBlocks);
    };

    pi.on("session_start", async (_event, ctx) => {
      reportWarning = ctx.hasUI
        ? (message) => ctx.ui.notify(message, "warning")
        : (message) => process.stderr.write(`${message}\n`);
      await reloadConfig(ctx.cwd);
      rules = config.enabled ? await reloadRules(ctx.cwd) : [];
      availableSkills.clear();
      pendingRules.clear();
      inFlight.clear();
      cachedBranch = undefined;
    });

    pi.on("session_tree", () => {
      pendingRules.clear();
    });

    pi.on("before_agent_start", async (event, ctx) => {
      availableSkills.clear();
      for (const skill of event.systemPromptOptions?.skills ?? []) availableSkills.set(skill.name, skill);
      if (!config.enabled) return;
      rules = await reloadRules(ctx.cwd);
      const state = branchState(ctx);
      const due = takeDueRules(state);
      if (due.length === 0) return;
      return { message: await buildInjection(due, state) };
    });

    pi.on("tool_call", async (event, ctx) => {
      if (!config.enabled) return;
      const target = extractTarget(event, ctx.cwd);
      if (!target) return;
      rules = await reloadRules(ctx.cwd);
      const state = branchState(ctx);

      const label = targetLabel(target);
      let shouldBlock = false;
      for (const rule of rules) {
        if (state.rules.has(rule.id)) continue;
        if (!ruleAppliesToTarget(rule, target)) continue;
        if (!ruleMatchesToolCallEvent(rule, event.toolName)) continue;
        if (event.toolName !== "read") shouldBlock = true;
        const pending = pendingRules.get(rule.id);
        if (pending) {
          if (isScoped(rule)) pending.targets.add(label);
        } else {
          pendingRules.set(rule.id, { rule, targets: new Set(isScoped(rule) ? [label] : []) });
        }
      }
      if (!shouldBlock) return;

      // Reads can finish before the next model call. Edits and writes pause, because their arguments are already final.
      return { block: true, reason: `[pi-rules] Tool \`${event.toolName}\` paused so Pi can load matching rules. Review them, adjust the change if needed, then retry.` };
    });

    pi.on("turn_end", async (event, ctx) => {
      if (!config.enabled) {
        pendingRules.clear();
        return;
      }
      rules = await reloadRules(ctx.cwd);
      // The preview already holds the entries that earlier handlers proposed for this boundary.
      const state = withInFlight(collectInjectedState(event.context.contextEntries, event.context.pendingMessages));
      const due = takeDueRules(state);
      if (due.length === 0) return;
      const injection = await buildInjection(due, state);
      return { entries: [...event.entries, { type: "custom_message", ...injection }] };
    });

    pi.on("session_compact", async (_event, ctx) => {
      pendingRules.clear();
      await reloadConfig(ctx.cwd);
      if (!config.enabled) {
        rules = [];
        return;
      }
      rules = await reloadRules(ctx.cwd);
      // A compaction that retries the turn makes a model call before any turn boundary, so restore the rules now.
      const state = branchState(ctx);
      const due = takeDueRules(state);
      if (due.length === 0) return;
      const injection = await buildInjection(due, state);
      inFlight.set(injection.details.injectionId, injection.details);
      pi.sendMessage(injection);
    });

    pi.on("agent_settled", () => {
      // By now pi has written every queued message or dropped it.
      inFlight.clear();
    });
  };
}

interface SkillBlock {
  name: string;
  content: string;
}

export function createInjection(entries: PendingRule[], skillBlocks: SkillBlock[] = []): RuleInjection {
  const sorted = [...entries].sort(comparePendingRules);
  const sources = sorted.map((entry) => entry.rule.sourceLabel);
  const targets = Object.fromEntries(sorted.map((entry) => [entry.rule.sourceLabel, [...entry.targets].sort()]));
  const ruleBody = sorted
    .map((entry) => `## Rule: ${entry.rule.sourceLabel}\n\n${entry.rule.body}`)
    .join("\n\n---\n\n");
  const skillBody = skillBlocks.map((skill) => skill.content).join("\n\n");

  return {
    customType: CUSTOM_MESSAGE_TYPE,
    content: skillBody ? `${ruleBody}\n\n---\n\n${skillBody}` : ruleBody,
    display: true,
    details: {
      injectionId: randomUUID(),
      rules: sorted.map((entry) => ({ id: entry.rule.id, hash: entry.rule.hash })),
      sources,
      targets,
      skills: skillBlocks.map((skill) => skill.name),
    },
  };
}

async function loadSkillBlocks(
  entries: PendingRule[],
  availableSkills: Map<string, Skill>,
  injectedSkills: ReadonlySet<string>,
  reportWarning: (message: string) => void,
): Promise<SkillBlock[]> {
  const names = [...new Set(entries.flatMap((entry) => entry.rule.skills ?? []))]
    .filter((name) => !injectedSkills.has(name))
    .sort();
  const blocks: SkillBlock[] = [];
  for (const name of names) {
    const skill = availableSkills.get(name);
    if (!skill) {
      reportWarning(`[pi-rules] skill not found: ${name}`);
      continue;
    }
    try {
      const body = stripFrontmatter(await readFile(skill.filePath, "utf8")).trim();
      blocks.push({
        name,
        content: `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      reportWarning(`[pi-rules] failed to load skill ${name}: ${reason}`);
    }
  }
  return blocks;
}

function isScoped(rule: Rule): boolean {
  return Boolean(rule.paths || rule.events);
}

function comparePendingRules(left: PendingRule, right: PendingRule): number {
  return left.rule.sourceLabel.localeCompare(right.rule.sourceLabel);
}

export default makeExtension();
