# Studio

`brighttest studio` opens a local web app that mirrors a running Roku: a live screenshot with a node overlay, the
SceneGraph tree, a remote, a flow editor, run traces, recording, profiling and an app **State inspector**. This page is
the entry point; the lane-specific details live in [E2E](/e2e/), [App state](/e2e/app-state) and
[Sharing a device (lease)](/guide/device-lease#studio).

::: warning What the screenshots are
The screenshots on this page were captured by `scripts/docs-screenshots.js` against the in-repo **fake Roku**
(`test/fixtures/fake-roku`) and a **scripted stand-in for an instrumented app** that acks edits. No real Roku was
involved: the picture in the monitor is a generic placeholder gradient frame that the capture script substitutes for the device screenshot, and the model and firmware text in the
header comes from the fake. They show the layout and the messages, not device behaviour.
:::

![Studio Inspect page connected to a device, with a flow open in the editor and the node and remote panels](/images/studio/overview.png)
*Inspect page (monitor picture is a placeholder frame): flow editor, live monitor, inspector tabs (Node, Tree, Selector, State, Actions, Network) and the remote. The header
shows the model and the lease badge.*

## Start and stop

```sh
npm run studio:build          # once, when working from a source checkout (the UI bundle is not committed)
brighttest studio --host <roku-ip> --password <dev-password> --open
```

Stop it with Ctrl-C. The server listens on `127.0.0.1` only. Flags (from `brighttest studio --help`):

| Flag | Meaning |
| --- | --- |
| `--host <ip>` | Roku IP (or `ROKU_HOST`). Without one, Studio uses the only cached device; with several cached devices it refuses to guess and exits; with none it starts with no device and you pick one on the Devices page. |
| `--password <pw>` | Roku dev password (or `ROKU_PASSWORD`, `.env`, or the device cache); Studio refuses to start for a host with no known password. |
| `--port <n>` | Local port, default 8700. Without `--port`, a busy 8700 falls back to the first free port of 8701-8709 and prints it; an explicit busy port fails. |
| `--app <id>` | Channel to launch and drive (default `dev`). |
| `--flows-dir <dir>` | Where flows (`*.e2e.yaml`) are read and written (default `./flows`). |
| `-o`, `--open` | Open the browser. |

If the UI bundle is missing the command prints an error and exits with code 2.

## Security model

Studio is for the local machine only. It answers only requests whose `Host` is `localhost`, `127.0.0.1` or `[::1]`,
refuses cross-site browser requests and any `Origin` that is not loopback (HTTP 403), and accepts non-GET requests only
with `Content-Type: application/json` (HTTP 415 otherwise; `POST /api/perf/bsprof` also takes
`application/octet-stream`). Reaching it through a LAN name or a reverse proxy is refused. Scripts calling the API must
send those headers. (`lib/studio/server.js`, the request guard near `LOOPBACK_HOSTS`.)

## The device lease

Studio is a normal client of the [device lease](/guide/device-lease#studio): it takes the lease on the first request from
an open tab or on a user action, releases it after `studioIdle` without user actions (or `studioYield` when someone is
queued), and never preempts. While another session holds the device, device routes answer `423` with the lease status.
The header badge shows who holds the device.

![Header badge and banner saying the device is in use by another session, with Take over when free](/images/studio/device-held.png)
*Another session holds the device (monitor picture is a placeholder frame). The banner offers **Take over when free**, and the
State tab switches to its read-only held view with the notice "Device is held by another session". An edit sent after the
hand-over is refused with HTTP 423 and nothing is written (the inspector sets "Device is held elsewhere; edit not sent."
but the held view then replaces the panel, so that line may not stay on screen). The header badge can lag: it updates on
the next poll, so it may still read "Studio holding" or already read "Studio released" while the banner shows the other holder. The read-only held view masks `name` and `token` like the live view.*

### The lease board on the Devices page

The Devices page has a **Lease** section: one card per device with its state, who holds it and for how long, the line of
waiting sessions, whether the device answers, a table of recent runs, a bar strip of hold times (wait part in amber) and
the last 24 hours in numbers. It is the same board as [`brighttest device watch`](/guide/device-lease). It reads
`GET /api/lease/board`, which needs no lease, takes none and never waits on the device: the reachability check runs in the
background, at most one small request per device every 30 seconds. The page refreshes every 3 seconds only while the Devices page
is open. Studio's own hold shows like any other holder, with the purpose `studio :<port>` and the agent from `BRIGHTTEST_AGENT`, or `<user>@pid<N>` when that is not set.

## State inspector

The **State** tab on the Inspect page reads the instrumented app's `__bt_agent` node over ECP (one small request, not a
tree walk) and shows its layers: `global`, `scene` and `registry`, each marked **truncated** if the agent had to cut
it. The values shown are redacted by default: the agent masks secret-looking keys as `<redacted:key>`, and Studio adds
the built-in key names plus `instrument.state.redact.paths` from `brighttest.json`. **show raw** reveals only what
Studio masks on top of the agent's own masking, behind a banner, and makes exports unredacted.
Studio masks published app state everywhere it shows it read-only, including the State view when the hub is held or absent, the node list and run traces, using the built-in sensitive key names plus `instrument.state.redact.paths`. Only the State panel's **show raw** toggle (`?raw=1`) reveals raw values. Unmaskable text is shown as `<redacted:text>` (a run step that cannot be masked is shown without its nodes or app state). The failure message of an `assertState` step can still contain the asserted value. Without an
instrumented build the tab says no layers were published; see [Instrumented builds](/guide/instrument).

![State tab showing the global and scene layers, with a masked name and token](/images/studio/state-inspector.png)
*State tab, read from the scripted stand-in app (monitor picture is a placeholder frame). `name` and `token` are masked.*

### Editing

Editing needs the instrument hub: Studio starts it itself while it holds the lease, only when started with a device host,
and the build must have connected to it (an `agent.hello`). Click a value in `global`, `scene` or `registry` to edit it.
The value keeps its type (a string stays a string). The edit is validated like a `setState` flow step and sent to the app
as a command; an ack chip then walks **received**, **applied**, **reflected**, or shows the error. **+ setState step**
adds the edit to the open flow, and **+** on a leaf adds an `assertState`. Registry values are edited as a whole
`<section>.<key>` value; a `<redacted:...>` marker is never written (HTTP 400 `REDACTED_VALUE`). The hub logs each
command as `cmd.sent` and the app's replies as `cmd.ack`.

![State tab after editing theme to light, with a reflected chip and a setState step button](/images/studio/state-edit.png)
*An edit of `theme` acked through to **reflected** (monitor picture is a placeholder frame); a snapshot was saved with **save**.*

Snapshots (save, restore, delete, diff, export, import) are capped at 64 KB each, 20 kept. The history list shows each
edit and restore with its ack phase. The action log, time travel and "save as spec fixture" routes are described in
[Instrumented builds](/guide/instrument) and [State fixtures](/writing-tests/state-fixtures).

### Node State view

The **Node** tab has a **Fields** / **State** switch (Fields, the ECP strings, is the default; the choice is kept for the
session). **State** reads the selected node through the app's agent over the hub (`GET /api/state/node`, no ECP request):
the node's own fields (**fields**) or its component's `m` (**m**), as the same value tree the State tab shows, with a
**refresh** button and the age of the last read. It refreshes every 2 s while it is visible, Live is on and nothing is
being edited. Open it by clicking a node on the monitor and choosing **State**, by the **state** button on a Tree row,
or by **Inspect state** in the right-click menu (the last two switch to the Node tab in State view).

- **Edit** a leaf like in the State tab: the value keeps its type, the edit is sent with `layer: node` or `m` and the
  node id, and an ack chip walks received, applied or shows the refusal (`FIELD_NOT_FOUND`, `TYPE_MISMATCH`,
  `PATH_UNDER_NODE`, `M_NOT_AVAILABLE`, `M_PATH_FORBIDDEN`, `NODE_NOT_FOUND`, `REDACTED_VALUE`, `STATE_TOO_LARGE`) with a
  short hint. The edited path is read again afterwards. **+ setState step** adds the edit to the open flow. `PATH_UNDER_NODE`
  offers **go to node**.
- A value that is a node reference (`{ "$node": id }`) is a link that selects that node in the tree; it is not editable.
  Truncation and type markers are read only, and a `$truncated:depth` row has **load** to read that sub-path.
- Masked values (`<redacted:key>`) are read only; **show raw** reveals only Studio's extra masking.
- When the whole read is over 64 KB the view says so: node fields list the field names from the tree and read each when
  you pick it, and `m` offers a path box (`node-state-path`).
- A selected node with no id cannot be read (the agent finds nodes by id): the view says to give it one or pick an
  ancestor. If several tree nodes share the id, a warning says the agent reads the first one it finds.
- Without a hub (no `BRIGHTTEST_HUB_TOKEN`, pool mode), with the device held by another session, or before the app has
  said hello, the view shows that reason and edits are off; the Fields view keeps working.
- On the simulator target there is no tree, so type the node id into the box (`node-state-id`); reads and edits go
  through the hub as usual.
- **+** next to a node field adds `assertField` using the tree's string value, only for fields in the node's ECP
  attributes. `m` has no assertion button yet.

### Actions tab

The **Actions** tab lists the app's `state.action` log (seq, type, hash before and after) and refreshes every 2 s. **Travel** on a
row restores the state recorded at that entry. The 202 reply carries a note that is shown as-is: it restores the recorded state
only, and the effects of later actions (network, registry, tasks) are not undone. An entry with no recorded snapshot answers
409 `NO_SNAPSHOT`. Recording a snapshot is route-only: Studio has no record control. The tab shows a message, and no rows, when
there is no hub, the device is held elsewhere, or the routes are unreachable.

### Refusals you may see

| Message or code | Meaning |
| --- | --- |
| `Device is held elsewhere; edit not sent.` (HTTP 423) | Another session holds the device; nothing was written. |
| 503 `NO_HUB` | No instrument hub (no device host, or no valid `BRIGHTTEST_HUB_TOKEN`); the panel falls back to read only. |
| 409 `STATE_NOT_INSTRUMENTED` | No `agent.hello` yet: the build is not instrumented or has not reached the hub. |
| 400 `REDACTED_VALUE` | The value is a mask marker, not a real value. |
| 413 `STATE_TOO_LARGE`, 409 `STORE_FULL` | Request body over 256 KB or state payload over 64 KB, or 20 snapshots already stored. |
| 502/`ACK_TIMEOUT` | The app did not ack in time (12 s wait on the synchronous routes). |

## Profile page

The **Profile** page has a live session (CPU, memory, texture memory and page-fault charts with markers, JSON and CSV
export), a texture inventory, the SceneGraph console buttons (`sgperf`, textures, FPS display), a Perfetto system trace
and `.bsprof` import or pull. See [Troubleshooting](/guide/troubleshooting#console-command-answers-command-not-recognized-or-returns-nothing)
for console replies and [the lease page](/guide/device-lease#perfetto-tracing-cannot-be-switched-off) for why Perfetto
tracing cannot be switched off from Studio.

Agents can read the same data without Studio's UI through the [`perf_summary` and `perf_trace_summary` MCP tools](/guide/mcp#profiling-read-only) (read-only).

![Profile page with the live profiling, console, Perfetto and bsprof panels](/images/studio/profile.png)
*Profile page against the fake Roku: the panels are shown empty because the fake serves no profiling data.*

## Overlay switch

The **overlay** checkbox in the header (Inspect and Record pages) turns the node outlines on the picture on or off. It
is on by default and Studio remembers the choice in the browser (`localStorage`, per origin); nothing is stored on the
server or in config.

- **Off:** nothing is drawn over the picture (no outlines, hover or run highlight), clicking the picture selects
  nothing, and **all nodes** and **offscreen** are disabled. The selected node stays selected, so the Node tab and the
  context-menu steps still work from the Tree tab. The monitor header shows "overlay off".
- **Tree reads:** with the overlay off, Studio reads the SceneGraph tree only while the Node, Tree or Selector tab is open
  on the Inspect page, or the State tab shows the read-only app state; then once a second instead of every 300 ms.
  Otherwise it reads nothing, which frees the device for screenshots and key presses.
- Turning the overlay on reads the tree at once.

## Other pages

**Runs** (run flows and step through a time-travel trace; each run frame carries the app state snapshot), **Record**
(capture remote presses into a flow), **Devices** (discover and switch Rokus) and **Settings** (a placeholder with no
working controls). **Run** executes state and network steps too (`setState`, `snapshot`, `restore`, `callFunc`, `waitForAgent`, `mockHttp`, `assertRequest` and the rest) through Studio's own hub, the same way `brighttest e2e run` does; with no hub (no `BRIGHTTEST_HUB_TOKEN`, pool mode) such a flow fails before step 1 with the hub's message. `assertLog` and `expectNoLog` still need `e2e run`. **Stop** (`POST /api/run/stop` with the `runId` from the stream's `start` event; 200, or 409 `NOT_RUNNING`) ends a run between steps or mid-step: a polling step stops within about 250 ms, at most one device request is still in flight, and the stream sends `stopped` then `done` with `stopped: true`. The run is saved as **stopped**, the end-of-run cleanup (network rules, flow snapshots, unmatched mode) runs as for any end, and Studio keeps the device lease. A `setState`, `snapshot`, `restore` or `callFunc` already queued on the hub is not recalled and may still apply. Closing the page also stops the run, and only one run is active at a time (a second `/api/run` answers 409 `RUN_IN_PROGRESS`). The **Network** tab shows the hub's HTTP traffic; see [E2E: Network panel](/e2e/#network-panel).

## Driving Studio from a browser agent

Studio's controls carry a stable `data-testid` (selector `[data-testid="flow-run"]`) and, for icon-only controls, an
`aria-label`, so a browser agent or a test can find them without relying on layout or wording. The ids are part of the
Studio contract: they do not change between releases without a changelog note, and a unit test
(`test/studio-agent-labels.test.js`) fails if one goes missing. They name controls only; Studio has no WebMCP tools.

| Area | Ids |
|---|---|
| Shell and device | `studio-app`, `studio-header`, `device-summary` (model and firmware, or "no device"), `page-nav`, `nav-inspect`, `nav-runs`, `nav-record`, `nav-devices`, `nav-profile`, `nav-settings` |
| Lease and device status | `lease-badge`, `lease-badge-summary`, `lease-queue`, `lease-bar` (banner while another holder has the device), `lease-queued`, `lease-take-over`, `sim-badge`, `sim-tail` |
| Live monitor | `live-monitor`, `monitor-stage`, `monitor-screenshot` (the live screenshot), `monitor-overlay` (the node outlines), `monitor-needs-device`, `toggle-live`, `toggle-overlay`, `toggle-all-nodes`, `toggle-offscreen`, `live-status` |
| Inspect page | `page-inspect`, `inspector-panel`, `tab-node`, `tab-tree`, `tab-selector`, `tab-state`, `tab-actions`, `tab-net` |
| Node State view | `node-view-fields`, `node-view-state`, `tree-node-state` (Tree row), `menu-inspect-state` (right-click menu), `node-state`, `node-state-id`, `node-state-layer-node`, `node-state-layer-m`, `node-state-refresh`, `node-state-raw`, `node-state-age`, `node-state-dup`, `node-state-noid`, `node-state-reason`, `node-state-large`, `node-state-field`, `node-state-path`, `node-state-notfound`, `node-state-rows`, `node-state-edit`, `node-state-input`, `node-state-chip`, `node-state-step`, `node-state-goto`, `node-state-goto-under`, `node-state-load` |
| Remote | `remote-panel`, `remote`, `remote-key-up`, `remote-key-down`, `remote-key-left`, `remote-key-right`, `remote-key-select`, `remote-key-back`, `remote-key-home`, `remote-needs-device` |
| Flow editor | `flow-tree`, `flow-tree-show`, `flow-editor`, `flow-name`, `flow-editor-text`, `flow-save`, `flow-run`, `flow-message`, `flow-run-steps` |
| Record page | `page-record`, `record-start`, `record-stop`, `record-clear`, `record-save`, `record-message`, `record-doc` |
| Devices page | `page-devices`, `devices-discover`, `device-current`, `devices-message`, `device-list`, `device-row`, `device-connect` (one per row), `lease-board`, `lease-device` |
| Runs page and trace viewer | `page-runs`, `run-history`, `run-history-item`, `trace-viewer`, `trace-frame`, `trace-scrubber`, `trace-prev`, `trace-slider`, `trace-next`, `trace-position`, `trace-steps`, `trace-step` |
| Profile page | `page-profile`, `profile-controls`, `profile-start`, `profile-stop`, `profile-interval`, `profile-marker`, `profile-export-json`, `profile-export-csv`, `profile-tiles`, `profile-snapshot-textures`, `profile-perfetto-enable`, `profile-perfetto-start`, `profile-perfetto-stop`, `profile-perfetto-heap`, `profile-bsprof-import`, `profile-bsprof-pull` |
| Profile console buttons | `profile-console-free`, `profile-console-sgperf-start`, `profile-console-sgperf-report`, `profile-console-sgperf-stop`, `profile-console-loaded-textures`, `profile-console-fps-display-on`, `profile-console-fps-display-off`, `profile-console-logrendezvous-on`, `profile-console-logrendezvous-off` |

Studio has no refresh or screenshot button: the monitor refreshes on its own (about once a second) while `toggle-live`
is on, and `monitor-screenshot` always holds the latest frame. Controls that need a device are disabled or replaced by a
`*-needs-device` note when Studio runs on the simulator target. The screenshot and node outlines show the device screen,
so treat an agent's captures of them like any other device output.

## Simulator target (no device)

```sh
brighttest studio --simulator [--port 8700] [--flows-dir flows] [--open]
```

Builds your app instrumented, runs it on the local brs-node engine and points Studio at that instead of a Roku. It is
state-only: the AppState panel works, while panels that need a device (tree, screenshot, remote, run, connect, launch,
performance) answer 409 `SIMULATOR_TARGET`, and the Network panel needs a device. The banner prints the engine as
`simulator <name>@<version> (<flavor>)`.

- **Engine**: `auto` (the patched engine when installed, else the stock `brs-node` shipped as a brighttest dependency) unless `engines.brsNode` or `BRIGHTTEST_ENGINES` picks another one.
  If the engine is missing from `node_modules` it exits 1 and prints the `npm i brs-node` hint.
  A `brs-node` installed in your own project wins over the bundled one, and the banner shows its version.
  Both engines declare the `brs-cli` bin, so `npx brs-cli` may run either one; brighttest itself reads each engine's
  path from its package, so it is not affected.
- **Install step**: nothing extra to install; `npm i brs-node` only if it is missing from `node_modules`.
- **Header badge**: instead of the device lease badge the header shows the engine and its
  state, like `simulator · brs-node@2.7.1 (stock) · running`. The Screen mirror, Remote and Run controls say they need a device. The State tab shows live layers in
  this mode: each refresh asks the app for a `snapshot` through the instrument hub (quiet: it is not logged, streamed
  or listed, so refreshing never evicts the action log). Simulator layers cover global, scene, node and registry and
  exclude `focus` (a device-only read). Before the app has said hello, or when the engine is `no-hello` or has exited,
  `GET /api/state` answers 200 with `layers: null`, `agentReadFailed: true` and `agentCode: SIM_NOT_CONNECTED`
  (`the simulator is not connected (state: <state>)`), and nothing is queued. A read that races a fresh app hello can
  answer `CMD_FAILED` (the hello abandons open commands); the next refresh succeeds. Edits made from the State
  panel (`/api/state/cmd`) apply as before. Run is disabled (`/api/run` answers 409).
- **States** (also in `GET /api/device` as `state`): `starting` (engine launched), `settling` (the app said hello, Studio
  waits about 1.5 s for it to stay quiet), `running` (ready), `no hello from the app` (`no-hello`) and `engine exited`
  (`exited`). Hover the badge to read the last engine output.
- **No hello**: after 30 s without an `agent.hello` the state becomes `no-hello`. It means the app never started its
  agent: the build is not instrumented, the app crashed before the agent started, or you picked the patched engine,
  which can hang on Tasks. Studio prints the engine output and keeps the engine running so you can read it; stop Studio
  to end it.
- **Resend an abandoned first command**: a command sent in the first seconds after the app says hello can be dropped
  when the hub resyncs (it shows `abandoned`). Send it again; reads simply re-run on refresh. Scripts that send
  commands should wait until the state is `running`.
- **Conflicts**: `--simulator` with `--host`, or with a `deviceLease.pool`, exits 2. `--simulator=<value>` exits 2
  (the flag takes no value). `--password` is ignored, with a warning.
- **Exit codes**: 2 for a usage error or a missing UI bundle, 1 for any other start failure.

## Troubleshooting

- **"UI not built" / exit 2**: run `npm run studio:build` in a source checkout.
- **403 forbidden host/origin or 415**: you reached Studio through a non-loopback name, or a script omitted
  `Content-Type: application/json`.
- **Everything answers 423**: someone else holds the device; see `brighttest device status`.
- **State tab is read only**: no hub or no hello yet; the message in the tab says which.
- **Port 8700 busy**: Studio prints the fallback port it chose.

## Verification status

- Checked against code and `--help` in this repo, and exercised headless with the fake Roku (the screenshots above, and
  the Studio unit tests in `test/studio-*.test.js`).
- **Not device-verified in these docs.** Real-device behaviour of Studio is not claimed here.
- **Not available yet**: a refusal of edits made against a stale view of the state. It does not exist in the code today;
  the 423 above is the lease refusal.
- The simulator target (`--simulator`, above) is covered by unit tests with a faked engine, and was exercised end to end
  headless with the stock engine and the greenfield example (badge, `running`, an edit reaching `reflected`, snapshot
  and restore). It was not compared with a device.

## Regenerating the screenshots

```sh
npm run studio:build
node scripts/docs-screenshots.js        # writes docs/public/images/studio/*.png
```

It needs a local Chrome (`CHROME_BIN` overrides the search), uses no dependencies and no device, and closes everything
it starts.
