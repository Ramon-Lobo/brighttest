# Flow reference

::: info At a glance
**What it is for:** the reference for `*.e2e.yaml` flow files.

**You will:**
- Look up any step and its options
- Check key names, `requires:` and `holdKey` rules
- Set up state flows, launch readiness and device logs
- Write selectors, focus moves and text entry

**First file to open:** `flows/<name>.e2e.yaml`
:::

## File shape

A flow is a small YAML file parsed into a step model the runner executes on the device.

```yaml
appId: dev              # channel to launch (default: dev). --app overrides it.
config: { timeout: 8 }  # optional overrides (timeout in seconds, noSystemDialog, redactState, ready*)
requires: { firmware: ">=12.5" }  # optional: skip the flow on a device that does not match
steps:
  - launch
  - assertVisible: { id: homeScreen }
```

A step is a **bare word** (`launch`, `back`, `home`) or a **single-key map** (`press: Select`). Values are scalars
or inline maps (`{ id: foo, count: 2 }`) that may nest. It is a deliberately small YAML subset: anything else raises
a line-referenced error instead of being misparsed.

## Steps

All steps. Each family has its own section below.

| Step | Meaning |
|---|---|
| `launch` / `launch: { contentId, mediaType }` | Start the app, optionally deep-linking |
| `press: <Key>` / `press: { key, count }` | One or N keypresses |
| `holdKey: { key, ms }` | Hold a key `ms` milliseconds (map form only) |
| `requires: { … }` | Skip the rest of the flow unless the device matches |
| `pressUntil: { key, visible: <selector>, max }` | Repeat a key until a selector appears (scroll a row) |
| `focus: <selector>` | Arrow-key **path-find** focus onto a node |
| `text: "hello"` | Type into the focused field via `Lit_` keypresses |
| `assertVisible` / `assertGone: <selector>` | Poll until present / absent |
| `assertText: { …selector, equals \| contains }` | A node's text |
| `assertField: { …selector, field, equals \| contains }` | **Any** field `inspect` shows |
| `assertFocused: <selector>` | Node has focus |
| `assertState: { path, equals \| contains }` | Published app state ([App state](/e2e/app-state)); `layer: node\|m` with `node: { id }` reads that node through the hub |
| `assertPlaying` / `assertMedia: { state }` | ECP media-player state (reliable during video) |
| `wait: <ms>` / `wait: { ms }` | Fixed pause in **milliseconds** |
| `waitFor: { …selector, timeout }` | Explicit wait for a selector |
| `runFlow: { file, env? }` | Subflow inline (path relative to this flow); `env` replaces `${name}` |
| `assertLog: <text>` / `assertLog: { pattern, timeout }` | Poll the device log for `text` (or `"/regex/"`) |
| `expectNoLog: <text>` | Fail if any log line so far matches |
| `screenshot: <name>` | Save a PNG/JPG |
| `back` / `home` | `press: Back` / `press: Home` |
| `waitForAgent`, `setState`, `snapshot`, `restore`, `callFunc` | [State steps](#state-steps) |

### Polling and timeouts

Assertions **poll** until satisfied or the step timeout (`config.timeout`, `--timeout`, default 10s) elapses.

- `timeout` / `waitFor` are **seconds**; `wait` is **milliseconds**.
- Prefer `assertVisible` / `waitFor`. Use `wait` only for a fixed pause with nothing to poll (splash, animation,
  debounce).
- A flow stops at its first failing step.

## Key names

`press`, `pressUntil` and `holdKey` accept only these case-sensitive ECP names:

`Home`, `Rev`, `Fwd`, `Play`, `Select`, `Left`, `Right`, `Down`, `Up`, `Back`, `InstantReplay`, `Info`, `Backspace`,
`Search`, `Enter`, `FindRemote`, `VolumeDown`, `VolumeMute`, `VolumeUp`, `PowerOff`, `ChannelUp`, `ChannelDown`,
`InputTuner`, `InputHDMI1`..`InputHDMI4`, `InputAV1`, and `Lit_<char>` (one literal character).

::: warning Typos fail at parse time
`press: Rigth` fails in parsing, `e2e lint` and `e2e run` with `unknown key "Rigth"; valid keys: …`. If every flow in a
run fails this (or has a bad `requires:` / `holdKey`), the run stops before the first device request.
:::

## holdKey

`holdKey: { key, ms }` sends `keydown`, waits `ms` (1 to 30000), then `keyup`.

- Map form only: `holdKey: Right`, or no `key`, is a parse error (as is a non-boolean `config.noSystemDialog`).
- `keyup` is always attempted, even if `keydown` or the wait fails, and is retried like any queued request.
- Hold failed: that error, plus `(keyup also failed: …)` if needed. Only keyup failed:
  `keyup <Key> failed (HTTP <status>)`.

::: warning Interrupted holds
Ctrl-C or SIGTERM mid-hold can leave the key down (the lease handler re-raises the signal). A Studio abort still sends
the `keyup`, up to `ms` later.
:::

## requires

`requires:` skips instead of failing. At the top, it covers the flow; as a step, it skips the rest of the flow from
there (earlier steps keep their result).

| Key (at least one) | Meaning |
|---|---|
| `firmware: ">=12.5"` | Version compared per dotted number; `>=` (default when bare), `>`, `<=`, `<`, `=` |
| `videoMode: 1080p` | Device video mode (or `ui-resolution` when no `video-mode`), case-insensitive |
| `deviceClass: box` | `tv`, `box` or `stick` (from `is-tv`, `is-stick`) |

::: warning Always quote `firmware`
Unquoted `12.10` is a number and is rejected: YAML reads it as 12.1.
:::

- Values come from the `device-info` record read at start (no extra request). Unreported values count as unmet.
- A skip prints `○ <flow> skipped: <reason>`, counts as `N skipped` (apart from step counts) and keeps the exit code.
- Studio shows a `skipped` event and does not fail the run. `--junit <file>` writes `<skipped message="…">`
  ([Scaling & CI](/e2e/scaling#junit-output)).
- A `requires` inside a `runFlow` sub-flow skips the whole parent flow from that `runFlow` step on.

| Situation | Exit |
|---|---|
| Some flow ran and passed | 0 |
| Every flow skipped | exit 1: `no flow ran: N skipped by requires:` |
| `--fail-on-skip` and any skip | exit 1: `--fail-on-skip: N skipped by requires: <flow: reason; …>` |

## noSystemDialog

`config: { noSystemDialog: true }` refuses to act while a system dialog is in front.

- Before `press`, `holdKey`, `text`, `back`, `home`, `focus` and `pressUntil`, the step fails with
  `noSystemDialog: a system dialog is in front; refusing to <action>` (no key sent).
- A `launch` ending with a dialog in front fails with the same prefix.
- Detection: root subtype `SystemDialog` or `StdDlgSystem`, shared with launch readiness.

::: warning Not confirmed on hardware
These dialog shapes are not yet confirmed on a device.
:::

## Launching

### Launch parameters

Params are the flat keys of the `launch` map and apply on a **fresh launch only**:
`launch: { netdiag: "http://127.0.0.1:8787/status/503" }`.

- Never nest under `params:` (sent as `params=[object Object]`).
- Values must be string, number or boolean; others are rejected before any device call.
- Roku ignores params for a running channel, so the runner presses Home and waits 800 ms first.
- The legacy example reads `scene=`, `netdiag=`, `noinput=`, `stress=`, `stresskb=`, `stressfields=`, `stresstree=`
  (`examples/legacy-app/source/main.brs`).

::: warning Not proof of the param path
`examples/legacy-app/flows/network-legacy.e2e.yaml` passes the same `netdiag` URL that
`examples/legacy-app/source/Config.brs` uses by default, so its pass proves nothing about params.
:::

### Starting without a Home step
<!-- covers: A flow may start without a Home step -->

No `home` is required before `launch`.

- On lease acquire, before the first flow, the runner presses Home twice (best effort). Not between flows.
- Plain `launch` waits for readiness; a running channel keeps its screen and is not restarted.
- `launch` with params presses Home first (800 ms wait). For a known first screen, use `home` then `launch`.

### Launch readiness

On the dev channel, `launch` returns only when all hold:

1. Dev channel in front (`active-app`).
2. sgnodes answers within a short client timeout (slow or `FAILED` = not ready).
3. Two consecutive reads share a focus signature.
4. No osd facade or root system dialog on top.

- A Home reading is tolerated for a grace window, then fails the launch.
- A 404/5xx on launch right after a sideload is "maybe launched"; the checks decide.
- After 3 failed sgnodes reads, `/query/app-ui` is accepted ([Tree source fallback](/e2e/scaling#tree-source-fallback)).
- Override `READY_DEFAULTS` (`lib/e2e/ready.js`) under `config:`: `readyTimeout`, `readyInterval`,
  `readySgnodesTimeout`, `readyHomeGrace` (ms), `readyStableReads`, and `readyNode: <id>` (wait for that node).

::: warning Starting values
Defaults await device data; osd/dialog shapes are not confirmed on hardware.
:::

## Net-mock flows

Any flow with `config.net` or a `mockHttp`, `waitForRequest`, `assertRequest`, `recordHttp` or `clearHttp` step.

- Needs `instrument build --net` and the instrument hub (`e2e run` starts it).
- `BRIGHTTEST_HUB_TOKEN` must match at build and run time.
- Examples: `examples/greenfield-app/flows/network.e2e.yaml`, `examples/legacy-app/flows/network-legacy.e2e.yaml`.

## State steps

Any flow with `config.state` or a `waitForAgent`, `setState`, `snapshot`, `restore` or `callFunc` step.

- Needs `instrument build` (the state agent) and the hub, started inside the device lease. Same
  `BRIGHTTEST_HUB_TOKEN` at build and run.
- Needs an agent hello **since the flow started**: `launch` first. Earlier flows' hellos do not count.
- No hello at all fails right after `launch` with `STATE_NOT_INSTRUMENTED`.
- A relaunched agent only gets commands queued after its hello.

| Step | Meaning |
|---|---|
| `waitForAgent: { timeout: 10 }` | Wait (seconds) for this flow's hello; only `timeout` (bare form uses step timeout) |
| `setState: { layer: global, path: user.tier, value: premium }` | One write. `layer`: `global` (default), `scene`, `node` (+ `node: { id: heroTitle }`), `registry` (`path` = `<section>.<key>`) |
| `setState: { layer: global, ops: [ { path: a, value: 1 }, { path: b, value: 2 } ] }` | Batch: one command, one ack. Not for `registry` |
| `snapshot: fresh_home` | Store state layers under a name, scoped to this flow |
| `snapshot: { name: fresh_home, nodes: [ heroTitle, homePanel ] }` | Also store those nodes' fields (non-empty id list, repeats dropped) |
| `restore: fresh_home` | Write back (best effort). Rejects `nodes`. Unknown name: `STATE_SNAPSHOT_NOT_FOUND` before sending |
| `callFunc: { node: { id: homePanel }, fn: resetHome, args: [] }` | Call a node function with at most one argument (`args[0]`; use an object for several) |

::: warning `ops:` batches
All ops are checked first (path, type, no node reference crossing); one failure applies nothing and is named `ops[N]`
(0-based). A failure that appears only after an earlier op applied (writing `a.b` after setting `a` to a number)
leaves earlier ops applied, no rollback, and says how many.
:::

::: warning `callFunc` allow-list
`fn` must be in `instrument.state.callable` (case-insensitive, see [Callable names](/e2e/app-state#callable-names)),
or the flow fails before its first step. No name-prefix exemption.
:::

### Snapshots

Kept in hub memory only: at most 20 per run, 64 KB each, scoped to one flow (file path plus run label, so same-named
flows or parameter units never share), dropped at flow end, lost at run end. Nothing is written to disk (the earlier
plan used `.brighttest/state/`). A full store fails `snapshot` with a message.

### Acks, timeouts and error codes

Every state step takes `ack: applied | reflected` and `timeout:` (seconds, above 0; default `config.timeout`).

- Default ack: `config: { state: { ack: reflected } }`, else `applied`.
- The step waits its full timeout past the hub's shorter ack limits: a late ack still counts.
- Failures report the phase reached (`received`, `applied`, `reflected`, `none`) and a code: `STATE_ACK_TIMEOUT`,
  `STATE_CMD_FAILED`, `STATE_NOT_INSTRUMENTED`, `STATE_NO_HUB`, `STATE_SNAPSHOT_NOT_FOUND`, `STATE_TOO_LARGE`,
  `STATE_BAD_COMMAND`.

::: tip Checked before any device call
Unknown keys, wrong types and bad layers are parse errors. `dispatch` is not a flow step yet (the agent answers "not
supported" until a later release).
:::

## Device logs

Inside the lease the lane opens the BrightScript console on port 8085 (`ROKU_LOG_PORT` changes it), once per run.

- ANSI is stripped; partial lines flush after 250 ms; replayed history is discarded.
- `assertLog` polls. `expectNoLog` checks what is captured so far, without waiting.
- Lines are saved as `<flow>.log` (`seq<TAB>line`) beside the screenshots.
- A `Brightscript Debugger>` prompt is a crash: the step fails with the parsed backtrace and Home is pressed.
- Any failed step writes `<flow>-failure/`: `error.json`, `log-tail.txt` (last 50 lines), `tree.xml`, and the
  screenshot or `screenshot-error.json`.

::: warning One console client
The device allows one client. A telnet session or other tool holding it makes `assertLog` / `expectNoLog` fail with
that reason.
:::

## Selectors

Combine keys to narrow; all must hold.

```yaml
{ id: settingsTile }                 # built-in id, preferred (matched as name=)
{ subtype: Poster }                  # node type
{ text: "Play" }                     # exact visible text
{ textContains: "Continue" }         # substring
{ uri: "pkg:/images/hero.png" }      # image/poster uri
{ subtype: RowList, index: 0 }       # Nth match (0-based)
```

- Filters: `visible: true|false`, `focusable: true`, `focused: true`.
- `focused: true` picks the **deepest** focused node (the whole focus chain is flagged); other keys apply to it.
- Prefer `id`, then `text` / `subtype`.

::: warning `id`, not `testId`
`testId` is **invisible** to `sgnodes`, which dumps only built-in fields (`id` as `name=`). Without ids, use `text` /
`subtype` or inject ids at build time ([Authoring flows](/e2e/authoring)).
:::

::: tip `Group` shows up as `RenderableNode`
Seen on firmware 16.0.4, so `{ subtype: Group }` never matches; custom fields stay invisible (re-confirmed on 16.0.4).
`brighttest e2e lint <flow…>` warns (exit 0) on each `subtype: Group`.
:::

## Asserting arbitrary node fields

`assertField` checks **any** field [`e2e inspect --id <x>`](/e2e/authoring) lists under *fields* (`uri`, `opacity`,
`bounds`, `width`, `translation`, `visible`, `color`, …; id as `name`).

```yaml
- assertField: { id: hero, field: uri, equals: "pkg:/images/hero.png" }
- assertField: { id: progressBar, field: width, contains: "480" }
```

Values compare as **strings**: `equals` exact, `contains` substring (handy for `bounds="{820, 400, 280, 64}"`). It
polls like other assertions.

## Focus navigation

Roku has no tap. `focus: <selector>` loops: read focus and target geometry, press toward it, settle, re-read, switch
axis at an edge, and fail with an error and screenshot after `maxPresses`.

```yaml
- focus: { id: settingsTile }              # navigate only (no Select)
- press: Select
- focus: { id: farTile, maxPresses: 40 }   # large grid
```

::: tip Keyboards and start position
A focused keyboard (inner cursor invisible) gets up to 6 extra presses per axis before an edge is reported. Lead with
`focus:` on a known anchor: relaunching a running channel does not reset focus.
:::

## Text entry

`text:` sends one `Lit_<char>` per character to the **focused** field, skipping the keyboard grid. Works on the
standard `Keyboard`, spaces and punctuation included.

```yaml
- focus: { id: searchKeyboard }
- press: { key: Backspace, count: 40 }   # clear: a Keyboard keeps text across relaunches
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

## Adding a step (maintainers)
<!-- covers: Adding a step -->

Steps are listed in `lib/e2e/step-catalog.js` (group, detail, snippet, map keys, example); the parser rejects others.
`test/e2e-step-catalog.test.js` fails if the parser or runner handles an unlisted step, or a catalog step is missing
here or in the flow-reference skill.

## Related

- [End-to-end overview](/e2e/): requirements, quick start, Studio
- [App state](/e2e/app-state): `assertState`, layers, `setState` paths
- [Scaling & CI](/e2e/scaling): JUnit, tree fallback, many devices

**Full guide:** [Flow reference](full:/e2e/flows) — the original wording.
