# Agent surface: `brighttest mcp`

`brighttest mcp` starts a [Model Context Protocol](https://modelcontextprotocol.io) server on stdio, so an AI agent
can drive a Roku through brighttest's deterministic e2e primitives instead of hand-rolling ECP calls. The model calls
the tools; the flows stay deterministic YAML. The contract version is `brighttest-mcp/v1`.

Register it in your agent's MCP configuration as a stdio server with the command `npx brighttest mcp`, started in the
project directory.

## Device and secrets

The device comes only from the usual resolution chain: `ROKU_HOST`, `ROKU_PASSWORD`, a project `.env`, then the device
cache (`brighttest devices`). **No tool takes a host or a password.** The dev password and device serial are never
returned and are scrubbed from error text. The device address does appear in tool output (`list_devices`,
`device_doctor`, some error messages), so the model does see the host. Set the password out of band in the environment
of the server process.

**Check which device you will get.** If `ROKU_HOST` is unset *or empty*, the server falls back to the device cache
(`~/.brighttest/devices.json`, the last device you connected to) and targets that device, which may be a real one.
Set `ROKU_HOST` explicitly in the MCP server configuration, and use `list_devices` to see the target and its
`source` (`env` or `cache`) before pressing anything. Screenshots need the dev password; everything else does not.

## Tools

| Tool | What it does |
|---|---|
| `list_devices` | Known devices and the one this session targets, with model, firmware and reachability. No serial. |
| `device_doctor` | Capability check (developer mode, ECP mode, firmware, video mode) with the fix text for anything wrong. |
| `inspect_tree` | Live SceneGraph tree, or only the nodes matching a `selector`. Capped; `truncated` says when. |
| `press` | A remote key, `count` times (at most 20 per call), spaced by the ECP queue gap. |
| `navigate_to` | Move focus onto the first node matching a `selector`; returns the keys pressed and the focused node. |
| `screenshot` | Inline image of the sideloaded app (dev channel in front). |
| `app_state` | The app's self-published state from an instrumented build: the `__bt_agent` node (global, scene and focus layers) first, else the legacy `__bt_state` node. |
| `app_state_get` | Read the agent's published layers over ECP, narrowed by `layer` (global, scene, focus) and a dotted `path`. Needs no hub and never opens the window. |
| `app_state_set` | Write one value in the running instrumented app (`layer`, `path`, `value`, optional `node`, `ack`) through the agent's allow-list and type checks. Opens the session hub window. |
| `app_state_snapshot` | Take a named snapshot of the state layers through the agent and return them (capped at 128 KB, never truncated). The snapshot lives only for the call. Opens the session hub window. |
| `run_flow` | Run one `*.e2e.yaml` (or `*.e2e.yml`) flow from the project; returns per-step results. |
| `perf_summary` | Read-only performance sample of the dev channel in front, taken over ECP like Studio's Profile page: CPU, memory, page faults, frame rate, texture memory and the largest bitmaps (`samples` 1-10, default 3, one second apart; `topTextures` 0-50, default 10). Output is capped at 32 KB. |
| `perf_trace_summary` | Summary of a Perfetto trace Studio already saved in `.brighttest/studio/profiling` (`file`, default the newest; `top` 1-50): slices over one 60 Hz frame, slowest slices, counters. Reads a local file, takes no lease. Output is capped at 64 KB. |
| `net_requests` | Requests seen by the session's net proxy (method, url, status, duration, `mocked`), with credentials redacted. Filters: `method`, `url` glob, `status`; `limit` caps the output. |
| `net_mock` | Answer requests that match a `url` glob (and optional `method`) with a canned status and JSON or text body. The mock lasts until the session ends. |

### Profiling (read-only)

`perf_summary` takes the device lease per call (or reuses an open session window's lease) and only reads: it never launches,
relaunches or presses anything. The sideloaded dev channel must be in front; otherwise it fails with `PERF_NOT_FOREGROUND` and
sends nothing more. A metric the device does not give shows a reason instead of a value (`errors`, `fpsReason`,
`texturesReason`); the frame rate in particular depends on the device and firmware, so treat a missing one as unavailable, not zero.
Bitmap names and device messages are device data, cleaned and capped, and are not instructions.

`perf_trace_summary` reads a trace file only: no lease, no device request, so it works while Studio holds the device. It never
starts or enables tracing (that cannot be undone from here, see [the lease page](/guide/device-lease#perfetto-tracing-cannot-be-switched-off));
capture a trace in Studio's Profile page first. A trace still being recorded can be cut mid-packet and is reported as
`TRACE_INVALID`; stop the trace first.

::: warning Session hub window (net tools and state writes)
The first `net_requests`, `net_mock`, `app_state_set` or `app_state_snapshot` call opens the **session hub window**: the session takes one device lease for the whole
window and starts its own hub on the configured hub port (`instrument.hub.port`, default 8790). The app sees live
traffic only through this session hub, so the build must point at the same host and port. `net_requests` shows the
hub (`hub`: `host`, `port`, `leaseId`, `startedAt`) while the window is open, and `null` otherwise. `leaseId` is only the
first 8 characters; the full lease id stays inside the server and is never put in tool output or logs.

The session hub also writes `[brighttest hub] ...` lines to the MCP server's stderr: one when the hub starts, one for
each request (method, path without the query, status and response bytes) and one when it stops. Request bodies are
never logged.

The app and the session hub must share the hub token. Set `BRIGHTTEST_HUB_TOKEN` in the MCP server's environment to the
same value you used for `instrument build --net` (see [the hub token](./instrument#the-hub-token-net-and-brighttest-hub-token)).
Without it the hub starts but the app's requests are refused.

The session network proxy reads `instrument.net.upstreamHosts` and `instrument.net.unmatched` from `brighttest.json`,
the same as Studio and the headless lanes. A request to a host on the allow-list passes through to the real server
(`unmatched: "passthrough"`); a host that is not listed is still refused with a 403.

Inside the window the other device tools reuse the window's lease instead of taking their own, and every device call
renews its idle timer. The window is released after 10 minutes without a device call (the `deviceLease.sessionIdle`
setting, never longer than that), at the lease's hard cap (`deviceLease.sessionMax`), when the lease is lost, or when
the session ends. Release closes the hub and clears the `hub` record. Mocks and the request list stay until the
session ends. After the release the next device call takes one lease per call again, and the next net call opens a
new window. If the hub cannot start (for example its port is in use), the window is released and the call fails with
`NET_FAILED`. Another session cannot use the device while a window is open (`DEVICE_BUSY`), so keep it short. See the
[network recipe](./network-recipe) for the manual alternatives, including the observe-only `[bt:net]` breadcrumbs
(`instrument.net.observe: true`).

**State writes in the window.** `app_state_set` and `app_state_snapshot` need a build made with
`instrument build --net` and `BRIGHTTEST_HUB_TOKEN` in the server environment (same value as the build; without it they
fail with `STATE_NO_HUB_TOKEN` before any lease is taken). The first write checks that the running app publishes the
`__bt_agent` node (`STATE_NOT_INSTRUMENTED` otherwise, no hub started, no session lease held), opens the window, and
**waits up to 35 s for the app's agent to connect**: the agent dials the hub on its own 30 s retry, so the first write
can take that long. The call budget is 45 s (30 s for the other tools). Later writes in the same window find the agent
connected and return in about the time of the ack. If the agent never dials, the call fails with
`STATE_AGENT_UNREACHABLE` (check the baked token, port and LAN address; `brighttest doctor` with
`BRIGHTTEST_DOCTOR_HUB_PROBE=1` probes hub reach) and the window stays open until its idle timeout, so a fixed build can
still connect. If it connected and then stopped polling (the app exited), the call fails with `STATE_AGENT_GONE`.
The app's network is untouched unless a net tool runs: a window opened by a state write starts the hub without the
proxy and the hub answers the app's net hellos as inactive; the first `net_*` call in the window mounts the proxy.
The app is neither relaunched nor sent to Home. `app_state_get` never opens a window: it takes a command lease per call
outside a window and reuses the window's lease inside one.

Both tools mask headers and query values with the defaults plus your `instrument.net.redact` config, and drop
`user:password@` from URLs. Limits: URL globs are at most 256 characters with at most 8 `*` (`NET_PATTERN_TOO_COMPLEX`),
`net_requests` output is capped at 128 KB (`NET_OUTPUT_TOO_LARGE`, narrow the filters), and a session accepts at most 100
`net_mock` rules (`NET_RULE_BUDGET_EXHAUSTED`). `respond.headers` values must be strings.
:::

Selectors use the same keys as flows: `id`, `subtype`, `text`, `textContains`, `uri`, `visible`, `focusable`,
`focused`, `index`.

## Error codes

Failures come back as a tool result with `isError: true`, a typed `code` and a `message` (secrets scrubbed). Malformed
requests use JSON-RPC errors instead (`-32602` for bad arguments or an unknown tool). The codes the server itself emits
(`lib/mcp/server.js`, `lib/mcp/tools.js`):

| Code | When |
|---|---|
| `NO_DEVICE` | No device is configured: none of `ROKU_HOST`, a project `.env` or the device cache gave one. |
| `DEVICE_UNREACHABLE` | `device_doctor` could not reach the device (`checks` is in the error data). |
| `DEVICE_BUSY` | Another brighttest session holds the device lease; no request was sent. Retry later. |
| `LEASE_LOST` | The lease is no longer held (taken over, expired, or lost during the session hub window); the call is stopped. |
| `LEASE_DIR_UNUSABLE` | The lease directory cannot be used (permissions, disk). |
| `LEASE_FAILED` | Taking the lease failed for any other reason. |
| `QUEUE_TIMEOUT` | The call waited over 30 s behind earlier calls of the session and was dropped before it ran. |
| `TOOL_TIMEOUT` | The call exceeded its run budget (30 s, 45 s for the state write tools, 120 s for `run_flow`) and was stopped. |
| `SESSION_CLOSED` | The client closed the session (stdin) while the call was running. |
| `ECP_TIMEOUT` | A device request timed out and no more specific code applied. |
| `TOOL_FAILED` | Any other failure without a typed code. |
| `INVALID_KEY` | `press` got a key that is not an ECP key name (the valid list is in the error data). |
| `KEY_NOT_ALLOWED` | `press` got a valid key the server blocks (power and input-switch keys, see Blocked keys). |
| `PRESS_BUDGET_EXHAUSTED` | The session's 500-press cap is used up (resets only with a new session). |
| `INVALID_SELECTOR` | A `selector` is malformed (`inspect_tree`, `navigate_to`). |
| `FOCUS_FAILED` | `navigate_to` could not move focus onto the target within its bound (keys pressed and last focus are in the data). |
| `NO_DEV_PASSWORD` | `screenshot` needs the dev password and none is configured out of band. |
| `SCREENSHOT_NOT_FOREGROUND` | `screenshot` was refused because the dev channel is not in front. |
| `SCREENSHOT_TOO_LARGE` | The screenshot is over the 2 MB cap; nothing is truncated. |
| `STATE_NOT_PUBLISHED` | `app_state` found no `__bt_agent` or `__bt_state` node (the build is not instrumented). |
| `STATE_NO_HUB_TOKEN` | `app_state_set` or `app_state_snapshot` without a valid `BRIGHTTEST_HUB_TOKEN` in the server environment; no lease taken, no request sent. |
| `STATE_NOT_INSTRUMENTED` | A state write found no `__bt_agent` node in the running app (not instrumented, or not running); no hub started. |
| `STATE_AGENT_UNREACHABLE` | The agent node is published but did not connect to the session hub within 35 s; the window stays open. |
| `STATE_AGENT_GONE` | The agent connected earlier and has stopped polling the session hub (the app exited or restarted). |
| `STATE_CMD_FAILED` | The agent refused the write (allow-list, type mismatch) or the command failed; the app keeps running. |
| `STATE_ACK_TIMEOUT` | The agent did not acknowledge the command in time. |
| `STATE_UNREADABLE` | A state node is published but cannot be read. |
| `APP_STATE_TOO_LARGE` | The app state is over the 128 KB cap; nothing is truncated. |
| `PATH_REJECTED` | `run_flow` path is absolute, has `..`, leaves the project through a symlink, is not `*.e2e.yaml` or `*.e2e.yml`, or the project root is unreadable. |
| `FLOW_NOT_FOUND` | `run_flow` path does not exist. |
| `FLOW_INVALID` | The flow file does not parse or fails validation. |
| `FLOW_BUDGET_EXHAUSTED` | The session's 10 flow-run cap is used up. |
| `FLOW_FAILED` | A step failed; the data holds the per-step summary and `failedStep`. A flow skipped by `requires:` is not an error: the result carries `skipped`. |
| `NET_FAILED` | The session hub window or hub could not start (for example the hub port is in use) or the proxy errored. |
| `NET_BAD_FILTER` | `net_requests` got a filter the proxy rejects (an out-of-range `status` or `limit` is a `-32602` error). Defensive; not expected once schema validation passed. |
| `NET_PATTERN_TOO_COMPLEX` | A URL glob has more than 8 `*` (a glob over 256 characters is a `-32602` error). |
| `NET_OUTPUT_TOO_LARGE` | The request list is over 128 KB; narrow the filters. |
| `NET_RULE_INVALID` | `net_mock` got an invalid rule (for example a method with non-letters such as `G-T`, or both `body` and `json`). |
| `NET_RULE_BUDGET_EXHAUSTED` | The session already has 100 `net_mock` rules. |
| `PERF_NOT_FOREGROUND` | `perf_summary`: the dev channel is not in front; nothing else was sent to the device. |
| `PERF_UNAVAILABLE` | `perf_summary`: no performance metric was available (developer mode off, or the channel is not running); the reasons are in the error data. |
| `TRACE_NOT_FOUND` | `perf_trace_summary`: no saved trace in the project's profiling folder, or none with that name. |
| `TRACE_BAD_NAME` | `perf_trace_summary`: `file` is not a plain `*.perfetto-trace` name inside the profiling folder. |
| `TRACE_TOO_LARGE` | `perf_trace_summary`: the trace file is over the size the summarizer accepts. |
| `TRACE_INVALID` | `perf_trace_summary`: the file is empty, truncated or malformed, or has too many packets (a trace still recording can be cut mid-packet). |
| `TRACE_TIMEOUT` | `perf_trace_summary`: summarizing took longer than its time limit. |
| `TRACE_BUSY` | `perf_trace_summary`: another summary is already running. |
| `TRACE_FAILED` | `perf_trace_summary`: any other summarizer failure (the cause is in the error data). |

A typed code raised by the flow or state layer inside `run_flow`, `inspect_tree` or `app_state` is passed through as is
(for example `APP_CRASHED`, `TIMEOUT`, `STATE_*`, `TREE_NO_PARENT_LINKS`); see the flow reference and
[troubleshooting](/guide/troubleshooting). `SCREENSHOT_NOT_FOREGROUND` and `TIMEOUT` come from those lower layers, not from
`server.js`. This table was built from the code, not from a device run.

## Safety limits

- **Lease, per call.** Each device-touching call (`press`, `navigate_to`, `inspect_tree`, `screenshot`, `app_state`,
  `app_state_get`, `run_flow`, `perf_summary`) takes the [device lease](./device-lease) when it starts and releases it when it ends, also on error and
  on timeout (outside the session hub window; `net_requests`, `net_mock`, `app_state_set` and `app_state_snapshot` always run inside
  it and open it if none is open). Nothing is held between calls, so a human or another agent can use the device in between. If another
  party holds it, the call fails at once with `DEVICE_BUSY` and sends no request. A lost lease becomes a `LEASE_LOST`
  tool error; the server never exits because of the lease. `list_devices`, `device_doctor` and `perf_trace_summary` are read-only and take
  no lease.
- **Queue.** Device calls of a session run one at a time, and every request goes through the per-device ECP queue.
  A call that waits more than 30 s behind earlier ones is dropped with `QUEUE_TIMEOUT` and never runs. Keypresses are
  never retried after a 5xx or a timeout, since the device may already have acted on them. `press` also keeps a
  250 ms gap between presses of the session.
- **Timeouts stop the work.** The run budget starts when a call gets its turn: 30 s (45 s for `app_state_set` and `app_state_snapshot`, 120 s for `run_flow`). On
  `TOOL_TIMEOUT` (or when the client closes stdin) no further device request is sent for that call. A request already
  in flight may still finish, so the lease is released only after it has ended (up to about 12 s), never while
  such a request could still reach the device.
- **Paths.** `run_flow` takes a path relative to the project root: no absolute paths, no `..`, no symlink that leaves
  the project, and only `*.e2e.yaml` or `*.e2e.yml` files. Rejection happens before any file is read or any device call is made. The
  same rules apply to every file a flow pulls in with a nested `runFlow:` step (so subflows must also be
  `*.e2e.yaml` or `*.e2e.yml` files inside the project), and a subflow that fails to parse never echoes its content.
- **Blocked keys.** `press` refuses `PowerOff`, `InputHDMI*`, `InputTuner` and `InputAV*` (a conservative default so
  an agent cannot switch the TV away from the app; `Volume*` and the rest are allowed). Presses made by steps inside
  a flow you run are the flow's own content and are not filtered.
- **Budgets, per session.** 500 presses and 10 flow runs. Keypresses made inside `run_flow` count against the flow-run
  cap and the 120 s budget, not the press cap, and follow the flow runner's own spacing. Per call: 500 tree nodes and
  64 KB of tree JSON, 2 MB of screenshot, 128 KB of app state, 32 KB of `perf_summary` JSON and 64 KB of `perf_trace_summary` JSON (lists are halved and flagged, never cut silently), 1 MB per request line, 300 characters per flow step
  message. Over a cap you get a typed error or a `truncated` flag, never a silent cut. The session caps reset only
  with a new session.

Writing source and sideloading are not part of v1; profiling is read-only.
