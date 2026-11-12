<div align="center">

# pi-rules

Pi extension: load Markdown rules into the agent context, for the whole project or only for matching files.

[![npm](https://img.shields.io/npm/v/@lazco/pi-rules)](https://www.npmjs.com/package/@lazco/pi-rules) [![License](https://img.shields.io/npm/l/@lazco/pi-rules)](LICENSE)

[Installation](#installation) · [Usage](#usage) · [Rule files](#rule-files) · [Frontmatter](#frontmatter) · [Configuration](#configuration) · [Limitations](#limitations)

</div>

`@lazco/pi-rules` is a fork of [`tigorlazuardi/pi-rules`](https://github.com/tigorlazuardi/pi-rules), maintained by Lazco Corporation.
It reads the same rule files, so you can switch without a change to your rules.

## Highlights

- **Claude Code compatible.** Reads `.claude/rules/` and `.agents/rules/` next to `.pi/rules/`, so one set of files serves both tools.
- **Rules for matching files.** A rule with `paths` loads only when the agent reads, edits, or writes a matching file.
- **Rule before change.** An edit or a write to a matching file waits until the agent has the rule, then the agent tries again.
- **Linked skills.** A rule can load full pi [skills](#skills) when it loads.
- **Six sources in one list.** Project and user directories merge by file name, and the first source wins. See [Rule files](#rule-files).

## Installation

You need [pi](https://github.com/earendil-works/pi) and Node.js 22.19.0 or later.

```sh
pi install npm:@lazco/pi-rules
```

Then run `/reload` in pi.
To check the install, run `pi list`.
The list of user packages shows `npm:@lazco/pi-rules`.

If you use `npm:@tigorhutasuhut/pi-rules`, remove it first:

```sh
pi remove npm:@tigorhutasuhut/pi-rules
```

If pi loads both packages, every rule loads twice.

## Usage

Create `.pi/rules/project.md` in your project:

```md
Run the focused tests after you change production code.
Never commit secrets or build output.
```

Start pi in the project and send a message.
Before the first model call, the rule loads, and the chat shows:

```text
Loaded rules:
↳ .pi/rules/project.md
```

Press the expand key on the message to see the full rule text and the files that matched.

### Rules for some files

Add `paths` frontmatter when a rule applies only to part of the project:

```md
---
paths:
  - "src/**/*.ts"
  - "test/**/*.ts"
---
Use strict TypeScript.
Keep tests next to the behavior they check.
```

| The agent calls | What happens |
| --- | --- |
| `read` on a matching file | The read runs. The rule loads before the next model call. |
| `edit` or `write` on a matching file | The call stops before it runs. The rule loads, and the agent tries the call again. |

Each rule loads once.
After a compaction, the rules load again when they are needed.

## Rule files

A rule is a Markdown file.
pi-rules reads every `.md` file in these directories, also in subdirectories:

| Order | Directory | Scope |
| --- | --- | --- |
| 1 | `<project>/.pi/rules/` | project |
| 2 | `<project>/.agents/rules/` | project |
| 3 | `<project>/.claude/rules/` | project |
| 4 | `~/.pi/agent/rules/` | user |
| 5 | `~/.agents/rules/` | user |
| 6 | `~/.claude/rules/` | user |

`<project>` is the directory where you start pi.
The file name without `.md` is the rule name.
When two files have the same rule name, only the file from the first directory in the table loads.
pi-rules follows symbolic links to files and directories.

`PI_CODING_AGENT_DIR` or `PI_CONFIG_DIR` changes directory 4.
`CLAUDE_CONFIG_DIR` changes directory 6.

## Frontmatter

All frontmatter fields are optional.
A file without frontmatter is a rule for every session.

| Field | Value | Effect |
| --- | --- | --- |
| `paths` | a glob or a list of globs | The rule loads only for matching files. |
| `events` | `tool_call: <tool>` or a list of tools | The rule loads only for these tools: `read`, `edit`, `write`. |
| `skills` | a skill name or a list of names | These skills load with the rule. |

Globs are relative to `<project>`, use `/`, and match dotfiles.

### Tools

Use `events` to load a rule for some tools only:

```md
---
paths: "docs/**/*.md"
events:
  tool_call: read
---
Check the facts in the docs against the code.
```

This rule loads after a read of a matching file, but not for an edit or a write.

### Skills

Use `skills` to load full pi skills with a rule:

```md
---
paths: "src/frontend/**"
skills:
  - frontend-design
---
Follow the linked frontend workflow.
```

pi-rules finds the skill by name in the skills that pi found.
The skill loads even when its frontmatter sets `disable-model-invocation: true`.
A missing skill shows a warning, and the rule still loads.

## Configuration

A `rules.json` file turns pi-rules off or changes the directory list.
pi-rules reads the first file that exists:

1. `<project>/.pi/rules.json`
2. `~/.pi/agent/rules.json`

The two files do not merge.

```json
{
  "enabled": true,
  "sources": [
    { "scope": "repo", "kind": "pi" },
    { "scope": "repo", "kind": "agents" },
    { "scope": "repo", "kind": "claude" },
    { "scope": "user", "kind": "pi" },
    { "scope": "user", "kind": "agents" },
    { "scope": "user", "kind": "claude" }
  ]
}
```

| Field | Default | Effect |
| --- | --- | --- |
| `enabled` | `true` | `false` turns off all rules. |
| `sources` | the six directories above | The directories to read, in order. `scope` is `repo` or `user`. `kind` is `pi`, `agents`, or `claude`. |

To turn off the rules in one project, put `{ "enabled": false, "sources": [] }` in `<project>/.pi/rules.json`.
An invalid file shows a warning, and no rule loads.
pi-rules reads `rules.json` when a session starts and after a compaction.

## Limitations

- **Files outside the project.** A `read`, `edit`, or `write` of a file outside `<project>` does not load a rule, also a user rule.
- **Shell commands.** A file that a `bash` command changes does not load a rule.
- **Branches.** After you go back to an earlier message with `/tree`, the new branch can miss rules that loaded on the old branch.
- **Resume.** After a resume or `/reload`, rules that are already in the session can load again.
- **Changed rules.** A rule that already loaded does not load again after you change its file, until the next compaction.

## Contributing

Report bugs and ask questions in [GitHub issues](https://github.com/Lazco-Corporation/pi-rules/issues).
Pull requests are welcome.
See [CONTRIBUTING.md](CONTRIBUTING.md) for the setup and the tests.

## License

[AGPL-3.0-or-later](LICENSE).
The code from the original project is under the MIT License. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
