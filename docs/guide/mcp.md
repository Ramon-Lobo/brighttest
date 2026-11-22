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
| `app_state` | The app's `__bt_state` snapshot from an instrumented build. |
| `run_flow` | Run one `*.e2e.yaml` (or `*.e2e.yml`) flow from the project; returns per-step results. |
| `net_requests` | Requests seen by the session's net proxy (method, url, status, duration, `mocked`), with credentials redacted. Filters: `method`, `url` glob, `status`; `limit` caps the output. |
| `net_mock` | Answer requests that match a `url` glob (and optional `method`) with a canned status and JSON or text body. The mock lasts until the session ends. |

::: warning Net tools: current limitation
The MCP session's net proxy has no hub mounted, so live app traffic does not reach `net_requests` or `net_mock` yet.
They are only exercised through the proxy path (tests and stubs), not against a running app on a device. Both take
the device lease per call, like `press`. See the [network recipe](./network-recipe) for the manual alternatives,
including the observe-only `[bt:net]` breadcrumbs (`instrument.net.observe: true`).
:::

Selectors use the same keys as flows: `id`, `subtype`, `text`, `textContains`, `uri`, `visible`, `focusable`,
`focused`, `index`.

Failures come back as a tool result with `isError: true` and a typed `code` (for example `DEVICE_BUSY`,
`INVALID_KEY`, `KEY_NOT_ALLOWED` (a valid key that the server blocks, see Blocked keys), `PATH_REJECTED`, `PRESS_BUDGET_EXHAUSTED`, `TOOL_TIMEOUT`, `SCREENSHOT_NOT_FOREGROUND`,
`STATE_NOT_PUBLISHED`). Malformed requests use JSON-RPC errors (`-32602` for bad arguments or an unknown tool).

## Safety limits

- **Lease, per call.** Each device-touching call (`press`, `navigate_to`, `inspect_tree`, `screenshot`, `app_state`,
  `run_flow`, `net_requests`, `net_mock`) takes the [device lease](./device-lease) when it starts and releases it when it ends, also on error and
  on timeout. Nothing is held between calls, so a human or another agent can use the device in between. If another
  party holds it, the call fails at once with `DEVICE_BUSY` and sends no request. A lost lease becomes a `LEASE_LOST`
  tool error; the server never exits because of the lease. `list_devices` and `device_doctor` are read-only and take
  no lease.
- **Queue.** Device calls of a session run one at a time, and every request goes through the per-device ECP queue.
  A call that waits more than 30 s behind earlier ones is dropped with `QUEUE_TIMEOUT` and never runs. Keypresses are
  never retried after a 5xx or a timeout, since the device may already have acted on them. `press` also keeps a
  250 ms gap between presses of the session.
- **Timeouts stop the work.** The run budget starts when a call gets its turn: 30 s (120 s for `run_flow`). On
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
  64 KB of tree JSON, 2 MB of screenshot, 128 KB of app state, 1 MB per request line, 300 characters per flow step
  message. Over a cap you get a typed error or a `truncated` flag, never a silent cut. The session caps reset only
  with a new session.

Writing source, sideloading and profiling are not part of v1.
