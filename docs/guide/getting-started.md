# Quick start

Adding brighttest to an existing app or starting a new one? See [Adopting brighttest](./adopting.md).

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
| `testsFilePattern` | Written to the generated `bsconfig.json`; the Rooibos fork does not currently read it (it selects specs with `includeFilters`, default `**/*.spec.bs`). | `**/*.spec.bs` |
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

`0` on success, `1` on any failure, `2` on a usage or engine-resolution error (an unreadable `brighttest.json` currently exits 1; a `--config` path that does not exist is ignored and the defaults are used). A device run with no result line, a
crashed test, a timeout or an idle abort is a failure too. A device run that cannot get the device in time exits `75`
(see [Sharing a device](/guide/device-lease#exit-codes)). With `--lcov`, a **missing** coverage report also
fails the run, so CI never silently loses coverage.

## Sharing the device

`--device` and `--cross-check` take a per-device [lease](/guide/device-lease) and queue behind other users of the
same Roku (`--wait`, `--as`, `--purpose`; `--device any` picks from `deviceLease.pool`). A device run also stops when the
device prints nothing for `--idle-timeout` seconds (default 120) or after `--timeout` (default 900).

## CLI reference

Every lane flag and subcommand (`init`, `skills`, `instrument`, `e2e`, `studio`, `doctor`, `mcp`, `device`, ...) is
listed in the [CLI reference](/guide/cli-reference); `npx brighttest --help` prints the same.
