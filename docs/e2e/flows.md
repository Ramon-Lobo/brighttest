# Flow reference

A flow is a small YAML file (`*.e2e.yaml`) describing a scripted UI journey. It parses to an internal
step model that the runner executes against the device.

## File shape

```yaml
appId: dev              # channel to launch (default: dev). --app overrides it.
config: { timeout: 8 }  # optional per-flow overrides (timeout in seconds, noSystemDialog, redactState, ready*)
requires: { firmware: ">=12.5" }  # optional: skip the flow on a device that does not match
steps:
  - launch
  - assertVisible: { id: homeScreen }
  - ...
```

A step is either a **bare word** (`launch`, `back`, `home`) or a **single-key map** (`press: Select`,
`assertVisible: { id: x }`). Values are scalars or inline maps like `{ id: foo, count: 2 }`, which may
nest. This is a deliberately small YAML subset — anything outside it raises a clear, line-referenced
error rather than being silently misparsed.

## Steps

| Step | Meaning |
|---|---|
| `launch` / `launch: { contentId, mediaType }` | Start the app, optionally deep-linking |
| `press: <Key>` / `press: { key, count }` | One or N keypresses (`Up`/`Down`/`Left`/`Right`/`Select`/`Back`/…) |
| `holdKey: { key, ms }` | Hold a key down for `ms` milliseconds (keydown, wait, keyup; see below). The map form is required: a scalar `holdKey: Right` is a parse error |
| `requires: { … }` | Skip the rest of the flow unless the device matches (see below) |
| `pressUntil: { key, visible: <selector>, max }` | Repeat a key until a selector appears (e.g. scroll a row) |
| `focus: <selector>` | Arrow-key **path-find** focus onto a node (see below) |
| `text: "hello"` | Type text into the focused field via `Lit_` keypresses |
| `assertVisible: <selector>` | Poll until the selector is present (else fail) |
| `assertGone: <selector>` | Poll until the selector is absent |
| `assertText: { …selector, equals \| contains }` | Assert a node's text |
| `assertField: { …selector, field, equals \| contains }` | Assert **any** field the node exposes (any value `inspect` shows) |
| `assertFocused: <selector>` | Assert the node currently has focus |
| `assertState: { path, equals \| contains }` | Assert a value in the app's published state ([App state](/e2e/app-state)) |
| `assertPlaying` / `assertMedia: { state }` | Assert ECP media-player state (reliable during video) |
| `wait: <ms>` / `wait: { ms }` | Pause a fixed number of **milliseconds** (contrast the second-based `timeout`) |
| `waitFor: { …selector, timeout }` | Explicit wait for a selector |
| `runFlow: { file, env? }` | Run a reusable subflow inline (path relative to this flow); `env` values substitute `${name}` in it |
| `assertLog: <text>` / `assertLog: { pattern, timeout }` | Poll the device log until a line contains `text` (or matches `"/regex/"`) |
| `expectNoLog: <text>` | Fail if any log line so far in this flow matches |
| `screenshot: <name>` | Save a PNG/JPG artifact |
| `back` / `home` | Convenience for `press: Back` / `press: Home` |

**Key names are validated.** `press`, `pressUntil` and `holdKey` accept only the ECP key names `Home`, `Rev`, `Fwd`, `Play`, `Select`, `Left`, `Right`, `Down`, `Up`, `Back`, `InstantReplay`, `Info`, `Backspace`, `Search`, `Enter`, `FindRemote`, `VolumeDown`, `VolumeMute`, `VolumeUp`, `PowerOff`, `ChannelUp`, `ChannelDown`, `InputTuner`, `InputHDMI1`..`InputHDMI4`, `InputAV1`, plus `Lit_<char>` (one literal character). Names are case-sensitive. A typo such as `press: Rigth` fails when the flow is parsed, by `e2e lint` and by `e2e run` alike, with `unknown key "Rigth"; valid keys: …`. When every flow in a run fails this validation (or a bad `requires:` / `holdKey`), the run stops before the first device request.

**`holdKey: { key, ms }`** sends `keydown`, waits `ms` (1 to 30000), then sends `keyup`. The `keyup` is always attempted, also when the `keydown` or the wait fails, so a key is not left held on the device. If the hold itself failed, that error is reported and a failing `keyup` is appended as `(keyup also failed: …)`; if only the `keyup` failed, the step fails with `keyup <Key> failed (HTTP <status>)`. The `keyup` is retried like any queued request (a repeated keyup is harmless). Limits: Ctrl-C or SIGTERM in the middle of a hold can leave the key down on the device (the lease handler re-raises the signal), and a Studio abort during a hold still sends the `keyup`, up to `ms` later. `holdKey` without a map or a `key`, and a non-boolean `config.noSystemDialog`, are parse errors.

**`requires:`** skips instead of failing. Put it at the top of the flow or as a step (a step-level `requires` skips the rest of the flow from that step; earlier steps keep their result). Keys, all optional but at least one:

| Key | Meaning |
|---|---|
| `firmware: ">=12.5"` | Software version (always quote it: an unquoted `12.10` is a number and is rejected, because YAML would read it as 12.1) compared per dotted number; operators `>=` (default when bare), `>`, `<=`, `<`, `=` |
| `videoMode: 1080p` | Equals the device's reported video mode (falls back to `ui-resolution` when the device has no `video-mode`), case-insensitive |
| `deviceClass: box` | One of `tv`, `box`, `stick` (from `is-tv` and `is-stick`) |

The values come from the `device-info` record the run already reads at the start (no extra request). A value the device did not report counts as unmet and the reason says so. A skipped flow prints `○ <flow> skipped: <reason>`, counts in the summary as `N skipped`, and does not change the exit code. If every flow in the run is skipped, nothing was tested, so the run prints `no flow ran: N skipped by requires:` and exits 1 (a run where some flow ran and passed still exits 0). Pass `--fail-on-skip` to `e2e run` to make any skip (a skipped flow, or a step-level `requires` that skipped the rest of a flow) exit 1 with `--fail-on-skip: N skipped by requires: <flow: reason; …>`; without the flag nothing changes. Skipped flows are counted separately from step counts. A `requires` inside a sub-flow (`runFlow`), flow-level or step-level, skips the whole parent flow from that `runFlow` step on, not just the sub-flow. Studio shows a skip as a `skipped` event and does not mark the run failed. With `--junit <file>` the reason is also written to the JUnit file as `<skipped message="…">` (see [Scaling & CI](/e2e/scaling#junit-output)).

**`config: { noSystemDialog: true }`** refuses to act while a system dialog is the foreground: before `press`, `holdKey`, `text`, `back`, `home`, `focus` and `pressUntil` the runner reads the tree and fails the step with `noSystemDialog: a system dialog is in front; refusing to <action>` (no key is sent), and a `launch` that ends with a system dialog in front fails with the same prefix. It reuses the launch readiness gate's detection (root node subtype `SystemDialog` or `StdDlgSystem`), whose shapes are not yet confirmed on hardware.

**Launch parameters apply on a fresh launch only.** Params are the flat keys of the `launch` map, for example `launch: { netdiag: "http://127.0.0.1:8787/status/503" }`; do not nest them under a `params:` key, because the nested object is sent as `params=[object Object]`. The runner rejects any launch param whose value is not a string, number or boolean (objects, arrays and null), before any device call. The legacy example app reads `scene=`, `netdiag=`, `noinput=`, `stress=`, `stresskb=`, `stressfields=` and `stresstree=` in `examples/legacy-app/source/main.brs`. Params reach the channel only when it starts, and Roku ignores them if the channel is already running. When params are set, the runner presses Home and waits 800 ms before it launches, so they always reach a fresh start. `examples/legacy-app/flows/network-legacy.e2e.yaml` passes `netdiag` with the same URL that `examples/legacy-app/source/Config.brs` uses as its default, so a pass of that flow does not prove the param path worked.

**Net-mock flows** (any flow with `config.net` or a `mockHttp`, `waitForRequest`, `assertRequest`, `recordHttp` or `clearHttp` step) need a channel built with `instrument build --net` and the instrument hub. `e2e run` starts the hub, and `BRIGHTTEST_HUB_TOKEN` must be the same value at build and run time. `examples/greenfield-app/flows/network.e2e.yaml` and `examples/legacy-app/flows/network-legacy.e2e.yaml` are both net-mock flows.

**State flows** (any flow with `config.state` or a `waitForAgent`, `setState`, `snapshot`, `restore` or `callFunc` step) need a channel built with `instrument build` (the state agent) and the instrument hub, which `e2e run` starts inside the device lease. `BRIGHTTEST_HUB_TOKEN` must be the same at build and run time. A state step needs a hello from the agent that arrived since the flow started, so the flow must launch the app (`launch`) before its state steps; `waitForAgent` waits for that new hello, and a hello from an earlier flow does not count. A build that never says hello fails right after `launch` with `STATE_NOT_INSTRUMENTED` instead of waiting out step timeouts. A relaunched agent only receives commands queued after its hello, never earlier ones.

**A flow may start without a Home step.** Nothing requires `home` or `press: Home` before `launch`. The runner
presses Home twice (best effort) when it acquires the device lease, before the first flow, but not between flows, so a later flow
starts from wherever the previous one left the device. `launch` with no params sends the launch request and waits
for readiness; if the channel is already running, Roku keeps it and its current screen, and `launch` does not
restart it. Only a `launch` with params presses Home first (800 ms wait), so the app starts fresh. If a flow needs
a known first screen, begin it with `home` and then `launch` (or give `launch` params).

| Step | Meaning |
|---|---|
| `waitForAgent: { timeout: 10 }` | Wait (seconds) until the agent has said hello since this flow started; takes only `timeout` (bare `waitForAgent` uses the step timeout) |
| `setState: { layer: global, path: user.tier, value: premium }` | One write. `layer` is `global` (default), `scene`, `node` (add `node: { id: heroTitle }`) or `registry` (`path` is `<section>.<key>`) |
| `setState: { layer: global, ops: [ { path: a, value: 1 }, { path: b, value: 2 } ] }` | A batch sent as one command with one ack. Every op is checked first (path, type, no crossing a node reference); if any fails, nothing is applied and the error names it as `ops[N]` (0-based). A failure that only shows once an earlier op of the same batch has applied (for example writing `a.b` after setting `a` to a number) leaves the earlier ops applied, with no rollback, and says how many. Not available for `registry` |
| `snapshot: fresh_home` | Store the agent's state layers under a name, scoped to this flow |
| `snapshot: { name: fresh_home, nodes: [ heroTitle, homePanel ] }` | Same, and also store the listed nodes' fields so `restore` can write them back. `nodes` is a non-empty list of node id strings; repeated ids are dropped. `restore` rejects `nodes` (it restores whatever the snapshot holds) |
| `restore: fresh_home` | Write a snapshot of this flow back (best effort); an unknown name fails with `STATE_SNAPSHOT_NOT_FOUND` before anything is sent |
| `callFunc: { node: { id: homePanel }, fn: resetHome, args: [] }` | Call a node function with at most one argument (`args[0]`; pass an object to send several values). `fn` must be listed in `instrument.state.callable` in `brighttest.json` (names compared ignoring case, see [Callable names](./app-state.md#callable-names)); otherwise the flow fails when it starts, before its first step runs. There is no name-prefix exemption |

**Snapshots** live in the hub's memory only: at most 20 per run, each at most 64 KB, scoped to one flow (its file path plus the run label, so same-named flows or parameter units never share them), dropped when the flow ends and lost when the run ends. This differs from the earlier plan to write snapshot files under `.brighttest/state/`; nothing is written to disk. A full store fails the `snapshot` step with a message saying so.

Every state step takes `ack: applied | reflected` and `timeout:` (seconds, greater than 0; omit it for the step default, which is the flow's `config.timeout`). The default ack comes from `config: { state: { ack: reflected } }` and is `applied` otherwise. The step waits up to its timeout even if the hub's own, shorter ack limits have passed, because a late ack still counts. A failure reports the ack phase reached (`received`, `applied`, `reflected` or `none`) and carries a typed code: `STATE_ACK_TIMEOUT`, `STATE_CMD_FAILED`, `STATE_NOT_INSTRUMENTED`, `STATE_NO_HUB`, `STATE_SNAPSHOT_NOT_FOUND`, `STATE_TOO_LARGE`, `STATE_BAD_COMMAND`. Unknown keys, wrong types and bad layers are rejected when the flow is parsed (a validation error, so the run stops before any device call). `dispatch` is not a flow step yet (the agent answers "not supported" until a later release).

**Launch readiness.** `launch` on the dev channel does not return on the first sgnodes answer: it waits until the dev channel is in front (`active-app`), sgnodes answers under a short client timeout (a slow or `FAILED` read counts as not-ready), two consecutive reads have the same focus signature, and no osd facade or root system dialog is on top. A Home reading is tolerated for a grace window after launch, then fails the launch; a 404/5xx on the launch request right after a sideload is treated as "maybe launched" and the same checks decide. After 3 consecutive failed sgnodes reads, readiness accepts the `/query/app-ui` tree instead (see [Tree source fallback](scaling.md#tree-source-fallback)). All timing values live in one object (`READY_DEFAULTS` in `lib/e2e/ready.js`) and a flow can override them under `config:` with `readyTimeout`, `readyInterval`, `readySgnodesTimeout`, `readyHomeGrace` (milliseconds) and `readyStableReads`; `readyNode: <id>` additionally waits for that node to exist. The defaults are starting values pending device data, and the osd/dialog shapes are not yet confirmed on hardware.

**Device logs.** Inside the device lease the lane opens the device's BrightScript console on port 8085 (one connection per run; the device allows only one client, so a telnet session or another tool holding it makes `assertLog`/`expectNoLog` fail with that reason). Lines are ANSI-stripped, a partial line is flushed after 250 ms, and the history the console replays on connect is discarded, so a flow only sees its own output. `assertLog` polls for a matching line; `expectNoLog` checks what has been captured so far and does not wait. The flow's lines are saved next to the screenshots as `<flow>.log` (`seq<TAB>line`). A `Brightscript Debugger>` prompt means the app crashed: the step fails with the parsed backtrace, Home is pressed, and a failure bundle `<flow>-failure/` is written for any failed step (`error.json`, `log-tail.txt` with the last 50 lines, `tree.xml`, and the screenshot or `screenshot-error.json`). Set `ROKU_LOG_PORT` to use a console port other than 8085.

Assertions **poll** until satisfied or the step timeout elapses (`config.timeout`, `--timeout`, default
10s), so you rarely need explicit waits — screens are given time to settle. Prefer `assertVisible`/`waitFor`
over a fixed `wait`; reach for `wait: <ms>` only when a step must pause for a *fixed* duration with nothing
to poll on (a timed splash, an animation, a debounce). Note the units: `wait` is **milliseconds**, while
`timeout`/`waitFor` are seconds. A flow stops at its first failing step (fail-fast within a flow).

## Selectors

A selector matches nodes in the live tree. Combine keys to narrow (all must hold):

```yaml
{ id: settingsTile }                 # built-in id — the stable, preferred hook (matched as name=)
{ subtype: Poster }                  # node type
{ text: "Play" }                     # exact visible text
{ textContains: "Continue" }         # substring of visible text
{ uri: "pkg:/images/hero.png" }      # image/poster uri
{ subtype: RowList, index: 0 }       # the Nth match (0-based)
```

Extra filters: `visible: true|false`, `focusable: true`, `focused: true`.

`focused: true` selects the **deepest** focused node. The device flags every node on the focus chain (scene, containers, the focused leaf) as focused, so the selector keeps only the focused node that has no focused descendant; other keys in the same selector then apply to that node.

::: warning Selectors use `id`, not `testId`
A dedicated `testId` field is **invisible** to `sgnodes` — Roku only dumps a fixed set of built-in
fields, and a node's `id` surfaces there as the `name=` attribute. So the selectable hook is the
built-in **`id`**. If your app has none, use `text`/`subtype`, or auto-inject ids at build time — see
[Authoring flows](/e2e/authoring).
:::

::: tip `Group` shows up as `RenderableNode`
A node created as `Group` is dumped by `sgnodes` with the subtype `RenderableNode` (seen on firmware
16.0.4), so `{ subtype: Group }` will not match. Select by `id` or `text` instead. Custom fields stay
invisible there too (re-confirmed on 16.0.4).

Run `brighttest e2e lint <flow…>` to get a warning (exit 0) for every `subtype: Group` selector.
:::

Stability preference: `id` → `text`/`subtype`. Prefer ids for anything you assert on repeatedly.

## Asserting arbitrary node fields

`assertText` handles the common case; `assertField` generalizes it to **any** field a node exposes —
exactly the fields [`e2e inspect --id <x>`](/e2e/authoring) prints. Give it a selector, a `field:` name,
and `equals:` or `contains:`.

```yaml
- assertField: { id: hero, field: uri, equals: "pkg:/images/hero.png" }
- assertField: { id: title, field: opacity, equals: 1 }
- assertField: { id: progressBar, field: width, contains: "480" }
```

Discover field names by running `e2e inspect` on the node — every line under *fields* is assertable
(`uri`, `opacity`, `bounds`, `width`, `translation`, `visible`, `color`, …; the built-in id surfaces as
`name`). Values compare as **strings** (sgnodes reports fields as text): `equals` is an exact match and
`contains` is a substring — useful for tuples like `bounds="{820, 400, 280, 64}"`. Like the other
assertions, it polls until it matches or the step timeout elapses.

## Focus navigation

Roku has no tap: "click X" means moving focus to X with the D-pad. `focus: <selector>` runs a bounded,
deterministic loop — read the focused node and the target's geometry, press toward it, wait for the UI to
settle, re-read; back off to the orthogonal axis at an edge; give up with a clear error (and a screenshot)
after `maxPresses`. A focused keyboard (or other composite whose inner cursor is invisible in the node tree) gets up to 6 consecutive extra presses per axis before the navigator reports an edge, so `focus:` on a target after a keyboard may need up to that many presses.

```yaml
- focus: { id: settingsTile }              # navigate, then stop (does not Select)
- press: Select
# tune the guard when a grid is large:
- focus: { id: farTile, maxPresses: 40 }
```

Because it drives from wherever focus currently is, lead your flow with a `focus:` to a known anchor
rather than assuming the initial focus position (relaunching a running channel does not reset it).

## Text entry

`text: "…"` types into the **focused** field by sending one `Lit_<char>` keypress per character —
directly, without navigating the on-screen keyboard grid. This works on the standard Roku `Keyboard`
(spaces and punctuation included). Focus the field first:

```yaml
- focus: { id: searchKeyboard }
- press: { key: Backspace, count: 40 }   # clear — a Keyboard persists text across relaunches
- text: "the wire"
- assertText: { id: searchQuery, equals: "the wire" }
```

## A complete example

```yaml
# flows/search.e2e.yaml
appId: dev
config: { timeout: 8 }
steps:
  - launch
  - focus: { id: searchTab }
  - press: Select
  - focus: { id: searchKeyboard }
  - text: "news"
  - assertVisible: { id: searchResults }
  - assertText: { id: firstResultTitle, contains: "News" }
  - screenshot: search-results.png
```
