# 12. Common mistakes

::: info At a glance
**What it is for:** recognising the test-writing errors nearly everyone hits, and fixing them fast.

**You will:**
- match a symptom to its cause
- apply the fix
- jump to the page that explains it

**First file:** your failing spec. For tool/setup issues, see [Troubleshooting & how it works](/guide/troubleshooting).
:::

## Structure and build

Errors from where and how specs are written.

### Spec in the wrong folder → "Use of uninitialized variable"

- **Symptom:** build/run error at your suite class, e.g. `Use of uninitialized variable` at the generated `RuntimeConfig`.
- **Cause:** the spec is outside a compiled path (like a top-level `tests/`). Roku compiles only `source/` and `components/`.
- **Fix:** put specs under `source/`, e.g. `source/tests/MyThing.spec.bs`.

### `@it` not attached to its function

- **Symptom:** a test silently does not run, or a build error about a duplicate/unknown function.
- **Cause:** `@it` (or `@describe`) separated from its function, or two `@it`s on one function.
- **Fix:** each `@it` is immediately followed by exactly one function.

```brightscript
@it("does the thing")     ' ✅ directly above its function
function _()
  ...
end function
```

### Forgetting the `tests` namespace / suite name collisions

- **Symptom:** odd build errors when two suites share a class name.
- **Fix:** wrap suites in `namespace tests` (or another namespace); give each suite class a unique name.

### Very long `@it` / `@describe` names

- **Symptom:** a test vanishes from results: counts do not add up, neither passed nor failed.
- **Cause:** Rooibos prints to a fixed-width line; a long name pushes `(PASS)`/`(FAIL)` off the end, so the parser
  cannot classify it.
- **Fix:** keep names short. They read better in reports too.

## Assertions

Type-strict comparisons and weak tests.

### `assertEqual` fails on numbers that look equal

- **Symptom:** `expected "2147483647 (Float)" to equal "2147483647 (Double)"`.
- **Cause:** `assertEqual` is type-strict across numeric subtypes (Float, Double, Integer).
- **Fix:** when only the value matters, use `=` in `assertTrue`: `m.assertTrue(value = 2147483647)`.

### Comparing a float field to an integer literal

- **Symptom:** `expected "150 (Float)" to equal "150 (Integer)"` though the numbers look identical.
- **Cause:** `assertEqual` is **type-strict**. SceneGraph numeric fields (`opacity`, `width`, `translation`, padding,
  any `float` field) return floats, and `150.0 <> 150`.
- **Fix:** compare to float literals: `m.assertEqual(node.opacity, 0.5)`, `m.assertEqual(t[0], 150.0)`. `as float`
  test params are already floats, so parameterized tests sidestep this.

### Asserting too much in one test

- **Symptom:** a failing test with ten assertions; you cannot tell which behaviour broke.
- **Fix:** split into focused (or parameterized) tests. One clear reason to fail per test.

### Not watching a test fail

- **Symptom:** a test that "always passes", even when the code is broken.
- **Cause:** the assertion does not exercise the thing (e.g. asserting a constant).
- **Fix:** temporarily break the code or expectation, confirm it fails, restore. A test you have not seen fail is not
  protecting you. See [Your first test](/writing-tests/first-test).

## Test design

State and dependencies that make tests fragile.

### Tests that depend on each other

- **Symptom:** passes alone, fails in the full suite (or vice versa).
- **Cause:** shared mutable state leaking between tests.
- **Fix:** rebuild state in `@beforeEach`; never rely on run order. See [Setup & teardown](/writing-tests/setup-teardown).

### Leaving `@only` in committed code

- **Symptom:** CI reports very few tests; most are silently skipped.
- **Cause:** `@only` (a debugging focus aid) left on a test or group.
- **Fix:** remove `@only` before committing; keep it for local iteration.

### Un-injectable dependencies (hard-to-test code)

- **Symptom:** you cannot test a function without a real device/network/clock because it builds them itself.
- **Cause:** it calls `CreateObject("roDateTime")`, makes a request, or reads the registry directly.
- **Fix:** pass the dependency in as a parameter; inject a fake in the test. See
  [Mocks, stubs & spies](/writing-tests/test-doubles).

::: code-group
```brightscript [Hard to test]
function greet(name) : hour = CreateObject("roDateTime").getHours() : ...
```
```brightscript [Easy to test]
function greet(name, clock) : hour = clock.nowHour() : ...
```
:::

## Lanes

Surprises about what each run does.

### Trying to run a SceneGraph node test headless

- **Symptom:** a crash / no result for an `@SGNode` test under `npx brighttest`.
- **Cause:** node tests need the real render thread; the headless simulator cannot provide it.
- **Fix:** run node tests with `--device`. Better: extract the logic into a pure function tested headless. See
  [SceneGraph & async tests](/writing-tests/scenegraph-async).

### Expecting coverage from the *default* lane

- **Symptom:** no coverage numbers from `npx brighttest`.
- **Cause:** the default lane skips coverage for speed.
- **Fix:** run `npx brighttest --coverage`: coverage + LCOV, no device. `--device` also produces coverage. See [CI](/guide/ci).

### Surprised the default run boots a scene

- **Symptom:** `npx brighttest` is slower than expected on a project with `@SGNode` specs.
- **Cause:** the default lane runs `@SGNode` suites headless (no device), booting a SceneGraph scene: slower than the
  SceneGraph-off driver used with no node specs.
- **Fix:** nothing is wrong; node tests run by default on purpose. For the quickest pure-logic loop, add `--no-sgnode`.
  Node behaviour (incl. `onChange` cascades) stays covered by default/`--coverage`/`--device` runs.

## Related

- [Troubleshooting & how it works](/guide/troubleshooting): tool and setup issues
- [Setup & teardown](/writing-tests/setup-teardown): clean state per test
- [Mocks, stubs & spies](/writing-tests/test-doubles): injecting fakes
- [Headless vs device](/writing-tests/headless-vs-device): what runs where

**Full guide:** [Common mistakes](full:/writing-tests/mistakes) — the original wording.
