---
name: testing-app-state
description: Use when a brighttest flow needs to read, set, snapshot, restore, or assert an app's internal state (m.global, scene fields, registry values) — publishing state with __bt_state or the instrumented agent, the assertState matchers, the setState/snapshot/restore/callFunc/waitForAgent flow steps, the instrument.state config keys, and the typed STATE_* errors.
triggers: assertState; setState step; snapshot and restore state; callFunc in a flow; waitForAgent; __bt_state; m.global in a flow; registry state in a test; STATE_ACK_TIMEOUT
when-not-to-use: Do not use for the one-off `app_state` MCP tool call (use using-brighttest-mcp), for general flow syntax and selectors (use writing-e2e-flows), or for the Studio State tab layout (use using-brighttest-studio).
license: MIT
metadata:
  source: brighttest
---

# Testing app state with brighttest

ECP cannot see `m.global`, custom fields, or component locals. brighttest gets state two ways. Full reference:
`docs/e2e/app-state.md`.

## 1. Read-only: publish a snapshot

The app mirrors JSON into a hidden node with the id `__bt_state` (a ten-line `BTState_publish` helper is
listed in `docs/e2e/app-state.md`). The reader accepts at most 256 KB and fails with
`STATE_TOO_LARGE` rather than truncating (`lib/e2e/appstate.js`).

```yaml
- assertState: { path: global.channel, equals: "Open Cinema" }
- assertState: { path: watchlist.0.id, contains: steel }
```

`e2e inspect` prints the published block. `equals` and `contains` compare as strings. Roku lowercases
`m.global` field names (`lastVerb` becomes `lastverb`).

## 2. Instrumented agent: layers, matchers, writes

Build with `brighttest instrument build` and sideload. The agent publishes layers `global`, `scene`, `focus`
and, if configured, `registry`. Select one with `layer:`; `path` is then relative to it.

```yaml
- assertState: { layer: scene, path: current, equals: PlayerPanel }
- assertState: { layer: global, path: cfg, deepEquals: { retries: 3 } }
- assertState: { layer: global, path: token, exists: false }
```

Matchers: `equals`, `contains`, `deepEquals` (typed, structural), `exists: true|false`. One per step. A failure
says whether nothing was published, the layer or the path was missing, or what the value was.

## Flow steps that write state

These need an instrumented build, and run through the instrument hub started under the device lease
(`lib/e2e/state-steps.js`). A flow that uses them without a hub fails before its first step.

```yaml
config:
  state: { ack: applied }          # applied (default) or reflected
steps:
  - waitForAgent: { timeout: 10 }  # fail fast if the build is not instrumented
  - setState: { layer: global, path: user.tier, value: premium }
  - setState: { layer: global, ops: [ { path: a, value: 1 }, { path: b, value: 2 } ] }
  - snapshot: fresh_home
  - restore: fresh_home
  - callFunc: { node: { id: homePanel }, fn: bt_resetHome, args: [] }
```

- `setState` layers: `global` (default), `scene`, `node` and `m` (both need `node: { id }`; `m` is that component's own `m`, existing fields only, never in snapshots), `registry` (path is
  `<section>.<key>`, one key at a time, no `ops`). `ops:` is one atomic batch; if any path fails, none applies.
- On `global`, missing keys are created. On other layers a missing top-level field fails with `FIELD_NOT_FOUND`.
  Arrays are never extended (`BAD_PATH`).
- `ack: applied` waits until the agent applied the change; `reflected` waits until it shows in published state.
  A step can override with its own `ack:` and `timeout:` (seconds).
- `snapshot` and `restore` names are letters, digits, `_`, `-`, `.`. Snapshots are per flow and dropped when the
  flow ends; the hub keeps at most 20 per run. Restoring an unknown name fails with `STATE_SNAPSHOT_NOT_FOUND`.
- `callFunc` passes at most one argument, and only names listed in `instrument.state.callable` run. The flow
  fails at start if a name is missing from that list, and you must rebuild after adding one.

## Config (brighttest.json)

```json
"instrument": { "state": {
  "registrySections": ["prefs"],
  "callable": ["bt_resetHome"],
  "redact": { "paths": ["scene.profile.email"] },
  "publish": { "maxBytes": 65536, "intervalMs": 500 }
} }
```

Registry writes go only to `registrySections`. Secret-looking keys (`token`, `password`, and similar) are always
published as `<redacted:key>`. Wrong types or out-of-range numbers fail the instrument build, naming the key.

## Errors

A failed step prints its code first, for example `STATE_ACK_TIMEOUT: setState: no applied ack within 10s`.
Codes: `STATE_NO_HUB`, `STATE_NOT_INSTRUMENTED`, `STATE_ACK_TIMEOUT`, `STATE_CMD_FAILED` (the agent's reason, such
as `BAD_PATH` or `TYPE_MISMATCH`, is in the message), `STATE_SNAPSHOT_NOT_FOUND`, `STATE_TOO_LARGE`,
`STATE_BAD_COMMAND`. With log capture on, the code is also in `<flow>-failure/error.json`.

`STATE_NOT_INSTRUMENTED` means the build has no agent or cannot reach the hub: rebuild, sideload, and check that
`BRIGHTTEST_HUB_TOKEN` matches at build and run time.
