---
name: using-brighttest-studio
description: Use when a person wants to see, author, or profile a Roku app in the browser through `brighttest studio` — start Studio on a device, inspect the live SceneGraph, drive the remote, run flows with a step trace, and use the Profile page for CPU/memory charts, texture inventory, the SceneGraph debug console, Perfetto system traces with heap snapshots, and .bsprof BrightScript Profiler imports.
triggers: brighttest studio; open studio; profile a roku app; cpu and memory charts; texture memory; perfetto trace; heap snapshot; bsprof profiler file; sgperf
when-not-to-use: Do not use to write flow files by hand (use writing-e2e-flows), for agent-driven device control (use using-brighttest-mcp), or for setting or asserting app state (use testing-app-state). For where to start or whether brighttest fits at all, use adopting-brighttest.
license: MIT
metadata:
  source: brighttest
---

# Using brighttest Studio and its profiling tools

`brighttest studio` opens a local web app that mirrors a running Roku. It is for a person at a browser; an
agent that needs live device access should use the MCP server (`using-brighttest-mcp`), not drive Studio. If a person
asks an agent to operate Studio in a browser, every control has a stable `data-testid` (e.g. `[data-testid="flow-run"]`)
and icon-only ones an `aria-label`; the id table is in `docs/guide/studio.md` ("Driving Studio from a browser agent").
There is no refresh or screenshot button and no WebMCP tools; `monitor-screenshot` shows the device screen.

## Start it

```sh
brighttest studio --host <ip> [--password <pw>] [--port 8700] [--app dev] [--flows-dir flows] [--open]
```

- The device comes from `--host` or `ROKU_HOST`; `--password` or `ROKU_PASSWORD` enables screenshots.
- Port 8700 by default; if busy, the first free of 8701-8709 (`bin/cli.js`, `studio --help`). The device needs developer mode and ECP network access Permissive.
- With `deviceLease.pool` set and no `--host`, Studio binds one free pool member when it takes the lease, but the instrument hub (Network and State panels) is not started in pool mode: pass `--host <ip>` to use them (connecting to a device later does not start the hub; restart with `--host`).
- Studio takes the device lease like every other device lane (`lib/studio/lease.js`; see
  `docs/guide/device-lease.md`). When Studio releases the device it stops any running profiling session or Perfetto capture
  (`lib/studio/server.js`).
- The State tab is a state inspector for instrumented builds: click a value in the `global`, `scene` or `registry` layer to
  edit it. The edit goes through the hub (the same validation as a `setState` flow step) and an ack chip walks received,
  applied, reflected, or shows the error. Snapshots can be saved, restored, deleted, diffed, exported and imported. It needs
  the device lease: every state route answers 423 while another session holds the device, and nothing is written. Values are
  redacted by default (the app's agent masks secret-looking keys itself; Studio adds `instrument.state.redact.paths`), and
  "show raw" reveals only what Studio masks on top of that, behind a banner. A `<redacted:...>` marker is not a real value:
  Studio always refuses to write one, and a restore skips masked values (it reports how many). Registry values are edited
  one `<section>.<key>` at a time; a structured value is read only.
  A snapshot holds at most 64 KB and the store keeps 20. Without an instrumented build the tab stays read-only (see
  `testing-app-state`).

## Simulator target (no device)

`brighttest studio --simulator` builds the app instrumented and runs it on the local brs-node engine, so the State tab
works with no device and no lease. It is state-only: tree, screenshot, remote, run, connect and profiling routes answer
409 `SIMULATOR_TARGET`. The header badge shows the engine and its state (`simulator · brs-node@2.7.1 (stock) · running`; `(patched)` when the patched engine is installed, since the default engine is `auto`).
State shows global, scene, node and registry layers (not `focus`); before the app says hello, or when the engine is
`no-hello` or exited, `GET /api/state` answers 200 with `layers: null` and `agentCode: SIM_NOT_CONNECTED`. Combining
`--simulator` with `--host` or `deviceLease.pool` exits 2. See `docs/guide/studio.md`.

## What the UI gives you

Pages (`lib/studio/web/src/App.svelte`): Inspect, Runs, Record, Devices (with a lease board of who holds which device), Profile, Settings (read-only: device and its source, password known or not, lease timings, hub status, token set or not, Test connection). In the editor view, tabs next to the
Node/Tree/Selector inspector include State, Actions (action log with Travel; route-only snapshot recording) and Network. Click a Network row for details (Headers, Payload, Response): JSON opens as a Tree (or Pretty/Raw), images preview, and **Copy as cURL** gives a redacted command (raw only with show secrets on).

- Inspect the live SceneGraph and build selectors; use "+" on a node or state leaf to add a step. The header **overlay** checkbox hides the node outlines (remembered per browser; the tree is then read only when an Inspect tab needs it).
- Drive the remote from the browser (`POST /api/keypress`); run a flow (Run turns into Stop, `flow-stop`, or Cmd/Ctrl+.) and scrub the step trace (each frame keeps the screen and app state).
- Record: each remote press becomes a flow step, live.

## Profile page

Start a session, drive the app, stop, export. All of these exist in `lib/studio/web/src/lib/pages/Profile.svelte`
and the `/api/perf/*` routes in `lib/studio/server.js`.

- **Session charts** poll `/query/chanperf` and `/query/r2d2-bitmaps` over ECP (`lib/studio/perf.js`): channel CPU,
  channel memory with its limit, texture memory, page faults per sample. The r2d2 texture data needs a dev channel.
- **Markers**: "+ marker" adds a labelled point. A remote key pressed in Studio during a live session adds a
  `key: <KEY>` marker automatically, so spikes line up with what you pressed.
- **Export** the session as JSON or CSV (`/api/perf/export`).
- **Texture inventory**: "Snapshot textures" lists every bitmap in texture memory, largest first. Sizes marked
  `*` are estimated as width x height x 4 because the firmware does not report them.
- **Device console**: whitelisted SceneGraph debug commands (telnet :8080), for example the sgperf
  start, drive the app, report flow (node operations and rendezvous per thread).

## Perfetto system trace

Needs firmware 15.2 or later; Studio reads the device firmware and reports unsupported below that
(`lib/studio/server.js`, `perfetto/status`). Order matters:

1. **Enable for channel** (`POST /perfetto/enable/<channelId>` on the device). It must happen BEFORE the channel launches.
2. Relaunch the channel.
3. **Start trace**: Studio streams `/perfetto-session` into a `.perfetto-trace` file under
   `.brighttest/studio/profiling/` in the project.
4. Optional **+ heap snapshot** while tracing writes a heap graph into the active trace.
5. **Stop trace**, then download the file from the Profile page and open it at https://ui.perfetto.dev.

The enable record is kept per device (ESN) in `~/.brighttest/perfetto-state.json` and ignored after 6 hours,
since a rebooted device forgets it (`lib/studio/perfetto-state.js`). If a trace is empty, enable again and
relaunch. A dropped stream is reopened a bounded number of times, then Studio gives up (`lib/studio/perfetto.js`).

## BrightScript Profiler (.bsprof)

Studio parses Roku's `.bsprof` files into call-path tables; it reports raw ticks and percentages, never
invented milliseconds (`lib/studio/bsprof.js`).

- Produce one: set `bsprof_enable=1` in the manifest, exercise the channel, then export from the device's
  Developer Settings Profiling Data screen.
- Import it in the Profile page (`POST /api/perf/bsprof`, up to 64 MB).
- Or set `bsprof_data_dest=network` and use "Pull from device :8090". A channel without profiling enabled just
  refuses the connection.

## Pitfalls

- A trace or chart that is empty usually means the channel was not running, or Perfetto was enabled after launch.
- Do not leave Studio open while running another device lane; it holds the lease.
- Profile numbers are for comparing runs of the same device and firmware, not across models.
