# 8. SceneGraph & async tests

::: info At a glance
**What it is for:** testing behaviour that only exists inside a real SceneGraph node, and keeping those tests rare.

**You will:**
- run a suite inside a node with `@SGNode`
- wait for async field changes instead of assuming them
- know what brighttest catches when an `@async` case stalls
- extract node logic into pure functions

**First command:** `npx brighttest`
:::

## How it runs

Where `@SGNode` suites run.

| Lane | What runs |
|---|---|
| **Default** (`brighttest`) | `@SGNode` suites headless when the project has them (boots a SceneGraph scene). `--no-sgnode` skips them and uses the faster SceneGraph-off driver, handy for a pure-logic inner loop. |
| **Coverage** (`brighttest --coverage`) | Headless, SceneGraph on. Runs `@SGNode` suites in full: component logic, computed state **and** XML `onChange` cascades. Same node suites as the default lane, plus LCOV. |
| **Device** (`brighttest --device`) | Runs them for real on hardware. |

Two patches brighttest ships make the headless lanes work:

- a [rooibos-roku patch](full:/maintainers#sgnode-headless-patch): node suites complete headless;
- a [brs-node patch](full:/maintainers#brs-node-onchange-patch): `onChange` fires synchronously.

::: tip `autoImportComponentScript` is set for you
brighttest sets this required compiler option. Without it, generated node components do not link their own script and
node tests hang.
:::

Still prefer pure functions tested in the fast default lane. Keep `@SGNode` for UI-coupled behaviour, and treat the
**device lane as the fidelity reference** for render-thread timing.

## What is a SceneGraph (RSG) node?

A UI/component object created from an XML component.

- It has fields, can render, runs code on a separate render thread, and reacts to field changes via observers.
- Node behaviour (rendering, field observation, `createChild`, focus, animations) needs the real Roku runtime; a
  simulator cannot reproduce it faithfully.

::: tip Node tests are headless too, `onChange` observers included
A complex widget (ButtonEx: layout math, key handling, opacity interpolation, **field observers**) cross-checked at
**95/95, 0 divergence**. Both of these work headless in `--coverage`:

- Calling the component's functions/subs, reading/writing fields, pure computation.
- **XML `onChange` cascades:** "set `padding` → all four sides update", "set `text` → the label mirrors it",
  "set `focusPercent` → layers cross-fade".

brs-node normally batches field-change notifications, so `onChange` would not fire mid-test; the
[brs-node patch](full:/maintainers#brs-node-onchange-patch) dispatches them synchronously, like real Roku.
:::

::: warning Still device-only
Behaviour that depends on **real wall-clock render timing**: animations playing out, Task-node I/O, live remote input.
Run [`--cross-check`](/writing-tests/headless-vs-device#verifying-fidelity-cross-check) to confirm both lanes agree for
your component.
:::

## `@SGNode` — running a test inside a node

Annotate the suite with `@SGNode` and the component name. Rooibos hosts the suite inside that node.

```brightscript
namespace tests
  @suite("Hud component")
  @SGNode("Hud")                         ' run these tests inside a Hud node
  class HudTests extends rooibos.BaseTestSuite

    @describe("offset")

    @it("moves the info group when offset changes")
    function _()
      ' m.top is the Hud node instance
      m.top.offset = [20, 0]
      m.assertEqual(m.top.infoGroup.translation[0], 20)
    end function

  end class
end namespace
```

`m.top` is the node under test: set fields, call its functions, assert on its state.

## Observing fields & asynchronous behavior

Node work is often async: a result appears after a render tick, a task, or an observer.

1. Trigger the change.
2. Wait for the field or observer (Rooibos helpers, with a timeout so a stuck test fails instead of hanging).
3. Assert.

The exact helper names and async annotation are in the Rooibos docs and change across versions. The key idea: wait for
an **observable signal**, do not assume immediacy.

```brightscript
@it("loads rows after data arrives")
function _()
    m.top.callFunc("requestData")
    ' wait for m.top.rows to be populated (observer/timeout), then:
    m.assertNotEmpty(m.top.rows)
end function
```

### Stalled `@async` cases

An `@async` case must call `m.done()` before its timeout. If it never does, Rooibos stops the rest of the node suite
and wrongly reports `Total: 0 ... Success`. brighttest compares Rooibos's report tree with the `It:` / `END It:`
markers it streamed, and exits non-zero when:

- a case started but never finished (named "started but never finished"), or
- the report tree lists more cases than Rooibos counted in `Total`.

Every case listed as PASS that never streamed an end marker is reported as failed ("never ran"). Long (truncated) names
and `@params` cases are matched by name prefix and position.

::: warning Not detected
- An `@ignore` case in the stalled node suite, before the stall, looks like a dropped case and is reported as failed.
- A stall where `Total` is at or above the tree size (for example, other suites' `@ignore`d tests inflate it) is caught
  only if the unfinished case streamed its `It:` start marker.
- Two cases whose names share their first 40 characters can be matched to each other's end marker.
:::

## Keep node tests rare — extract the logic

Put little logic in the node. Push decisions into pure functions tested headless; the node wires fields to them.

| Part | Tested in |
|---|---|
| Pure functions | Headless lane ✅ |
| Node (thin shell: fields ↔ pure functions) | Device lane, only if needed |

Instead of computing a layout in `onOffsetChange`:

```brightscript
' pure, headless-testable
function computeInfoTranslation(offset as object) as object
    return [offset[0], 0]
end function
```

The logic gets fast headless tests; a thin device test confirms the node wires the field through.

## Running node tests

```bash
# Headless (no device) — the default run already includes @SGNode suites:
npx brighttest

# Headless + coverage (no device):
npx brighttest --coverage

# On hardware — the fidelity reference for render-thread behavior:
npx brighttest --device --host <roku-ip> --password <dev-pw>
```

- Headless node suites suit CI with no hardware.
- The device lane runs *everything* and is the source of truth for timing-sensitive behaviour.
- In CI, gate the device lane to merges/nightly on a self-hosted runner: see [CI integration](/guide/ci).

## Rule of thumb

| Behavior | Where to test |
|---|---|
| Calculations, parsing, formatting, validation, state transitions | Default headless (pure functions) |
| A node's own functions/subs + computed state (call directly, assert) | Headless `--coverage` or device |
| **`onChange` observer cascades** (set field → handler reacts) | Headless `--coverage` or device |
| Real wall-clock render timing: animations, Task I/O, live remote input | Device (`@SGNode`), the fidelity reference |

::: tip Assert floats against floats
`assertEqual` is **type-strict**: a `float` field (`opacity`, `translation`, `width`, padding) never equals an
`Integer` literal. Write `m.assertEqual(node.opacity, 0.5)` and `translation[0], 150.0`, not `150`. Values bound to
`as float` test params are already floats.
:::

Many node tests usually means logic should move out of nodes.

## Related

- [Headless vs device](/writing-tests/headless-vs-device): the full lane picture
- [Global context](/writing-tests/global-context): widgets that crash on device during `init()`
- [Media state](/writing-tests/media-state): drive `Video` / `Audio` nodes headless
- [CI integration](/guide/ci): gating the device lane

**Full guide:** [SceneGraph & async tests](full:/writing-tests/scenegraph-async) — the original wording.
