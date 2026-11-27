# 2. Anatomy of a test file

::: info At a glance
**What it is for:** understanding each line of the spec from [Your first test](/writing-tests/first-test).

**You will:**
- Walk the spec in 8 steps
- Learn Arrange-Act-Assert
- See where files go

**First file to open:** `source/tests/MathUtils.spec.bs`
:::

## The spec, numbered

Each `' N` comment matches a step below.

```brightscript
namespace tests                                        ' 1
  @suite("math utils")                                 ' 2
  class MathUtilsTests extends rooibos.BaseTestSuite   ' 3

    @describe("addNumbers")                            ' 4

    @it("adds two positive numbers")                   ' 5
    function _()                                       ' 6
      result = addNumbers(2, 3)                        ' 7
      m.assertEqual(result, 5)                         ' 8
    end function

  end class
end namespace
```

## Walk through it

1. **`namespace tests`**: keeps names from clashing with your project. Optional but recommended: tidy generated names, no collisions between similar class names. <!-- covers: 1. `namespace tests` -->
2. **`@suite("math utils")`**: an annotation the Rooibos build plugin reads. Marks the class as a suite; the string is its name in output and reports. <!-- covers: 2. `@suite("math utils")` -->
3. **`class … extends rooibos.BaseTestSuite`**: the base class supplies assertions (`assertEqual`, `assertTrue`, …) and mocking helpers, called as `m.assert…`. <!-- covers: 3. `class … extends rooibos.BaseTestSuite` -->
4. **`@describe("addNumbers")`**: starts a group; every later `@it` joins it until the next `@describe`. Shown as a prefix (`addNumbers > adds two positive numbers`). A suite can have several. <!-- covers: 4. `@describe("addNumbers")` -->
5. **`@it("adds two positive numbers")`**: one test. Write a specific description that reads as a sentence; it appears in pass/fail output. <!-- covers: 5. `@it("adds two positive numbers")` -->
6. **`function _()`**: the body. Named `_` by convention, since Rooibos finds tests by `@it`, not name. Each `@it` is immediately followed by its function. <!-- covers: 6. `function _()` -->
7. **`result = addNumbers(2, 3)`**: the act step. Headless runs load all `source/` code, so any global function is callable. <!-- covers: 7. `result = addNumbers(2, 3)` -->
8. **`m.assertEqual(result, 5)`**: the assert step, inherited from `BaseTestSuite`. On mismatch it records a helpful failure. Any failing assertion fails the test. <!-- covers: 8. `m.assertEqual(result, 5)` -->

::: info Annotations aren't normal code
The `rooibos-roku` plugin processes `@suite`, `@it`, `@describe` and others at **build time**. Without it they are ignored comments and nothing runs: the "Cannot find name 'rooibos'" error in [Troubleshooting](/guide/troubleshooting).
:::

::: warning One `@it` per function
An `@it` applies only to the function right below it. Never stack two on one function or separate one from its function.
:::

::: tip What is `m`?
`m` is the current object: inside a suite method, your suite. Assertions, fixtures (`m.data = …`) and helpers all hang off `m`.
:::

## The three-part shape (Arrange-Act-Assert)

Almost every test follows this rhythm, which keeps it readable and debuggable.

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

## Where files go

One suite per file, named after what it tests.

```
source/
├── mathutils.brs              ← code under test
└── tests/
    └── MathUtils.spec.bs      ← the suite that tests it
```

## Related

- [Assertions](/writing-tests/assertions): every check

**Full guide:** [Anatomy of a test file](full:/writing-tests/anatomy) — the original wording.
