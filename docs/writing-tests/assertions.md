# 3. Assertions

An **assertion** is the check that decides whether a test passes. All assertions are methods on your suite
(inherited from `rooibos.BaseTestSuite`), so you call them as `m.assert…`. If an assertion fails, the test
fails immediately and the rest of that test doesn't run.

Every assertion accepts an optional final `msg` argument — a custom failure message.

## Equality & truth

```brightscript
m.assertEqual(actual, expected)        ' passes if actual = expected (deep compare)
m.assertNotEqual(a, b)                 ' passes if a <> b
m.assertTrue(expr)                     ' passes if expr is true
m.assertFalse(expr)                    ' passes if expr is false
```

`assertEqual` deep-compares arrays and associative arrays, so this works:

```brightscript
m.assertEqual([1, 2, 3], [1, 2, 3])
m.assertEqual({ id: 1, name: "Ada" }, { id: 1, name: "Ada" })
```

::: warning assertEqual is type-strict on numbers
Rooibos distinguishes numeric subtypes. This can fail even though the values look identical:

```
expected "2147483647 (Float)" to equal "2147483647 (Double)"
```

When you only care about the numeric value, compare with a coercing `=` inside `assertTrue`:

```brightscript
m.assertTrue(mathObj.maxInt = 2147483647)   ' value compare, ignores Float vs Double
```
:::

## Invalid / existence

`invalid` is BrightScript's "no value" (like null). These check for it:

```brightscript
m.assertInvalid(value)        ' passes if value is invalid
m.assertNotInvalid(value)     ' passes if value is anything but invalid
```

Use `assertInvalid` to test error paths, e.g. a function that returns `invalid` on bad input.

## Collections — arrays

```brightscript
m.assertArrayContains(array, value)          ' array has value
m.assertArrayNotContains(array, value)       ' array lacks value
m.assertArrayContainsSubset(array, [a, b])   ' array contains all of these
m.assertArrayCount(array, n)                 ' array length = n
m.assertEmpty(arrayOrString)                 ' length 0 / ""
m.assertNotEmpty(arrayOrString)              ' length > 0
```

## Collections — associative arrays (maps)

An **associative array** (AA) is a key→value map, written `{ key: value }`.

```brightscript
m.assertAAHasKey(aa, "id")                   ' aa has this key
m.assertAANotHasKey(aa, "secret")            ' aa lacks this key
m.assertAAHasKeys(aa, ["id", "name"])        ' aa has all these keys
m.assertAAContainsSubset(aa, { id: 1 })      ' aa contains these key/values
```

## Failing on purpose

Sometimes you want to fail explicitly (e.g. a branch that should be unreachable):

```brightscript
if somethingImpossible then
    m.fail("should never get here")
end if
```

## Custom messages

Add a message to explain *why* a check matters — it appears when the test fails:

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

A test can assert several things. The first failure stops the test:

```brightscript
@it("parses a user record")
function _()
    u = parseUser("1|Ada|admin")
    m.assertEqual(u.id, 1)
    m.assertEqual(u.name, "Ada")
    m.assertEqual(u.role, "admin")
end function
```

Prefer a few focused assertions per test over one giant test that checks everything — when a focused test
fails, you immediately know what broke.

Next: how to organize many tests into suites and groups.
