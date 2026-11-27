# 4. Organizing tests

::: info At a glance
**What it is for:** keeping tests readable and failures easy to locate.

**You will:**
- Nest suites, groups and tests
- Lay out and name spec files
- Focus or skip tests while iterating

**First file to open:** `source/tests/<Thing>.spec.bs`
:::

## The three levels

| Level | What it is |
|---|---|
| **Suite** (`@suite`) | One class per file, named after what it tests (`MathUtilsTests`) |
| **Group** (`@describe`) | A section in a suite, usually per function or behaviour |
| **Test** (`@it`) | One clearly described scenario |

## Multiple groups in one suite

Group by function or behaviour; output prefixes each test with its group.

```brightscript
namespace tests
  @suite("string utils")
  class StringUtilsTests extends rooibos.BaseTestSuite
    @describe("trim")
    @it("removes leading and trailing spaces")
    function _()
      m.assertEqual(trim("  hi  "), "hi")
    end function

    @describe("toTitleCase")
    @it("capitalizes each word")
    function _()
      m.assertEqual(toTitleCase("hello world"), "Hello World")
    end function
  end class
end namespace
```

```
✓ trim > removes leading and trailing spaces
✓ toTitleCase > capitalizes each word
```

## File and folder layout

Keep tests near the code, under a compiled path.

```
source/
├── framework/
│   └── mathutils.brs
└── tests/
    └── MathUtils.spec.bs
```

- One suite per file, named `<Thing>.spec.bs`, one per source module.
- `testsFilePattern` (default `**/*.spec.bs`) discovers any `.spec.bs` under your source globs. No registration.

## Naming that helps future-you

| Level | Name after | Example |
|---|---|---|
| Suite | Module or feature | `@suite("cart pricing")` |
| Group | Function or behaviour | `@describe("applyDiscount")` |
| Test | Scenario and expectation | `@it("caps the discount at 50%")` |

A failure then reads: `cart pricing › applyDiscount › caps the discount at 50%`.

## Skipping and focusing (during development)

`@only` on a test or group runs just that one. `@ignore` skips it.

::: warning Don't commit `@only`
Committed, it makes CI silently skip everything else. Remove it before you push.
:::

## Related

- [Parameterized tests](/writing-tests/parameterized): many inputs, one test

**Full guide:** [Organizing tests](full:/writing-tests/organizing) — the original wording.
