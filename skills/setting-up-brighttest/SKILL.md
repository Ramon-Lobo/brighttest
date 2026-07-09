---
name: setting-up-brighttest
description: Use when adding brighttest to a Roku/BrightScript project or configuring how its tests run — installing the package, creating brighttest.json, deciding where specs live, choosing a run lane, wiring npm scripts and CI, and setting up device/coverage runs.
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

Node 18+. This brings its own toolchain (BrighterScript, Rooibos, and a headless BrightScript interpreter)
— you don't install those separately.

## Where specs must live

Put specs under a **compiled path** — `source/tests/<Thing>.spec.bs`. Roku only compiles `source/` and
`components/`; a spec in a top-level `tests/` folder never defines its suite class and fails with
`Use of uninitialized variable`. Specs are auto-discovered (default pattern `**/*.spec.bs`) — no manual
registration. One suite per file, named after what it tests.

## Config — `brighttest.json` (optional, at project root)

Every key is optional; the defaults suit a standard layout.

```json
{
  "rootDir": ".",
  "sourceGlobs": ["manifest", "source/**/*", "components/**/*"],
  "testsFilePattern": "**/*.spec.bs",
  "stagingDir": ".brighttest",
  "globalFields": { "*": { "config": null } }
}
```

| Key | Meaning | Default |
|---|---|---|
| `rootDir` | Root that globs resolve against | `.` |
| `sourceGlobs` | Files compiled into the test build | `["manifest","source/**/*","components/**/*"]` |
| `testsFilePattern` | Where Rooibos looks for specs | `**/*.spec.bs` |
| `stagingDir` | Scratch build dir (git-ignore it) | `.brighttest` |
| `globalFields` | Per-`@SGNode`-type scene-field seeding (see the `writing-rooibos-tests` skill) | — |

Point at a non-default config with `-c/--config <path>`.

## Choosing a lane

| Command | Device? | Coverage? | `@SGNode`? | Use for |
|---|---|---|---|---|
| `brighttest` | no | no | yes (headless) | everyday inner loop |
| `brighttest --no-sgnode` | no | no | skipped | fastest pure-logic loop |
| `brighttest --coverage [--lcov <path>]` | no | yes (+LCOV) | yes (headless) | coverage / CI, no hardware |
| `brighttest --device --host <ip> --password <pw>` | yes | yes | yes | fidelity + on-device coverage |
| `brighttest --cross-check --host <ip> --password <pw>` | yes | — | both lanes | confirm headless matches device |

Extra flags: `--junit <path>` (JUnit XML), `--timeout <sec>` (headless 300s / device 900s default).
Exit code is `0` on success, non-zero on any failure (and when `--lcov` is requested but no coverage came back).

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

These are all generated. `.brighttest/` is the build scratch dir; never commit it.

## CI

Two-tier setup works well:

- **Every push / PR (no hardware):** `brighttest --coverage --lcov coverage/lcov.info` on a standard Linux
  runner. Fast, produces coverage, runs `@SGNode` suites headless.
- **Before merge / nightly (self-hosted runner near a Roku):** `brighttest --device …` for on-device
  coverage + real render timing, and `brighttest --cross-check …` to confirm the headless lane still
  matches the device. Put device credentials in CI secrets (`ROKU_HOST`, `ROKU_PASSWORD`).

## Teaching your AI agent

Install the test-writing skill so agents author correct specs:

```sh
npx brighttest skills install
```
