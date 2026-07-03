# Quick start

## Requirements

- **Node.js** 18+ (the whole toolchain is Node-based).
- A Roku project containing plain BrightScript under `source/` (and optionally `components/`).
- For the **device lane only**: a Roku in developer mode (its IP + developer password).

## Install

```bash
npm i -D roku-test
```

This brings the toolchain with it (`brighterscript`, `rooibos-roku`, `brs-node`) — nothing else to install.

## Configure (optional)

Defaults work for a conventional layout. To customize, add `roku-test.json` at your project root:

```json
{
  "rootDir": ".",
  "sourceGlobs": ["manifest", "source/**/*", "components/**/*"],
  "testsFilePattern": "**/*.spec.bs",
  "stagingDir": ".roku-test"
}
```

| Key | Meaning | Default |
|---|---|---|
| `rootDir` | Project root that globs resolve against. | `.` |
| `sourceGlobs` | Files compiled into the test build. Roku only executes `source/` and `components/`. | `["manifest","source/**/*","components/**/*"]` |
| `testsFilePattern` | Where Rooibos looks for specs. | `**/*.spec.bs` |
| `stagingDir` | Scratch dir for generated builds/config. Git-ignore it. | `.roku-test` |

::: tip Git-ignore the scratch dirs
Add `.roku-test/`, `coverage/`, and `reports/` to your `.gitignore`.
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
# Headless (default) — no device, fast:
npx roku-test
npx roku-test --junit reports/junit.xml        # also write a JUnit report

# On a real Roku (adds code coverage):
npx roku-test --device --host <roku-ip> --password <dev-pw>
npx roku-test --device --host <roku-ip> --password <dev-pw> --lcov coverage/lcov.info
```

Add scripts to `package.json`:

```json
{
  "scripts": {
    "test": "roku-test --junit reports/junit.xml",
    "test:device": "roku-test --device"
  }
}
```

## Exit codes

`0` on success, non-zero on any failure — CI-ready. With `--lcov`, a **missing** coverage report also
fails the run, so CI never silently loses coverage.

## CLI reference

```
roku-test [--junit <path>] [--config <path>]                     Headless run (default)
roku-test --device --host <ip> --password <pw> [--lcov [path]]   On-device run + coverage

  -d, --device          Run on a Roku device (deploys + runs Rooibos, reports coverage)
      --host <ip>       Roku device IP (device mode)
      --password <pw>   Roku developer password (device mode)
      --lcov [path]     Write LCOV from the device run (default: coverage/lcov.info)
      --junit <path>    Write a JUnit XML report (headless mode)
  -c, --config <path>   Path to roku-test.json (default: ./roku-test.json)
  -h, --help            Show help
```
