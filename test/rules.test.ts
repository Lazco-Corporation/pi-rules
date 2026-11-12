import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Rule } from "../src/types.ts";
import { discoverRules, loadRuleConfig, parseRuleFile } from "../src/discovery.ts";
import extension, { CUSTOM_MESSAGE_TYPE } from "../src/index.ts";
import { extractTarget, ruleMatchesTarget, ruleMatchesToolCallEvent } from "../src/matching.ts";
import { createFakePi, FakeSession, type Loose } from "./fake-pi.ts";

// Keep the developer's own rules out of every test: discovery reads the home directory.
const isolatedHome = await mkdtemp(path.join(os.tmpdir(), "pi-rules-home-"));
process.env.HOME = isolatedHome;
delete process.env.PI_CODING_AGENT_DIR;
delete process.env.PI_CONFIG_DIR;
delete process.env.CLAUDE_CONFIG_DIR;

async function withTempDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-rules-test-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function writeRule(cwd: string, relativePath: string, content: string): Promise<void> {
  const target = path.join(cwd, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
}

function toolResult(toolName: string, filePath: string, overrides: Record<string, unknown> = {}): Loose {
  return {
    type: "tool_result",
    toolName,
    toolCallId: `${toolName}-1`,
    input: { path: filePath },
    content: [{ type: "text", text: "original output" }],
    details: { untouched: true },
    isError: false,
    ...overrides,
  };
}

function toolCall(toolName: string, filePath: string, overrides: Record<string, unknown> = {}): Loose {
  return {
    type: "tool_call",
    toolName,
    toolCallId: `${toolName}-1`,
    input: { path: filePath },
    ...overrides,
  };
}

test("merges rule roots by priority and deduplicates rule names", async () => {
  await withTempDirectory(async (root) => {
    const cwd = path.join(root, "repo");
    const home = path.join(root, "home");
    await writeRule(cwd, ".pi/rules/z.md", "Always Z");
    await writeRule(cwd, ".pi/rules/backend/auth.md", "---\npaths: src/auth/**\n---\nAuth rule");
    await writeRule(cwd, ".agents/rules/a.md", "Agents rule");
    await writeRule(cwd, ".agents/rules/auth.md", "Ignored duplicate auth");
    await writeRule(cwd, ".claude/rules/a.md", "Ignored duplicate a");
    await writeRule(cwd, ".claude/rules/claude.md", "Claude rule");
    await writeRule(root, "home/.pi/agent/rules/user.md", "User rule");
    await writeRule(cwd, ".pi/rules/ignored.txt", "not markdown");

    const result: Loose = await discoverRules(cwd, { home, env: {} });

    assert.deepEqual(result.rules.map((rule: Rule) => rule.sourceLabel), [
      ".pi/rules/backend/auth.md",
      ".pi/rules/z.md",
      ".agents/rules/a.md",
      ".claude/rules/claude.md",
      "~/.pi/agent/rules/user.md",
    ]);
    assert.deepEqual(result.rules[0].paths, ["src/auth/**"]);
    assert.equal(result.rules[0].body, "Auth rule");
    assert.equal(result.rules[1].paths, undefined);
    assert.equal(result.diagnostics.length, 0);
  });
});

test("follows symlinks while preserving source precedence and stopping cycles", async () => {
  await withTempDirectory(async (root) => {
    const cwd = path.join(root, "repo");
    const shared = path.join(root, "shared");
    await writeRule(cwd, ".pi/rules/auth.md", "Repo auth");
    await writeRule(root, "single.md", "Linked file");
    await writeRule(root, "shared/auth.md", "Ignored linked auth");
    await writeRule(root, "shared/common.md", "Linked directory");
    await symlink(path.join(root, "single.md"), path.join(cwd, ".pi/rules/single.md"));
    await mkdir(path.join(cwd, ".agents/rules"), { recursive: true });
    await symlink(shared, path.join(cwd, ".agents/rules/shared"), "dir");
    await symlink(shared, path.join(shared, "cycle"), "dir");

    const result: Loose = await discoverRules(cwd, { home: path.join(root, "home"), env: {} });

    assert.deepEqual(result.rules.map((rule: Rule) => [rule.sourceLabel, rule.body]), [
      [".pi/rules/auth.md", "Repo auth"],
      [".pi/rules/single.md", "Linked file"],
      [".agents/rules/shared/common.md", "Linked directory"],
    ]);
    assert.equal(result.diagnostics.length, 0);
  });
});

test("merges configured global rule roots", async () => {
  await withTempDirectory(async (root) => {
    const cwd = path.join(root, "repo");
    const home = path.join(root, "home");
    const piConfig = path.join(root, "pi-config");
    const codingAgent = path.join(root, "coding-agent");
    await mkdir(cwd, { recursive: true });
    await writeRule(root, "pi-config/agent/rules/pi.md", "PI config rule");
    await writeRule(root, "coding-agent/rules/agent.md", "Coding agent rule");
    await writeRule(root, "home/.claude/rules/claude.md", "Claude rule");
    await writeRule(root, "home/.agents/rules/agents.md", "Agents rule");

    const configured: Loose = await discoverRules(cwd, {
      home,
      env: { PI_CONFIG_DIR: piConfig, PI_CODING_AGENT_DIR: codingAgent },
    });
    const piConfigOnly: Loose = await discoverRules(cwd, { home, env: { PI_CONFIG_DIR: piConfig } });
    const codingAgentOnly: Loose = await discoverRules(cwd, { home, env: { PI_CODING_AGENT_DIR: codingAgent } });
    const agentsFallback: Loose = await discoverRules(cwd, { home, env: { CLAUDE_CONFIG_DIR: path.join(home, ".claude") } });
    await rm(path.join(home, ".agents"), { recursive: true, force: true });
    const claudeFallback: Loose = await discoverRules(cwd, { home, env: { CLAUDE_CONFIG_DIR: path.join(home, ".claude") } });
    await writeRule(root, "home/.pi/agent/rules/default-agent.md", "Default coding agent rule");
    const defaultCodingAgent: Loose = await discoverRules(cwd, { home, env: {} });

    assert.deepEqual(configured.rules.map((rule: Rule) => rule.body), ["Coding agent rule", "Agents rule", "Claude rule"]);
    assert.deepEqual(piConfigOnly.rules.map((rule: Rule) => rule.body), ["PI config rule", "Agents rule", "Claude rule"]);
    assert.deepEqual(codingAgentOnly.rules.map((rule: Rule) => rule.body), [
      "Coding agent rule",
      "Agents rule",
      "Claude rule",
    ]);
    assert.deepEqual(agentsFallback.rules.map((rule: Rule) => rule.body), ["Agents rule", "Claude rule"]);
    assert.deepEqual(claudeFallback.rules.map((rule: Rule) => rule.body), ["Claude rule"]);
    assert.deepEqual(defaultCodingAgent.rules.map((rule: Rule) => rule.body), ["Default coding agent rule", "Claude rule"]);
  });
});

test("project config controls source order and reloads on compaction", async () => {
  await withTempDirectory(async (cwd) => {
    await writeRule(
      cwd,
      ".pi/rules.json",
      JSON.stringify({ note: "extra fields are allowed", sources: [{ scope: "repo", kind: "claude", extra: true }] }),
    );
    await writeRule(cwd, ".pi/rules/pi.md", "PI rule");
    await writeRule(cwd, ".claude/rules/claude.md", "Claude rule");
    const fake = createFakePi();
    extension(fake.api);

    await fake.emit("session_start", { type: "session_start", reason: "startup" }, { cwd });
    const first = await fake.emit("before_agent_start", { type: "before_agent_start" }, { cwd });
    assert.match(first.message.content, /Claude rule/);
    assert.doesNotMatch(first.message.content, /PI rule/);

    await writeRule(cwd, ".pi/rules.json", JSON.stringify({ version: 1, sources: [{ scope: "repo", kind: "pi" }] }));
    await fake.emit("session_compact", { type: "session_compact", willRetry: true }, { cwd });
    assert.match(fake.sent[0].message.content, /PI rule/);
  });
});

test("loads user config from resolved Pi coding-agent directory", async () => {
  await withTempDirectory(async (root) => {
    const cwd = path.join(root, "repo");
    const home = path.join(root, "home");
    const piConfig = path.join(root, "pi-config");
    await mkdir(cwd, { recursive: true });
    await writeRule(
      root,
      "pi-config/agent/rules.json",
      JSON.stringify({
        version: 1,
        enabled: false,
        sources: [{ scope: "user", kind: "agents" }],
      }),
    );
    await writeRule(root, "home/.agents/rules/user.md", "User agents rule");

    const config = await loadRuleConfig(cwd, { home, env: { PI_CONFIG_DIR: piConfig } });
    const result: Loose = await discoverRules(cwd, { home, env: { PI_CONFIG_DIR: piConfig }, sources: config.sources });

    assert.equal(config.configPath, path.join(piConfig, "agent", "rules.json"));
    assert.equal(config.enabled, false);
    assert.deepEqual(result.rules.map((rule: Rule) => rule.body), ["User agents rule"]);
  });
});

test("warns without crashing when config fails TypeBox validation", async () => {
  await withTempDirectory(async (cwd) => {
    await writeRule(cwd, ".pi/rules.json", JSON.stringify({ version: 1, sources: [{ scope: "repo", kind: "nope" }] }));
    await writeRule(cwd, ".pi/rules/base.md", "Must not inject");
    const fake = createFakePi();
    const warnings: Loose[] = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = (chunk) => {
      warnings.push(String(chunk));
      return true;
    };

    try {
      extension(fake.api);
      await fake.emit("session_start", { type: "session_start", reason: "startup" }, { cwd });
      const injection = await fake.emit("before_agent_start", { type: "before_agent_start" }, { cwd });
      assert.equal(injection, undefined);
    } finally {
      process.stderr.write = originalWrite;
    }

    assert.match(warnings.join(""), /\[pi-rules\] invalid config \.pi\/rules\.json:/);
  });
});

test("accepts path, event, and skill filters while diagnosing malformed frontmatter", async () => {
  await withTempDirectory(async (cwd) => {
    const valid = path.join(cwd, "valid.md");
    const extra = path.join(cwd, "extra.md");
    const malformed = path.join(cwd, "malformed.md");
    const unsupportedEvent = path.join(cwd, "unsupported-event.md");
    const unsupportedTool = path.join(cwd, "unsupported-tool.md");
    await writeFile(valid, "---\npaths:\n  - src/**/*.ts\n  - tests/**\nevents:\n  tool_call: [edit, write]\nskills:\n  - tdd\n  - code-review\n---\nTyped", "utf8");
    await writeFile(extra, "---\ndescription: old schema\nalwaysApply: true\n---\nOld", "utf8");
    await writeFile(malformed, "---\npaths: [src/**\n---\nBad", "utf8");
    await writeFile(unsupportedEvent, "---\nevents:\n  tool_result: read\n---\nBad event", "utf8");
    await writeFile(unsupportedTool, "---\nevents:\n  tool_call: bash\n---\nBad tool", "utf8");

    const validResult: Loose = await parseRuleFile(valid, "valid.md");
    const extraResult: Loose = await parseRuleFile(extra, "extra.md");
    const malformedResult: Loose = await parseRuleFile(malformed, "malformed.md");
    const eventResult: Loose = await parseRuleFile(unsupportedEvent, "unsupported-event.md");
    const toolResult: Loose = await parseRuleFile(unsupportedTool, "unsupported-tool.md");

    assert.deepEqual(validResult.rule.paths, ["src/**/*.ts", "tests/**"]);
    assert.deepEqual(validResult.rule.events, { tool_call: ["edit", "write"] });
    assert.deepEqual(validResult.rule.skills, ["tdd", "code-review"]);
    assert.equal(extraResult.rule.body, "Old");
    assert.match(malformedResult.diagnostic.reason, /invalid YAML/);
    assert.match(eventResult.diagnostic.reason, /unsupported Pi event: tool_result/);
    assert.equal(toolResult.diagnostic.reason, "events.tool_call supports only read, edit, or write");
  });
});

test("warns and skips non-string paths without blocking valid sibling rules", async () => {
  await withTempDirectory(async (cwd) => {
    await writeRule(cwd, ".pi/rules/bad-object.md", "---\npaths:\n  include: src/**\n---\nBad object");
    await writeRule(cwd, ".pi/rules/bad-list.md", "---\npaths: [src/**, 42]\n---\nBad list");
    await writeRule(cwd, ".pi/rules/valid.md", "Valid sibling");
    const warnings: Loose[] = [];
    const ctx = { cwd, hasUI: true, ui: { notify: (message: string, level: string) => warnings.push({ message, level }) } };
    const fake = createFakePi();
    extension(fake.api);

    await fake.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
    const injection = await fake.emit("before_agent_start", { type: "before_agent_start" }, ctx);

    assert.match(injection.message.content, /Valid sibling/);
    assert.doesNotMatch(injection.message.content, /Bad object|Bad list/);
    assert.equal(warnings.every(({ level }) => level === "warning"), true);
    assert.equal(warnings.some(({ message }) => /bad-object\.md: paths must be a string or string list/.test(message)), true);
    assert.equal(warnings.some(({ message }) => /bad-list\.md: paths must be a string or string list/.test(message)), true);
  });
});

test("extracts project-local read/edit/write targets before execution", () => {
  const cwd = path.resolve("/workspace/project");
  assert.equal(extractTarget(toolCall("read", "@src/a.ts"), cwd), "src/a.ts");
  assert.equal(extractTarget(toolCall("edit", "/workspace/project/src/a.ts"), cwd), "src/a.ts");
  assert.equal(extractTarget(toolCall("write", "../outside.ts"), cwd), undefined);
  assert.equal(extractTarget(toolCall("bash", "src/a.ts"), cwd), undefined);
  assert.equal(extractTarget(toolResult("read", "src/a.ts", { isError: true }), cwd), undefined);
});

test("matches Claude-style paths and optional Pi tool_call filters", () => {
  const rule: Rule = {
    id: "rule",
    sourcePath: "/workspace/.agents/rules/typescript.md",
    sourceLabel: ".agents/rules/typescript.md",
    body: "Typed",
    hash: "hash",
    paths: ["./src/**/*.{ts,tsx}", ".github/**"],
    events: { tool_call: ["edit", "write"] },
  };
  assert.equal(ruleMatchesTarget(rule, "src/app.tsx"), true);
  assert.equal(ruleMatchesTarget(rule, ".github/workflows/ci.yml"), true);
  assert.equal(ruleMatchesTarget(rule, "README.md"), false);
  assert.equal(ruleMatchesToolCallEvent(rule, "read"), false);
  assert.equal(ruleMatchesToolCallEvent(rule, "edit"), true);
  assert.equal(ruleMatchesToolCallEvent({ ...rule, events: undefined }, "read"), true);
  assert.equal(ruleMatchesToolCallEvent({ ...rule, events: undefined }, "edit"), true);
  assert.equal(ruleMatchesToolCallEvent({ ...rule, events: { tool_call: ["read"] } }, "read"), true);
  assert.equal(ruleMatchesToolCallEvent({ ...rule, events: { tool_call: ["read"] } }, "write"), false);
});

test("injects unconditional rules before first model call", async () => {
  await withTempDirectory(async (cwd) => {
    await writeRule(cwd, ".agents/rules/base.md", "Always follow base rule.");
    const fake = createFakePi();
    extension(fake.api);
    await fake.emit("session_start", { type: "session_start", reason: "startup" }, { cwd });

    const first = await fake.emit("before_agent_start", { type: "before_agent_start" }, { cwd });
    const second = await fake.emit("before_agent_start", { type: "before_agent_start" }, { cwd });

    assert.equal(first.message.customType, CUSTOM_MESSAGE_TYPE);
    assert.equal(first.message.display, true);
    assert.match(first.message.content, /Always follow base rule\./);
    assert.deepEqual(first.message.details.sources, [".agents/rules/base.md"]);
    assert.deepEqual(first.message.details.targets, { ".agents/rules/base.md": [] });
    assert.equal(second, undefined);
  });
});

test("loads linked skills from Pi registry regardless model invocation setting", async () => {
  await withTempDirectory(async (cwd) => {
    await writeRule(cwd, ".pi/rules/a.md", "---\npaths: src/a/**\nevents:\n  tool_call: read\nskills: [hidden-skill, missing-skill]\n---\nRule A");
    await writeRule(cwd, ".pi/rules/b.md", "---\npaths: src/b/**\nevents:\n  tool_call: read\nskills: hidden-skill\n---\nRule B");
    const skillPath = path.join(cwd, ".pi/skills/hidden-skill/SKILL.md");
    await writeRule(
      cwd,
      ".pi/skills/hidden-skill/SKILL.md",
      "---\nname: hidden-skill\ndescription: Hidden from model discovery\ndisable-model-invocation: true\n---\n# Hidden workflow\n\nFollow hidden steps.",
    );
    const fake = createFakePi();
    const warnings: Loose[] = [];
    const ctx = { cwd, hasUI: true, ui: { notify: (message: string) => warnings.push(message) } };
    extension(fake.api);
    await fake.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
    await fake.emit(
      "before_agent_start",
      {
        type: "before_agent_start",
        systemPromptOptions: {
          skills: [{
            name: "hidden-skill",
            description: "Hidden from model discovery",
            filePath: skillPath,
            baseDir: path.dirname(skillPath),
            disableModelInvocation: true,
          }],
        },
      },
      ctx,
    );

    const firstCall = await fake.emit("tool_call", toolCall("read", "src/a/file.ts"), ctx);
    assert.equal(firstCall, undefined);
    assert.equal(fake.sent.length, 0);
    await fake.emit("turn_end", { type: "turn_end" }, ctx);

    assert.match(fake.sent[0].message.content, /Rule A/);
    assert.match(fake.sent[0].message.content, /<skill name="hidden-skill"/);
    assert.match(fake.sent[0].message.content, /Follow hidden steps\./);
    assert.doesNotMatch(fake.sent[0].message.content, /disable-model-invocation/);
    assert.deepEqual(fake.sent[0].message.details.skills, ["hidden-skill"]);
    assert.equal(warnings.some((warning) => /skill not found: missing-skill/.test(warning)), true);

    assert.equal(await fake.emit("tool_call", toolCall("read", "src/a/file.ts"), ctx), undefined);

    const secondCall = await fake.emit("tool_call", toolCall("read", "src/b/file.ts"), ctx);
    assert.equal(secondCall, undefined);
    await fake.emit("turn_end", { type: "turn_end" }, ctx);
    assert.match(fake.sent[1].message.content, /Rule B/);
    assert.doesNotMatch(fake.sent[1].message.content, /<skill name=/);
    assert.deepEqual(fake.sent[1].message.details.skills, []);

    await fake.emit("session_compact", { type: "session_compact", willRetry: true }, ctx);
    const afterCompact = await fake.emit("tool_call", toolCall("read", "src/b/again.ts"), ctx);
    assert.equal(afterCompact, undefined);
    await fake.emit("turn_end", { type: "turn_end" }, ctx);
    assert.match(fake.sent[2].message.content, /<skill name="hidden-skill"/);
  });
});

test("reads fresh rule content at each injection boundary", async () => {
  await withTempDirectory(async (cwd) => {
    await writeRule(cwd, ".pi/rules/base.md", "Base v1");
    await writeRule(cwd, ".pi/rules/scoped.md", "---\npaths: src/**\n---\nScoped v1");
    const fake = createFakePi();
    extension(fake.api);
    await fake.emit("session_start", { type: "session_start", reason: "startup" }, { cwd });

    await writeRule(cwd, ".pi/rules/base.md", "Base v2");
    const eager = await fake.emit("before_agent_start", { type: "before_agent_start" }, { cwd });
    assert.match(eager.message.content, /Base v2/);
    assert.doesNotMatch(eager.message.content, /Base v1/);

    await writeRule(cwd, ".pi/rules/scoped.md", "---\npaths: src/**\n---\nScoped v2");
    const call = await fake.emit("tool_call", toolCall("edit", "src/a.ts"), { cwd });
    assert.equal(call.block, true);
    await fake.emit("turn_end", { type: "turn_end" }, { cwd });
    assert.match(fake.sent[0].message.content, /Scoped v2/);
    assert.doesNotMatch(fake.sent[0].message.content, /Scoped v1/);
  });
});

test("discovers new unconditional and matching path rules before tool execution", async () => {
  await withTempDirectory(async (cwd) => {
    await writeRule(cwd, ".pi/rules/seed.md", "---\npaths: never/**\n---\nSeed");
    const fake = createFakePi();
    extension(fake.api);
    await fake.emit("session_start", { type: "session_start", reason: "startup" }, { cwd });
    const eager = await fake.emit("before_agent_start", { type: "before_agent_start" }, { cwd });
    assert.equal(eager, undefined);

    await writeRule(cwd, ".pi/rules/new-base.md", "New base rule");
    await writeRule(cwd, ".pi/rules/new-path.md", "---\npaths: src/**\n---\nNew path rule");
    const call = await fake.emit("tool_call", toolCall("edit", "src/new.ts"), { cwd });
    assert.equal(call.block, true);
    assert.equal(fake.sent.length, 0);
    await fake.emit("turn_end", { type: "turn_end" }, { cwd });

    assert.deepEqual(fake.sent[0].message.details.sources, [
      ".pi/rules/new-base.md",
      ".pi/rules/new-path.md",
    ]);
    assert.match(fake.sent[0].message.content, /New base rule/);
    assert.match(fake.sent[0].message.content, /New path rule/);

    assert.equal(await fake.emit("tool_call", toolCall("edit", "src/again.ts"), { cwd }), undefined);
    await fake.emit("turn_end", { type: "turn_end" }, { cwd });
    assert.equal(fake.sent.length, 1);
  });
});

test("parallel preflight matches aggregate once and block every governed tool", async () => {
  await withTempDirectory(async (cwd) => {
    await writeRule(cwd, ".agents/rules/auth.md", "---\npaths: src/**/*.ts\n---\nAuth rule");
    await writeRule(cwd, ".agents/rules/typescript.md", "---\npaths: src/**\n---\nTypeScript rule");
    const fake = createFakePi();
    extension(fake.api);
    await fake.emit("session_start", { type: "session_start", reason: "startup" }, { cwd });

    const first = toolCall("write", "src/a.ts", { toolCallId: "write-a" });
    const second = toolCall("edit", "src/b.ts", { toolCallId: "edit-b" });
    const before = structuredClone([first, second]);
    const results = await Promise.all([
      fake.emit("tool_call", first, { cwd }),
      fake.emit("tool_call", second, { cwd }),
    ]);

    assert.deepEqual([first, second], before);
    assert.deepEqual(results.map((result) => result.block), [true, true]);
    assert.equal(fake.sent.length, 0);
    await fake.emit("turn_end", { type: "turn_end" }, { cwd });

    assert.equal(fake.sent.length, 1);
    assert.equal(fake.sent[0].via, "turn_end");
    assert.deepEqual(fake.sent[0].message.details.sources, [
      ".agents/rules/auth.md",
      ".agents/rules/typescript.md",
    ]);
    assert.deepEqual(fake.sent[0].message.details.targets, {
      ".agents/rules/auth.md": ["src/a.ts", "src/b.ts"],
      ".agents/rules/typescript.md": ["src/a.ts", "src/b.ts"],
    });
    assert.match(fake.sent[0].message.content, /Auth rule/);
    assert.match(fake.sent[0].message.content, /TypeScript rule/);

    assert.equal(await fake.emit("tool_call", toolCall("edit", "src/c.ts"), { cwd }), undefined);
    await fake.emit("turn_end", { type: "turn_end" }, { cwd });
    assert.equal(fake.sent.length, 1);
  });
});

test("path rules inject after reads and block before edits or writes", async () => {
  await withTempDirectory(async (cwd) => {
    await writeRule(
      cwd,
      ".pi/rules/scoped.md",
      "---\npaths: src/**\n---\nMutation rule",
    );
    const fake = createFakePi();
    extension(fake.api);
    await fake.emit("session_start", { type: "session_start", reason: "startup" }, { cwd });

    assert.equal(await fake.emit("tool_call", toolCall("read", "src/a.ts"), { cwd }), undefined);
    await fake.emit("turn_end", { type: "turn_end" }, { cwd });
    assert.deepEqual(fake.sent[0].message.details.targets, { ".pi/rules/scoped.md": ["src/a.ts"] });

    await fake.emit("session_compact", { type: "session_compact", willRetry: true }, { cwd });
    assert.equal(fake.sent.length, 1);
    const editCall = await fake.emit("tool_call", toolCall("edit", "src/a.ts"), { cwd });
    assert.equal(editCall.block, true);
    assert.equal(editCall.reason, "[pi-rules] Tool `edit` paused so Pi can load matching rules. Review them, adjust the change if needed, then retry.");
    await fake.emit("turn_end", { type: "turn_end" }, { cwd });
    assert.deepEqual(fake.sent[1].message.details.targets, { ".pi/rules/scoped.md": ["src/a.ts"] });

    await fake.emit("session_compact", { type: "session_compact", willRetry: true }, { cwd });
    assert.equal(fake.sent.length, 2);
    const writeCall = await fake.emit("tool_call", toolCall("write", "src/b.ts"), { cwd });
    assert.equal(writeCall.block, true);
    await fake.emit("turn_end", { type: "turn_end" }, { cwd });
    assert.deepEqual(fake.sent[2].message.details.targets, { ".pi/rules/scoped.md": ["src/b.ts"] });
  });
});

test("no path match produces no row or message", async () => {
  await withTempDirectory(async (cwd) => {
    await writeRule(cwd, ".agents/rules/auth.md", "---\npaths: src/auth/**\n---\nAuth rule");
    const fake = createFakePi();
    extension(fake.api);
    await fake.emit("session_start", { type: "session_start", reason: "startup" }, { cwd });

    assert.equal(await fake.emit("tool_call", toolCall("edit", "src/ui/button.ts"), { cwd }), undefined);
    await fake.emit("turn_end", { type: "turn_end" }, { cwd });

    assert.equal(fake.sent.length, 0);
  });
});

test("separate extension instances inject independently", async () => {
  await withTempDirectory(async (cwd) => {
    await writeRule(cwd, ".pi/rules/base.md", "Shared base rule");
    const parent = createFakePi();
    const subagent = createFakePi();
    extension(parent.api);
    extension(subagent.api);

    await parent.emit("session_start", { type: "session_start", reason: "startup" }, { cwd });
    await subagent.emit("session_start", { type: "session_start", reason: "startup" }, { cwd });
    const parentInjection = await parent.emit("before_agent_start", { type: "before_agent_start" }, { cwd });
    const subagentInjection = await subagent.emit("before_agent_start", { type: "before_agent_start" }, { cwd });

    assert.match(parentInjection.message.content, /Shared base rule/);
    assert.match(subagentInjection.message.content, /Shared base rule/);
  });
});

test("renderer collapses to sources and expands targets plus full body", () => {
  const fake = createFakePi();
  extension(fake.api);
  const renderer = fake.renderers.get(CUSTOM_MESSAGE_TYPE);
  const message = {
    role: "custom",
    customType: CUSTOM_MESSAGE_TYPE,
    content: "## Rule: .agents/rules/auth.md\n\nFull body",
    display: true,
    details: {
      sources: [".agents/rules/auth.md", ".agents/rules/typescript.md"],
      targets: {
        ".agents/rules/auth.md": ["src/auth.ts"],
        ".agents/rules/typescript.md": [],
      },
    },
    timestamp: Date.now(),
  };
  const theme = { fg: (_color: string, text: string) => text };

  const collapsed = renderer(message, { expanded: false }, theme)
    .render(200)
    .map((line: string) => line.trimEnd())
    .join("\n")
    .trimEnd();
  const expanded = renderer(message, { expanded: true }, theme).render(200).join("\n").trimEnd();

  assert.equal(
    collapsed,
    "Loaded rules:\n↳ .agents/rules/auth.md\n↳ .agents/rules/typescript.md",
  );
  assert.match(expanded, /\.agents\/rules\/auth\.md → src\/auth\.ts/);
  assert.match(expanded, /\.agents\/rules\/typescript\.md → unconditional/);
  assert.match(expanded, /Full body/);
});

test("compaction re-injects unconditional rules and permits lazy re-injection", async () => {
  await withTempDirectory(async (cwd) => {
    await writeRule(cwd, ".agents/rules/base.md", "Base rule");
    await writeRule(cwd, ".agents/rules/auth.md", "---\npaths: src/auth/**\n---\nAuth rule");
    const fake = createFakePi();
    extension(fake.api);
    await fake.emit("session_start", { type: "session_start", reason: "startup" }, { cwd });

    await fake.emit("before_agent_start", { type: "before_agent_start" }, { cwd });
    const firstCall = await fake.emit("tool_call", toolCall("edit", "src/auth/user.ts"), { cwd });
    assert.equal(firstCall.block, true);
    await fake.emit("turn_end", { type: "turn_end" }, { cwd });
    assert.equal(fake.sent.length, 1);

    await writeRule(cwd, ".agents/rules/base.md", "Fresh base rule");
    await fake.emit("session_compact", { type: "session_compact", willRetry: true }, { cwd });
    assert.equal(fake.sent.length, 2);
    assert.match(fake.sent[1].message.content, /Fresh base rule/);
    assert.equal(fake.sent[1].options, undefined);

    await writeRule(cwd, ".agents/rules/auth.md", "---\npaths: src/auth/**\n---\nFresh auth rule");
    const secondCall = await fake.emit("tool_call", toolCall("write", "src/auth/session.ts"), { cwd });
    assert.equal(secondCall.block, true);
    await fake.emit("turn_end", { type: "turn_end" }, { cwd });
    assert.equal(fake.sent.length, 3);
    assert.match(fake.sent[2].message.content, /Fresh auth rule/);
  });
});

test("a branch without the injection gets the rules again, and the old branch does not", async () => {
  await withTempDirectory(async (cwd) => {
    await writeRule(cwd, ".pi/rules/base.md", "Base rule");
    const fake = createFakePi();
    extension(fake.api);
    await fake.emit("session_start", { type: "session_start", reason: "startup" }, { cwd });

    const firstPrompt = fake.session.appendUserMessage("first");
    assert.match((await fake.emit("before_agent_start", { type: "before_agent_start" }, { cwd })).message.content, /Base rule/);
    const injectedLeaf = fake.session.appendUserMessage("answer");

    // Go back to the first prompt, before the injection, as `/tree` or a resend does.
    fake.session.branchTo(firstPrompt.parentId);
    await fake.emit("session_tree", { type: "session_tree", newLeafId: firstPrompt.parentId, oldLeafId: injectedLeaf.id }, { cwd });
    fake.session.appendUserMessage("first, again");
    const onNewBranch = await fake.emit("before_agent_start", { type: "before_agent_start" }, { cwd });
    assert.match(onNewBranch.message.content, /Base rule/);

    fake.session.branchTo(injectedLeaf.id);
    assert.equal(await fake.emit("before_agent_start", { type: "before_agent_start" }, { cwd }), undefined);
  });
});

test("a resume or a reload does not inject the rules again", async () => {
  await withTempDirectory(async (cwd) => {
    await writeRule(cwd, ".pi/rules/base.md", "Base rule");
    await writeRule(cwd, ".pi/rules/scoped.md", "---\npaths: src/**\n---\nScoped rule");
    const session = new FakeSession();
    const first = createFakePi(session);
    extension(first.api);
    await first.emit("session_start", { type: "session_start", reason: "startup" }, { cwd });
    await first.emit("before_agent_start", { type: "before_agent_start" }, { cwd });
    assert.equal((await first.emit("tool_call", toolCall("edit", "src/a.ts"), { cwd })).block, true);
    await first.emit("turn_end", { type: "turn_end" }, { cwd });
    assert.equal(first.sent.length, 1);

    for (const reason of ["resume", "resume"]) {
      const resumed = createFakePi(session);
      extension(resumed.api);
      await resumed.emit("session_start", { type: "session_start", reason }, { cwd });
      assert.equal(await resumed.emit("before_agent_start", { type: "before_agent_start" }, { cwd }), undefined);
      assert.equal(await resumed.emit("tool_call", toolCall("edit", "src/a.ts"), { cwd }), undefined);
      await resumed.emit("turn_end", { type: "turn_end" }, { cwd });
      assert.equal(resumed.sent.length, 0);
    }

    await first.emit("session_start", { type: "session_start", reason: "reload" }, { cwd });
    assert.equal(await first.emit("before_agent_start", { type: "before_agent_start" }, { cwd }), undefined);
  });
});

test("a fork from a node before the injection gets the rules", async () => {
  await withTempDirectory(async (cwd) => {
    await writeRule(cwd, ".pi/rules/base.md", "Base rule");
    const original = new FakeSession();
    const prompt = original.appendUserMessage("first");
    original.append({ type: "custom_message", customType: CUSTOM_MESSAGE_TYPE, content: "Base rule", display: true, details: { injectionId: "old", rules: [{ id: path.join(cwd, ".pi/rules/base.md"), hash: "any" }], sources: [], targets: {}, skills: [] } });

    const forked = new FakeSession();
    forked.append({ ...prompt });
    const fake = createFakePi(forked);
    extension(fake.api);
    await fake.emit("session_start", { type: "session_start", reason: "fork" }, { cwd });
    assert.match((await fake.emit("before_agent_start", { type: "before_agent_start" }, { cwd })).message.content, /Base rule/);
  });
});

test("an injection that a context edit removed counts as gone", async () => {
  await withTempDirectory(async (cwd) => {
    await writeRule(cwd, ".pi/rules/base.md", "Base rule");
    const fake = createFakePi();
    extension(fake.api);
    await fake.emit("session_start", { type: "session_start", reason: "startup" }, { cwd });
    await fake.emit("before_agent_start", { type: "before_agent_start" }, { cwd });
    const injection = fake.session.entries.at(-1)!;
    fake.session.append({ type: "context_edit", targetId: injection.id, replacement: null });

    assert.match((await fake.emit("before_agent_start", { type: "before_agent_start" }, { cwd })).message.content, /Base rule/);
  });
});

test("a queued injection that pi has not written yet is not sent twice", async () => {
  await withTempDirectory(async (cwd) => {
    await writeRule(cwd, ".pi/rules/base.md", "Base rule");
    const fake = createFakePi();
    extension(fake.api);
    await fake.emit("session_start", { type: "session_start", reason: "startup" }, { cwd });
    const queued = {
      role: "custom",
      customType: CUSTOM_MESSAGE_TYPE,
      details: { injectionId: "queued", rules: [{ id: path.join(cwd, ".pi/rules/base.md"), hash: "any" }], sources: [], targets: {}, skills: [] },
    };

    await fake.emit("turn_end", { type: "turn_end", pendingMessages: [queued] }, { cwd });
    assert.equal(fake.sent.length, 0);
  });
});

test("an injection from an older version loads the rules once more", async () => {
  await withTempDirectory(async (cwd) => {
    await writeRule(cwd, ".pi/rules/base.md", "Base rule");
    const session = new FakeSession();
    session.append({ type: "custom_message", customType: CUSTOM_MESSAGE_TYPE, content: "Base rule", display: true, details: { sources: [".pi/rules/base.md"], targets: {} } });
    const fake = createFakePi(session);
    extension(fake.api);
    await fake.emit("session_start", { type: "session_start", reason: "resume" }, { cwd });

    assert.match((await fake.emit("before_agent_start", { type: "before_agent_start" }, { cwd })).message.content, /Base rule/);
    assert.equal(await fake.emit("before_agent_start", { type: "before_agent_start" }, { cwd }), undefined);
  });
});

test("a turn after a compaction gets the unconditional rules once", async () => {
  await withTempDirectory(async (cwd) => {
    await writeRule(cwd, ".pi/rules/base.md", "Base rule");
    const fake = createFakePi();
    extension(fake.api);
    await fake.emit("session_start", { type: "session_start", reason: "startup" }, { cwd });
    await fake.emit("before_agent_start", { type: "before_agent_start" }, { cwd });

    await fake.emit("session_compact", { type: "session_compact", willRetry: true }, { cwd });
    assert.equal(fake.sent.length, 1);
    await fake.emit("turn_end", { type: "turn_end" }, { cwd });
    assert.equal(await fake.emit("before_agent_start", { type: "before_agent_start" }, { cwd }), undefined);
    assert.equal(fake.sent.length, 1);
  });
});
