# Changelog

All releases of `@lazco/pi-rules` are in this file.
The newest release is at the top.
Releases up to 0.6.0 are from the original package `@tigorhutasuhut/pi-rules`.

## [0.8.0] - 2026-11-12

### Added

- A user rule now loads for a file outside the project, such as `/tmp/build.sh` or `~/.zshrc`.
  In a user rule, a glob that starts with `/` is an absolute path, and a glob that starts with `~/` starts at the home directory.

### Fixed

- When you start pi in the home directory, the rules in `~/.agents/rules/` count as user rules, not project rules.

## [0.7.0] - 2026-11-12

### Changed

- The package is now `@lazco/pi-rules`, a fork of `@tigorhutasuhut/pi-rules`, under `AGPL-3.0-or-later`.
  Remove `npm:@tigorhutasuhut/pi-rules` before you install it, or every rule loads twice.
- pi-rules now reads which rules the model has from the messages on the current branch, not from memory.
  In a session from an older version, each rule loads one more time.

### Fixed

- After you go back to an earlier message with `/tree`, or send a message again after you stop an answer, the new branch gets its rules.
  Before, rules that loaded on the old branch did not load on the new branch.
- After a resume, `/reload`, or a fork, rules that the session already has do not load again.

### Removed

- Commit nudges and the `nudges` field in `rules.json`.
- The `pi-rules:config` event and the `emitPiRulesConfig` export.

[0.8.0]: https://github.com/Lazco-Corporation/pi-rules/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/Lazco-Corporation/pi-rules/releases/tag/v0.7.0
