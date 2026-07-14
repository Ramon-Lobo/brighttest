# brighttest

[![npm](https://img.shields.io/npm/v/brighttest.svg)](https://www.npmjs.com/package/brighttest)
[![Test](https://github.com/Ramon-Lobo/brighttest/actions/workflows/test.yml/badge.svg)](https://github.com/Ramon-Lobo/brighttest/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![GitHub](https://img.shields.io/badge/GitHub-Ramon--Lobo%2Fbrighttest-181717?logo=github)](https://github.com/Ramon-Lobo/brighttest)

**Repository:** <https://github.com/Ramon-Lobo/brighttest> · **Docs:** <https://ramon-lobo.github.io/brighttest/> · **Issues:** <https://github.com/Ramon-Lobo/brighttest/issues>

**A unified test runner for BrightScript / Roku SceneGraph apps.** Write your tests once in
[Rooibos](https://github.com/rokucommunity/rooibos) syntax and run them two ways from the same spec files:

- **Headless** (default) — fast, no device, CI-friendly. Runs on the
  [`brs-engine`](https://github.com/lvcabral/brs-engine) BrightScript simulator.
- **On-device** — deploys to a real Roku and runs the same suites on hardware.

Both lanes produce **code coverage (LCOV)**, and a **cross-check** mode runs your suites on *both* lanes
and diffs the results so you can trust the fast headless lane as a faithful proxy for the device.

> brighttest is an independent, community tool for testing BrightScript apps. It is **not** affiliated
> with, endorsed by, or sponsored by Roku, Inc. "Roku" and "BrightScript" are trademarks of their
> respective owners and are used here only to describe what this tool works with.

---

## Why

Testing a Roku channel has traditionally meant packaging tests into the app, sideloading to a device, and
reading results back over telnet — slow, hardware-bound, and awkward in CI. brighttest keeps the mature,
maintained pieces of that workflow (the BrighterScript compiler and the Rooibos framework) but adds a
**headless lane** so the vast majority of your tests — including SceneGraph node tests and `onChange`
observer cascades — run in seconds with no device at all.

It is a thin orchestrator over a proven stack, not a new BrightScript engine:

| Layer | Role |
|---|---|
| [BrighterScript](https://github.com/rokucommunity/brighterscript) (`bsc`) | Compiles/validates `.brs`/`.bs` and hosts the Rooibos plugin |
| [Rooibos](https://github.com/rokucommunity/rooibos) | The test framework — `describe`/`it`, mocks, coverage |
| [brs-engine](https://github.com/lvcabral/brs-engine) | The BrightScript + SceneGraph simulator that runs suites headlessly |

## Features

- **One spec, two lanes** — the exact same `.spec.bs` files run headless and on-device.
- **No device required for most tests** — pure logic, data models, and even `@SGNode` node suites
  (with their `onChange` cascades) run on the simulator.
- **Code coverage + LCOV, headless** — feed Coveralls / Codecov / `genhtml` with no hardware.
- **Cross-check fidelity mode** — diff headless vs device results and fail on any divergence.
- **`@deviceOnly` annotation** — mark the few tests that only make sense on hardware; headless lanes skip
  them automatically.
- **Standard Rooibos syntax** — no lock-in; if you already use Rooibos, your tests work as-is.
- **CI-ready** — non-zero exit on failure, JUnit and LCOV reporters, zero device needed for the default
  and coverage lanes.

## Requirements

- **Node.js** 22+ (the headless and coverage lanes run on the brs-node simulator, which requires Node 22+).
- **A Roku device in developer mode** — only for `--device` and `--cross-check`.

## Install

```bash
npm i -D brighttest
```

This pulls its runtime dependencies (`brighterscript`, `@ramonlobo/rooibos-roku`, `@ramonlobo/brs-node`).

## Quick start

```bash
npx brighttest                                   # headless run (default) — fast, no device
npx brighttest --no-sgnode                       # headless, skip @SGNode suites (fastest inner loop)
npx brighttest --coverage                        # headless + coverage + LCOV (no device)
npx brighttest --coverage --lcov coverage/lcov.info
npx brighttest --junit reports/junit.xml         # headless + JUnit report
npx brighttest --device   --host <ip> --password <pw>            # on-device run + coverage
npx brighttest --cross-check --host <ip> --password <pw>         # diff headless vs device
```

The command exits non-zero on any test failure, so it drops straight into CI. With `--lcov`, a missing
coverage report also fails the run so CI never silently loses coverage.

### The run modes

| Command | Device? | Coverage? | `@SGNode` node tests? | Speed |
|---|---|---|---|---|
| `brighttest` (default) | no | no | yes (headless) | fast |
| `brighttest --no-sgnode` | no | no | skipped | fastest |
| `brighttest --coverage` | no | yes (+LCOV) | yes (headless) | slower (boots a scene) |
| `brighttest --device …` | yes | yes (+LCOV) | yes | slowest |
| `brighttest --cross-check …` | yes | — | both lanes | slowest (runs both) |

## Writing a test

Put specs under a compiled path — Roku only compiles `source/` and `components/`, so e.g.
`source/tests/Math.spec.bs`:

```brightscript
namespace tests
  @suite("math")
  class MathTests extends rooibos.BaseTestSuite

    @describe("add")

    @it("adds two numbers")
    function _()
      m.assertEqual(2 + 3, 5)
    end function

  end class
end namespace
```

Rooibos gives you `@describe`/`@it`, parameterized tests (`@params`), setup/teardown hooks, and
mocks/stubs/spies. See the [Writing tests guide](docs/writing-tests/index.md) for the full walkthrough.

### SceneGraph node tests

Annotate a suite with `@SGNode("MyComponent")` to host it inside a real node. These run **headless** in the
default and `--coverage` lanes (including `onChange` observer cascades), and on hardware with `--device`.

### Device-only tests

For the rare test that only makes sense on real hardware (behavior tied to render/animation timing, a
firmware quirk the simulator can't reproduce), mark it `@deviceOnly`:

```brightscript
@it("plays the fade-in over real frames")
@deviceOnly
function _()
  ...
end function
```

Headless lanes skip it; `--device` runs it; `--cross-check` reports it as device-only (not a divergence).
It works on a whole `@suite`, a `@describe` group, or a single `@it`.

## Coverage

`--coverage` (headless) and `--device` both emit an LCOV report. Framework-internal records are filtered
out automatically, so the file is ready for Coveralls, Codecov, or `genhtml`:

```bash
npx brighttest --coverage --lcov coverage/lcov.info
genhtml coverage/lcov.info -o coverage/html
```

## Configuration

All optional — sensible defaults apply. Drop a `brighttest.json` at your project root:

```json
{
  "rootDir": ".",
  "sourceGlobs": ["manifest", "source/**/*", "components/**/*"],
  "testsFilePattern": "**/*.spec.bs",
  "stagingDir": ".brighttest",
  "diagnosticFilters": [],
  "globalFields": {}
}
```

- **`sourceGlobs`** — what to compile (bsc `files`). Exclude your real `main` so the test scene boots
  instead of the app.
- **`diagnosticFilters`** — BrighterScript diagnostic codes to silence (e.g. cross-scope/third-party noise).
- **`globalFields`** — seed `m.global` fields (per `@SGNode` type) so widgets that read global context
  construct correctly. See [Global context](docs/writing-tests/global-context.md).

## What it can (and can't) test

- **Unit tests** — pure functions, parsing, formatting, data models, crypto: the fast, headless sweet spot.
- **Integration tests** — `@SGNode` components with their children and `onChange` wiring (headless), and
  the request/response logic of Task/API code via HTTP fixtures.
- **Not end-to-end** — brighttest exercises components and logic; it does not drive the full app through
  the remote / navigation. For UI-journey E2E, pair it with a device-automation tool.

## How it works

- Both lanes build with `bsc` + the Rooibos plugin.
- **Headless** runs the compiled Rooibos suites on the `brs-engine` simulator — no device, no real render
  thread. The `--coverage` lane enables the simulator's SceneGraph so `@SGNode` suites and the coverage
  collector work, and writes LCOV.
- **Device** builds with coverage on and hands off to the stock Rooibos CLI to deploy and run on hardware.
- **Cross-check** runs both and diffs per-test results, failing on any divergence.

See [Architecture](docs/architecture.md) and [Motivation & decisions](docs/motivation.md) for the design,
and [Maintainers](docs/maintainers.md) for the simulator patches that make headless SceneGraph testing
faithful.

## Documentation

Full docs live in [`docs/`](docs/) (a VitePress site):

```bash
npm run docs:dev      # local preview
npm run docs:build    # static site → docs/.vitepress/dist
```

Highlights: [Getting started](docs/guide/getting-started.md) ·
[Writing tests](docs/writing-tests/index.md) · [Headless vs device](docs/writing-tests/headless-vs-device.md) ·
[CI](docs/guide/ci.md) · [Troubleshooting](docs/guide/troubleshooting.md).

## Contributing

Contributions are welcome — bug reports, docs fixes, and pull requests. Start with
[`CONTRIBUTING.md`](CONTRIBUTING.md) for the dev setup, how to run the test suite and docs locally, the
branch/commit conventions, and the PR checklist. For the internals behind the headless SceneGraph lane,
see [Maintainers](docs/maintainers.md).

- **Bugs / feature requests:** <https://github.com/Ramon-Lobo/brighttest/issues>
- **Questions / ideas:** <https://github.com/Ramon-Lobo/brighttest/discussions>

## Acknowledgements

brighttest stands on [BrighterScript](https://github.com/rokucommunity/brighterscript) and
[Rooibos](https://github.com/rokucommunity/rooibos) by the RokuCommunity, and
[brs-engine](https://github.com/lvcabral/brs-engine) by Marcelo Lv Cabral. Thank you.

## License

MIT.
