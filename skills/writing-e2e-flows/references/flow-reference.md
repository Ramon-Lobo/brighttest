# Flow reference

A flow is a small YAML file (`*.e2e.yaml`) describing a scripted UI journey. It parses to an internal step
model the runner executes against the device.

## File shape

```yaml
appId: dev              # channel to launch (default: dev). --app overrides it.
config: { timeout: 8 }  # optional per-flow overrides (currently: timeout, in seconds)
steps:
  - launch
  - assertVisible: { id: homeScreen }
  - ...
```

A step is either a **bare word** (`launch`, `back`, `home`) or a **single-key map** (`press: Select`,
`assertVisible: { id: x }`). Values are scalars or inline maps (`{ id: foo, count: 2 }`), which may nest.
This is a deliberately small YAML subset — anything outside it raises a clear, line-referenced error.

## Steps

| Step | Meaning |
|---|---|
| `launch` / `launch: { contentId, mediaType }` | Start the app, optionally deep-linking |
| `press: <Key>` / `press: { key, count }` | One or N keypresses (`Up`/`Down`/`Left`/`Right`/`Select`/`Back`/…) |
| `holdKey: { key, ms }` | Hold a key down `ms` milliseconds (1 to 30000): keydown, wait, keyup (keyup is always attempted). The map form is required; `holdKey: Right` is a parse error |
| `requires: { firmware, videoMode, deviceClass }` | Skip (not fail) the rest of the flow unless the device matches; see **Gating with requires** below |
| `pressUntil: { key, visible: <selector>, max }` | Repeat a key until a selector appears (e.g. scroll a row) |
| `focus: <selector>` | Arrow-key **path-find** focus onto a node (does not Select) |
| `text: "hello"` | Type text into the focused field via `Lit_` keypresses |
| `assertVisible: <selector>` | Poll until the selector is present (else fail) |
| `assertGone: <selector>` | Poll until the selector is absent |
| `assertText: { …selector, equals \| contains }` | Assert a node's text |
| `assertField: { …selector, field, equals \| contains }` | Assert **any** field the node exposes (any value `inspect` shows) |
| `assertFocused: <selector>` | Assert the node currently has focus |
| `assertState: { path, equals \| contains }` | Assert a value in the app's published state (dotted `path`; also `deepEquals`, `exists: true\|false`, `layer`, `timeout`; `layer: node\|m` with `node: { id }` reads that node's fields or component `m` through the hub). Needs an instrumented build |
| `assertPlaying` / `assertMedia: { state }` | Assert ECP media-player state (`play`, `pause`, `buffer`, `finished`, ...); `assertPlaying` is `state: play`. Works during fullscreen video, where `sgnodes` does not; both take `timeout` (seconds) |
| `wait: <ms>` / `wait: { ms }` | Pause a fixed number of **milliseconds** (not seconds — cf. `timeout`) |
| `waitFor: { …selector, timeout }` | Explicit wait for a selector |
| `runFlow: { file, env? }` | Run a reusable subflow inline (path relative to this flow); `env` values substitute `${name}` in it |
| `assertLog: <text>` / `assertLog: { pattern, timeout }` | Poll the device log (8085 console) until a line contains `text`, or matches when written `"/regex/"` |
| `expectNoLog: <text>` | Fail if any log line so far in this flow matches (`pattern` form accepted, no `timeout`) |
| `screenshot: <name>` | Save a PNG/JPG artifact (always captures unless `--screenshots-mode off`) |
| `back` / `home` | Convenience for `press: Back` / `press: Home` |

Key names are validated when the flow is parsed (`press: Rigth` fails in `e2e lint` and `e2e run` with the valid
list); names are case-sensitive, and `Lit_<char>` sends one literal character.

Assertions **poll** until satisfied or the step timeout elapses (`config.timeout`, `--timeout`, default
10s), so you rarely need explicit waits — prefer `assertVisible`/`waitFor` over a fixed `wait`. Reach for
`wait: <ms>` only when a step must pause for a *fixed* duration with nothing to poll on (a timed splash,
an animation, a debounce). Note the units: `wait` is **milliseconds**, while `timeout`/`waitFor` are
seconds. A flow stops at its first failing step (fail-fast within a flow).

## Gating with requires

`requires:` skips instead of failing. Put it at the top of the flow or as a step (a step-level one skips the rest of
the flow from that step). All keys are optional, at least one is needed:

```yaml
requires: { firmware: ">=12.5", videoMode: 1080p, deviceClass: box }
```

- `firmware`: always quote it (an unquoted `12.10` is read as the number 12.1 and rejected). Operators `>=` (default
  when bare), `>`, `<=`, `<`, `=`, compared per dotted number.
- `videoMode`: equals the device's video mode, case-insensitive.
- `deviceClass`: one of `tv`, `box`, `stick`.
- A skipped flow prints `skipped: <reason>`, counts as skipped and does not change the exit code. If every flow in a
  run is skipped nothing was tested, so the run exits 1 (`no flow ran`). Pass `--fail-on-skip` to `e2e run` to exit 1
  on any skip. With `--junit` the reason is written as `<skipped message="...">`.
- Prefer `requires:` over hand-rolled branching or a `wait` loop for device-specific flows.

## State steps (instrumented build)

Steps `waitForAgent`, `setState`, `snapshot`, `restore`, `callFunc` (and `assertState` above) talk to the state agent
through the instrument hub that `e2e run` starts. Build the channel with `brighttest instrument build` and sideload
it; `BRIGHTTEST_HUB_TOKEN` must be the same at build and run time. `launch` first: a state step needs a hello from the
agent that arrived since the flow started (`waitForAgent` waits for it). A build that never says hello fails with
`STATE_NOT_INSTRUMENTED`.

| Step | Meaning |
|---|---|
| `waitForAgent` / `waitForAgent: { timeout }` | Wait (seconds) for a fresh agent hello |
| `setState: { layer, path, value }` | One write. `layer`: `global` (default), `scene`, `node` or `m` (both need `node: { id }`), `registry` (`path` is `<section>.<key>`) |
| `setState: { layer, ops: [ { path, value } ] }` | Batch with one ack; every op is checked first. Not for `registry` |
| `snapshot: name` / `snapshot: { name, nodes: [ids] }` | Store the state layers (and the listed nodes' fields) in hub memory, scoped to this flow |
| `restore: name` | Write the snapshot back (best effort); unknown name fails `STATE_SNAPSHOT_NOT_FOUND` |
| `callFunc: { node: { id }, fn, args }` | Call a node function with at most one argument; `fn` must be in `instrument.state.callable` in `brighttest.json` |

Every state step takes `ack: applied | reflected` and `timeout:` (seconds). Failures carry typed codes
(`STATE_ACK_TIMEOUT`, `STATE_CMD_FAILED`, `STATE_NOT_INSTRUMENTED`, `STATE_NO_HUB`, ...). See the `testing-app-state`
skill and docs `e2e/app-state`.

## Net steps (instrumented build with --net)

Steps `mockHttp`, `waitForRequest`, `assertRequest`, `recordHttp`, `clearHttp` (and a `config.net` block) mock and
observe the app's HTTP traffic. They need a channel built with `brighttest instrument build --net` plus the hub; a
build without the handshake fails with `no agent.hello/BT_url handshake seen`.

| Step | Meaning |
|---|---|
| `mockHttp: { method?, url: "<glob>", status, file \| json \| body, headers?, times?, delayMs?, fault?, responses?, passthrough? }` | Add a mock rule. `responses: [ ... ]` serves a sequence (e.g. 503 then 200). Unknown keys are parse errors |
| `waitForRequest: { url, method?, status?, bodyContains?, timeout? }` | Wait (seconds) until a matching request was seen |
| `assertRequest: { url, method?, status?, bodyContains?, count?, timeout? }` | Assert a matching request was seen (`count` = exactly N, 0 allowed) |
| `recordHttp: { file: <path.har> }` / `recordHttp: stop` | Start or stop recording traffic to a HAR file (refuses to start without `config.net.upstreamHosts`) |
| `clearHttp` | Drop this flow's rules and hide the request log so far (rules are dropped when the flow ends anyway) |

`config: { net: { fixtures: [paths], unmatched: fail \| passthrough, record, upstreamHosts, redact } }` loads
fixture files up front. `upstreamHosts` is required for any `unmatched: passthrough` (an empty list refuses every request with 403
and fails lint/run). A flow inherits `instrument.net` from brighttest.json (`fixtures`, `unmatched`, `upstreamHosts`, `redact`);
`config.net` overrides per key, in `e2e run` and in Studio's Run. A failing step prints the requests the allow-list refused.
Use the `mocking-network-and-store` skill for the larger workflow.

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

**Selectors use `id`, not `testId`.** A dedicated `testId` field is *invisible* to `sgnodes` — Roku only
dumps a fixed set of built-in fields, and a node's `id` surfaces there as `name=`. So the selectable hook
is the built-in **`id`**. No ids? Use `text`/`subtype`, or auto-inject ids at build time (see authoring).

Stability preference: `id` → `text`/`subtype`. Prefer ids for anything you assert on repeatedly.

## Asserting arbitrary node fields

`assertText` covers the common case; `assertField` generalizes it to **any** field a node exposes — exactly
the fields `e2e inspect --id <x>` prints. Give it a selector, a `field:` name, and `equals:` or `contains:`.

```yaml
- assertField: { id: hero, field: uri, equals: "pkg:/images/hero.png" }
- assertField: { id: title, field: opacity, equals: 1 }
- assertField: { id: progressBar, field: width, contains: "480" }
- assertField: { id: playButton, field: name, equals: playButton }   # the built-in id surfaces as `name`
```

- **Discover field names with `inspect`.** Run `e2e inspect --id <x>`; every line under *fields* is a name
  you can assert on (`uri`, `opacity`, `bounds`, `width`, `translation`, `visible`, `color`, …).
- **Values compare as strings.** sgnodes reports fields as text, so `equals` is an exact string match
  (`equals: 1` matches the field `"1"`) and `contains` is a substring — handy for tuples like
  `bounds="{820, 400, 280, 64}"` where `contains: "820"` checks just the x. Like the other assertions it
  **polls** until it matches or the step timeout elapses.
- A wrong value and an absent field fail with different messages (`got "…"` vs `field "…" not present`).

## Focus navigation

Roku has no tap: "click X" means moving focus to X with the D-pad. `focus: <selector>` runs a bounded,
deterministic loop — read the focused node and the target's geometry, press toward it, wait for the UI to
settle, re-read; back off to the orthogonal axis at an edge; give up with a clear error (and a screenshot)
after `maxPresses`.

```yaml
- focus: { id: settingsTile }              # navigate, then stop (does not Select)
- press: Select
- focus: { id: farTile, maxPresses: 40 }   # tune the guard when a grid is large
```

Because it drives from wherever focus currently *is*, lead your flow with a `focus:` to a known anchor
rather than assuming the initial focus position (relaunching a running channel does not reset it).

## Text entry

`text: "…"` types into the **focused** field by sending one `Lit_<char>` keypress per character — directly,
without navigating the on-screen keyboard grid. Works on the standard Roku `Keyboard` (spaces and
punctuation included). Focus the field first, and clear it first if it persists text:

```yaml
- focus: { id: searchKeyboard }
- press: { key: Backspace, count: 40 }   # a Keyboard persists text across relaunches
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
