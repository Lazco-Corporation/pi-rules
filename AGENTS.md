# AGENTS.md

`@lazco/pi-rules` is a pi extension that loads Markdown rules into the agent context.
A rule without `paths` loads before the first model call.
A rule with `paths` loads when the agent reads or changes a matching file.
It is a fork of `tigorlazuardi/pi-rules`.

## Commands

| Command | What it does |
|---|---|
| `bun run check` | Type-check. |
| `bun run test` | Run the unit tests under node. |
| `python3 scripts/audit-sessions.py --since <YYYY-MM-DD>` | Measure rule behavior in the local pi sessions. |
| `npm run release -- <bump>` | Cut a release. See **Release** below. |

The package ships TypeScript source, so there is no build step.

## Layout

All source sits under `src/`.

| File | What it holds |
|---|---|
| `index.ts` | the pi event handlers, the injection message, and its renderer |
| `discovery.ts` | `rules.json`, the rule sources, and the rule file parser |
| `matching.ts` | the tool call target and the glob match |
| `types.ts` | the shared types |

`scripts/audit-sessions.py` reads `~/.pi/agent/sessions` and prints JSON totals for each known problem.
Run it before and after a behavior change.
`scripts/release.sh` cuts a release.
`scripts/changelog-notes.sh` prints the `CHANGELOG.md` section for one version.
`.github/workflows/release-npm.yml` publishes one.

## Upstream

The `upstream` remote is `tigorlazuardi/pi-rules`, under the MIT License.
This fork is `AGPL-3.0-or-later`.
Keep `THIRD_PARTY_NOTICES.md` with the upstream copyright notice and the MIT text.
Pick upstream fixes one commit at a time with `git cherry-pick`.

## Dependencies

Read `docs/packages.md` in the installed `@earendil-works/pi-coding-agent` before you add a dependency.

- A package that pi supplies goes in `peerDependencies` with a `"*"` range. Never bundle one.
- Any other runtime dependency goes in `dependencies`.

## Tests

The tests set `HOME` to an empty directory, so the rules of the developer do not leak into them.
Drive the extension through the fake pi in `test/`.
Do not call a real model in a unit test.

## Release

`npm version` owns the version number.
Never edit the `version` field in `package.json` by hand.

Every release has a `CHANGELOG.md` entry, and the GitHub release shows that entry.
Cut a release from `main` in this order:

1. Add a `## [<version>] - <YYYY-MM-DD>` section at the top of `CHANGELOG.md`, below the intro.
2. Add a `[<version>]: <compare-url>` link at the bottom of `CHANGELOG.md`.
3. Commit the entry and push `main`.
4. Run the release command:

```bash
npm run release -- <bump>
```

`<bump>` is `patch`, `minor`, `major`, `prepatch`, `preminor`, `premajor`, `prerelease`, or an exact version such as `<MAJOR>.<MINOR>.<PATCH>`.
Add `--dry-run` to run every check and print the plan without a change.

The script refuses to start unless the branch is `main`, the working tree is clean, `main` agrees with its upstream, and `npm run check` and `npm run test` pass.
It then runs `npm version <bump>`, refuses a version that has no `CHANGELOG.md` section or is already on npm, and pushes `main` and the `v<version>` tag.
If a step after the bump fails, it resets to the starting commit and deletes only the tag that this run created.

A push of a `v*` tag starts `release-npm.yml`.
The workflow refuses a tag that `main` does not hold.
It then reads the `CHANGELOG.md` section for the version, installs, type-checks, tests, reads `NPM_TOKEN` from Infisical, and publishes with provenance.
Last, it creates the GitHub release with the `CHANGELOG.md` section, followed by the notes that GitHub generates.
A missing section stops the workflow before the publish.
A version with a `-` goes to the `next` dist-tag. A normal version goes to `latest`.

The workflow needs this one-time setup:

1. The Infisical project `lazco-pi-rules`, env `prod`, path `/ci`, with `NPM_TOKEN`.
2. The repo variable `INFISICAL_CI_IDENTITY_ID`.
3. The Infisical machine identity, bound to this repo.

### Pick the bump

- `patch` for a fix only.
- `minor` for new user-facing behavior, such as a new frontmatter field.
- `major` for a change that breaks a user setup.

### Write the changelog entry

- Write only changes that a user can see. Leave out CI, tests, and refactors.
- Group the items under `### Added`, `### Changed`, `### Fixed`, `### Removed`, or `### Docs`.
- Put each full sentence on its own line.
