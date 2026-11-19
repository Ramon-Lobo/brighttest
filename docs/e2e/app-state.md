# App state

Read an app's own state — `m.global`, screen, registry-backed values, anything — over ECP, and assert
on it in flows.

## Why this needs a convention

Roku's ECP only serializes a node's **built-in** attributes (`bounds`, `visible`, `text`, `uri`, …).
It does **not** expose `m.global`, custom interface fields, or component `m.` locals — so there's no way
to read app state directly off a device. `e2e inspect` on a running channel confirms this: you see the
render tree's visual fields and nothing of the app's own model.

The one opening: a node's `text` **is** serialized. So an app that wants its state inspectable mirrors a
JSON snapshot into a hidden node with the well-known id **`__bt_state`**. brighttest finds that node,
parses its text, and surfaces it everywhere below. The app decides what to publish — this is opt-in and
costs nothing when nobody's looking.

## Publishing state from the app

Include a tiny helper and call it whenever state changes. The streaming sample ships
[`BTState.brs`](https://github.com/Ramon-Lobo/brighttest/blob/main/examples/streaming-app/source/lib/BTState.brs):

```brightscript
' Mirror a JSON snapshot into a hidden __bt_state Label under `parent`.
sub BTState_publish(parent as object, snapshot as object)
    node = parent.findNode("__bt_state")
    if node = invalid
        node = parent.createChild("Label")
        node.id = "__bt_state"
        node.visible = false
    end if
    node.text = FormatJson(snapshot)
end sub
```

Then, from your scene, publish whatever you want to see:

```brightscript
sub publishState()
    BTState_publish(m.top, {
        current: m.current,               ' which screen is mounted
        global: BTState_scalars(m.global) ' all scalar m.global values
        watchlist: loadWatchlist()        ' registry-backed state
    })
end sub
```

`BTState_scalars(node)` collects a node's scalar fields (string/number/boolean) into a plain map, so you
can dump "all globals" without hand-listing each one. Keep snapshots compact — very large `text` can be
truncated by the device's sgnodes serializer.

## Reading it

**`e2e inspect`** prints an **App state** block when the app publishes one:

```bash
npx brighttest e2e inspect --host <ip> --app dev
```

```
App state (__bt_state)
  {
    "current": "HomePanel",
    "global": { "channel": "Open Cinema", "lastverb": "search", "titlecount": 7 },
    "watchlist": [ { "id": "tears-of-steel", "position": 1, "length": 734 } ]
  }
```

**Studio** shows it two ways: a live **State** tab next to Node/Tree/Selector, and — because every run
frame captures the snapshot — an *App state at this step* panel in the run trace, so you can scrub the
timeline and watch state change step by step.

## Asserting it in flows

`assertState` reads the published snapshot and checks a value at a dot-separated `path` (array indices
included). Like the other assertions it polls until it matches or the step timeout elapses.

```yaml
- assertState: { path: current, equals: PlayerPanel }
- assertState: { path: global.channel, equals: "Open Cinema" }
- assertState: { path: watchlist.0.id, contains: steel }
```

Values compare as **strings** (`equals` exact, `contains` substring). A missing snapshot and a missing
path report distinctly, so a failure tells you whether the app published nothing or the path was wrong.

::: tip Field names are lowercased
Roku returns `m.global` field names in lowercase (`lastVerb` → `lastverb`). Use the lowercased form in
`path`, or check what `e2e inspect` prints.
:::

## Headless

The pure unit lane has no SceneGraph, so `__bt_state` doesn't apply there — but the **`@SGNode`** lane
runs real components headless, so the exact same `BTState_publish` convention works with no device. The
streaming sample's `StateProbe` `@SGNode` suite publishes a snapshot and asserts it round-trips — the
same mechanism the device path uses, proven without hardware.
