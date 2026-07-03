# 11. Common mistakes

The errors nearly everyone hits when starting, what they look like, and the fix. (For tool/setup issues
rather than test-writing, see [Troubleshooting & how it works](/guide/troubleshooting).)

## Spec in the wrong folder → "Use of uninitialized variable"

**Symptom:** a build/run error pointing at your suite class, e.g. `Use of uninitialized variable` at the
generated `RuntimeConfig`.

**Cause:** the spec lives outside a compiled path (like a top-level `tests/` folder). Roku only compiles
`source/` and `components/`, so the suite class is never defined.

**Fix:** put specs under `source/`, e.g. `source/tests/MyThing.spec.bs`.

## `@it` not attached to its function

**Symptom:** a test silently doesn't run, or a build error about a duplicate/unknown function.

**Cause:** an `@it` (or `@describe`) separated from its function by blank logic, or two `@it`s stacked on
one function.

**Fix:** each `@it` must be immediately followed by exactly one function.

```brightscript
@it("does the thing")     ' ✅ directly above its function
function _()
  ...
end function
```

## `assertEqual` fails on numbers that look equal

**Symptom:** `expected "2147483647 (Float)" to equal "2147483647 (Double)"`.

**Cause:** `assertEqual` is type-strict across numeric subtypes (Float vs Double vs Integer).

**Fix:** when you only care about the value, compare with `=` inside `assertTrue`:

```brightscript
m.assertTrue(value = 2147483647)
```

## Forgetting the `tests` namespace / suite name collisions

**Symptom:** odd build errors when two suites share a class name.

**Fix:** wrap suites in `namespace tests` (or another namespace) and give each suite class a unique name.

## Tests that depend on each other

**Symptom:** a test passes alone but fails when the whole suite runs (or vice versa).

**Cause:** shared mutable state leaking between tests — one test's changes affect the next.

**Fix:** rebuild state in `@beforeEach` so every test starts clean. Never rely on run order. See
[Setup & teardown](/writing-tests/setup-teardown).

## Leaving `@only` in committed code

**Symptom:** CI reports very few tests; most are silently skipped.

**Cause:** `@only` (a debugging focus aid) left on a test or group.

**Fix:** remove `@only` before committing. Reserve it for local iteration.

## Trying to run a SceneGraph node test headless

**Symptom:** a crash / no result for an `@SGNode` test under `npx roku-test`.

**Cause:** node tests need the real render thread; the headless simulator can't provide it.

**Fix:** run node tests with `--device`. Better: extract the logic into a pure function and test that
headless — see [SceneGraph & async tests](/writing-tests/scenegraph-async).

## Un-injectable dependencies (hard-to-test code)

**Symptom:** you can't test a function without a real device/network/clock because it builds those itself.

**Cause:** the function calls `CreateObject("roDateTime")` / makes a request / reads the registry directly.

**Fix:** pass the dependency in as a parameter and inject a fake in the test. See
[Mocks, stubs & spies](/writing-tests/test-doubles).

```brightscript
' hard to test:
function greet(name) : hour = CreateObject("roDateTime").getHours() : ...
' easy to test:
function greet(name, clock) : hour = clock.nowHour() : ...
```

## Asserting too much in one test

**Symptom:** a failing test with ten assertions and you can't tell which behavior broke.

**Fix:** split into focused tests (or a parameterized test). One clear reason to fail per test.

## Not watching a test fail

**Symptom:** a test that "always passes" — including when the code is broken.

**Cause:** the assertion doesn't actually exercise the thing (e.g. asserting a constant).

**Fix:** temporarily break the code or the expectation and confirm the test fails, then restore. A test you
haven't seen fail isn't protecting you. (We did this deliberately in
[Your first test](/writing-tests/first-test).)

## Expecting coverage from the *default* lane

**Symptom:** no coverage numbers from `npx roku-test`.

**Cause:** the default lane skips coverage for speed.

**Fix:** run `npx roku-test --coverage` — coverage + LCOV, no device required. (`--device` also produces
coverage.) See [CI](/guide/ci).

## Comparing a float field to an integer literal

**Symptom:** an assertion fails with `expected "150 (Float)" to equal "150 (Integer)"` even though the
numbers look identical.

**Cause:** Rooibos `assertEqual` is **type-strict**. SceneGraph numeric fields (`opacity`, `width`,
`translation`, padding, any `float` field) come back as floats, and `150.0 <> 150`.

**Fix:** compare floats to float literals — `m.assertEqual(node.opacity, 0.5)`,
`m.assertEqual(t[0], 150.0)`. Values passed via `as float` test params are already floats, so
parameterized tests sidestep this.

## Very long `@it` / `@describe` names

**Symptom:** a test seems to vanish from the results — counts don't add up, and it's neither passed nor
failed.

**Cause:** Rooibos prints results to a fixed-width console line. A very long name pushes the trailing
`(PASS)`/`(FAIL)` marker off the end, so the result parser can't classify it.

**Fix:** keep test names short and to the point. It reads better in reports anyway.

## Surprised the default run boots a scene

**Symptom:** `npx roku-test` is slower than expected on a project that has `@SGNode` specs.

**Cause:** the default lane runs `@SGNode` suites headless (no device), which means booting a SceneGraph
scene. That's slower than the pure SceneGraph-off driver used when there are no node specs.

**Fix:** nothing's wrong — node tests run by default on purpose. For the quickest pure-logic inner loop,
add `--no-sgnode` to skip node suites and use the faster driver. Node behaviour (incl. `onChange`
cascades) is still fully covered by the default/`--coverage`/`--device` runs.
