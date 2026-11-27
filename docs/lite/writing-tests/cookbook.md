# 11. Cookbook

::: info At a glance
**What it is for:** copy-paste recipes. All headless-friendly unless noted.

**You will:**
- Copy a recipe
- Rename the functions to yours

**First command:** `npx brighttest`
:::

## Test a pure function

```brightscript
@it("lowercases and hyphenates")
function _()
  m.assertEqual(slugify("Hello World"), "hello-world")
end function
```

## Table-driven cases (many inputs)

```brightscript
@it("rounds to 2 decimals")
@params(1.005, "1.01")
@params(2.5,   "2.50")
function _(input, expected)
  m.assertEqual(money(input), expected)
end function
```

## Test the error / invalid path

```brightscript
m.assertInvalid(factorial(-3))                     ' invalid on bad input
m.assertEqual(asInteger("not a number", 99), 99)   ' default when parsing fails
```

## Test a function with a dependency (inject a fake)

```brightscript
http = { get: function(url) return { status: 200, body: "ok" } end function }
m.assertEqual(fetchStatus("https://example.com", http), 200)
```

## Assert on arrays

```brightscript
out = unique([1, 2, 2, 3, 1])
m.assertEqual(out, [1, 2, 3])
m.assertArrayCount(out, 3)
```

## Assert on associative arrays (maps)

```brightscript
u = buildUser("1|Ada")
m.assertAAHasKeys(u, ["id", "name"])
m.assertAAContainsSubset(u, { id: 1, name: "Ada" })
```

## Fixture shared across tests

```brightscript
@beforeEach
function _()
  m.data = loadFixtureRows()      ' rebuilt fresh for each test
end function
```

## Freeze time with a fake clock

```brightscript
clock = { nowHour: function() return 9 end function }
m.assertEqual(greet("Ada", clock), "Good morning, Ada")
```

## Spy: verify a collaborator was called

See [Mocks, stubs & spies](/writing-tests/test-doubles) for more.

```brightscript
spy = { calls: 0, track: function(n) m.calls = m.calls + 1 end function }
onSelect({ id: 1 }, spy)
m.assertEqual(spy.calls, 1)
```

## Crypto (still headless)

```brightscript
m.assertEqual(toMd5("hello"), "5d41402abc4b2a76b9719d911017c592")
```

## A thin SceneGraph node test (runs headless by default)

This runs headless by default; add `--device` to run it on a device.

```brightscript
@suite("Hud")
@SGNode("Hud")
class HudTests extends rooibos.BaseTestSuite
  @describe("wiring")
  @it("maps offset to translation")
  function _()
    m.top.offset = [20, 0]
    m.assertEqual(m.top.infoGroup.translation[0], 20)
  end function
end class
```

::: tip Prefer a pure function
Extract the calculation into a pure function and test that headless ([SceneGraph & async tests](/writing-tests/scenegraph-async)).
:::

## Number equality that ignores Float vs Double

```brightscript
m.assertTrue(newMath().maxInt = 2147483647)   ' value compare
```

## Related

- [Common mistakes](/writing-tests/mistakes): frequent errors and fixes

**Full guide:** [Cookbook](full:/writing-tests/cookbook) — the original wording.
