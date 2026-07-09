# Cheatsheet

## Annotations

| Annotation | Applies to | Purpose |
|---|---|---|
| `@suite("name")` | class | Declares the class (which `extends rooibos.BaseTestSuite`) as a test suite. |
| `@describe("group")` | position | Starts a labelled group; every `@it` after it belongs to the group until the next `@describe`. Shows as a prefix in output. |
| `@it("description")` | the function immediately below | Marks one test. Must be directly above its function. Keep names short. |
| `@params(a, b, …, expected)` | repeated above one function | One test case per line, passed positionally to the function args. Max **6** params headless. |
| `@beforeEach` | function | Runs before every test in the group. Rebuild fresh state on `m`. |
| `@afterEach` | function | Runs after every test in the group. Per-test cleanup. |
| `@only` | test/group/suite | Focus the run to just this. **Never commit it** — CI silently skips the rest. |
| `@ignore` | test/group/suite | Skip this test/group/suite. |
| `@SGNode("Component")` | suite | Host the suite inside a real SceneGraph node; `m.top` is that node. Runs headless (default/`--coverage`) or on device. |
| `@deviceOnly` | test/group/suite | Headless lanes skip it; device lane runs it. For behavior real only on hardware. Equivalent to `@tags("deviceOnly")`. |
| `@tags("a", "b")` | test/group/suite | Tag tests for selective runs. |

Structure: `namespace tests` → `@suite` + `class … extends rooibos.BaseTestSuite` → `@describe` groups →
`@it` + `function _()`. One suite per file, named `<Thing>.spec.bs`, under `source/tests/`.

## Assertions

All are methods on the suite (`m.assert…`), inherited from `rooibos.BaseTestSuite`. Every assertion takes
an optional final `msg` argument. The first failure stops the test.

| Check | Assertion |
|---|---|
| Values equal (deep-compares arrays & AAs; **type-strict on numbers**) | `m.assertEqual(actual, expected)` |
| Values not equal | `m.assertNotEqual(a, b)` |
| Value-only numeric equality (ignores Float/Double/Integer) | `m.assertTrue(a = b)` |
| Boolean condition true / false | `m.assertTrue(expr)` / `m.assertFalse(expr)` |
| Is / isn't `invalid` (BrightScript's null) | `m.assertInvalid(v)` / `m.assertNotInvalid(v)` |
| Array contains / lacks a value | `m.assertArrayContains(arr, v)` / `m.assertArrayNotContains(arr, v)` |
| Array contains all of these | `m.assertArrayContainsSubset(arr, [a, b])` |
| Array length is n | `m.assertArrayCount(arr, n)` |
| Empty / not empty (array or string) | `m.assertEmpty(x)` / `m.assertNotEmpty(x)` |
| AA has / lacks a key | `m.assertAAHasKey(aa, "id")` / `m.assertAANotHasKey(aa, "secret")` |
| AA has all these keys | `m.assertAAHasKeys(aa, ["id", "name"])` |
| AA contains these key/values | `m.assertAAContainsSubset(aa, { id: 1 })` |
| Fail explicitly (e.g. unreachable branch) | `m.fail("message")` |

**Number gotcha:** `assertEqual` distinguishes Float/Double/Integer, so `150.0 <> 150`. Compare floats to
float literals (`m.assertEqual(node.opacity, 0.5)`) or use `m.assertTrue(a = b)` for value-only checks.

## CLI lanes

| Command | Device? | Coverage? | `@SGNode`? |
|---|---|---|---|
| `brighttest` | no | no | yes (headless) |
| `brighttest --no-sgnode` | no | no | skipped (fastest) |
| `brighttest --coverage [--lcov <path>]` | no | yes (+LCOV) | yes (headless) |
| `brighttest --device --host <ip> --password <pw>` | yes | yes | yes |
| `brighttest --cross-check --host <ip> --password <pw>` | yes | — | both lanes |

Other flags: `--junit <path>` (JUnit XML), `--timeout <sec>` (headless 300s / device 900s), `-c/--config <path>`.
Exit code is `0` on success, non-zero on any failure (and when `--lcov` is requested but no coverage came back).

## Config (`brighttest.json`, all optional)

```json
{
  "rootDir": ".",
  "sourceGlobs": ["manifest", "source/**/*", "components/**/*"],
  "testsFilePattern": "**/*.spec.bs",
  "stagingDir": ".brighttest",
  "globalFields": { "*": { "config": null } }
}
```

Git-ignore `.brighttest/` and `coverage/`. Specs are auto-discovered by `testsFilePattern` — no manual
registration.
