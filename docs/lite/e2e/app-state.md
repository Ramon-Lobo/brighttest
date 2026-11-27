# App state

::: info At a glance
**What it is for:** reading an app's own state (`m.global`, screen, registry values, anything) over ECP and asserting
on it in flows.

**You will:**
- Publish a state snapshot from the app
- Read it in `e2e inspect` and Studio
- Assert on it with `assertState`, layers and matchers
- Write state with `setState`, snapshots and `callFunc`

**First file to open:** [`BTState.brs`](https://github.com/Ramon-Lobo/brighttest/blob/main/examples/streaming-app/source/lib/BTState.brs)
:::

## Why this needs a convention

ECP serializes only a node's **built-in** attributes (`bounds`, `visible`, `text`, `uri`, …).

- It does **not** expose `m.global`, custom interface fields or component `m.` locals. `e2e inspect` shows the render
  tree's visual fields and nothing of the app's model.
- The opening: a node's `text` **is** serialized. An app mirrors a JSON snapshot into a hidden node with id
  **`__bt_state`**; brighttest finds it, parses its text and surfaces it everywhere below.
- Opt-in: the app decides what to publish, and it costs nothing when nobody looks.

## Publishing state from the app

Include the helper from the streaming sample and call it whenever state changes.

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

sub publishState()
    BTState_publish(m.top, {
        current: m.current,               ' which screen is mounted
        global: BTState_scalars(m.global) ' all scalar m.global values
        watchlist: loadWatchlist()        ' registry-backed state
    })
end sub
```

`BTState_scalars(node)` collects a node's scalar fields (string/number/boolean) into a map, so you can dump "all
globals" without listing each.

::: warning Keep snapshots compact
A hidden Label's `text` read back intact up to 256 KB on firmware 16.0.4 (a Roku Ultra), but reads slow as it grows
(about 27 ms at 1 KB, 850 ms at 256 KB). Above 256 KB was not tested: treat it as the ceiling. Other models and
firmware may differ.
:::

## Reading it

Two places show the published state.

- **`e2e inspect`** prints an **App state** block: `npx brighttest e2e inspect --host <roku-ip> --app dev`

  ```
  App state (__bt_state)
    {
      "current": "HomePanel",
      "global": { "channel": "Open Cinema", "lastverb": "search", "titlecount": 7 },
      "watchlist": [ { "id": "tears-of-steel", "position": 1, "length": 734 } ]
    }
  ```

- **Studio**: a live **State** tab (read-only for this snapshot) next to Node/Tree/Selector, and, since every run
  frame captures the snapshot, an *App state at this step* panel in the run trace to scrub step by step.

## Asserting it in flows

`assertState` checks a value at a dot-separated `path` (array indices included) and polls until match or step
timeout.

```yaml
- assertState: { path: current, equals: PlayerPanel }
- assertState: { path: global.channel, equals: "Open Cinema" }
- assertState: { path: watchlist.0.id, contains: steel }
```

### Hiding values in failure messages (redaction)

A failed `assertState` prints the actual value (`got "..."`) by default. Turn redaction on when an agent drives the
run and output lands in traces or transcripts.

- The value becomes `<redacted:key>` in the failure message and step detail when the path has a sensitive segment
  (`token`, `secret`, `password`, `passwd`, `session`, `auth`, `cookie`, `apikey`, `api_key`) or matches
  `instrument.state.redact.paths` (`*` = one segment).
- Case is ignored. Array elements are `list[1]` or `list.1`; printing the array or parent shows `<redacted:1>`. A
  value that only contains such keys is scrubbed inside.

Turn it on with any of these; the first one set wins, highest first:

| Setting | Where |
| --- | --- |
| runner option `redactState` | programmatic runs only; no CLI flag yet |
| `BRIGHTTEST_REDACT_STATE=1` | environment |
| `config: { redactState: true }` | the flow file |
| `"redactState": true` | `brighttest.json` |

::: warning Edge cases
- `false`, `0`, `no` or `off` at a higher level turns it off; any other non-empty value (even a typo) turns it on.
- `runFlow` subflows inherit it. A subflow's own `config: { redactState: true }` turns it on for itself even when the
  runner option is false; a subflow can never turn it off once the parent has it on.
- It covers `assertState` text only, not screenshots, log tails or `assertField` output.
:::

### Instrumented apps: layers and the agent node

An app built with the brighttest agent publishes state in hidden node **`__bt_agent`**, split into **layers**.

| Layer | Contents |
|---|---|
| `global` | `m.global` fields |
| `scene` | the Scene's fields |
| `focus` | the focus chain |
| `registry` | configured sections ([below](#the-registry-layer)) |

brighttest reads it with `nodes?node-id=__bt_agent` (one small request, not a full tree walk) and falls back to the
full tree on a miss. Apps without the agent keep using `__bt_state`.

**Studio State tab with layers**

- A layer the agent cut shows a **truncated** marker; "+" on a leaf adds an `assertState` step with `layer:`.
- With an instrumented build connected to the hub (it starts while Studio holds the lease) you can also:
  - **Edit in place** in `global`, `scene` and `registry`, checked like `setState`. An ack chip shows received,
    applied, reflected or the error. "+ setState step" adds the edit to the open flow.
  - **Save, restore, delete, diff, export and import snapshots** (64 KB cap, 20 kept).
  - See the session **history** of edits and restores, each with its ack phase.

::: warning Lease and redaction in Studio
- Every state route needs the device lease; otherwise it answers `423` and writes nothing.
- **Redacted by default**: the agent masks secret-looking keys as `<redacted:key>`; Studio adds the built-in key names
  plus `instrument.state.redact.paths`.
- A wrapped dispatch's payloads are masked on the device before sending, so `?raw=1` no longer shows them (rebuild the
  instrumented app for this).
- **show raw** reveals only Studio's extra masking, behind a banner, and makes exports unredacted.
- Studio never writes a `<redacted:...>` marker; a restore skips masked values and says how many. Registry values are
  edited as a whole `<section>.<key>` value.
:::

::: details Where else masking applies
- The read-only State view (hub held, absent or connecting), the `/api/tree` node list and saved run traces are masked
  the same way, including traces from earlier versions when loaded or served.
- An `assertState` failure message can still contain the asserted value (tracked separately).
- Published text that cannot be masked (not JSON, or wrong shape) shows as `<redacted:text>` in the node list.
  Invalid `__bt_state` JSON shows no state plus `invalid JSON`; parse errors do not quote the input.
- For legacy `__bt_state`, `instrument.state.redact.paths` match from the state root with no layer prefix
  (`user.name`, not `global.user.name`).
:::

**Mask path syntax** (`instrument.state.redact.paths`, for Studio, the hub and `assertState` messages)

- First segment is the layer (`global`, `scene`, `focus`, `registry`, `task`), as in `global.user.email`; a leading
  `layers.` is accepted.
- Case-insensitive. On the host, `*` (or `[*]`) is one segment. Array elements: `list[0]` or `list.0`
  (`global.cart.items[1].price`), shown as `<redacted:1>`.

::: warning Host and device differ on `*`
The device agent treats a trailing `.*` as everything below the path; the host treats `*` as exactly one segment. So
`global.*.email` differs between them: use explicit paths when both matter.
:::

**Layer selection and matchers**

`layer` picks a layer and `path` is relative to it; without `layer`, the first path segment is the layer.

```yaml
- assertState: { layer: scene, path: current, equals: PlayerPanel }
- assertState: { path: global.channel, equals: "Open Cinema" }   # same, layer in the path
- assertState: { layer: global, path: cfg, deepEquals: { retries: 3, regions: [us, ca] } }
- assertState: { layer: global, path: token, exists: false }
```

One matcher per step:

| Matcher | Passes when |
| --- | --- |
| `equals` / `contains` | string exact / substring ([rules](#matching-rules-for-equals-and-contains)) |
| `deepEquals: <value>` | structurally equal (objects by keys, arrays by order, numbers and booleans typed, not strings) |
| `exists: true` / `exists: false` | key at `path` present (not undefined) / absent |

A failure names the problem: no state published, layer not found (listing the layers that exist), path not found, or
the actual value.

### The `m` layer (a component's own `m`)

`layer: m` reads and writes one component's `m`, found by `node: { id }`.

```yaml
- setState: { layer: m, node: { id: homePanel }, path: rowIndex, value: 3 }
```

The build adds `BT_op` to the root of every instrumented component chain (descendants inherit it, nothing is injected
twice), and the agent calls it on the render thread. On by default; no flag. Rules enforced on the device:

| Rule | Code |
|---|---|
| Existing fields only; never adds a key | `FIELD_NOT_FOUND` |
| `top`, `global`, keys starting with `__bt` unreachable | `M_PATH_FORBIDDEN` |
| Writes type-checked | `TYPE_MISMATCH` |
| Path never crosses a node reference | `PATH_UNDER_NODE` |
| Node without `BT_op` (not instrumented, in `instrument.exclude`, or built-in) | `M_NOT_AVAILABLE` |

- Reads use the same caps, redaction and 64 KB limit as other layers.
- `m` is read on demand only: never in the published `__bt_agent` document or a `snapshot`, and `restore` skips it.

#### Asserting a node's fields or `m`

`assertState` accepts `layer: node` or `layer: m` with `node: { id }` (refused for other layers).

```yaml
- assertState: { layer: node, node: { id: hero }, path: opacity, equals: 1 }
- assertState: { layer: m, node: { id: homePanel }, path: rowIndex, equals: 3 }
- assertState: { layer: node, node: { id: hero }, path: text, exists: true }
```

- It asks the agent through the hub (`get`): needs an instrumented build and `e2e run` with the hub up (such a step
  starts it). It polls like other `assertState` forms; all four matchers work.
- A masked value (`<redacted:key>`) cannot be compared: `equals`, `contains`, `deepEquals` fail saying it is masked,
  without printing it. `exists` still works.
- A missing field or node counts as absent (`exists: false` passes). Refusals like `M_NOT_AVAILABLE` fail at once; no
  hub fails with `STATE_NO_HUB`.
- In Studio, the Node tab's State view has **+ assert** on each plain value.

::: tip Publish rate cap
When the last document exceeds 16384 bytes, the publish interval is at least 1000 ms (`max(publish.intervalMs, 1000)`).
The agent logs one `agent.rate` event when clamping starts (real period; `docChars` is the label's character count,
not bytes).
:::

### The registry layer

List the sections to publish in `brighttest.json`:

```json
"instrument": { "state": { "registrySections": ["prefs"] } }
```

- No sections, no `registry` layer (others unchanged). Non-string or blank entries are dropped; the layer appears only
  if a name is left.
- Published as `registry.<section>.<key>`. JSON objects and arrays stay structured; anything else is a string.
- Read-only on the device (`GetKeyList` and `Read`).

```yaml
- assertState: { layer: registry, path: prefs.theme, equals: dark }
- assertState: { path: registry.prefs.watchlist, deepEquals: [a, b] }
```

Same limits as other layers (depth, array items, string length, publish byte cap, 64 KB by default). A section the
byte cap cuts becomes `$truncated:bytes` and is listed in `truncated`, never an error. Secret-looking keys (`token`,
`password`, `secret`, `sessionid`, `authorization`, `apikey`) publish as `<redacted:key>`.

### Redact paths and publish limits

Optional keys under `instrument.state`; leave one out for the agent's default.

```json
"instrument": {
  "state": {
    "redact": { "paths": ["scene.profile.email", "registry.prefs.*"] },
    "publish": { "maxBytes": 131072, "intervalMs": 1000 }
  }
}
```

| Key | Type | Default | Build accepts |
|---|---|---|---|
| `redact.paths` | array of strings | none | layer-prefixed paths |
| `publish.maxBytes` | integer, cut size | 65536 | 1024 to 1048576 |
| `publish.intervalMs` | integer, republish ms | 500 | 100 to 60000 |

- `redact.paths` values publish as `<redacted:key>`, on top of always-redacted keys. Paths start with `global`,
  `scene`, `focus`, `registry` or `task`; `a.b.c` is exact, `a.b.*` is everything below (device agent; the host treats
  `*` as one segment). Case-insensitive. Elements are `a.list[0]` or `a.list.0`; `a.list[1]` masks one (`<redacted:1>`),
  `a.list.*` masks all.
- A wrong type or out-of-range value fails the instrument build, naming the key, for example
  `instrument.state.publish.maxBytes must be an integer from 1024 to 1048576 (got 99)` or
  `instrument.state.redact.paths must be an array of strings`. Nothing is coerced.
- The agent also ignores bad values and uses the default (`lib/instrument/runtime/source/bt/BT_core.brs`,
  `BT_pubInt`), only as a safety net.

### Callable names

`instrument.state.callable` lists the callFunc names the `callFunc` write op may run (default none).

- Plain identifiers, at most 64 characters (namespaced `x.fn` is written `x_fn`), no case-insensitive duplicates, at
  most 64 names.
- Written to the device config as `callFuncAllow`; anything invalid fails the build and names the key.

### Action log (`state.action`)

The agent logs `state.action` (with `hashBefore` and `hashAfter` of global state) only for functions named in
`instrument.state.dispatch`.

```json
"instrument": { "state": { "dispatch": ["dispatch"] } }
```

- Empty by default, so a build with no list logs no actions, even with `BTStore`.
- Name the function the app calls to dispatch. The greenfield example's `AppStore.dispatch` enters its `BTStore`, and
  `examples/greenfield-app/brighttest.json` ships this line.
- An unknown name is reported as `wrap-target-unknown` and fails the build under `instrument.strict`. See
  [Instrument](/guide/instrument).

### The 256 KB limit

The reader accepts at most **256 KB** (262,144 bytes), the largest size read back intact on firmware 16.0.4.

::: warning Never truncated silently
A larger document fails the step at once with `STATE_TOO_LARGE`. Shrink what the agent publishes (redact paths, lower
the publish byte cap).
:::

### Matching rules for `equals` and `contains`

Values compare as **strings** (`equals` exact, `contains` substring). A missing snapshot and a missing path report
distinctly, so you know whether the app published nothing or the path was wrong.

::: tip Field names are lowercased
Roku returns `m.global` field names lowercase (`lastVerb` → `lastverb`). Use that form in `path`, or check
`e2e inspect`.
:::

### Writing a dotted path with `setState`

`setState` takes a dot-separated `path` in `layer` (`global` by default). The first segment is a field of the layer's
node; later ones walk object keys or non-negative array indices.

```yaml
- setState: { layer: global, path: user.tier, value: premium }
- setState: { layer: global, path: cart.items.0.qty, value: 2 }
```

| Case | Result |
|---|---|
| `global`: missing top-level field or object key | Created, with intermediates (`a.b.c` creates `a` and `b`) |
| `scene`, `node`, `m`: missing top-level field | `FIELD_NOT_FOUND`; fields are not added |
| Array index past the end, or non-index under an array | `BAD_PATH` (`no element <segment>`); arrays never grow |
| Segment lands on a non-container | `PATH_NOT_CONTAINER` |
| Path crosses a node reference | `PATH_UNDER_NODE` (use `layer: node`) |
| Empty path | `BAD_PATH` |
| Wrong type for an existing field | `TYPE_MISMATCH` |

These are agent reasons. In the run they appear as typed code `STATE_CMD_FAILED`, with the reason in the message
(`setState: BAD_PATH: no element 7 (ack phase reached: received, ...)`); a missing segment has no state code of its
own. In an `ops:` batch all paths are checked first; one failure applies nothing and is named `ops[N]`.

### Snapshot and restore in flows

`snapshot: name` stores the `global`, `scene` and `registry` layers. List node ids to save their fields too:

```yaml
- snapshot: { name: fresh_home, nodes: [tierLabel, homePanel] }
- setState: { layer: node, node: { id: tierLabel }, path: text, value: "Tier: premium" }
- restore: fresh_home
```

- `nodes`: non-empty list of id strings (repeats dropped). Only listed nodes are saved, not nodes an earlier
  `setState` wrote.
- `restore` (takes only `name`) writes them back, best effort. A listed node absent at snapshot time is left out; one
  gone at restore time goes in the `skipped` list (`node.<id>: node not found`) and does not fail the step.
- Over the 64 KB limit: `STATE_TOO_LARGE`, nothing truncated.

### Where the code shows up

A failed state step prints its code first, for example
`STATE_ACK_TIMEOUT: setState: no applied ack within 10s (ack phase reached: received)`. With log capture, it is also a
`code` field in `<flow>-failure/error.json`, only for typed `STATE_*` failures; other failures leave the file as
before.

## Headless

The pure unit lane has no SceneGraph, so `__bt_state` does not apply. The **`@SGNode`** lane runs real components
headless, so `BTState_publish` works with no device: the streaming sample's `StateProbe` `@SGNode` suite publishes a
snapshot and asserts it round-trips, the same mechanism as on device.

## Related

- [Flow reference](/e2e/flows#state-steps): state step syntax, acks, snapshot limits
- [Instrument](/guide/instrument): building the agent and dispatch wrapper
- [Studio](/guide/studio): the State inspector

**Full guide:** [App state](full:/e2e/app-state) — the original wording.
