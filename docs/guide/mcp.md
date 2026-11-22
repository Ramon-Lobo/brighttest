# Agent surface: `brighttest mcp`

`brighttest mcp` starts a [Model Context Protocol](https://modelcontextprotocol.io) server on stdio, so an AI agent
can drive a Roku through brighttest's deterministic e2e primitives instead of hand-rolling ECP calls. The model calls
the tools; the flows stay deterministic YAML. The contract version is `brighttest-mcp/v1`.

Register it in your agent's MCP configuration as a stdio server with the command `npx brighttest mcp`, started in the
project directory.

## Device and secrets

The device comes only from the usual resolution chain: `ROKU_HOST`, `ROKU_PASSWORD`, a project `.env`, then the device
cache (`brighttest devices`). **No tool takes a host or a password**, so neither ends up in the model's context. Set
them out of band in the environment of the server process. Screenshots need the dev password; everything else does not.

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
| `run_flow` | Run one `*.e2e.yaml` flow from the project; returns per-step results. |

Selectors use the same keys as flows: `id`, `subtype`, `text`, `textContains`, `uri`, `visible`, `focusable`,
`focused`, `index`.

Failures come back as a tool result with `isError: true` and a typed `code` (for example `DEVICE_BUSY`,
`INVALID_KEY`, `PATH_REJECTED`, `PRESS_BUDGET_EXHAUSTED`, `TOOL_TIMEOUT`, `SCREENSHOT_NOT_FOREGROUND`,
`STATE_NOT_PUBLISHED`). Malformed requests use JSON-RPC errors (`-32602` for bad arguments or an unknown tool).

## Safety limits

- **Lease.** The first device-touching call takes the [device lease](./device-lease) for the whole session; it is
  released when stdin closes. If another session holds it, the call fails at once with `DEVICE_BUSY` and sends no
  request. `list_devices` and `device_doctor` are read-only and take no lease.
- **Queue.** Every call goes through the per-device ECP queue, one request at a time. Keypresses are never retried
  after a 5xx or a timeout, since the device may already have acted on them.
- **Paths.** `run_flow` takes a path relative to the project root: no absolute paths, no `..`, no symlink that leaves
  the project, and only `*.e2e.yaml` files. Rejection happens before any file is read or any device call is made.
- **Budgets, per session.** 500 presses, 10 flow runs. Per call: 30 s (120 s for `run_flow`), 500 tree nodes and
  64 KB of tree JSON, 2 MB of screenshot, 128 KB of app state. Over a cap you get a typed error or a `truncated`
  flag, never a silent cut. The session caps reset only with a new session.

Writing source, sideloading and profiling are not part of v1.
