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
can dump "all globals" without hand-listing each one. Keep snapshots compact: a hidden Label's `text` was read back intact up to 256 KB on
firmware 16.0.4 (a Roku Ultra), but the read gets slower as it grows (about 27 ms at 1 KB, 850 ms at 256 KB).
Sizes above 256 KB were not tested, so treat that as the practical ceiling. Other models and firmware may differ.

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

**Studio** shows it two ways: a live **State** tab (the inspector, read only for this snapshot) next to Node/Tree/Selector, and — because every run
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

### Instrumented apps: layers and the agent node

An app instrumented with the brighttest agent publishes its state in a hidden node with id
**`__bt_agent`**, split into named **layers**: `global` (`m.global` fields), `scene` (the Scene's
fields) and `focus` (the focus chain). brighttest reads it with `nodes?node-id=__bt_agent` (one small
request, not a full tree walk) and falls back to the full tree if that misses. Apps without the agent
keep working through the `__bt_state` snapshot above.

In Studio, the State tab is an inspector over those layers. A layer the agent had to cut shows a **truncated**
marker, and "+" on a leaf adds an `assertState` step with `layer:` set. With an instrumented build connected to the
hub (it starts while Studio holds the device lease), you can also:

- **Edit in place** in the `global`, `scene` and `registry` layers. The edit is checked like a `setState` flow step and
  an ack chip shows received, applied, reflected, or the error. "+ setState step" adds the edit to the open flow.
- **Save, restore, delete, diff, export and import snapshots.** A snapshot is capped at 64 KB and the store keeps 20.
- See the **history** of edits and restores made in the session, each with its ack phase.

Every state route needs the device lease: while another session holds the device they answer `423` and nothing is
written. Values are **redacted by default**: the agent already masks secret-looking keys with `<redacted:key>`, and Studio
adds the built-in key names plus `instrument.state.redact.paths` from `brighttest.json`. The **show raw** toggle reveals
only what Studio masks on top of the agent's own masking, behind a banner, and makes exports unredacted. A
`<redacted:...>` marker is never a real value, so Studio always refuses to write one; restoring a snapshot skips masked
values and tells you how many. Registry values are edited as a whole `<section>.<key>` value, never a part of one.

`layer` selects one layer; `path` is then relative to it. Without `layer`, the first segment of `path`
is the layer name.

```yaml
- assertState: { layer: scene, path: current, equals: PlayerPanel }
- assertState: { path: global.channel, equals: "Open Cinema" }   # same, layer in the path
```

Three matchers, one per step (`equals` and `contains` are unchanged):

| Matcher | Passes when |
| --- | --- |
| `deepEquals: <value>` | the value at `path` is structurally equal to `<value>` (objects by keys, arrays by order, numbers and booleans typed, not compared as strings) |
| `exists: true` | the key at `path` is present (value not undefined) |
| `exists: false` | the key at `path` is absent |

```yaml
- assertState: { layer: global, path: cfg, deepEquals: { retries: 3, regions: [us, ca] } }
- assertState: { layer: global, path: token, exists: false }
```

A failure says which part was wrong: no state published, layer not found (with the layers that exist),
path not found, or the actual value.

### The `m` layer (a component's own `m`)

`layer: m` reads and writes the `m` of one component, found by `node: { id }`. The build adds a `BT_op` function to
the root of every instrumented component chain (descendants inherit it; nothing is injected twice), and the agent
calls it on the render thread. No new flag: `BT_op` is on by default.

```yaml
- setState: { layer: m, node: { id: homePanel }, path: rowIndex, value: 3 }
```

Rules, all enforced on the device:

- Existing fields only. A missing field fails with `FIELD_NOT_FOUND`; the layer never adds a key to `m`.
- `top`, `global` and any key starting with `__bt` are not reachable (`M_PATH_FORBIDDEN`).
- Every write is type-checked like the other layers (`TYPE_MISMATCH`), and a path never crosses a node reference
  (`PATH_UNDER_NODE`). Reads use the same caps, redaction and 64 KB limit as the other layers.
- A node without `BT_op` (not instrumented, excluded by `instrument.exclude`, or a built-in node) answers
  `M_NOT_AVAILABLE`.
- `m` is read on demand only. It is never in the published `__bt_agent` document or in a `snapshot`, and `restore`
  does not touch it.

Publish rate cap: when the last published document is larger than 16384 bytes, the publish interval is at least
1000 ms (`max(publish.intervalMs, 1000)`), and the agent logs an `agent.rate` event each time it clamps.

### The registry layer

List the registry sections the agent should publish in `brighttest.json`. With no sections configured there
is no `registry` layer, and the other layers are unchanged. The value is an array of section names; entries
that are not strings or are blank are dropped, and the layer appears only when at least one name is left.

```json
"instrument": { "state": { "registrySections": ["prefs"] } }
```

Each configured section is published under `registry.<section>.<key>`. A value that is a JSON object or array
is kept structured; anything else is a string. The agent only reads (`GetKeyList` and `Read`).

```yaml
- assertState: { layer: registry, path: prefs.theme, equals: dark }
- assertState: { path: registry.prefs.watchlist, deepEquals: [a, b] }
```

The layer follows the same limits as the others: caps on depth, array items and string length, and the publish
byte cap (64 KB by default). A section the byte cap cuts is replaced by `$truncated:bytes` and named in the
`truncated` list, never an error. Keys that look secret (`token`, `password`, `secret`, `sessionid`,
`authorization`, `apikey`) are published as `<redacted:key>`.

### Redact paths and publish limits

Three more optional keys under `instrument.state` in `brighttest.json` tune what the agent publishes. Leave a
key out and the agent uses its built-in default.

```json
"instrument": {
  "state": {
    "redact": { "paths": ["scene.profile.email", "registry.prefs.*"] },
    "publish": { "maxBytes": 131072, "intervalMs": 1000 }
  }
}
```

- **`redact.paths`** is an array of strings. A value at a listed path is published as `<redacted:key>`, on top
  of the secret-looking keys that are always redacted. A path starts with the layer name (`global`, `scene`,
  `focus`, `registry`). `a.b.c` matches that path exactly and `a.b.*` matches everything below `a.b`. Matching
  ignores case.
- **`publish.maxBytes`** is an integer, the size at which the agent cuts the published document (default 65536).
  The build accepts 1024 to 1048576.
- **`publish.intervalMs`** is an integer, how often the agent republishes, in milliseconds (default 500). The
  build accepts 100 to 60000.

A value of the wrong type, or an integer outside the ranges above, fails the instrument build, and the error
names the full key, for example
`instrument.state.publish.maxBytes must be an integer from 1024 to 1048576 (got 99)` or
`instrument.state.redact.paths must be an array of strings`. Nothing is coerced. The device-side agent also ignores a non-integer or out-of-range value and uses the default
(`lib/instrument/runtime/source/bt/BT_core.brs`, `BT_pubInt`), but only as a safety net: the build never emits one.

### Callable names

`instrument.state.callable` is an array of callFunc names the `callFunc` write op may run (default none). Each is a plain
identifier of at most 64 characters (a namespaced `x.fn` is written `x_fn`), no duplicates ignoring case, at most 64
names. The build writes them to the device config as `callFuncAllow`; anything else fails the build and names the key.

### The 256 KB limit

The reader accepts at most **256 KB** (262,144 bytes) of published text, the largest size measured to
read back intact on firmware 16.0.4. A larger document fails the step immediately with error code
`STATE_TOO_LARGE`. It is never truncated silently. Shrink what the agent publishes (redact paths,
lower the publish byte cap) instead.

### Matching rules for `equals` and `contains`

Values compare as **strings** (`equals` exact, `contains` substring). A missing snapshot and a missing
path report distinctly, so a failure tells you whether the app published nothing or the path was wrong.

::: tip Field names are lowercased
Roku returns `m.global` field names in lowercase (`lastVerb` → `lastverb`). Use the lowercased form in
`path`, or check what `e2e inspect` prints.
:::

### Writing a dotted path with `setState`

`setState` takes a dot-separated `path` in the chosen `layer` (`global` by default). The first segment is a field
of that layer's node; later segments walk into an object (by key) or an array (by a non-negative integer index):

```yaml
- setState: { layer: global, path: user.tier, value: premium }
- setState: { layer: global, path: cart.items.0.qty, value: 2 }
```

What happens when a segment is missing:

- **Global layer, missing top-level field or missing object key:** it is created, including the intermediate
  objects (`a.b.c` creates `a` and `b` when absent).
- **Other layers (`scene`, `node`, `m`):** a missing top-level field fails with `FIELD_NOT_FOUND`; fields are not added.
- **Array index past the end, or a segment under an array that is not an index:** fails with `BAD_PATH`
  (`no element <segment>`). Arrays are never extended.
- **A segment that lands on a value that is not an object or array:** `PATH_NOT_CONTAINER`. A path that would
  cross a node reference: `PATH_UNDER_NODE` (address that node with `layer: node`).
- An empty path: `BAD_PATH`. A value of the wrong type for an existing field: `TYPE_MISMATCH`.

These are agent-side reasons. In the run they surface as a failed step with the typed code `STATE_CMD_FAILED`,
and the agent's reason is in the message (`setState: BAD_PATH: no element 7 (ack phase reached: received, ...)`).
A path with a missing segment is not a separate state code. In an `ops:` batch every path is checked first and
nothing is applied if one fails; the message names it as `ops[N]`.

### Where the code shows up

A failed state step prints its code first on the failure line, for example
`STATE_ACK_TIMEOUT: setState: no applied ack within 10s (ack phase reached: received)`. When the flow has log
capture, the same code is written as a `code` field in the failure bundle's `error.json`
(`<flow>-failure/error.json`). The field is only present for typed state failures (`STATE_*`); other failures
keep the file as before.

## Headless

The pure unit lane has no SceneGraph, so `__bt_state` doesn't apply there — but the **`@SGNode`** lane
runs real components headless, so the exact same `BTState_publish` convention works with no device. The
streaming sample's `StateProbe` `@SGNode` suite publishes a snapshot and asserts it round-trips — the
same mechanism the device path uses, proven without hardware.
