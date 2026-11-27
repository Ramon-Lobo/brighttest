# 3. Assertions

::: info At a glance
**What it is for:** every `m.assert*` method.

**You will:**
- Pick the right assertion
- Avoid the Float vs Double trap
- Add failure messages

**First file to open:** any `*.spec.bs`
:::

## How assertions behave

They are inherited from `rooibos.BaseTestSuite` and called as `m.assert…`. A failure stops the test immediately. Every one takes an optional final `msg`: a custom failure message.

## Equality & truth

`assertEqual` deep-compares arrays and associative arrays.

```brightscript
m.assertEqual(actual, expected)        ' actual = expected (deep)
m.assertNotEqual(a, b)                 ' a <> b
m.assertTrue(expr)
m.assertFalse(expr)
m.assertEqual({ id: 1, name: "Ada" }, { id: 1, name: "Ada" })   ' passes
```

::: warning assertEqual is type-strict on numbers
Numeric subtypes differ, so this can fail: `expected "2147483647 (Float)" to equal "2147483647 (Double)"`. For value-only checks use `m.assertTrue(mathObj.maxInt = 2147483647)`.
:::

## Invalid / existence

`invalid` is BrightScript's null. Use these for error paths, such as a function returning `invalid` on bad input.

```brightscript
m.assertInvalid(value)
m.assertNotInvalid(value)
```

## Collections — arrays

```brightscript
m.assertArrayContains(array, value)
m.assertArrayNotContains(array, value)
m.assertArrayContainsSubset(array, [a, b])   ' contains all of these
m.assertArrayCount(array, n)                 ' length = n
m.assertEmpty(arrayOrString)                 ' length 0 / ""
m.assertNotEmpty(arrayOrString)              ' length > 0
```

## Collections — associative arrays (maps)

An associative array (AA) is a key→value map, `{ key: value }`.

```brightscript
m.assertAAHasKey(aa, "id")
m.assertAANotHasKey(aa, "secret")
m.assertAAHasKeys(aa, ["id", "name"])        ' all these keys
m.assertAAContainsSubset(aa, { id: 1 })      ' these key/values
```

## Failing on purpose

For an unreachable branch: `m.fail("should never get here")`.

## Custom messages

The message explains why the check matters when it fails:

```brightscript
m.assertEqual(user.role, "admin", "first seeded user must be an admin")
```

## Choosing the right assertion

| You want to check… | Use |
|---|---|
| Two values are equal | `assertEqual` (value-only numbers → `assertTrue(a = b)`) |
| A boolean condition | `assertTrue` / `assertFalse` |
| A function returned "nothing" | `assertInvalid` / `assertNotInvalid` |
| An item is in a list | `assertArrayContains` |
| A list has N items | `assertArrayCount` |
| A map has a field | `assertAAHasKey` / `assertAAHasKeys` |
| A map contains specific field values | `assertAAContainsSubset` |
| Something is empty | `assertEmpty` / `assertNotEmpty` |

## Multiple assertions per test

The first failure stops the test. Prefer a few focused assertions per test over one giant test, so a failure points at what broke.

```brightscript
@it("parses a user record")
function _()
    u = parseUser("1|Ada|admin")
    m.assertEqual(u.id, 1)
    m.assertEqual(u.role, "admin")
end function
```

## Related

- [Cookbook](/writing-tests/cookbook): assertion recipes

**Full guide:** [Assertions](full:/writing-tests/assertions) — the original wording.
