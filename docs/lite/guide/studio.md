# Studio

::: info At a glance
**What it is for:** a local web app that mirrors a running Roku: live screenshot with node overlay, SceneGraph tree, remote, flow editor, run traces, recording, profiling and an app **State inspector**.

**You will:**
- start Studio against a device or the simulator
- inspect and edit app state, nodes and network calls
- arrange the Inspect page tiles
- run, stop and record flows; install stored builds

**First command:** `brighttest studio --host <roku-ip> --open`
:::

Lane details live in [E2E](/e2e/), [App state](/e2e/app-state) and [Sharing a device (lease)](/guide/device-lease#studio).

::: warning What the screenshots in the full guide are
They were captured by `scripts/docs-screenshots.js` against the in-repo **fake Roku** (`test/fixtures/fake-roku`) and a **scripted stand-in for an instrumented app** that acks edits. No real Roku: the monitor picture is a placeholder gradient frame, and the model and firmware text come from the fake. They show layout and messages, not device behaviour.
:::

Screenshot: see the full guide. (Inspect page: flow editor, live monitor, remote and the inspector panels Node, Tree, Selector, State, Actions, Network, each in its own tile. The header shows the model and the lease badge.)

## Start and stop

Build the UI once (source checkout only), set the password, start.

```sh
npm run studio:build          # once, from a source checkout (the UI bundle is not committed)
export ROKU_PASSWORD=<dev-password>
brighttest studio --host <roku-ip> --open
```

- Stop with Ctrl-C. Started via `npx brighttest studio`, Studio also stops within a few seconds if the npm process is killed (for example by a timeout wrapper), so it frees the port and lease.
- Listens on `127.0.0.1` only.
- A missing UI bundle prints an error and exits with code 2.

### Flags

From `brighttest studio --help`:

| Flag | Meaning |
| --- | --- |
| `--host <ip>` | Roku IP (or `ROKU_HOST`). Without it: the only cached device; several cached devices → refuses and exits; none → starts with no device, pick one on Devices. |
| `--password <pw>` | Discouraged (visible in the process list). Use `ROKU_PASSWORD`, `.env` or the device cache. Studio refuses to start for a host with no known password. |
| `--port <n>` | Default 8700. Without `--port`, a busy 8700 falls back to the first free of 8701-8709 (printed). An explicit busy port fails. |
| `--app <id>` | Channel to launch and drive (default `dev`). |
| `--as <agent>` | Lease holder label (`BRIGHTTEST_AGENT` also works). |
| `--flows-dir <dir>` | Where `*.e2e.yaml` flows are read and written (default `./flows`). |
| `--simulator` | Local engine instead of a device; see [Simulator target](#simulator-target-no-device). |
| `-o`, `--open` | Open the browser. |

### Hub line at startup

Studio prints one line about its instrument hub.

| Line | Meaning |
|---|---|
| `hub: on (port 8790, passthrough to 2 hosts)` | Hub running. |
| `hub: off (<why>)` | `BRIGHTTEST_HUB_TOKEN not set`, malformed token (must be 32 lowercase hex characters), no device, or a device pool. |

- Warns when the passthrough allow-list (`instrument.net.upstreamHosts`) is empty and `unmatched` is not `fail`.
- For a flow run from Studio, the hub's net config is `instrument.net` merged with the flow's `config.net` (flow wins per key), as in `e2e run`.

## Security model

Studio is for the local machine only. Scripts calling the API must send the right headers.

| Check | Refusal |
|---|---|
| `Host` must be `localhost`, `127.0.0.1` or `[::1]` | LAN names and reverse proxies are refused |
| No cross-site requests; `Origin` must be loopback | HTTP 403 |
| Non-GET needs `Content-Type: application/json` (`POST /api/perf/bsprof` also takes `application/octet-stream`) | HTTP 415 |

Source: `lib/studio/server.js`, the request guard near `LOOPBACK_HOSTS`.

## The device lease

Studio is a normal [device lease](/guide/device-lease#studio) client and never preempts.

- Takes the lease on the first request from an open tile or a user action.
- Releases after `studioIdle` (5 minutes) without user actions, or after `studioYield` (60 seconds idle) when someone is queued.
- While another session holds the device, device routes answer `423` with the lease status. The header badge shows the holder.
- **Take over** is the explicit override.
- The lease record is marked interactive (yield and idle timings, last action time, whether a run is in flight). A waiter sees `interactive: yields to waiters 60s after its last action; last action 12s ago` in its wait line and in `device status`, so it can tell Studio from a stuck process.
- `brighttest studio --as <agent>` sets the holder label (or `BRIGHTTEST_AGENT`).

### Scripted clients

A `423` queues nothing. To wait in one call instead of polling, send `POST /api/lease` with `{ "action": "acquire", "wait": "2m" }`.

```sh
curl -s -X POST http://127.0.0.1:8700/api/lease -H 'Content-Type: application/json' \
  -d '{"action":"acquire","wait":"2m"}'   # 200: Studio holds it, 423: still held, retry the route after 200
```

| Answer | When |
|---|---|
| `200` + lease status | Studio now holds the device |
| `423` + holder in `lease` | Wait ended; Studio leaves the queue |
| `400`, `code: "BAD_WAIT"` | `wait` invalid or over `deviceLease.wait` (default `30m`) |

- `wait` takes `90s`, `10m`, `1h` or milliseconds.
- A client disconnect drops the queued take-over.
- Without `wait`, the call queues Studio and answers at once.

Screenshot: see the full guide. (Another session holds the device: the banner offers **Take over when free**; the State tile switches to a read-only held view with "Device is held by another session". An edit sent after hand-over is refused with HTTP 423 and nothing is written; "Device is held elsewhere; edit not sent." may be replaced by the held view. The header badge updates on the next poll, so it can still read "Studio holding" or already "Studio released". The held view masks `name` and `token` like the live view.)

### The lease board on the Devices page

The **Lease** section shows one card per device, the same board as [`brighttest device watch`](/guide/device-lease).

- Each card: state, holder and for how long, waiting sessions, whether the device answers, recent runs, a hold-time bar strip (wait part in amber), last 24 hours in numbers.
- Reads `GET /api/lease/board`: needs no lease, takes none, never waits on the device. Reachability runs in the background, at most one small request per device every 30 seconds.
- Refreshes every 3 seconds, only while Devices is open.
- Studio's hold shows with purpose `studio :<port>` and the agent from `BRIGHTTEST_AGENT`, else `<user>@pid<N>`.

## State inspector

The **State** tile reads the instrumented app's `__bt_agent` node over ECP (one small request, not a tree walk).

- Layers: `global`, `scene`, `registry`, each marked **truncated** if the agent cut it.
- Without an instrumented build the tile says no layers were published; see [Instrumented builds](/guide/instrument).

### Redaction

| Layer of masking | Detail |
|---|---|
| Agent | Masks secret-looking keys as `<redacted:key>` |
| Studio | Adds built-in sensitive key names plus `instrument.state.redact.paths`, everywhere it shows app state read-only: State view when the hub is held or absent, node list, run traces |
| Unmaskable text | Shown as `<redacted:text>`; a run step that cannot be masked is shown without nodes or app state |

- Only the State panel's **show raw** toggle (`?raw=1`) reveals raw values, and only what Studio masked on top of the agent. It shows a banner and makes exports unredacted.
- The failure message of an `assertState` step can still contain the asserted value.

Screenshot: see the full guide. (State tile from the scripted stand-in app; `name` and `token` are masked.)

### Editing

Editing needs the instrument hub. Studio starts it itself while it holds the lease, only with a device host, and the build must have connected (an `agent.hello`).

1. Click a value in `global`, `scene` or `registry`. It keeps its type (a string stays a string).
2. The edit is validated like a `setState` step and sent as a command.
3. An ack chip walks **received**, **applied**, **reflected**, or shows the error.

- **+ setState step** adds the edit to the open flow; **+** on a leaf adds an `assertState`.
- Registry values are edited as a whole `<section>.<key>` value.
- A `<redacted:...>` marker is never written (HTTP 400 `REDACTED_VALUE`).
- The hub logs commands as `cmd.sent` and replies as `cmd.ack`.

Screenshot: see the full guide. (An edit of `theme` acked to **reflected**; a snapshot saved with **save**.)

- Snapshots (save, restore, delete, diff, export, import): 64 KB each, 20 kept.
- History lists each edit and restore with its ack phase.
- Action log, time travel and "save as spec fixture" routes: [Instrumented builds](/guide/instrument) and [State fixtures](/writing-tests/state-fixtures).

### Node State view

The **Node** tile has a **Fields** / **State** switch. Fields (the ECP strings) is the default; the choice is kept for the session.

**State** reads the selected node via the agent over the hub (`GET /api/state/node`, no ECP request):

- the node's own fields (**fields**) or its component's `m` (**m**), as the State tile's value tree;
- **refresh** button and age of the last read;
- auto refresh every 2 s while visible, Live is on and nothing is being edited.

Open it by: clicking a node on the monitor and choosing **State**; the **state** button on a Tree row; or **Inspect state** in the right-click menu (the last two switch the Node tile to State view).

| Topic | Behaviour |
|---|---|
| Edit | Like the State tile; sent with `layer: node` or `m` and the node id; chip walks received, applied, or a refusal with a hint. Edited path is re-read. **+ setState step** adds it to the flow. |
| Refusals | `FIELD_NOT_FOUND`, `TYPE_MISMATCH`, `PATH_UNDER_NODE` (offers **go to node**), `M_NOT_AVAILABLE`, `M_PATH_FORBIDDEN`, `NODE_NOT_FOUND`, `REDACTED_VALUE`, `STATE_TOO_LARGE` |
| Node references | `{ "$node": id }` is a link that selects that node; not editable |
| Markers | Truncation and type markers are read only; a `$truncated:depth` row has **load** for that sub-path. Masked `<redacted:key>` values are read only; **show raw** reveals only Studio's extra masking. |
| Over 64 KB | Node fields list names from the tree and read each on pick; `m` offers a path box (`node-state-path`) |
| No id | Cannot be read (agent finds nodes by id): give it one or pick an ancestor. Duplicate ids: warning that the first found is read. |
| Unavailable | No hub (no `BRIGHTTEST_HUB_TOKEN`, pool mode), device held elsewhere, or no hello yet: reason shown, edits off; Fields still works. |
| Simulator | No tree: type the node id in `node-state-id`; reads and edits go through the hub. |
| Assertions | **+** next to a node field adds `assertField` with the tree's string value, only for the node's ECP attributes. `m` has no assertion button yet. |

### Actions tile

Lists the app's `state.action` log (seq, type, hash before and after), refreshed every 2 s.

- **Travel** on a row restores the state recorded at that entry. The 202 reply's note is shown as-is: only recorded state is restored; effects of later actions (network, registry, tasks) are not undone.
- No recorded snapshot: 409 `NO_SNAPSHOT`. Recording a snapshot is route-only; Studio has no record control.
- No hub, device held elsewhere, or routes unreachable: a message and no rows.

### Refusals you may see

| Message or code | Meaning |
| --- | --- |
| `Device is held elsewhere; edit not sent.` (HTTP 423) | Another session holds the device; nothing written. |
| 503 `NO_HUB` | No hub (no device host, or no valid `BRIGHTTEST_HUB_TOKEN`); panel falls back to read only. |
| 409 `STATE_NOT_INSTRUMENTED` | No `agent.hello` yet: not instrumented or not reached the hub. |
| 400 `REDACTED_VALUE` | The value is a mask marker. |
| 413 `STATE_TOO_LARGE`, 409 `STORE_FULL` | Body over 256 KB or state over 64 KB, or 20 snapshots already stored. |
| 502/`ACK_TIMEOUT` | No ack in time (12 s wait on synchronous routes). |

## Profile page

Live profiling, console commands, Perfetto and `.bsprof`.

- Live session: CPU, memory, texture memory and page-fault charts with markers; JSON and CSV export.
- Texture inventory; SceneGraph console buttons (`sgperf`, textures, FPS display); Perfetto system trace; `.bsprof` import or pull.
- Console replies: [Troubleshooting](/guide/troubleshooting#console-command-answers-command-not-recognized-or-returns-nothing). Why Perfetto tracing cannot be switched off from Studio: [lease page](/guide/device-lease#perfetto-tracing-cannot-be-switched-off).
- Agents read the same data via the [`perf_summary` and `perf_trace_summary` MCP tools](/guide/mcp#profiling-read-only) (read-only).

Screenshot: see the full guide. (Profile page against the fake Roku; panels empty because the fake serves no profiling data.)

## Inspect layout (tiles)

The Inspect page is a grid of tiles, no tabs: Program monitor, Flow, Remote, and one tile per inspector panel (Node, Tree, Selector, State, Actions, Network).

### Arrange tiles

| Action | How |
|---|---|
| Move | Drag by the title. A ghost follows, a dashed placeholder shows the target, tiles below make room. 12-column grid, 32 px rows. |
| Resize | Drag the bottom-right grip. Minimums: monitor 3×5, remote 2×7, others 3×6 (columns × rows). |
| Minimize (`–`) | Keeps the place, shows only the header. The panel is unmounted, so polling or streams stop. Exception: Flow's editor stays mounted (minimized or hidden), keeping undo and cursor. |
| Hide | Tile menu `⋯`, or uncheck in **Tiles** in the header. Removes the tile from the grid. |
| Tile menu | Hide; move one cell; wider, narrower, taller, shorter (no dragging needed). |
| Pop out / Dock | **Tiles** → **Panels** list: **Dock** removes an inspector tile from the grid, **Pop out** brings it back to its previous slot if free, else the next free one. Right-click a node → **Pop out Node panel**. Node beside State = two popped-out tiles. Docked panels list newest first. |

The **Tiles** menu lists every tile with a checkbox, **Restore** for minimized ones, presets **Default** and **Monitor and info** (monitor large, Node and State beside it, rest hidden), and **Reset layout**. Presets and Reset ask to confirm: there is no undo.

### Saved layout

- Per browser, in `localStorage` key `bt.studio.layout.inspect` (`{"v":2,"reg":2,"tiles":[...],"panels":{"order":[...]}}`). A stored v1 layout loads unchanged and is saved as v2.
- Saved after each completed change, never during a drag. Nothing on the server or in config.
- Cleared key or unreadable value → default layout.

### Feed, polling and narrow windows

- **Feed:** the monitor keeps 16:9 at any size (largest 16:9 box, letterboxed); outlines are drawn on that box, so they stay aligned.
- **Polling follows what is open:** with the monitor minimized or hidden, no `/api/screenshot` and no overlay tree reads. Node, Tree and Selector still read the tree once a second while open. Restoring the monitor takes a screenshot at once.
- **Narrow windows:** under 960 px grid width, tiles stack in one column in reading order. Drag and resize are off; minimize, hide and Tiles still work; saved layout unchanged.
- **Running chip:** during a run with the Flow tile not open, a **Running · Stop** chip (`header-run-stop`) shows in the header. `Cmd+.` or `Ctrl+.` stops a run from anywhere.

### Keyboard

1. Tab to a tile's title (its drag handle).
2. Arrow keys move one cell; Shift + arrow makes it wider, narrower, taller or shorter. It never leaves the grid or goes under its minimum.
3. Each step is announced, for example "Program monitor tile, column 6, row 1, 6 by 11"; a blocked step says so.
4. Focus stays on the tile; **Escape** returns focus to the grid. Tab follows visual order.

- The tile menu has **Move left**, **Move right**, **Move up**, **Move down**.
- In the single-column view keyboard moves are off and a line at the top says why. Nothing animates on keyboard moves.

### Record page layout

Same grid with three tiles: Program monitor, Remote, Recording.

- Moving, resizing, keyboard, announcements and narrow single column work as on Inspect.
- Saved separately in `localStorage` key `bt.studio.layout.record` (same format, registry version 1), so one page never moves the other's tiles.
- The strip above the grid has a checkbox per tile (to bring back a hidden one) and **Reset layout**.
- Test ids: `tile-rec-monitor`, `tile-rec-remote`, `tile-rec-steps`.

## Overlay switch

The **overlay** header checkbox (Inspect and Record) turns node outlines on or off. On by default; remembered per browser (`localStorage`, per origin), not on the server or in config.

- **Off:** nothing drawn (no outlines, hover or run highlight), clicking the picture selects nothing, **all nodes** and **offscreen** are disabled. The selected node stays selected, so the Node tile and context-menu steps still work from Tree. Monitor header shows "overlay off".
- **Tree reads when off:** only while Node, Tree or Selector is open on Inspect, or the State tile shows read-only app state; once a second instead of every 300 ms. Otherwise none, freeing the device for screenshots and keys.
- Turning it on reads the tree at once.

## Capture-card feed (live video)

Screenshots refresh about twice a second at best. With the Roku's HDMI going into a USB capture card on the browser's machine, pick the card in **Screen source** (Inspect and Record header, device targets only).

All in the browser (`getUserMedia`): server, config and CLI unchanged; nothing stored in the project.

### Use it

1. Click **Allow camera access** so the browser shows device names.
2. Pick the card. Only on `http://localhost` or `https`.
3. Wait: the first 2 s show "waiting for signal" (cards often show a splash).
4. Studio fits a 16:9 picture area (whole frame for 16:9; centered 16:9 for 4:3 or ultrawide).
5. If needed, **Calibrate**: nudge arrows (10 scene pixels), zoom (1 %), **Reset to auto**, and an alignment aid (dashed whole-scene frame plus the focused node's outline).

Calibration is saved per capture device in `localStorage` key `bt.studio.feed.<deviceId>` (per origin).

### Behaviour

- Denied permission, missing card or a card held by another app: a message; Studio stays on screenshots.
- **Screenshots are off while a feed is live.** The tree is still read every 300 ms for overlay and remote. **Device screenshots**, or unplugging the card, restores on-demand screenshots (refresh, shot age) at once.
- **Overlay age and settling:** boxes come from tree reads, so the monitor shows "boxes 0.3 s old". After a remote press boxes dim with "settling" until two tree reads agree on focus (at most 3 s).
- **Reopening:** on load, reopens the last feed only if camera permission is already granted and the device is present. Never prompts by itself.

::: warning Limits
Protected (HDCP) playback may show black or an error screen; Studio does not work around it. The picture is not recorded or sent anywhere. Agents (MCP) do not see the feed.
:::

## Builds page

Lists the [build store](/guide/builds).

- Drop zips to add; edit label, tags, notes; pin, download, delete.
- Install on the connected device after a confirmation, under the device lease. Studio compares the build's hub token with its own and warns on a mismatch. No installs in simulator mode.
- Direct link: `http://localhost:<port>/#/builds`. Every page works the same way (`#/inspect`, `#/runs`, `#/record`, `#/devices`, `#/profile`, `#/settings`); the address bar follows the nav.

## Builds API

`/api/builds` serves the `brighttest builds` store. Same loopback and origin guard as the rest of Studio. `POST /api/builds` is the only route taking a raw body (`application/zip` or `application/octet-stream`).

| Route | Answers |
| --- | --- |
| `GET /api/builds`, `GET /api/builds/:id` | Store summary and records; 404 `BUILD_NOT_FOUND` |
| `POST /api/builds` (raw zip, `X-Build-Filename`, optional `?label=`) | 201 created, 200 deduplicated; 413 `BUILD_TOO_LARGE`, 422 `BUILD_INVALID_ZIP` / `BUILD_UNSAFE_ZIP` / `BUILD_NO_MANIFEST`, 503 `STORE_LOCKED`, 507 `STORE_WRITE_FAILED` |
| `PATCH /api/builds/:id` (`label`, `notes`, `tags`, `pinned`) | The record; 400 `BAD_FIELD` |
| `DELETE /api/builds/:id` (`{ "force": true }` for pinned) | 200; 409 `BUILD_PINNED` / `BUILD_BUSY` |
| `GET /api/builds/:id/download` | The zip (an instrumented zip holds its hub token); 410 `BUILD_BLOB_MISSING`, 409 `BUILD_BLOB_CORRUPT` |
| `POST /api/builds/:id/install` (`{ "allowTokenMismatch": false }`) | 202 `{ jobId, tokenCheck }`; 409 `RUN_IN_PROGRESS` / `INSTALL_IN_PROGRESS` / `TOKEN_MISMATCH` / `SIMULATOR_TARGET`; 400 `NO_DEVICE`; 423 `LOCKED` |
| `GET /api/builds/jobs/:jobId` | SSE `step`, `log`, `done`; past events replayed on re-attach; jobs kept 10 minutes; at most 8 open streams (429 `BUSY`) |
| `POST /api/builds/jobs/:jobId/cancel` | 200; 409 `NOT_RUNNING`. After upload started, the device may still finish installing |
| `GET /api/builds/current` | Dev channel on the device (`devApp`), matching build, `match`: `confirmed`, `probable`, `unknown` or `none` |

- An install runs under the device lease (same 423 and Take over flow), one at a time, and refuses during a run (and a run refuses during an install).
- `tokenCheck` is an enum only: `match`, `mismatch`, `no-studio-token`, `not-instrumented`, `unreadable`.
- The dev password and hub tokens never appear in a response, event or log line.

## Other pages

**Runs** (run flows, step through a time-travel trace; each frame carries the app state snapshot), **Record** (capture remote presses into a flow), **Devices** (discover and switch Rokus) and **Settings** (below). The **Network** tile shows the hub's HTTP traffic; see [E2E: Network panel](/e2e/#network-panel).

### Running flows

**Run** executes state and network steps (`setState`, `snapshot`, `restore`, `callFunc`, `waitForAgent`, `mockHttp`, `assertRequest` and the rest) through Studio's own hub, as `brighttest e2e run` does.

- No hub (no `BRIGHTTEST_HUB_TOKEN`, pool mode): such a flow fails before step 1 with the hub's message.
- `assertLog` and `expectNoLog` still need `e2e run`.
- One run at a time: a second `/api/run` answers 409 `RUN_IN_PROGRESS` (shown as "a run is already in progress"). Closing the page stops the run.

### Stopping a run

Stop ends a run between steps or mid-step.

| Way | Detail |
|---|---|
| Button | **Run** becomes a red **Stop** (`flow-stop`); then reads **Stopping...** until the run ends. After 5 s without an answer the page closes the stream, which stops the run anyway. |
| Keys | `Cmd+.` (macOS) or `Ctrl+.`, in the editor or anywhere on the page. Escape is left to the editor. |
| API | `POST /api/run/stop` with the `runId` from the stream's `start` event; 200, or 409 `NOT_RUNNING`. |

- A polling step stops within about 250 ms; at most one device request is still in flight.
- The stream sends `stopped`, then `done` with `stopped: true`. The run is saved as **stopped**.
- End-of-run cleanup (network rules, flow snapshots, unmatched mode) runs as usual. Studio keeps the lease.
- A `setState`, `snapshot`, `restore` or `callFunc` already queued on the hub is not recalled and may still apply.
- UI: the stopped step shows an amber square; the message reads "run stopped at step N (op)", plus a note if a state command was queued; Runs marks it with a **stopped** badge (`run-stopped-badge`).

### Settings page

Shows what Studio uses and where each value came from. It reads `GET /api/settings` once on open (and after Save): no polling, no device call, no lease. It changes only two things, on request.

| Section | Shows |
|---|---|
| Device | Target host and source (`--host`, `ROKU_HOST` in the environment, project `.env`, cached device, Devices page for this session, simulator or pool); the `.env` default when different. **Test connection** reads model, firmware, developer mode, ECP mode and a failing check's fix text, without the lease; 409 for the simulator or no device. |
| Dev password | Known or not, and the source. Never the value. |
| Device lease | `enabled`, `wait`, `maxHold`, `studioIdle`, `studioYield`, `pool`, each marked default, `brighttest.json` or environment; whether Studio holds the device. |
| Instrument hub | Running or why not (no `BRIGHTTEST_HUB_TOKEN`, malformed, pool mode, no device, no lease), address, whether `instrument.net` is set. **Hub token**: set, not set or malformed; never the value or length. |
| Project, Redaction, About | Redaction lists `instrument.state.redact.paths` names, never values. About: brighttest, Node and engine versions, with Copy for bug reports. |
| This browser | The `bt.studio.*` keys in local storage. |

The two changes:

- **Save as project default** writes `ROKU_HOST=<host>` to the project `.env` via the `brighttest setup` writer (one line; other lines including `ROKU_PASSWORD` kept; `.env` is git-ignored). It does not change the running target. Setup never asks for or stores the password.
  - `POST /api/settings/host` with `{ "host": "<host>" }`: only the current target or a cached device (403 otherwise), a bare IPv4 address or host name (400 otherwise); cross-origin refused (403).
- **Reset Studio preferences in this browser** confirms, then removes only the `bt.studio.*` keys. Nothing else in storage or on the server changes.

The response never carries a password, the hub token, a device serial or a lease id.

### Network details

Click a Network row (or press Enter) to open a details pane.

**Pane layout**

- Beside the list, or below it when the tile is under 720 px (**Stack** / **Side** flips it).
- Splitter: drag, or focus and arrow keys (5 % per step; Home and End go to limits); double-click resets to 50 %.
- Minimums: list 30 % and 160 px; details 280 px wide (160 px high stacked).
- Esc or close returns focus to the row. Up and Down move the selection; details follow.
- Size and orientation remembered in this browser (`bt.studio.net`).

**Tabs**

| Tab | Content |
|---|---|
| Headers | General block: source, rule, timings, sizes, redaction state, "Not in HAR export" for answers brighttest gave itself; the refused-host hint and "Allow this host". |
| Payload | Query parameters, form fields, request body. |
| Response | JSON as a collapsible **Tree** (same as the State panel; arrow keys and `*`), plus **Pretty** and **Raw**. |

**Bodies**

- Pretty and Raw have search (Enter / Shift+Enter jump, `Aa` matches case) and Copy.
- At most 256 KB renders at once; "Show all" goes to the 1 MB the server sends. A cut body says so and offers **Download body**.
- A body cut at 1 MB has no Pretty, Raw toggle or Tree (cut JSON cannot be parsed); raw text is still shown. Download it to read all.
- Images (PNG, JPEG, GIF, WebP, BMP, AVIF up to 512 KB) preview. Other binary: size, type and a hex dump of the first 512 bytes.
- Downloads keep the server's file name.

**Copy as cURL and secrets**

- **Copy as cURL** (top of the pane): Authorization, Cookie and similar headers become `<redacted>`; URL and body keep the server's redaction. Real values only while **show secrets** is on.
- Single quotes in bodies are escaped; a binary or cut request body is left out with a comment.
- **show secrets** applies to details too (fetched raw, banner shown). Redacted is the default.

## Driving Studio from a browser agent

Controls carry a stable `data-testid` (selector `[data-testid="flow-run"]`), and icon-only controls an `aria-label`, so agents and tests do not rely on layout or wording.

- The ids are part of the Studio contract: no change between releases without a changelog note. A unit test (`test/studio-agent-labels.test.js`) fails if one goes missing.
- They name controls only; Studio has no WebMCP tools.

In the table, `<tile>` stands for each of `monitor`, `flow`, `remote`, `node`, `tree`, `selector`, `state`, `actions`, `network`.

| Area | Ids |
|---|---|
| Shell and device | `studio-app`, `studio-header`, `device-summary` (model and firmware, or "no device"), `page-nav`, `nav-inspect`, `nav-runs`, `nav-record`, `nav-devices`, `nav-builds`, `nav-profile`, `nav-settings` |
| Settings page | `settings-page`, `settings-device-source`, `settings-test-connection`, `settings-password-status`, `settings-hub-status`, `settings-token-status`, `settings-save-host`, `settings-save-result`, `settings-reset-prefs`, `settings-about-copy` |
| Lease and device status | `lease-badge`, `lease-badge-summary`, `lease-queue`, `lease-bar` (banner while another holder has the device), `lease-queued`, `lease-take-over`, `sim-badge`, `sim-tail` |
| Live monitor | `live-monitor`, `monitor-stage`, `monitor-screenshot` (live screenshot), `monitor-refresh` (screenshot now), `monitor-shot-age`, `monitor-overlay` (outlines), `monitor-needs-device`, `toggle-live`, `toggle-overlay`, `toggle-all-nodes`, `toggle-offscreen`, `live-status` |
| Inspect page | `page-inspect` |
| Inspect tiles | `layout-grid`, `layout-placeholder` (target cell while dragging), `layout-live` (announcements), `layout-empty`, `layout-empty-show`; `tile-<tile>`; per tile `tile-<tile>-handle` (drag), `tile-<tile>-minimize`, `tile-<tile>-menu`, `tile-<tile>-hide`, `tile-<tile>-resize` |
| Tiles menu | `tiles-menu`, `tiles-menu-list`, `tiles-preset-default`, `tiles-preset-monitor-info`, `tiles-reset`, `tiles-confirm`, `tiles-cancel`, `header-run-stop` (header Stop chip); per tile `tiles-menu-item-<tile>` (checkbox), `tiles-restore-<tile>` (minimized) |
| Network panel and details | `net-panel`, `net-filter`, `net-clear`, `net-export-har`, `net-show-secrets`, `net-list`, `net-row` (has `data-id`), `net-detail-splitter`, `net-detail`, `net-detail-close`, `net-detail-orient`, `net-detail-general`, `net-detail-req-headers`, `net-detail-res-headers`, `net-detail-tab-headers`, `net-detail-tab-payload`, `net-detail-tab-response`, `net-redaction-badge`, `net-not-in-har`, `net-refused-hint`, `net-copy-url`, `net-copy-req-headers`, `net-copy-res-headers`, `net-query`, `net-mock-this`, `net-copy-rule`, `net-block`, `net-clear-rules`, `net-body` (has `data-side`), `net-body-pretty`, `net-body-raw`, `net-body-tree`, `net-body-tree-view`, `net-body-image`, `net-copy-curl`, `net-body-show-all`, `net-body-download`, `net-body-truncated`, `net-body-binary`, `net-body-search`, `net-body-search-next`, `net-body-search-prev`, `net-body-search-count`, `net-body-search-case`, `net-body-copy` |
| Node State view | `node-view-fields`, `node-view-state`, `tree-node-state` (Tree row), `menu-inspect-state` (right-click menu), `node-state`, `node-state-id`, `node-state-layer-node`, `node-state-layer-m`, `node-state-refresh`, `node-state-raw`, `node-state-age`, `node-state-dup`, `node-state-noid`, `node-state-reason`, `node-state-large`, `node-state-field`, `node-state-path`, `node-state-notfound`, `node-state-rows`, `node-state-edit`, `node-state-input`, `node-state-chip`, `node-state-step`, `node-state-goto`, `node-state-goto-under`, `node-state-load` |
| Remote | `remote-panel`, `remote`, `remote-key-up`, `remote-key-down`, `remote-key-left`, `remote-key-right`, `remote-key-select`, `remote-key-back`, `remote-key-home`, `remote-needs-device` |
| Flow editor | `flow-tree`, `flow-tree-show`, `flow-editor`, `flow-name`, `flow-editor-text`, `flow-save`, `flow-run`, `flow-stop`, `flow-message`, `flow-run-steps` |
| Record page | `page-record`, `record-start`, `record-stop`, `record-clear`, `record-save`, `record-message`, `record-doc` |
| Devices page | `page-devices`, `devices-discover`, `device-current`, `devices-message`, `device-list`, `device-row`, `device-connect` (one per row), `lease-board`, `lease-device` |
| Runs page and trace viewer | `page-runs`, `run-history`, `run-history-item`, `run-stopped-badge`, `trace-viewer`, `trace-frame`, `trace-scrubber`, `trace-prev`, `trace-slider`, `trace-next`, `trace-position`, `trace-steps`, `trace-step` |
| Profile page | `page-profile`, `profile-controls`, `profile-start`, `profile-stop`, `profile-interval`, `profile-marker`, `profile-export-json`, `profile-export-csv`, `profile-tiles`, `profile-snapshot-textures`, `profile-perfetto-enable`, `profile-perfetto-start`, `profile-perfetto-stop`, `profile-perfetto-heap`, `profile-bsprof-import`, `profile-bsprof-pull` |
| Profile console buttons | `profile-console-free`, `profile-console-sgperf-start`, `profile-console-sgperf-report`, `profile-console-sgperf-stop`, `profile-console-loaded-textures`, `profile-console-fps-display-on`, `profile-console-fps-display-off`, `profile-console-logrendezvous-on`, `profile-console-logrendezvous-off` |

### When the monitor takes a screenshot

With `toggle-live` on, only when something may have changed:

| Trigger | Timing |
|---|---|
| Key press | About 0.4 s after; a burst is one wait; never held back over 1.5 s |
| Node tree changed | Right after |
| Nothing happens | Every 5 s |

- A screenshot costs the device about a second and holds its one call queue; this keeps tree reads and key presses fast.
- `monitor-shot-age` shows the age ("just now", "3 s ago"); `monitor-refresh` takes one now. The picture can be up to 5 s old when the screen changes on its own (video, rotating banner) and the tree does not: press refresh.
- `monitor-screenshot` holds the latest frame. On the simulator target, device controls are disabled or replaced by a `*-needs-device` note.
- Screenshots and outlines show the device screen: treat an agent's captures of them like any other device output.

## Simulator target (no device)

Builds your app instrumented, runs it on the local brs-node engine and points Studio at it. State-only.

```sh
brighttest studio --simulator [--port 8700] [--flows-dir flows] [--open]
```

- The AppState panel works. Device panels (tree, screenshot, remote, run, connect, launch, performance) answer 409 `SIMULATOR_TARGET`; Network needs a device. Run is disabled (`/api/run` answers 409).
- The banner prints `simulator <name>@<version> (<flavor>)`.

### Engine

| Topic | Detail |
|---|---|
| Choice | `auto`: the patched engine when installed, else the stock `brs-node` shipped as a brighttest dependency, unless `engines.brsNode` or `BRIGHTTEST_ENGINES` picks another. A `brs-node` in your own project wins; the banner shows its version. |
| Missing | Exits 1 with the `npm i brs-node` hint. Nothing else to install. |
| `brs-cli` | Both engines declare the `brs-cli` bin, so `npx brs-cli` may run either. brighttest reads each engine's path from its package and is unaffected. |

### Header badge and states

The header shows the engine and state instead of the lease badge, like `simulator · brs-node@2.7.1 (stock) · running`. Screen mirror, Remote and Run say they need a device. Hover the badge for the last engine output.

States (also `state` in `GET /api/device`):

| State | Meaning |
|---|---|
| `starting` | Engine launched |
| `settling` | App said hello; Studio waits about 1.5 s for quiet |
| `running` | Ready |
| `no hello from the app` (`no-hello`) | No `agent.hello` after 30 s |
| `engine exited` (`exited`) | Engine ended |

### State tile on the simulator

- Each refresh asks the app for a `snapshot` via the hub, quietly (not logged, streamed or listed, so the action log is never evicted).
- Layers: global, scene, node, registry. Not `focus` (device-only).
- Before hello, or with `no-hello` or exited: `GET /api/state` answers 200 with `layers: null`, `agentReadFailed: true`, `agentCode: SIM_NOT_CONNECTED` (`the simulator is not connected (state: <state>)`); nothing queued.
- A read racing a fresh hello can answer `CMD_FAILED` (hello abandons open commands); the next refresh succeeds.
- Edits from the State panel (`/api/state/cmd`) apply as before.

::: details Troubleshooting the simulator
- **No hello:** the app never started its agent: not instrumented, crashed before the agent started, or you picked the patched engine, which can hang on Tasks. Studio prints the engine output and keeps the engine running so you can read it; stop Studio to end it.
- **Abandoned first command:** a command in the first seconds after hello can be dropped when the hub resyncs (shows `abandoned`). Send it again; reads re-run on refresh. Scripts should wait for `running`.
- **Conflicts:** `--simulator` with `--host` or a `deviceLease.pool` exits 2. `--simulator=<value>` exits 2 (no value allowed). `--password` is ignored with a warning.
:::

### Exit codes

| Code | When |
|---|---|
| 2 | Usage error or missing UI bundle |
| 1 | Any other start failure |

## Troubleshooting

| Symptom | Fix |
|---|---|
| "UI not built" / exit 2 | `npm run studio:build` in a source checkout |
| 403 forbidden host/origin, or 415 | You used a non-loopback name, or a script omitted `Content-Type: application/json` |
| Everything answers 423 | Someone else holds the device; see `brighttest device status` |
| State tile is read only | No hub or no hello yet; the tile says which |
| Port 8700 busy | Studio prints the fallback port |

## Verification status

What the full page claims was checked.

- Checked against code and `--help`, and exercised headless with the fake Roku (the screenshots, and unit tests `test/studio-*.test.js`).
- Simulator target: unit tests with a faked engine, plus end to end headless with the stock engine and the greenfield example (badge, `running`, an edit reaching `reflected`, snapshot and restore). Not compared with a device.

::: warning Not device-verified
Real-device behaviour of Studio is not claimed. **Not available yet:** refusing edits made against a stale view of state; it does not exist in the code. The 423 above is the lease refusal.
:::

## Regenerating the screenshots

Maintainers only.

```sh
npm run studio:build
node scripts/docs-screenshots.js        # writes docs/public/images/studio/*.png
```

Needs a local Chrome (`CHROME_BIN` overrides the search), no dependencies, no device; closes everything it starts.

## Related

- [Device lease](/guide/device-lease#studio): how Studio shares the device
- [E2E](/e2e/): flows that Studio edits and runs
- [App state](/e2e/app-state): the state model behind the State tile
- [Builds](/guide/builds): the build store
- [Instrumented builds](/guide/instrument): what the hub and agent need

**Full guide:** [Studio](full:/guide/studio) — the original wording.
