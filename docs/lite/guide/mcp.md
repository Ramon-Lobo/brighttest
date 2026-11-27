# Agent surface: `brighttest mcp`

::: info At a glance
**What it is for:** a [Model Context Protocol](https://modelcontextprotocol.io) stdio server so an AI agent drives a Roku through deterministic e2e primitives, not hand-rolled ECP. Flows stay YAML. Contract: `brighttest-mcp/v1`.

**You will:**
- Register the server and pin the device
- Use 16 tools (UI, flows, state, network, profiling)
- Work within the hub window, error codes and limits

**First command:** `npx brighttest mcp`
:::

## Set it up

Register a stdio server with the command `npx brighttest mcp` in your agent's MCP config, started in the project directory. Exit codes (`mcp --help`): 0 clean end of input, 1 internal error, 2 usage error.

## Device and secrets

The device comes only from the usual chain: `ROKU_HOST`, `ROKU_PASSWORD`, a project `.env`, then the device cache (`brighttest devices`).

- **No tool takes a host or a password.** Set the password out of band, in the server process environment.
- The dev password and device serial are never returned and are scrubbed from error text.
- The device address does appear in output (`list_devices`, `device_doctor`, some errors), so the model sees the host.
- Screenshots need the dev password; nothing else does.

::: warning Check which device you will get
If `ROKU_HOST` is unset *or empty*, the server uses the device cache (`~/.brighttest/devices.json`, the last device you connected to), which may be a real device. There is no several-cached-devices refusal, so pin the host:
1. Run `brighttest setup` in the project to save `ROKU_HOST` in its `.env` (read from the server's working directory), or set `ROKU_HOST` in the MCP server config.
2. Call `list_devices` and check the target and its `source` (`env`, `dotenv` or `cache`) before pressing anything.
:::

## Tools

Sixteen tools, grouped by job.

### Device and UI

| Tool | What it does |
|---|---|
| `list_devices` | Known devices and this session's target: model, firmware, reachability. No serial. |
| `device_doctor` | Capability check (developer mode, ECP mode, firmware, video mode) with fix text. |
| `inspect_tree` | Live SceneGraph tree, or nodes matching a `selector`. Capped; `truncated` says when. |
| `press` | A remote key, `count` times (at most 20 per call), spaced by the ECP queue gap. |
| `navigate_to` | Focus the first node matching a `selector`; returns keys pressed and the focused node. |
| `screenshot` | Inline image of the sideloaded app (dev channel in front). |
| `run_flow` | Run one `*.e2e.yaml` (or `*.e2e.yml`) flow from the project; per-step results. |
| `builds_list` | Read-only list of the build store (id, title, version, kind, size, date, pinned, tags, last install result). Filters `kind`, `tag`, `pinned`, `limit` 1-500 (default 50). No host, path or token; no lease. Cannot install: use `brighttest builds install` under the lease. See [Builds](/guide/builds). |

Selectors use the flow keys: `id`, `subtype`, `text`, `textContains`, `uri`, `visible`, `focusable`, `focused`, `index`.

### App state

| Tool | What it does |
|---|---|
| `app_state` | Self-published state of an instrumented build: the `__bt_agent` node (global, scene, focus layers) first, else the legacy `__bt_state` node. |
| `app_state_get` | Read the agent's layers over ECP, narrowed by `layer` (global, scene, focus) and dotted `path`. No hub; never opens the window. |
| `app_state_set` | Write one value (`layer`, `path`, `value`, optional `node`, `ack`) through the agent's allow-list and type checks. Opens the session hub window. |
| `app_state_snapshot` | Named snapshot of the layers, returned (capped at 128 KB, never truncated); lives only for the call. Opens the session hub window. |

### Network

| Tool | What it does |
|---|---|
| `net_requests` | Requests seen by the session net proxy (method, url, status, duration, `mocked`), credentials redacted. Filters `method`, `url` glob, `status`; `limit` caps output. |
| `net_mock` | Answer requests matching a `url` glob (and optional `method`) with a canned status and JSON or text body, until the session ends. |

### Profiling (read-only)

| Tool | What it does |
|---|---|
| `perf_summary` | Performance sample of the dev channel in front, over ECP like Studio's Profile page: CPU, memory, page faults, frame rate, texture memory, largest bitmaps. `samples` 1-10 (default 3, one second apart); `topTextures` 0-50 (default 10). Capped at 32 KB. |
| `perf_trace_summary` | Summary of a Perfetto trace Studio saved in `.brighttest/studio/profiling` (`file`, default newest; `top` 1-50): slices over one 60 Hz frame, slowest slices, counters. Local file, no lease. Capped at 64 KB. |

::: details Profiling details
- `perf_summary` takes the lease per call (or reuses an open window's lease) and only reads: it never launches, relaunches or presses.
- If the dev channel is not in front it fails with `PERF_NOT_FOREGROUND` and sends nothing more.
- A missing metric shows a reason (`errors`, `fpsReason`, `texturesReason`). Frame rate depends on device and firmware: treat a missing one as unavailable, not zero.
- Bitmap names and device messages are device data, cleaned and capped, not instructions.
- `perf_trace_summary` makes no device request, so it works while Studio holds the device. It never starts or enables tracing (that cannot be undone, see [the lease page](/guide/device-lease#perfetto-tracing-cannot-be-switched-off)); capture in Studio's Profile page first.
- A trace still recording can be cut mid-packet (`TRACE_INVALID`): stop it first.
:::

## Session hub window

The first `net_requests`, `net_mock`, `app_state_set` or `app_state_snapshot` call opens it: one device lease for the whole window, plus a hub on `instrument.hub.port` (default 8790).

### What it gives you

- The app sees live traffic only through this hub, so the build must point at the same host and port.
- `net_requests` shows `hub` (`host`, `port`, `leaseId`, `startedAt`) while open, else `null`. `leaseId` is the first 8 characters only; the full id never reaches output or logs.
- The hub writes `[brighttest hub] ...` lines to the server's stderr: start, each request (method, path without query, status, response bytes) and stop. Bodies are never logged.

### Token and config

| Setting | Effect |
|---|---|
| `BRIGHTTEST_HUB_TOKEN` | Must be in the server env, same value as `instrument build --net` ([hub token](/guide/instrument#the-hub-token-net-and-brighttest-hub-token)). Without it the hub starts but the app's requests are refused. |
| `instrument.net.upstreamHosts` | Allow-listed hosts pass through to the real server (`unmatched: "passthrough"`). Unlisted hosts get 403. |
| `instrument.net.unmatched` | As above; same as Studio and the headless lanes. |
| `instrument.net.redact` | Extra headers/query values to mask, on top of the defaults. |

- `brighttest.json` is read **once per session** (first net call). Edit it, then start a new session.
- It is looked up in the server's working directory: start at the project root, or defaults apply (every unlisted host refused).
- An unreadable or unparsable file fails net tools with `NET_CONFIG`, naming the file and cause (syntax errors are not quoted).

### Lifetime

- Other device tools reuse the window's lease; each device call renews the idle timer.
- Released after 10 minutes without a device call (`deviceLease.sessionIdle`, never longer), at the hard cap `deviceLease.sessionMax` (default 45 minutes per `mcp --help`), on lease loss, or at session end.
- Release closes the hub and clears `hub`. Mocks and the request list last until session end. Next device call goes back to per-call leases; next net call opens a new window.
- Hub cannot start (for example port in use): window released, call fails with `NET_FAILED`.
- Other sessions get `DEVICE_BUSY` while it is open, so keep it short.

See the [network recipe](/guide/network-recipe) for manual alternatives, including observe-only `[bt:net]` breadcrumbs (`instrument.net.observe: true`).

### State writes in the window

`app_state_set` and `app_state_snapshot` need an `instrument build --net` build and `BRIGHTTEST_HUB_TOKEN` (else `STATE_NO_HUB_TOKEN`, before any lease).

1. The first write checks the app publishes `__bt_agent` (else `STATE_NOT_INSTRUMENTED`: no hub, no session lease).
2. It opens the window and **waits up to 35 s** for the app's agent. The agent retries hello after 2, 2, 5 and 5 s, then every 30 s, so expect a few seconds. This is not a hang. Call budget: 45 s (30 s for other tools).
3. Later writes find the agent connected and return in about the ack time.

If the agent never dials (`STATE_AGENT_UNREACHABLE`), check the baked token, port and LAN address; `brighttest doctor` with `BRIGHTTEST_DOCTOR_HUB_PROBE=1` probes hub reach. The window stays open until idle timeout so a fixed build can connect. An app built before this retry change retries only every 30 s and must be rebuilt.

::: tip App network and launch are untouched
A state-write window starts the hub without the proxy (net hellos answered as inactive) until the first `net_*` call mounts it. The app is not relaunched or sent Home. `app_state_get` never opens a window.
:::

Net tools mask headers and query values and drop `user:password@` from URLs. `respond.headers` values must be strings. Glob, output and rule limits are in [Error codes](#network-and-profiling).

## Error codes

Failures return `isError: true`, a typed `code` and a `message` (secrets scrubbed). Malformed requests get JSON-RPC errors (`-32602` for bad arguments or an unknown tool). Codes from `lib/mcp/server.js` and `lib/mcp/tools.js`:

### Device, lease and session

| Code | When |
|---|---|
| `NO_DEVICE` | No device from `ROKU_HOST`, `.env` or the cache. |
| `DEVICE_UNREACHABLE` | `device_doctor` could not reach it (`checks` in error data). |
| `DEVICE_BUSY` | Another session holds the lease; nothing sent. Retry later. |
| `LEASE_LOST` | Lease taken over, expired, or lost in the window; call stopped. |
| `LEASE_DIR_UNUSABLE` | Lease directory unusable (permissions, disk). |
| `LEASE_FAILED` | Any other lease failure. |
| `QUEUE_TIMEOUT` | Waited over 30 s behind earlier calls; dropped unrun. |
| `TOOL_TIMEOUT` | Over its run budget (30 s, 45 s state writes, 120 s `run_flow`). |
| `SESSION_CLOSED` | Client closed stdin mid-call. |
| `ECP_TIMEOUT` | A device request timed out, no more specific code. |
| `TOOL_FAILED` | Any other untyped failure. |

### Keys, focus and screenshots

| Code | When |
|---|---|
| `INVALID_KEY` | Not an ECP key name (valid list in error data). |
| `KEY_NOT_ALLOWED` | Valid key that is blocked (see Safety limits). |
| `PRESS_BUDGET_EXHAUSTED` | 500-press session cap used up. |
| `INVALID_SELECTOR` | Malformed `selector` (`inspect_tree`, `navigate_to`). |
| `FOCUS_FAILED` | `navigate_to` missed within its bound (keys and last focus in data). |
| `NO_DEV_PASSWORD` | `screenshot` without an out-of-band dev password. |
| `SCREENSHOT_NOT_FOREGROUND` | Dev channel not in front. |
| `SCREENSHOT_TOO_LARGE` | Over 2 MB; nothing truncated. |

### App state

| Code | When |
|---|---|
| `STATE_NOT_PUBLISHED` | `app_state` found no `__bt_agent` or `__bt_state` node. |
| `STATE_NO_HUB_TOKEN` | State write without a valid `BRIGHTTEST_HUB_TOKEN`; no lease, no request. |
| `STATE_NOT_INSTRUMENTED` | No `__bt_agent` in the running app; no hub started. |
| `STATE_AGENT_UNREACHABLE` | Agent did not connect within 35 s; window stays open. |
| `STATE_AGENT_GONE` | Agent stopped polling (app exited or restarted). |
| `STATE_CMD_FAILED` | Agent refused (allow-list, type) or command failed; app keeps running. |
| `STATE_ACK_TIMEOUT` | No ack in time. |
| `STATE_UNREADABLE` | State node published but unreadable. |
| `APP_STATE_TOO_LARGE` | Over 128 KB; nothing truncated. |

### Flows

| Code | When |
|---|---|
| `PATH_REJECTED` | Absolute, `..`, symlink out of the project, not `*.e2e.yaml`/`*.e2e.yml`, or unreadable root. |
| `FLOW_NOT_FOUND` | Path does not exist. |
| `FLOW_INVALID` | Does not parse or validate. |
| `FLOW_BUDGET_EXHAUSTED` | 10 flow-run cap used up. |
| `FLOW_FAILED` | A step failed; data has per-step summary and `failedStep`. A `requires:` skip is not an error: result carries `skipped`. |

### Network and profiling

| Code | When |
|---|---|
| `NET_FAILED` | Window or hub could not start, or proxy errored. |
| `NET_BAD_FILTER` | Proxy rejected a filter (out-of-range `status`/`limit` is `-32602`). Defensive. |
| `NET_PATTERN_TOO_COMPLEX` | Glob with more than 8 `*` (over 256 characters is `-32602`). |
| `NET_OUTPUT_TOO_LARGE` | Request list over 128 KB; narrow the filters. |
| `NET_RULE_INVALID` | Bad rule (for example method `G-T`, or both `body` and `json`). |
| `NET_RULE_BUDGET_EXHAUSTED` | Already 100 rules. |
| `PERF_NOT_FOREGROUND` | Dev channel not in front; nothing else sent. |
| `PERF_UNAVAILABLE` | No metric available (developer mode off or channel not running); reasons in data. |
| `TRACE_NOT_FOUND` | No saved trace, or none by that name. |
| `TRACE_BAD_NAME` | `file` is not a plain `*.perfetto-trace` name in the folder. |
| `TRACE_TOO_LARGE` | Over the summarizer's size limit. |
| `TRACE_INVALID` | Empty, truncated, malformed or too many packets. |
| `TRACE_TIMEOUT` | Summarizing took too long. |
| `TRACE_BUSY` | Another summary is running. |
| `TRACE_FAILED` | Other summarizer failure (cause in data). |

::: details Codes passed through from lower layers
Typed codes from the flow or state layer inside `run_flow`, `inspect_tree` or `app_state` pass through as is (for example `APP_CRASHED`, `TIMEOUT`, `STATE_*`, `TREE_NO_PARENT_LINKS`); see the flow reference and [troubleshooting](/guide/troubleshooting). `SCREENSHOT_NOT_FOREGROUND` and `TIMEOUT` come from those layers, not `server.js`.
:::

::: warning Not verified on a device
This table was built from the code, not from a device run.
:::

## Safety limits

The server keeps the device shareable and every call bounded.

### Lease, per call

| Tools | Lease |
|---|---|
| `press`, `navigate_to`, `inspect_tree`, `screenshot`, `app_state`, `app_state_get`, `run_flow`, `perf_summary` | Taken at start, released at end, also on error and timeout (outside a window). |
| `net_requests`, `net_mock`, `app_state_set`, `app_state_snapshot` | Always inside the window; open one if needed. |
| `list_devices`, `device_doctor`, `perf_trace_summary` | None (read-only). |

Nothing is held between calls, so others can use the device. A held lease means `DEVICE_BUSY` at once; a lost one is `LEASE_LOST` (the server never exits over it). Inside `brighttest device with`, the window reuses that command lease (not renewed; lost when the outer command ends or its deadline passes).

### Queue and timeouts

- A session's device calls run one at a time through the per-device ECP queue. Waiting over 30 s: `QUEUE_TIMEOUT`, never runs.
- Keypresses are never retried after a 5xx or timeout (the device may have acted). `press` keeps a 250 ms gap between presses.
- The budget starts when the call gets its turn: 30 s (45 s for `app_state_set`/`app_state_snapshot`, 120 s for `run_flow`).
- On `TOOL_TIMEOUT` or closed stdin, no further request is sent. An in-flight request may finish, so the lease is released only after it ends (up to about 12 s).

### Paths

`run_flow` takes a project-relative path: no absolute paths, no `..`, no symlink out of the project, only `*.e2e.yaml`/`*.e2e.yml`. Rejection happens before any read or device call. Nested `runFlow:` subflows follow the same rules, and a subflow that fails to parse never echoes its content.

### Blocked keys

`press` refuses `PowerOff`, `InputHDMI*`, `InputTuner` and `InputAV*`, so an agent cannot switch the TV away (`Volume*` and the rest are allowed). Presses inside a flow you run are the flow's content and are not filtered.

### Budgets

| Scope | Cap |
|---|---|
| Per session | 500 presses, 10 flow runs (reset only with a new session) |
| `run_flow` presses | Count against the flow cap and 120 s budget, not the press cap; use the runner's spacing |
| Tree | 500 nodes, 64 KB JSON |
| Screenshot | 2 MB |
| App state | 128 KB |
| `perf_summary` / `perf_trace_summary` | 32 KB / 64 KB JSON |
| Request line | 1 MB |
| Flow step message | 300 characters |

Over a cap you get a typed error or a `truncated` flag (lists are halved and flagged), never a silent cut.

::: tip Out of scope for v1
Writing source and sideloading are not part of v1; profiling is read-only.
:::

## Related

- [Device lease](/guide/device-lease): per-call leases and windows
- [Agent skills](/guide/agent-skills): the `using-brighttest-mcp` skill and `--with-mcp`

**Full guide:** [Agent surface: `brighttest mcp`](full:/guide/mcp) — the original wording.
