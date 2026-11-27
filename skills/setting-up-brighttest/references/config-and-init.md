# Config keys, `init` and `skills install`

Evidence: checked against `lib/config.js`, `bin/cli.js` (`INIT_HELP`, `SKILLS_HELP`) and `docs/guide/cli-reference.md`.
Not device-verified.

## More `brighttest.json` keys

All optional. Full reference: `docs/guide/cli-reference.md`, `docs/guide/engines.md`.

| Key | Meaning | Default |
|---|---|---|
| `engines` | Which brs-node / rooibos build runs: `auto`, `patched`, `stock` or a package name (per kind: `brsNode`, `rooibos`). Env `BRIGHTTEST_ENGINES` wins | `auto` (patched) |
| `deviceInfo` | Device identity the headless scene lane reports (`model`, `osVersion`, `locale`, `uiResolution`, `connectionType`, `friendlyName`, `country`); unset leaves the engine identity | unset |
| `deviceLease` | Device lease settings: `enabled`, `pool` (hosts for `--device any`), `maxHold`, `wait`, `sessionIdle`, `sessionMax`, `studioIdle`, `studioYield`, `hygiene` | lease on, `wait` 30m, `maxHold` 60m |
| `deviceIdleTimeout` | Seconds without device output before the idle watchdog aborts (`0` disables); `--idle-timeout` wins | 120 |
| `instrument` | Instrumented-build block: `enabled`, `strict`, `exclude`, `state`, `net` (written by `init --brownfield`; see `instrumenting-a-roku-app`) | off |
| `diagnosticFilters` | Extra BrighterScript diagnostic codes to silence in the test, headless and instrument builds (1107 is always filtered); `instrument build` prints a ready-to-paste line | `[1107]` |

Full key reference: `docs/guide/cli-reference.md`, `docs/guide/engines.md`.

There is no top-level `net` key: HTTP mocking rules live under `instrument.net` and in a flow's `config.net`.

## `init`

`npx brighttest init` writes `brighttest.json`, a first spec (`source/tests/Example.spec.bs`), git-ignore entries and an
npm `test` script; existing files are kept unless `--force`.

- `init --brownfield`: for an app you will not edit. Runs the instrument census and writes the `instrument` block; adds no
  example spec or npm script. An existing `brighttest.json` is merged, not overwritten: valid keys are kept, missing ones
  added, wrong-typed ones fixed (each change listed, a `.bak` kept when it writes); a valid file is left untouched.
  `--dry-run` prints the plan and writes nothing (brownfield only; other modes exit 2). Run it before building even when
  `brighttest.json` exists.
- `init --greenfield`: for a new app; also copies the `BTStore.brs` and `BTHttp.brs` helpers into `source/brighttest/` and
  adds `BT_AGENT=false` to the manifest `bs_const`. Cannot be combined with `--brownfield`.

## `skills install`

```sh
npx brighttest skills install --agent claude --with-hook --with-mcp
```

Merges into what is there and never overwrites files it did not create (`--force` overrides). Also writes an always-on
safety block (device lease, secrets, claims) for each detected agent. `--with-hook` merges the device-lease guard hook into
`.claude/settings.json`; `--with-mcp` merges the brighttest MCP server into `.mcp.json`. Both refuse invalid JSON.
`skills uninstall` removes what install merged. `skills list` shows the bundled skills and detected agents.
