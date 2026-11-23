# The first green headless run

Evidence: run on a copy of `examples/legacy-app` with `node bin/cli.js` at this version, after adding one spec
(`Util_buildUrl`, two tests). `npx brighttest --no-sgnode --junit r.xml` printed `7 passed, 0 failed` and exited 0;
after flipping one expected string it printed `6 passed, 1 failed` and exited 1; restored, green again. The same
copy without `--no-sgnode` printed nothing after "building the test bundle" for over 100 s and was killed. No
device. Failure routes marked "unverified" were not reproduced.

## Before you start

- Step 0 answers are recorded (edit permission, device). On the no-edit path, do this in the copy.
- `brighttest.json` exists and its `sourceGlobs` cover the sources and the specs (`bsconfig-mapping.md`).
- `npx brighttest doctor --engines` exits 0.

## 1. Three meaningful specs

Pick pure functions that already exist as global functions in `source/` (formatters, URL builders, parsers). A spec
lives in `source/tests/*.spec.bs`, matches `testsFilePattern` (default `**/*.spec.bs`), and needs a `@suite`, a
`@describe` and `@it` blocks (a spec without `@describe` failed here with `Cannot process it of a test group`):

```brightscript
namespace tests
  @suite("Util_buildUrl")
  class UtilBuildUrlTests extends rooibos.BaseTestSuite

    @describe("Util_buildUrl")

    @it("joins base, api path, version and kind")
    function _()
      cfg = { baseUrl: "http://example.invalid", apiPath: "api", version: "v2" }
      m.assertEqual(Util_buildUrl(cfg, "items", ""), "http://example.invalid/api/v2/items")
    end function

  end class
end namespace
```

"Meaningful" means the assertion would catch a real regression: no `assertTrue(true)`, no test that only checks
the function does not crash. Use `example.invalid` hosts and invented values, never real endpoints or tokens.
Spec syntax is in `writing-rooibos-tests`.

## 2. Run it

```bash
npx brighttest --no-sgnode --junit results.xml
```

Read the last line: `brighttest (headless): N passed, M failed`. Green means exit 0 and N of at least 3.
`0 passed, 0 failed` is not green: the run did not complete or found no spec. Add `--coverage --lcov
coverage/lcov.info` when the human wants coverage. That lane also runs `@SGNode` suites (per `--help`), so
bound it with `--timeout <sec>`; whether `--no-sgnode` combines with `--coverage` was not checked.

## 3. Prove a test can fail

Flip one expectation (change `v2` to `v3` in the expected string), run again, expect exit 1 and a `✗` line naming
the test, then restore the file. Check `git diff` shows no change beyond the spec files you meant to add. Do the
flip in the spec only, never in app code.

## 4. Engine smoke step

Run `npx brighttest doctor --engines` (exit 0 passes). A default run includes `@SGNode` suites, and on the engine
version used here it did not finish on the legacy-app copy. Record which of the two outcomes you saw
(`--no-sgnode` green, default run green or hung). The `@SGNode` outcome does not block the first green run on the current engine: do not
block the first green run on it, and do not claim it works or fails beyond the run you did.

## Failure modes and routes

| Symptom | Route |
|---|---|
| `Cannot read properties of null (reading 'addTestCase')` or `Cannot process it of a test group` | The spec has `@it` without a `@describe` before it (seen). Add the `@describe` line. |
| `0 passed, 0 failed` | No spec matched `testsFilePattern`, or the run died early. Read the output above the last line. |
| `Use of uninitialized variable` in a spec | Unverified here: usually a spec outside `source/`. Move it under `source/tests/`. |
| `Cannot find name 'rooibos'` | Unverified here: the Rooibos plugin is not loaded. Run through `npx brighttest`, not bsc alone. |
| Build errors for `BS1107` | Silenced always. Other noisy codes go into `diagnosticFilters` in `brighttest.json`. |
| Crash on `invalid` when a widget reads a global | Seed `globalFields` in `brighttest.json` (scene-field to value). |
| Nothing printed after "building the test bundle" | Likely an `@SGNode` suite on this engine: stop the run, repeat with `--no-sgnode`, and report it. |
| Warning "declares a Task node; the headless lane cannot run Task" | Expected with `--no-sgnode`. Tasks need a device. |

## Hand-off

Report: the command, the pass count, the flipped test shown failing then restored, the files you added, the engine
smoke outcome, and what you did not run. Never print a device password, token or serial in the report.
