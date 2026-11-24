# Quick start

## Requirements

- **Node.js** 22+ (the whole toolchain is Node-based; the brs-node simulator requires Node 22+).
- A Roku project containing plain BrightScript under `source/` (and optionally `components/`).
- For the **device lane only**: a Roku in developer mode (its IP + developer password).

## Install

```bash
npm i -D brighttest
```

This brings the toolchain with it (`brighterscript`, `rooibos-roku`, `brs-node`) — nothing else to install.

## Configure (optional)

Defaults work for a conventional layout. To customize, add `brighttest.json` at your project root:

```json
{
  "rootDir": ".",
  "sourceGlobs": ["manifest", "source/**/*", "components/**/*"],
  "testsFilePattern": "**/*.spec.bs",
  "stagingDir": ".brighttest"
}
```

| Key | Meaning | Default |
|---|---|---|
| `rootDir` | Project root that globs resolve against. | `.` |
| `sourceGlobs` | Files compiled into the test build. Roku only executes `source/` and `components/`. | `["manifest","source/**/*","components/**/*"]` |
| `testsFilePattern` | Where Rooibos looks for specs. | `**/*.spec.bs` |
| `stagingDir` | Scratch dir for generated builds/config. Git-ignore it. | `.brighttest` |

::: tip Git-ignore the scratch dirs
Add `.brighttest/`, `coverage/`, and `reports/` to your `.gitignore`.
:::

## Write your first test

Specs must live under a **compiled** path — e.g. `source/tests/` — because Roku only compiles `source/`
and `components/`. Create `source/tests/Example.spec.bs`:

```brightscript
namespace tests
  @suite("example")
  class ExampleTests extends rooibos.BaseTestSuite
    @describe("math")
    @it("adds numbers")
    function _()
      m.assertEqual(2 + 3, 5)
    end function
  end class
end namespace
```

Then walk through it in detail in the [Writing tests guide](/writing-tests/).

## Run

```bash
# Headless (default) — no device. Runs everything, including @SGNode node suites:
npx brighttest
npx brighttest --junit reports/junit.xml        # also write a JUnit report
npx brighttest --no-sgnode                      # skip @SGNode for the fastest inner loop

# Headless WITH coverage — still no device (writes LCOV):
npx brighttest --coverage
npx brighttest --coverage --lcov coverage/lcov.info

# On a real Roku (coverage + @SGNode, the fidelity reference):
npx brighttest --device --host <roku-ip> --password <dev-pw> --lcov coverage/lcov.info
```

`--device` and `--cross-check` resolve the target like the other device lanes: `--host` (also `ip:pw`), else `ROKU_HOST`, else the cached device (only when exactly one device is cached; with several, pass `--host` or set `ROKU_HOST`); the password comes from `--password`, the inline `ip:pw`, `ROKU_PASSWORD`, or the cache. An explicit `--host` always wins over `ROKU_HOST`.


Add scripts to `package.json`:

```json
{
  "scripts": {
    "test": "brighttest --junit reports/junit.xml",
    "test:device": "brighttest --device"
  }
}
```

## Adopting an existing app

Run `npx brighttest assess` first: it is read-only and offline, and it recommends `brownfield` (an app you will not edit)
or `greenfield` (a new app built with brighttest in mind). Then `npx brighttest init --brownfield` or
`npx brighttest init --greenfield` sets the project up (plain `init` is the scaffold described above). Both are covered in
[Assess a project](./assess) and [Instrumented builds](./instrument#brownfield-setup-init-brownfield). A device check before a
device run: `npx brighttest doctor --host <ip>` ([Troubleshooting](./troubleshooting#brighttest-doctor-is-the-device-ready)).

## Network fixtures in a headless run

`--net-record [file]` and `--net-unmatched <fail|passthrough>` apply to the headless lanes only (with `--device` or
`--cross-check` they exit 2). They are described in [Instrumented builds](./instrument#headless-network-fixtures-flags-config-and-run-records);
the rule format is in [HTTP fixtures](/writing-tests/http-fixtures).

## Exit codes

`0` on success, non-zero on any failure — CI-ready. With `--lcov`, a **missing** coverage report also
fails the run, so CI never silently loses coverage.

## CLI reference

```
brighttest [--junit <path>] [--config <path>]                     Headless run (default); runs @SGNode too
brighttest --no-sgnode                                            Headless run, skipping @SGNode (fastest)
brighttest --coverage [--lcov [path]] [--junit <path>]            Headless run + coverage (no device)
brighttest --device --host <ip> --password <pw> [--lcov [path]]   On-device run + coverage + node tests
brighttest --cross-check --host <ip> --password <pw>              Diff headless vs device (fidelity)

  -d, --device          Run on a Roku device (deploys + runs Rooibos, reports coverage)
      --coverage        Headless coverage via the brs-node simulator (no device); writes LCOV
      --no-sgnode       Skip @SGNode node suites; use the faster SceneGraph-off driver
      --cross-check     Run every suite headless AND on device; fail on any divergence
      --host <ip>       Roku device IP (device / cross-check mode)
      --password <pw>   Roku developer password (device / cross-check mode)
      --lcov [path]     Write LCOV (device or --coverage; default: coverage/lcov.info)
      --junit <path>    Write a JUnit XML report (headless / --coverage)
      --timeout <sec>   Watchdog (default: headless 300s, device 900s)
      --net-record [file]       Headless: record passthrough traffic to a HAR (needs instrument.net.upstreamHosts)
      --net-unmatched <policy>  Headless: fail (HTTP 599) or passthrough for requests no net rule matches
  -c, --config <path>   Path to brighttest.json (default: ./brighttest.json)
  -h, --help            Show help

brighttest init [--brownfield | --greenfield] [--force]           Scaffold a project (see: init --help)
brighttest assess [<dir>] [--json] [--out <dir>]                  Read-only project assessment
brighttest instrument build|verify|census                         Debug-only instrumented package (see: instrument --help)
brighttest doctor [--host <ip>] [--json] | --engines              Device or engine capability check
brighttest net convert <file.har> [-o <rules.json>]               HAR to net rules
```

The device-lease flags (`--wait`, `--as`, `--purpose`, `--device any`) are in
[Sharing a device](./device-lease); run `brighttest --help` for the full list (including `--idle-timeout`).
