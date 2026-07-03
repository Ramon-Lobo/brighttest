# 7. Mocks, stubs & spies

To test a unit **in isolation**, you replace its real dependencies (network, clock, registry, other
components) with stand-ins you control. These stand-ins are called **test doubles**. This is what lets a
test be fast, deterministic, and headless.

## The vocabulary

| Double | What it does | You use it to… |
|---|---|---|
| **Stub** | Returns canned values; doesn't record calls | Control what a dependency *returns* |
| **Spy** | Records how it was called (count, args) | Verify the code *called* a dependency correctly |
| **Mock** | A stub + spy with expectations | Both control returns and assert the interaction |
| **Fake** | A lightweight working implementation | Replace something heavy (e.g. an in-memory store) |

## Approach A — Dependency injection (works everywhere, incl. headless)

The simplest, most portable technique: **pass dependencies in** instead of reaching for globals, then hand
the code a fake in the test. No framework needed, and it runs headless.

Code written for testability takes its collaborators as arguments:

```brightscript
' source/greeter.brs
function greet(name as string, clock as object) as string
    hour = clock.nowHour()          ' dependency, not a direct roDateTime call
    if hour < 12 then return "Good morning, " + name
    if hour < 18 then return "Good afternoon, " + name
    return "Good evening, " + name
end function
```

The test supplies a **fake clock** — which doubles as a **spy** by counting calls:

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

  ' a fake that returns a fixed hour and records how many times it was asked
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

That's a stub (canned `nowHour`) and a spy (`calls`) in a few lines — and it runs in the headless lane.

::: tip Design for injection
If a function reaches directly for `CreateObject("roDateTime")`, a network call, or the registry, it's hard
to test. Pass those in as parameters (or via a small `deps` object). Testable code and injectable code are
the same thing.
:::

## Approach B — Rooibos mocks & stubs

Rooibos can replace functions on objects (and, with configuration, global/namespaced functions) without you
threading dependencies through. Typical shapes:

```brightscript
' Stub a method to return a canned value:
m.stubCall(myService.fetch, { ok: true, data: [1, 2, 3] })

' Mock with an expectation, then verify it was called as expected:
mock = m.createMock(myService)
mock.expectCall("save", 1)          ' expect save() called once
doWork(myService)
m.assertMocks()                     ' fails the test if expectations weren't met
```

Rooibos also supports argument matching and call counts. For global/namespaced function mocking you enable
`isGlobalMethodMockingEnabled` in the Rooibos config — see the Rooibos docs for specifics, as the exact API
evolves.

## Which approach to choose

- Reach for **dependency injection** first. It's explicit, framework-agnostic, fast, and always headless.
- Use **Rooibos mocks** when injecting isn't practical (e.g. deep call sites, legacy code that calls globals
  directly) or when you specifically want to assert an interaction that's awkward to observe otherwise.

## Verifying interactions, not just outputs

Sometimes the *behavior* you care about is "did it call the API with the right payload?" — not a return
value. That's a **spy/mock** assertion:

```brightscript
@it("sends the item id to analytics")
function _()
  analytics = { events: [], track: function(name, props)
      m.events.push({ name: name, props: props })
    end function }
  selectItem({ id: 42 }, analytics)
  m.assertEqual(analytics.events[0].props.id, 42)
end function
```

Next: the one category that can't run headless — SceneGraph and async node tests.
