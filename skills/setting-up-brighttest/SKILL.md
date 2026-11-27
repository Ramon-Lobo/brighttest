---
name: setting-up-brighttest
description: Use when adding brighttest to a Roku/BrightScript project or configuring how its tests run — installing the package, creating brighttest.json, deciding where specs live, choosing a run lane, wiring npm scripts, and setting up device/coverage runs. CI workflows belong to wiring-brighttest-into-ci.
triggers: add brighttest to a project; create brighttest.json; install brighttest; choose a run lane; wire npm scripts; configure device runs; configure coverage
when-not-to-use: Do not use to write spec files (use writing-rooibos-tests), to write UI flows (use writing-e2e-flows), to fix a failing run (use debugging-failing-tests), or to write CI workflows (use wiring-brighttest-into-ci). For where to start or whether brighttest fits at all, use adopting-brighttest.
license: MIT
metadata:
  source: brighttest
---

# Setting up brighttest

brighttest is a unified test runner for Rooibos specs: run them **headless by default** (no device),
headless **with coverage**, or **on a device**. This skill covers getting a project configured. For
*writing* specs, see the `writing-rooibos-tests` skill.

## Install

```sh
npm i -D brighttest
```

Node 22+. This brings its own toolchain (BrighterScript, Rooibos, and a headless BrightScript interpreter)
— you don't install those separately.

## Where specs must live

Put specs under a **compiled path** — `source/tests/<Thing>.spec.bs`. Roku only compiles `source/` and
`components/`; a spec in a top-level `tests/` folder never defines its suite class and fails with
`Use of uninitialized variable`. Specs are auto-discovered (default pattern `**/*.spec.bs`) — no manual
registration. One suite per file, named after what it tests.

## Config — `brighttest.json` (optional, at project root)

Every key is optional; the defaults suit a standard layout.

| Key | Meaning | Default |
|---|---|---|
| `rootDir` | Root that globs resolve against | `.` |
| `sourceGlobs` | Files compiled into the test build | `["manifest","source/**/*","components/**/*"]` |
| `testsFilePattern` | Where Rooibos looks for specs | `**/*.spec.bs` |
| `stagingDir` | Scratch build dir (git-ignore it) | `.brighttest` |
| `globalFields` | Per-`@SGNode`-type scene-field seeding (see the `writing-rooibos-tests` skill) | — |

More keys (`engines`, `deviceInfo`, `deviceLease`, `deviceIdleTimeout`, `instrument`, `diagnosticFilters`): see
`references/config-and-init.md`. Point at a non-default config with `-c/--config <path>`.

On the default scene lane (coverage off) a plain `source/main.brs` is left out of the test build at run time (logged); `brighttest init` does not write that exclusion, and coverage, device and `--no-sgnode` runs keep the file. The reason: Rooibos does not hook a plain `.brs` Main there and the app's own loop would hang the run. Your own `!source/main.brs` in `sourceGlobs` is respected.

## Pointing brighttest at a Roku

`npx brighttest setup` saves `ROKU_HOST=<ip>` to `./.env` (and `.env` to `.gitignore`) after a device-info-only check.
**Agents run `npx brighttest setup --host <ip> --write --json`** (no prompt, no secret fields).
**Never ask for the dev password or write it anywhere**: tell the human to set `ROKU_PASSWORD` or run `brighttest devices`. Every device command resolves the host as `--host`, shell `ROKU_HOST`,
`.env` `ROKU_HOST`, then the one cached device (`doctor` says which applied). CI uses secrets, not `setup`.

## Choosing a lane

| Command | Device? | Coverage? | `@SGNode`? | Use for |
|---|---|---|---|---|
| `brighttest` | no | no | yes (headless) | everyday inner loop |
| `brighttest --no-sgnode` | no | no | skipped | fastest pure-logic loop |
| `brighttest --coverage [--lcov <path>]` | no | yes (+LCOV) | yes (headless) | coverage / CI, no hardware |
| `brighttest --device --host <ip> --password <pw>` | yes | yes | yes | fidelity + on-device coverage |
| `brighttest --cross-check --host <ip> --password <pw>` | yes | — | both lanes | confirm headless matches device |

Extra flags: `--junit <path>`, `--timeout <sec>` (headless 300s / device 900s), `--idle-timeout <sec>` (device idle
watchdog, default 120, `0` disables), `--device any` (first free device of `deviceLease.pool`), `--instrument`.
Exit code is `0` on success, non-zero on any failure (and when `--lcov` is requested but no coverage came back).

## Scaffolding with `init`

`npx brighttest init` writes `brighttest.json`, a spec, git-ignore entries and an npm script (existing files kept unless
`--force`). For an app you will not edit use `init --brownfield`: it merges into an existing `brighttest.json` and takes
`--dry-run` (`references/config-and-init.md`).

## Recommended npm scripts

```json
{
  "scripts": {
    "test": "brighttest --junit reports/junit.xml",
    "test:coverage": "brighttest --coverage --lcov coverage/lcov.info",
    "test:device": "brighttest --device --host $ROKU_HOST --password $ROKU_PASSWORD"
  }
}
```

## Git-ignore

```gitignore
.brighttest/
coverage/
reports/
```

All generated; `.brighttest/` is the build scratch dir, never commit it.

## CI

Two-tier setup works well:

- **Every push / PR (no hardware):** `brighttest --coverage --lcov coverage/lcov.info` on a standard Linux
  runner. Fast, produces coverage, runs `@SGNode` suites headless.
- **Before merge / nightly (self-hosted runner near a Roku):** `brighttest --device …` for on-device
  coverage + real render timing, and `brighttest --cross-check …` to confirm the headless lane still
  matches the device. Put device credentials in CI secrets (`ROKU_HOST`, `ROKU_PASSWORD`).
- **Sharing the Roku with local users or agents:** device lanes take a per-device lease, so a CI job on the
  same machine (same OS user) queues behind them. Set `BRIGHTTEST_AGENT=ci:<run id>` and a longer
  `BRIGHTTEST_LEASE_WAIT` (e.g. `45m`). Do not run `device status` in CI: it prints device addresses into the job log
  (see `wiring-brighttest-into-ci`); check it from your own shell.
  Leases across different OS users are not supported (the lease dir is private to its user); run CI as the same OS user.
  Use one CI concurrency group per device. Exit 75 = the device stayed busy; 77 = the lease was lost.

## Teaching your AI agent

Install the skills so agents author correct specs and use devices safely:

```sh
npx brighttest skills install
npx brighttest skills install --agent claude --with-hook --with-mcp
```

`install` merges, never overwrites. `--with-hook` (guard hook) and `--with-mcp` (MCP server) apply to the `claude` target;
the hook is active only when registered, so if it is missing, tell the human to run the command above.
