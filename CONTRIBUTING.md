# Contributing

Report bugs and ask questions in [GitHub issues](https://github.com/Lazco-Corporation/pi-rules/issues).
Pull requests are welcome.
For a large change, open an issue first, so we can agree on the approach.

## Setup

You need [Bun](https://bun.sh) and Node.js 22.19.0 or later.

```sh
bun install
```

## Check and test

```sh
bun run check
bun run test
```

`check` runs the TypeScript compiler without output.
`test` runs the tests in `test/` with the Node.js test runner.

## Try a local copy in pi

Remove the published package from your pi settings first.
If pi loads two copies of this extension, every rule loads twice.

From the root of this repository, run pi with the local source:

```sh
pi -e ./src/index.ts
```

## Measure a change

`scripts/audit-sessions.py` reads your local pi sessions and prints JSON totals, such as rules missing from the active branch and paused tool calls.
Run it for the sessions after a date:

```sh
python3 scripts/audit-sessions.py --since 2026-11-12
```

## Release

See the **Release** section in [AGENTS.md](AGENTS.md).

## License

By contributing, you agree that your contribution is licensed under `AGPL-3.0-or-later`.
