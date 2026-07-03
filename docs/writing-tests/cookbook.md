# 10. Cookbook

Copy-paste recipes for situations you'll hit constantly. Each is headless-friendly unless noted.

## Test a pure function

```brightscript
@describe("slugify")

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
@params(0,     "0.00")
function _(input, expected)
  m.assertEqual(money(input), expected)
end function
```

## Test the error / invalid path

Functions often return `invalid` on bad input — assert that explicitly:

```brightscript
@it("returns invalid for a negative factorial")
function _()
  m.assertInvalid(factorial(-3))
end function

@it("returns a default when parsing fails")
function _()
  m.assertEqual(asInteger("not a number", 99), 99)
end function
```

## Test a function with a dependency (inject a fake)

```brightscript
@it("uses the injected http client")
function _()
  http = { get: function(url) return { status: 200, body: "ok" } end function }
  result = fetchStatus("https://example.com", http)
  m.assertEqual(result, 200)
end function
```

See [Mocks, stubs & spies](/writing-tests/test-doubles) for spying on calls.

## Assert on arrays

```brightscript
@it("dedupes while preserving order")
function _()
  out = unique([1, 2, 2, 3, 1])
  m.assertEqual(out, [1, 2, 3])
  m.assertArrayCount(out, 3)
end function
```

## Assert on associative arrays (maps)

```brightscript
@it("builds a user record with required fields")
function _()
  u = buildUser("1|Ada")
  m.assertAAHasKeys(u, ["id", "name"])
  m.assertAAContainsSubset(u, { id: 1, name: "Ada" })
end function
```

## Fixture shared across tests

```brightscript
@beforeEach
function _()
  m.data = loadFixtureRows()      ' rebuilt fresh for each test
end function

@it("has the expected row count")
function _()
  m.assertArrayCount(m.data, 15)
end function
```

## Freeze time with a fake clock

```brightscript
@it("greets in the morning")
function _()
  clock = { nowHour: function() return 9 end function }
  m.assertEqual(greet("Ada", clock), "Good morning, Ada")
end function
```

## Spy: verify a collaborator was called

```brightscript
@it("logs exactly one analytics event")
function _()
  spy = { calls: 0, track: function(n) m.calls = m.calls + 1 end function }
  onSelect({ id: 1 }, spy)
  m.assertEqual(spy.calls, 1)
end function
```

## Crypto (still headless)

```brightscript
@it("hashes with md5")
function _()
  m.assertEqual(toMd5("hello"), "5d41402abc4b2a76b9719d911017c592")
end function
```

## A thin SceneGraph node test (device lane)

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

Run with `--device`. Prefer extracting the calculation into a pure function and testing *that* headless —
see [SceneGraph & async tests](/writing-tests/scenegraph-async).

## Number equality that ignores Float vs Double

```brightscript
@it("exposes maxInt")
function _()
  m.assertTrue(newMath().maxInt = 2147483647)   ' value compare
end function
```

Next: the mistakes that trip up almost everyone, and how to fix them fast.
