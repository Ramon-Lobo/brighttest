# Command cheatsheet by step

Evidence: every line below was checked against `node bin/cli.js --help` and the subcommand `--help` at this
version (`bin/cli.js`, `lib/skills.js` facts gate). Not device-verified. `<device-ip>` is a placeholder; take
the real address from the human, never from this file.

## Install and check

```bash
npx brighttest --version
npx brighttest skills list
npx brighttest doctor --engines
```

`doctor --engines` contacts no device. `skills list` shows the skills bundled with this version and the agents
it detects in the project, not what is installed.

## Assess (existing app)

```bash
npx brighttest assess . --json
npx brighttest assess . --out .brighttest/assess
```

Read-only and offline. Without `--out` nothing is written. Exit 0 means a report was produced, even for a
non-Roku directory (its path is `not-a-roku-app`); 2 is a usage error or a refused `--out`.
Docs: `docs/guide/assess.md`; flags: `npx brighttest assess --help`.

## Scaffold

```bash
npx brighttest init
npx brighttest init --brownfield
npx brighttest init --greenfield
```

`init` keeps existing files unless `--force`. `--brownfield` and `--greenfield` cannot be combined.
`--brownfield` writes the `instrument` block into `brighttest.json` and no example spec.

## Headless run (no device)

```bash
npx brighttest --junit results.xml
npx brighttest --coverage --lcov coverage/lcov.info --junit results.xml
```

Headless runs `@SGNode` suites too; `--no-sgnode` skips them. Use this as the CI gate.

## Instrument (existing app, no source edits)

```bash
npx brighttest instrument census
npx brighttest instrument build --out app.bt-instrumented.zip
npx brighttest instrument verify <store-zip>
```

`instrument verify` exits 3 when markers are found and 0 when clean. `build --strict` exits 4 when something
could not be instrumented. Never ship the built package.

## Device (always through the lease)

`npx brighttest doctor --host <device-ip>` reads device-info only and takes no lease; run it first.

```bash
npx brighttest device status
npx brighttest device with --as "$BRIGHTTEST_AGENT" --purpose "<task>: <check>" -- <command>
```

`BRIGHTTEST_AGENT` is `<role>#<n>`. Lanes (`--device`, `e2e run`, `studio`, `instrument build --sideload`) take
the lease themselves; do not wrap them. The dev password comes from `ROKU_PASSWORD`; never write it down.
Exit 75 busy, 77 lease lost, 78 lease directory unusable. Details: `using-a-roku-device-safely`.
