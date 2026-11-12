import { readFile } from "node:fs/promises";
import { stripFrontmatter, type ExtensionAPI, type Skill } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { DEFAULT_RULE_SOURCES, discoverRules, loadRuleConfig, type RuleSource } from "./discovery.ts";
import { extractTarget, ruleMatchesTarget, ruleMatchesToolCallEvent } from "./matching.ts";
import type { PendingRule, Rule, RuleInjectionDetails } from "./types.ts";

export const CUSTOM_MESSAGE_TYPE = "pi-rules-injection";

export function makeExtension() {
  return (pi: ExtensionAPI): void => {
    let config: { enabled: boolean; sources: RuleSource[] } = { enabled: true, sources: DEFAULT_RULE_SOURCES };
    let rules: Rule[] = [];
    let reportWarning = (message: string): void => {
      process.stderr.write(`${message}\n`);
    };
    const injectedRuleIds = new Set<string>();
    const injectedSkillNames = new Set<string>();
    const availableSkills = new Map<string, Skill>();
    const pendingRules = new Map<string, PendingRule>();

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

    const createRuleInjection = async (entries: PendingRule[]) => {
      const skillBlocks = await loadSkillBlocks(entries, availableSkills, injectedSkillNames, reportWarning);
      for (const skill of skillBlocks) injectedSkillNames.add(skill.name);
      return createInjection(entries, skillBlocks);
    };

    pi.on("session_start", async (_event, ctx) => {
      reportWarning = ctx.hasUI
        ? (message) => ctx.ui.notify(message, "warning")
        : (message) => process.stderr.write(`${message}\n`);
      await reloadConfig(ctx.cwd);
      rules = config.enabled ? await reloadRules(ctx.cwd) : [];
      injectedRuleIds.clear();
      injectedSkillNames.clear();
      availableSkills.clear();
      pendingRules.clear();
    });

    pi.on("before_agent_start", async (event, ctx) => {
      availableSkills.clear();
      for (const skill of event.systemPromptOptions?.skills ?? []) availableSkills.set(skill.name, skill);
      if (!config.enabled) return;
      rules = await reloadRules(ctx.cwd);
      const unconditional = freshUnconditionalRules(rules, injectedRuleIds)
        .filter((rule) => !pendingRules.has(rule.id))
        .map((rule) => ({ rule, targets: new Set<string>() }));
      const entries = [...pendingRules.values(), ...unconditional];
      if (entries.length === 0) return;
      const injection = await createRuleInjection(entries);
      for (const entry of entries) injectedRuleIds.add(entry.rule.id);
      pendingRules.clear();
      return { message: injection };
    });

    pi.on("tool_call", async (event, ctx) => {
      if (!config.enabled) return;
      const target = extractTarget(event, ctx.cwd);
      if (!target) return;
      rules = await reloadRules(ctx.cwd);

      let shouldBlock = false;
      for (const rule of rules) {
        if (injectedRuleIds.has(rule.id)) continue;
        if (rule.paths && !ruleMatchesTarget(rule, target)) continue;
        if (!ruleMatchesToolCallEvent(rule, event.toolName)) continue;
        if (event.toolName !== "read") shouldBlock = true;
        const pending = pendingRules.get(rule.id);
        const isScoped = Boolean(rule.paths || rule.events);
        if (pending) {
          if (isScoped) pending.targets.add(target);
        } else {
          pendingRules.set(rule.id, { rule, targets: new Set(isScoped ? [target] : []) });
        }
      }
      if (!shouldBlock) return;

      // ponytail: reads can finish before the next model turn; mutations pause because their arguments are already issued.
      return { block: true, reason: `[pi-rules] Tool \`${event.toolName}\` paused so Pi can load matching rules. Review them, adjust the change if needed, then retry.` };
    });

    pi.on("turn_end", async (_event, ctx) => {
      if (!config.enabled) {
        pendingRules.clear();
        return;
      }
      rules = await reloadRules(ctx.cwd);
      for (const rule of freshUnconditionalRules(rules, injectedRuleIds)) {
        if (!pendingRules.has(rule.id)) pendingRules.set(rule.id, { rule, targets: new Set<string>() });
      }
      const pending = [...pendingRules.values()].sort(comparePendingRules);
      if (pending.length === 0) return;
      pi.sendMessage(await createRuleInjection(pending), { deliverAs: "steer" });
      for (const entry of pending) injectedRuleIds.add(entry.rule.id);
      pendingRules.clear();
    });

    pi.on("session_compact", async (_event, ctx) => {
      injectedRuleIds.clear();
      injectedSkillNames.clear();
      pendingRules.clear();
      await reloadConfig(ctx.cwd);
      if (!config.enabled) {
        rules = [];
        return;
      }
      rules = await reloadRules(ctx.cwd);
      const unconditional = freshUnconditionalRules(rules, injectedRuleIds);
      if (unconditional.length === 0) return;
      const entries = unconditional.map((rule) => ({ rule, targets: new Set<string>() }));
      pi.sendMessage(await createRuleInjection(entries));
      for (const rule of unconditional) injectedRuleIds.add(rule.id);
    });
  };
}

interface SkillBlock {
  name: string;
  content: string;
}

export function createInjection(entries: PendingRule[], skillBlocks: SkillBlock[] = []) {
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
    details: { sources, targets, skills: skillBlocks.map((skill) => skill.name) } satisfies RuleInjectionDetails,
  };
}

async function loadSkillBlocks(
  entries: PendingRule[],
  availableSkills: Map<string, Skill>,
  injectedSkillNames: Set<string>,
  reportWarning: (message: string) => void,
): Promise<SkillBlock[]> {
  const names = [...new Set(entries.flatMap((entry) => entry.rule.skills ?? []))]
    .filter((name) => !injectedSkillNames.has(name))
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

function freshUnconditionalRules(rules: Rule[], injectedRuleIds: Set<string>): Rule[] {
  return rules.filter((rule) => !rule.paths && !rule.events && !injectedRuleIds.has(rule.id));
}

function comparePendingRules(left: PendingRule, right: PendingRule): number {
  return left.rule.sourceLabel.localeCompare(right.rule.sourceLabel);
}

export default makeExtension();
