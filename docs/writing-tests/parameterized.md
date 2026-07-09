# 5. Parameterized tests

Often you want to run the *same* test logic over many input/output pairs. Copy-pasting the test for each
case is tedious and noisy. **Parameterized tests** let you write the logic once and supply a table of cases.

## The problem they solve

Without parameters, you'd write:

```brightscript
@it("clamps below the range") 
function _()
  m.assertEqual(clamp(-5, 0, 10), 0)
end function

@it("clamps above the range")
function _()
  m.assertEqual(clamp(99, 0, 10), 10)
end function

@it("leaves values in range")
function _()
  m.assertEqual(clamp(7, 0, 10), 7)
end function
```

Three near-identical tests. Parameters collapse them into one.

## `@params`

Add one `@params(...)` line per case, and give the function matching arguments:

```brightscript
@it("clamps a value into [lo, hi]")
@params(-5, 0, 10, 0)
@params(99, 0, 10, 10)
@params(7,  0, 10, 7)
function _(value, lo, hi, expected)
  m.assertEqual(clamp(value, lo, hi), expected)
end function
```

Each `@params` row becomes its **own** test case. Output:

```
✓ clamps a value into [lo, hi] [-5,0,10,0]
✓ clamps a value into [lo, hi] [99,0,10,10]
✓ clamps a value into [lo, hi] [7,0,10,7]
```

If one row fails, only that row is reported — you see exactly which input broke.

## How arguments map

The values in `@params(...)` are passed positionally to the function parameters, in order. A common
convention is "inputs first, expected result last":

```brightscript
@params("42", 42)      ' input "42" → expected 42
@params("7",  7)
function _(input, expected)
  m.assertEqual(asInteger(input), expected)
end function
```

## Supported value types

Params can be numbers, strings, booleans, `invalid`, arrays, and associative arrays:

```brightscript
@it("detects empty-ish values")
@params("",        true)
@params("x",       false)
@params(invalid,   true)
@params([],        true)
function _(value, expectedEmpty)
  m.assertEqual(isEmptyish(value), expectedEmpty)
end function
```

::: info Headless arity limit
brighttest's headless driver passes up to **6** parameters per case. If you need more (rare), split the
test or bundle args into a single associative-array parameter.
:::

## When to use them

- **Great for:** pure functions with clear input→output pairs (parsers, formatters, math, validators,
  boundary/edge cases).
- **Avoid for:** tests whose setup differs a lot between cases, or that assert many unrelated things — those
  read better as separate `@it`s.

## Boundary-value tip

Parameterized tests shine for edge cases. For a function operating on a range, test the boundaries and just
outside them:

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

Next: sharing setup across tests with lifecycle hooks.
