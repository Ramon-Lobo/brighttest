# Examples — ready-to-adapt specs

Copy, rename, and edit. Every spec goes in `source/tests/<Thing>.spec.bs`.

## Pure-logic suite

```brightscript
namespace tests
  @suite("framework/easing")
  class EasingTests extends rooibos.BaseTestSuite

    @describe("boundaries")

    @it("linear hits both ends and the midpoint")
    function _()
      m.assertTrue(m.close(easeLinear(0.0, 100.0, 10.0, 0.0), 0.0))
      m.assertTrue(m.close(easeLinear(0.0, 100.0, 10.0, 10.0), 100.0))
      m.assertTrue(m.close(easeLinear(0.0, 100.0, 10.0, 5.0), 50.0))
    end function

    @describe("monotonicity")

    @it("linear increases with time")
    function _()
      a = easeLinear(0.0, 100.0, 10.0, 2.0)
      b = easeLinear(0.0, 100.0, 10.0, 8.0)
      m.assertTrue(b > a)
    end function

    ' float comparison within a tolerance — the answer to type-strict assertEqual on floats
    function close(actual as float, expected as float, tolerance = 0.01 as float) as boolean
      return Abs(actual - expected) <= tolerance
    end function

  end class
end namespace
```

## Parameterized test (`@params`)

One `@params(...)` row per case, passed positionally. Convention: inputs first, expected last. Max **6**
params per case headless.

```brightscript
@it("clamps a value into [lo, hi]")
@params(-5, 0, 10, 0)
@params(99, 0, 10, 10)
@params(7,  0, 10, 7)
function _(value, lo, hi, expected)
  m.assertEqual(clamp(value, lo, hi), expected)
end function
```

Great for boundary/edge cases — test the boundaries and just outside them:

```brightscript
@it("validates age 0-120")
@params(-1,  false)
@params(0,   true)
@params(120, true)
@params(121, false)
function _(age, valid)
  m.assertEqual(isValidAge(age), valid)
end function
```

## Setup & teardown (`@beforeEach` / `@afterEach`)

Rebuild shared state on `m` before every test so tests stay independent.

```brightscript
namespace tests
  @suite("cart")
  class CartTests extends rooibos.BaseTestSuite

    @describe("totals")

    @beforeEach
    function _()
      m.cart = newCart()
      m.cart.add({ sku: "A", price: 100 })
      m.cart.add({ sku: "B", price: 50 })
    end function

    @afterEach
    function _()
      m.cart = invalid
    end function

    @it("sums line items")
    function _()
      m.assertEqual(m.cart.subtotal(), 150)
    end function

    @it("applies a percentage discount")
    function _()
      m.cart.applyDiscount(0.10)
      m.assertEqual(m.cart.subtotal(), 135)
    end function

  end class
end namespace
```

## Test doubles — dependency injection (preferred, always headless)

Pass collaborators in as arguments, then hand the code a fake. This is a stub (canned `nowHour`) and a spy
(`calls`) in a few lines.

```brightscript
namespace tests
  @suite("greeter")
  class GreeterTests extends rooibos.BaseTestSuite

    @describe("greet")

    @it("greets by time of day")
    @params(9,  "Good morning, Ada")
    @params(14, "Good afternoon, Ada")
    @params(20, "Good evening, Ada")
    function _(hour, expected)
      clock = fakeClock(hour)
      m.assertEqual(greet("Ada", clock), expected)
    end function

    @it("reads the clock exactly once")
    function _()
      clock = fakeClock(10)
      greet("Ada", clock)
      m.assertEqual(clock.calls, 1)     ' spy: verify the interaction
    end function

  end class

  function fakeClock(hour as integer) as object
    return {
      _hour: hour
      calls: 0
      nowHour: function() as integer
        m.calls = m.calls + 1
        return m._hour
      end function
    }
  end function
end namespace
```

## Test doubles — Rooibos mocks (when injection isn't practical)

```brightscript
' Stub a method to return a canned value:
m.stubCall(myService.fetch, { ok: true, data: [1, 2, 3] })

' Mock with an expectation, then verify it was called as expected:
mock = m.createMock(myService)
mock.expectCall("save", 1)          ' expect save() called once
doWork(myService)
m.assertMocks()                     ' fails the test if expectations weren't met
```

Global/namespaced-function mocking requires enabling `isGlobalMethodMockingEnabled` in the Rooibos config.
Reach for dependency injection first; use Rooibos mocks for deep call sites or legacy code that calls
globals directly.

## `@SGNode` — testing inside a real node

Annotate the suite with `@SGNode("<ComponentName>")`; `m.top` is the node under test. Set fields, call the
node's functions, assert on node state. Assert floats against float literals.

```brightscript
namespace tests
  ' @SGNode hosts this suite inside a real Brand node (m.top), so init() has run.
  @suite("Brand model")
  @SGNode("Brand")
  class BrandTests extends rooibos.BaseTestSuite

    @describe("hydrate()")

    @it("maps title from json")
    function _()
      hydrate({ id: 5, title: "Showtime" })   ' call the node's own sub directly
      m.assertEqual(m.top.title, "Showtime")
    end function

    @it("startColor wraps hex")
    function _()
      hydrate({ id: 1, startHexColor: "112233" })
      m.assertEqual(m.top.startColor, &h112233ff)
    end function

  end class
end namespace
```

## `@SGNode` — asynchronous behavior

Node work is often async — set a field, a result appears after an observer fires. The pattern is:
**trigger the change, wait for the observable signal, then assert** (with a timeout so a stuck test fails
instead of hanging). Never assume immediacy.

```brightscript
@it("loads rows after data arrives")
function _()
  m.top.callFunc("requestData")
  ' wait for m.top.rows to be populated (observer/timeout), then:
  m.assertNotEmpty(m.top.rows)
end function
```

## Prefer extracting logic over node tests

If a decision lives in a node callback, move it into a pure function and test that headless — leave the node
a thin shell:

```brightscript
' pure — fast, parameterized, headless
function tierForPrice(price as integer) as string
  if price > 100 then return "premium"
  return "standard"
end function

' node stays thin:
sub onPriceChanged()
  m.top.badge = tierForPrice(m.top.price)
end sub
```
