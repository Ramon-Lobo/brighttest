# 7. Mocks, stubs & spies

::: info At a glance
**What it is for:** testing a unit in isolation by swapping its dependencies (network, clock, registry, other components) for stand-ins.

**You will:**
- Inject a fake (headless, no framework)
- Use Rooibos stubs and mocks when injection is impractical
- Assert on interactions

**First file to open:** a function that reaches for a dependency
:::

## The vocabulary

Test doubles make tests fast, deterministic and headless.

| Double | What it does | Use it to… |
|---|---|---|
| **Stub** | Returns canned values; records nothing | Control what a dependency *returns* |
| **Spy** | Records calls (count, args) | Verify the code *called* it correctly |
| **Mock** | Stub + spy with expectations | Both |
| **Fake** | Lightweight working implementation | Replace something heavy (e.g. an in-memory store) |

## Approach A — Dependency injection (works everywhere, incl. headless)

Pass collaborators in as arguments, then give the code a fake in the test.

```brightscript
' source/greeter.brs
function greet(name as string, clock as object) as string
    hour = clock.nowHour()          ' dependency, not a direct roDateTime call
    if hour < 12 then return "Good morning, " + name
    if hour < 18 then return "Good afternoon, " + name
    return "Good evening, " + name
end function
```

The fake clock stubs `nowHour` and spies with `calls`:

```brightscript
@it("greets by time of day")
@params(9,  "Good morning, Ada")
@params(20, "Good evening, Ada")
function _(hour, expected)
  m.assertEqual(greet("Ada", fakeClock(hour)), expected)
end function

@it("reads the clock exactly once")
function _()
  clock = fakeClock(10)
  greet("Ada", clock)
  m.assertEqual(clock.calls, 1)     ' spy: verify the interaction
end function

' inside namespace tests, outside the class
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
```

::: tip Design for injection
Direct calls to `CreateObject("roDateTime")`, the network or the registry are hard to test. Pass them in as parameters or a small `deps` object: testable code is injectable code.
:::

## Approach B — Rooibos mocks & stubs

Rooibos replaces functions on objects without threading dependencies through.

```brightscript
m.stubCall(myService.fetch, { ok: true, data: [1, 2, 3] })   ' canned return

mock = m.createMock(myService)
mock.expectCall("save", 1)          ' expect save() called once
doWork(myService)
m.assertMocks()                     ' fails if expectations weren't met
```

It also supports argument matching and call counts. To mock global or namespaced functions, enable `isGlobalMethodMockingEnabled` in the Rooibos config.

::: warning The API evolves
Check the Rooibos docs for the exact API.
:::

## Which approach to choose

- **Dependency injection first:** explicit, framework-agnostic, fast, always headless.
- **Rooibos mocks** when injecting is impractical (deep call sites, legacy code calling globals) or an interaction is awkward to observe otherwise.

## Verifying interactions, not just outputs

When the behaviour is "did it call the API with the right payload?", assert on a spy:

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

## Related

- [SceneGraph & async tests](/writing-tests/scenegraph-async): node tests, also headless

**Full guide:** [Mocks, stubs & spies](full:/writing-tests/test-doubles) — the original wording.
