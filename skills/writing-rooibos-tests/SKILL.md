---
name: writing-rooibos-tests
description: Use when writing or editing Rooibos test specs (*.spec.bs) for a Roku/BrightScript project that uses brighttest. Covers suite/test annotations, assertions, test doubles, parameterized tests, headless-vs-device rules, and the common pitfalls that make specs silently fail or not run.
---

# Writing Rooibos tests with brighttest

brighttest runs [Rooibos](https://github.com/rokucommunity/rooibos) test specs for BrightScript/Roku
projects. Tests run **headless by default** (no device needed) via the `brighttest` CLI; a device lane
adds real-hardware fidelity and coverage. You write one kind of spec; where it *can* run depends on what
it touches.

## The rules that bite hardest

Follow these six or your specs will fail to build, silently not run, or falsely pass. Details and
symptoms are in [pitfalls.md](pitfalls.md).

1. **Specs must live under a compiled path — `source/`.** Put them in `source/tests/<Thing>.spec.bs`.
   Roku only compiles `source/` and `components/`; a spec in a top-level `tests/` folder gives
   `Use of uninitialized variable` at the generated suite class.
2. **One `@it` immediately above one function.** No blank logic between them; never stack two `@it`s on
   one function. A detached `@it` silently doesn't run.
3. **`assertEqual` is type-strict on numbers.** `150.0 <> 150` and `Float <> Double`. Compare floats to
   float literals (`m.assertEqual(node.opacity, 0.5)`), or use `m.assertTrue(a = b)` for value-only
   numeric checks. SceneGraph numeric fields (`opacity`, `width`, `translation`, padding) come back as floats.
4. **Never commit `@only`.** It focuses the run to just that test/group — CI then silently skips
   everything else. It's a local-iteration aid only.
5. **Each test must be independent** — no reliance on run order or leftover state. Rebuild state in
   `@beforeEach`.
6. **Keep test names short.** Rooibos prints results to a fixed-width line; a very long `@it`/`@describe`
   name pushes the `(PASS)`/`(FAIL)` marker off the end and the test can't be classified.

## Minimum viable spec

```brightscript
namespace tests
  @suite("math utils")
  class MathUtilsTests extends rooibos.BaseTestSuite

    @describe("addNumbers")

    @it("adds two positive numbers")
    function _()
      result = addNumbers(2, 3)     ' source/ code is loaded — call it directly
      m.assertEqual(result, 5)      ' m = the suite instance
    end function

  end class
end namespace
```

- Suite is a `class` that **extends `rooibos.BaseTestSuite`** — that's where every `m.assert…` comes from.
- Wrap suites in `namespace tests` to avoid class-name collisions.
- `function _()` — the name is irrelevant; Rooibos identifies the test by its `@it`. Naming it `_` is the convention.
- Follow **Arrange → Act → Assert**. Prefer a few focused assertions per test over one giant test.

## The core habit: keep logic in pure functions

The single most valuable practice: **push business logic into pure functions and out of SceneGraph node
code.** Pure functions get fast, parameterized, headless tests; nodes stay thin shells you rarely need to
test on a device. When you find yourself writing many `@SGNode` tests, extract the logic instead.

## How tests run (lanes)

| Command | Device? | Coverage? | `@SGNode`? | Use for |
|---|---|---|---|---|
| `brighttest` | no | no | yes (headless) | everyday inner loop |
| `brighttest --no-sgnode` | no | no | skipped | fastest pure-logic loop |
| `brighttest --coverage` | no | yes (+LCOV) | yes (headless) | coverage / CI, no hardware |
| `brighttest --device --host <ip> --password <pw>` | yes | yes | yes | fidelity reference + on-device coverage |
| `brighttest --cross-check --host <ip> --password <pw>` | yes | — | both lanes | confirm headless matches device |

`@SGNode` node suites **run headless by default** (the tool boots a SceneGraph scene) — a device is only
needed for behavior tied to real wall-clock timing. See [limitations.md](limitations.md).

## Reference files — read the one you need

- **[pitfalls.md](pitfalls.md)** — every common mistake as Symptom → Cause → Fix. Read this when a spec
  won't build, a test doesn't appear in results, or an assertion fails on values that look equal.
- **[limitations.md](limitations.md)** — what the headless lane can't do and the workaround: `@deviceOnly`,
  coverage lanes, `@SGNode` scene needs, `globalFields` seeding for widgets that read global context.
- **[examples.md](examples.md)** — copy-paste-ready suites: pure-logic, parameterized, setup/teardown,
  test doubles (stub/spy/mock), and `@SGNode` node tests.
- **[cheatsheet.md](cheatsheet.md)** — quick tables of every annotation and every assertion, with "use when".
