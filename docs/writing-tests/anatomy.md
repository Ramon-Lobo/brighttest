# 2. Anatomy of a test file

Let's dissect the spec from the last page, one piece at a time.

```brightscript
namespace tests                                   // 1
  @suite("math utils")                            // 2
  class MathUtilsTests extends rooibos.BaseTestSuite   // 3

    @describe("addNumbers")                        // 4

    @it("adds two positive numbers")               // 5
    function _()                                    // 6
      result = addNumbers(2, 3)                     // 7
      m.assertEqual(result, 5)                      // 8
    end function

  end class
end namespace
```

## 1. `namespace tests`

A **namespace** groups names so they don't clash with the rest of your project. Test suites conventionally
live in a `tests` namespace. It's optional but recommended — it keeps generated names tidy and avoids
collisions if two suites have similar class names.

## 2. `@suite("math utils")`

`@suite` is an **annotation** — a special comment-like marker the Rooibos build plugin reads. It declares
"the class below is a test suite," and the string is its human-readable name (shown in output and reports).

::: info Annotations aren't normal code
`@suite`, `@it`, `@describe`, etc. are processed at **build time** by the `rooibos-roku` plugin, which
rewrites your class into a runnable suite. If the plugin isn't active, they're just ignored comments and
nothing runs — that's the cause of the "Cannot find name 'rooibos'" error in
[Troubleshooting](/guide/troubleshooting).
:::

## 3. `class … extends rooibos.BaseTestSuite`

Your suite is a **class** that extends `rooibos.BaseTestSuite`. That base class is where all the
assertion methods (`assertEqual`, `assertTrue`, …) and mocking helpers come from. Because you extend it,
those methods are available inside your tests as `m.assert…`.

## 4. `@describe("addNumbers")`

`@describe` starts a **group** — a labelled section of related tests. Every `@it` *after* a `@describe`
belongs to that group until the next `@describe`. Groups are purely organizational; they show up in output
as a prefix (`addNumbers > adds two positive numbers`). You can have several `@describe` blocks in one suite.

## 5. `@it("adds two positive numbers")`

`@it` marks a single **test** and gives it a description. Good descriptions read like a sentence:
"it *adds two positive numbers*." The description is what you'll see in pass/fail output, so make it
specific.

## 6. `function _()`

The test body is a function. By convention it's named `_` (underscore) because the *name* doesn't matter —
Rooibos identifies the test by its `@it` annotation, not the function name. Every `@it` is immediately
followed by its function.

::: warning One `@it` per function
Each `@it` annotation applies to exactly the function right below it. Don't put two `@it`s on one function
or an `@it` far from its function.
:::

## 7. `result = addNumbers(2, 3)`

The **act** step: call the code under test with known inputs. Here we call the real `addNumbers` function
from `source/mathutils.brs`. Inside a headless run, all your `source/` code is loaded, so you can call any
global function directly.

## 8. `m.assertEqual(result, 5)`

The **assert** step. `m` is the suite instance (your class), so `m.assertEqual` is the method inherited
from `BaseTestSuite`. It checks `result` equals `5`; if not, it records a failure with a helpful message
and the test fails. A test can have several assertions — if any fails, the test fails.

::: tip What is `m`?
In BrightScript, `m` is the "current object." Inside a suite method, `m` is your suite instance, which is
why assertions, fixtures you set (`m.data = …`), and helpers are all reached through `m`.
:::

## The three-part shape (Arrange-Act-Assert)

Almost every test follows this rhythm:

```brightscript
@it("describes the scenario")
function _()
    ' Arrange: set up inputs / state
    input = { id: 1, name: "Ada" }

    ' Act: run the code under test
    result = formatUser(input)

    ' Assert: check the outcome
    m.assertEqual(result, "Ada (#1)")
end function
```

Keeping tests in this shape makes them easy to read and easy to debug when they fail.

## Where files go

```
source/
├── mathutils.brs              ← code under test
└── tests/
    └── MathUtils.spec.bs      ← the suite that tests it
```

One suite per file is the norm, named after what it tests. Next: the full set of assertions you can use.
