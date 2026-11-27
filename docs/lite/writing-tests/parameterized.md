# 5. Parameterized tests

::: info At a glance
**What it is for:** running one test's logic over a table of cases.

**You will:**
- Replace copy-pasted tests with `@params` rows
- Map rows to arguments, up to 6 headless

**First file to open:** a spec with near-identical `@it` tests
:::

## The problem they solve

Without parameters, three clamp cases (`clamp(-5, 0, 10)`, `clamp(99, 0, 10)`, `clamp(7, 0, 10)`) need three near-identical `@it` tests. Parameters collapse them into one.

## `@params`

One `@params(...)` line per case; the function takes matching arguments.

```brightscript
@it("clamps a value into [lo, hi]")
@params(-5, 0, 10, 0)
@params(99, 0, 10, 10)
@params(7,  0, 10, 7)
function _(value, lo, hi, expected)
  m.assertEqual(clamp(value, lo, hi), expected)
end function
```

Each row is its own case, and only a failing row is reported:

```
✓ clamps a value into [lo, hi] [-5,0,10,0]
✓ clamps a value into [lo, hi] [99,0,10,10]
✓ clamps a value into [lo, hi] [7,0,10,7]
```

## How arguments map

Values pass positionally, in order. Convention: inputs first, expected last, as in `@params("42", 42)` for `function _(input, expected)`.

## Supported value types

Numbers, strings, booleans, `invalid`, arrays and associative arrays.

```brightscript
@it("detects empty-ish values")
@params("",        true)
@params(invalid,   true)
@params([],        true)
function _(value, expectedEmpty)
  m.assertEqual(isEmptyish(value), expectedEmpty)
end function
```

::: info Headless arity limit
The headless driver passes up to **6** parameters per case. For more (rare), split the test or bundle args into one associative-array parameter.
:::

## When to use them

- **Great for:** pure input→output functions (parsers, formatters, math, validators, edge cases).
- **Avoid for:** cases with very different setup, or many unrelated asserts. Use separate `@it`s.

## Boundary-value tip

Test range boundaries and just outside them:

```brightscript
@it("validates age 0–120")
@params(-1,  false)
@params(0,   true)
@params(120, true)
@params(121, false)
function _(age, valid)
  m.assertEqual(isValidAge(age), valid)
end function
```

## Related

- [Setup & teardown](/writing-tests/setup-teardown): shared setup

**Full guide:** [Parameterized tests](full:/writing-tests/parameterized) — the original wording.
