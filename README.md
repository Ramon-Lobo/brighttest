# brighttest

📚 **Full documentation** lives in [`docs/`](docs/) (VitePress site). Preview it with:

```bash
npm run docs:dev      # local preview
npm run docs:build    # static site → docs/.vitepress/dist  (host on GitHub Pages, etc.)
```

Highlights: a from-scratch **[Writing tests guide](docs/writing-tests/index.md)**, architecture, CI setup,
and troubleshooting.

---

A unified BrightScript test runner for any Roku project. **Write tests once** in Rooibos syntax; run them:

- **headless** (default) — fast, no device, for CI (`@rokucommunity`/`brs-node` simulator)
- **on-device** (opt-in) — deploys via Rooibos and reports **code coverage**

Only tests that touch real SceneGraph nodes (`@SGNode`) are device-only; everything else runs headless.

## Install

```bash
npm i -D brighttest        # pulls brighterscript, rooibos-roku, brs-node
```

## Use

```bash
npx brighttest                                   # headless (default)
npx brighttest --junit reports/junit.xml         # headless + JUnit report
npx brighttest --device --host <ip> --password <pw>              # on-device + coverage
npx brighttest --device --host <ip> --password <pw> --lcov       # + write coverage/lcov.info
npx brighttest --device --host <ip> --password <pw> --lcov cov/lcov.info   # custom path
```

Exit code is non-zero on any failure (CI-ready). With `--lcov`, a missing coverage report also
fails the run so CI never silently loses coverage. The LCOV file (`TN:/SF:/DA:/LF:/LH:`) feeds
Coveralls/Codecov/`genhtml`; framework-internal records are filtered out automatically.

## Write a test

Put specs under a compiled path (e.g. `source/tests/…​.spec.bs`) — Roku only compiles `source/` and `components/`:

```brighterscript
namespace tests
  @suite("math")
  class MathTests extends rooibos.BaseTestSuite
    @describe("add")
    @it("adds")
    function _()
      m.assertEqual(2 + 3, 5)
    end function
  end class
end namespace
```

## Config (`brighttest.json`, optional)

```json
{
  "rootDir": ".",
  "sourceGlobs": ["manifest", "source/**/*", "components/**/*"],
  "testsFilePattern": "**/*.spec.bs",
  "stagingDir": ".brighttest"
}
```

## How it works
- Both lanes build with `bsc` + the `rooibos-roku` plugin.
- **Headless:** builds with coverage off, then a bundled driver (`brs/headless_runner.brs`) instantiates
  each compiled Rooibos suite and runs it on the `brs-node` simulator — no device, no SceneGraph.
- **Device:** builds with coverage on and hands off to the stock Rooibos CLI.
