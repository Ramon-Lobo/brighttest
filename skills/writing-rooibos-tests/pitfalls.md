# Common pitfalls — Symptom → Cause → Fix

The mistakes that make Rooibos specs fail to build, silently not run, or falsely pass.

## Spec in the wrong folder → "Use of uninitialized variable"

- **Symptom:** build/run error pointing at your suite class (e.g. `Use of uninitialized variable` at the
  generated `RuntimeConfig`).
- **Cause:** the spec lives outside a compiled path (like a top-level `tests/` folder). Roku only compiles
  `source/` and `components/`, so the suite class is never defined.
- **Fix:** put specs under `source/`, e.g. `source/tests/MyThing.spec.bs`.

## `@it` not attached to its function → test silently missing

- **Symptom:** a test doesn't run, or a build error about a duplicate/unknown function.
- **Cause:** an `@it` (or `@describe`) separated from its function by a blank line or logic, or two `@it`s
  stacked on one function.
- **Fix:** each `@it` must be **immediately** followed by exactly one function.

```brightscript
@it("does the thing")     ' ✅ directly above its function
function _()
  ' ...
end function
```

## `assertEqual` fails on numbers that look equal

- **Symptom:** `expected "2147483647 (Float)" to equal "2147483647 (Double)"`.
- **Cause:** `assertEqual` is type-strict across numeric subtypes (Float vs Double vs Integer).
- **Fix:** when you only care about the value, compare with `=` inside `assertTrue`:

```brightscript
m.assertTrue(value = 2147483647)
```

## Comparing a float field to an integer literal

- **Symptom:** `expected "150 (Float)" to equal "150 (Integer)"` even though the numbers look identical.
- **Cause:** SceneGraph numeric fields (`opacity`, `width`, `translation`, padding, any `float` field) come
  back as floats, and `150.0 <> 150` under type-strict `assertEqual`.
- **Fix:** compare floats to float literals — `m.assertEqual(node.opacity, 0.5)`,
  `m.assertEqual(t[0], 150.0)`. Values passed via `as float` test params are already floats, so
  parameterized tests sidestep this. For a tolerance, a small helper on the suite works well:

```brightscript
function close(actual as float, expected as float, tolerance = 0.01 as float) as boolean
  return Abs(actual - expected) <= tolerance
end function
' ... then: m.assertTrue(m.close(result, 50.0))
```

## Suite name collisions / missing namespace

- **Symptom:** odd build errors when two suites share a class name.
- **Fix:** wrap suites in `namespace tests` (or another namespace) and give each suite class a unique name.

## Tests that depend on each other

- **Symptom:** a test passes alone but fails when the whole suite runs (or vice versa).
- **Cause:** shared mutable state leaking between tests.
- **Fix:** rebuild state in `@beforeEach` so every test starts clean. Never rely on run order.

## Leaving `@only` in committed code

- **Symptom:** CI reports very few tests; most are silently skipped.
- **Cause:** `@only` (a debugging focus aid) left on a test or group.
- **Fix:** remove `@only` before committing. Reserve it for local iteration.

## Un-injectable dependencies (hard-to-test code)

- **Symptom:** you can't test a function without a real device/network/clock because it builds those itself.
- **Cause:** the function calls `CreateObject("roDateTime")`, makes a request, or reads the registry directly.
- **Fix:** pass the dependency in as a parameter and inject a fake in the test.

```brightscript
' hard to test:
function greet(name) : hour = CreateObject("roDateTime").getHours() : ' ...
' easy to test:
function greet(name, clock) : hour = clock.nowHour() : ' ...
```

## Asserting too much in one test

- **Symptom:** a failing test with ten assertions and you can't tell which behavior broke.
- **Fix:** split into focused tests (or a parameterized test). One clear reason to fail per test.

## Not watching a test fail

- **Symptom:** a test that "always passes" — including when the code is broken.
- **Cause:** the assertion doesn't actually exercise the thing (e.g. asserting a constant).
- **Fix:** temporarily break the code or the expectation, confirm the test fails, then restore. A test you
  haven't seen fail isn't protecting you.

## Very long `@it` / `@describe` names

- **Symptom:** a test seems to vanish from results — counts don't add up, and it's neither passed nor failed.
- **Cause:** Rooibos prints results to a fixed-width console line; a very long name pushes the trailing
  `(PASS)`/`(FAIL)` marker off the end, so the parser can't classify it.
- **Fix:** keep test names short and specific.

## Expecting coverage from the default lane

- **Symptom:** no coverage numbers from `brighttest`.
- **Cause:** the default lane skips coverage for speed.
- **Fix:** run `brighttest --coverage` — coverage + LCOV, no device required. (`--device` also produces coverage.)

## Trying to run a `@SGNode` test with `--no-sgnode`

- **Symptom:** a `@SGNode` suite doesn't run.
- **Cause:** `--no-sgnode` uses the fast SceneGraph-off driver, which skips node suites.
- **Fix:** run node suites with the default lane (`brighttest`) or `--coverage` — both boot a scene headless.
  Only add `--no-sgnode` when you deliberately want the quickest pure-logic loop.

## More than 6 parameters in a `@params` case

- **Symptom:** a parameterized case behaves wrong or doesn't receive all its arguments headless.
- **Cause:** brighttest's headless driver passes up to **6** parameters per case.
- **Fix:** split the test, or bundle the arguments into a single associative-array parameter.
