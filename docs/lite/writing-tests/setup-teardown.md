# 6. Setup & teardown

::: info At a glance
**What it is for:** sharing starting state through lifecycle hooks instead of repeating it.

**You will:**
- Build fresh fixtures with `@beforeEach`
- Clean up with `@afterEach`
- Keep tests independent

**First file to open:** a suite whose tests repeat setup
:::

## The hooks

| Hook | Runs | Use for |
|---|---|---|
| `@beforeEach` | before **every** test in the group | Fresh fixtures per test |
| `@afterEach` | after **every** test in the group | Cleanup per test |
| Suite setup | once, before the suite's tests | Expensive one-time prep |
| Suite teardown | once, after the suite's tests | One-time cleanup |

Order: suite setup → (`@beforeEach` → test → `@afterEach`) per test → suite teardown.

## `@beforeEach` / `@afterEach`

Put shared state on `m` in `@beforeEach`; tests read it from `m`.

```brightscript
@describe("totals")

@beforeEach
function _()
  ' fresh cart for each test — no leakage between tests
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
```

The cart is rebuilt per test, so the discount cannot leak into another test.

## Why "each" matters: test isolation

Tests must not depend on each other or on run order. If B passes only because A ran first, the suite is fragile. Prefer `@beforeEach` unless setup is genuinely expensive and read-only.

## Suite-level setup/teardown

For costly, read-only shared state, provide setup/teardown functions and reference them from the suite. Beginners: stick with `@beforeEach`/`@afterEach`, the safest default for most cases.

::: tip Keep hooks small
A large or branching `@beforeEach` means the tests want splitting into groups with simpler setup.
:::

## What `m` holds

Anything set on `m` in a hook is available to that run's tests and later hooks. This is also how you inject fakes ([Mocks, stubs & spies](/writing-tests/test-doubles)).

```brightscript
@beforeEach
function _()
  m.now = 1700000000        ' a fixed timestamp used by several tests
  m.user = { id: 1, name: "Ada" }
end function
```

## Related

- [Mocks, stubs & spies](/writing-tests/test-doubles): inject fakes

**Full guide:** [Setup & teardown](full:/writing-tests/setup-teardown) — the original wording.
