# Quick start

::: info At a glance
**What it is for:** install brighttest and get a first passing headless test, no Roku needed.

**You will:**
- install brighttest and scaffold a project
- write (or keep) a first spec
- run it headless, then with coverage
- optionally point brighttest at a Roku

**First command:** `npm i -D brighttest`
:::

Adding brighttest to an existing app or starting a new one? See [Adopting brighttest](/guide/adopting).

## Requirements

What you need before you start.

- **Node.js** 22+ (the toolchain is Node-based; the brs-node simulator requires Node 22+).
- A Roku project with plain BrightScript under `source/` (optionally `components/`).
- **Device lane only:** a Roku in developer mode (its IP and developer password).

## Do it: first passing test
<!-- covers: Write your first test -->

Five steps to a green headless run.

1. Install (brings `brighterscript`, `rooibos-roku`, `brs-node`; nothing else needed):

   ```bash
   npm i -D brighttest
   ```

2. Scaffold `brighttest.json`, `source/tests/Example.spec.bs`, `.gitignore` entries and an npm `test` script (if `package.json` exists); existing files are kept:

   ```bash
   npx brighttest init
   ```

3. Check the spec. It must be under a **compiled** path such as `source/tests/` (Roku only compiles `source/` and `components/`). Minimal form:

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

4. Run it headless (no device):

   ```bash
   npx brighttest
   ```

5. Expect exit code 0 and:

   ```text
   brighttest: headless lane
     ✓ sanity > runs a passing assertion
     ✓ sanity > compares floats to float literals (assertEqual is type-strict on numbers)
     brighttest (headless): 2 passed, 0 failed
   ```

::: tip Git-ignore the scratch dirs
Add `.brighttest/`, `coverage/` and `reports/` to `.gitignore` (`init` does it). Next: the [Writing tests guide](/writing-tests/).
:::

## Run options

The common lanes.

```bash
# Headless (default), no device. Runs everything, including @SGNode node suites:
npx brighttest
npx brighttest --junit reports/junit.xml        # also write a JUnit report
npx brighttest --no-sgnode                      # skip @SGNode for the fastest inner loop

# Headless WITH coverage, still no device (writes LCOV):
npx brighttest --coverage
npx brighttest --coverage --lcov coverage/lcov.info

# On a real Roku (coverage + @SGNode, the fidelity reference):
npx brighttest --device --host <roku-ip> --password <dev-password> --lcov coverage/lcov.info
```

Add scripts to `package.json`:

```json
{
  "scripts": {
    "test": "brighttest --junit reports/junit.xml",
    "test:device": "brighttest --device"
  }
}
```

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | Any failure: crashed test, device run with no result line, timeout, idle abort, unreadable `brighttest.json`, or (with `--lcov`) a **missing** coverage report, so CI never silently loses coverage |
| `2` | Usage or engine-resolution error (a missing `--config` path is ignored; defaults used) |
| `75` | Device not obtained in time ([Sharing a device](/guide/device-lease#exit-codes)) |

## Configure (optional)

Defaults fit a conventional layout. To customize, add `brighttest.json` at the project root.

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
| `rootDir` | Project root that globs resolve against | `.` |
| `sourceGlobs` | Files compiled into the test build. Roku only executes `source/` and `components/` | `["manifest","source/**/*","components/**/*"]` |
| `testsFilePattern` | Written to the generated `bsconfig.json`; the Rooibos fork does not currently read it (it selects specs with `includeFilters`, default `**/*.spec.bs`) | `**/*.spec.bs` |
| `stagingDir` | Scratch dir for generated builds and config. Git-ignore it | `.brighttest` |

::: tip A plain `source/main.brs`
On the default scene lane (an `@SGNode` spec exists, coverage off) Rooibos does not hook a plain `source/main.brs`, so the app's `Main()` would run and its event loop would hang the run.

- brighttest appends `!source/main.brs` (real casing) to the effective `sourceGlobs` on that lane and logs a line, unless you exclude it already or your globs skip it. `brighttest init` does not write this exclusion.
- Coverage, device and plain `--no-sgnode` lanes keep the file (other code may call its helpers).
- A Main in another `.brs` file: exclude it yourself.
:::

## Point brighttest at your Roku

Headless runs need no device. For the device lane, `e2e`, `doctor`, Studio and MCP, save your Roku once.

```sh
npx brighttest setup                    # finds Rokus on your network, checks the one you pick, asks before saving
npx brighttest setup --host 192.0.2.10  # same, for a known address
```

- Writes `ROKU_HOST=<ip>` to the project `.env`; adds `.env` to `.gitignore` in a git work tree.
- Checks the device like `doctor` (device info only: no lease, no keypress).
- Never asks for, stores or prints the dev password: set `ROKU_PASSWORD`, or cache it with `brighttest devices`.
- Agents and scripts: `brighttest setup --host <ip> --write --json`. In CI, set `ROKU_HOST` and `ROKU_PASSWORD` as secrets instead ([CI integration](/guide/ci)).

### How the target is resolved

Every device command (`--device`, `--cross-check`, `e2e`, `doctor`, `device`, Studio, MCP) uses one order:

1. `--host` (also `ip:pw`)
2. `ROKU_HOST` in the shell (wins over `.env`)
3. `ROKU_HOST` in the project `.env`
4. The cached device, only when exactly one is cached. With several, pass `--host` or run `brighttest setup`.

The password comes from `--password`, the inline `ip:pw`, `ROKU_PASSWORD`, or the cache. `doctor` and `brighttest setup` show where the host came from.

::: warning Doctor and several cached devices
[Troubleshooting](/guide/troubleshooting#brighttest-doctor-is-the-device-ready) says `doctor` warns and uses the last cached device instead of refusing. Pass `--host` to be sure.
:::

### Sharing the device

`--device` and `--cross-check` take a per-device [lease](/guide/device-lease) and queue behind other users of the same Roku (`--wait`, `--as`, `--purpose`; `--device any` picks from `deviceLease.pool`). A device run also stops when the device prints nothing for `--idle-timeout` seconds (default 120) or after `--timeout` (default 900).

## Adopting an existing app

Assess first, then pick a setup.

1. `npx brighttest assess`: read-only and offline; recommends `brownfield` (an app you will not edit) or `greenfield` (a new app built with brighttest in mind).
2. `npx brighttest init --brownfield` or `npx brighttest init --greenfield` (plain `init` is the scaffold above). See [Assess a project](/guide/assess) and [Instrumented builds](/guide/instrument#brownfield-setup-init-brownfield).
3. Before a device run: `npx brighttest doctor --host <ip>` ([Troubleshooting](/guide/troubleshooting#brighttest-doctor-is-the-device-ready)).

## Network fixtures in a headless run

`--net-record [file]` and `--net-unmatched <fail|passthrough>` apply to the headless lanes only; with `--device` or `--cross-check` they exit 2. See [Instrumented builds](/guide/instrument#headless-network-fixtures-flags-config-and-run-records); the rule format is in [HTTP fixtures](/writing-tests/http-fixtures).

## CLI reference

Every lane flag and subcommand (`init`, `skills`, `instrument`, `e2e`, `studio`, `doctor`, `mcp`, `device`, ...) is in the [CLI reference](/guide/cli-reference); `npx brighttest --help` prints the same.

## Related

- [Writing tests](/writing-tests/): next step
- [Device lease](/guide/device-lease): sharing a Roku

**Full guide:** [Quick start](full:/guide/getting-started) — the original wording.
