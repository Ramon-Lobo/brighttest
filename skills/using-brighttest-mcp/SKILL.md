---
name: using-brighttest-mcp
description: Use when an AI agent should look at or drive a real Roku live through the brighttest MCP server (`brighttest mcp`) instead of the CLI — list devices, check device health, read the SceneGraph tree, press remote keys, move focus to a node, take a screenshot, read the app's published state, or run one flow file and get step results. Covers the eight tools and their parameters, the per-call device lease, budgets, and typed errors.
triggers: brighttest mcp; drive a roku through mcp; read the scenegraph tree live; press remote keys from an agent; take a device screenshot; check device health; read published app state; run one flow via mcp
when-not-to-use: Do not use to author or maintain *.e2e.yaml files (use writing-e2e-flows) or for CLI-driven test runs and config (use setting-up-brighttest).
license: MIT
metadata:
  source: brighttest
---

# Using the brighttest MCP server

`brighttest mcp` is a stdio MCP server (contract `brighttest-mcp/v1`) that lets an agent do short, interactive
device work: look at the live screen tree, press keys, move focus, grab a screenshot, run one flow. It is built
on the same primitives as `brighttest e2e`, so selectors and flow files mean the same thing in both.

## Start it

Register it in your MCP client as a stdio server whose command is `brighttest mcp`, with the project root as
the working directory. The device comes only from brighttest's normal resolution chain (`ROKU_HOST`, the
project `.env`, the device cache). **No tool takes a host, password or absolute path.** Set `ROKU_HOST` (and
`ROKU_PASSWORD` for screenshots) out of band. Protocol output goes to stdout; logs go to stderr.

## Tools

Read-only, no lease: `list_devices`, `device_doctor`. Device tools, one lease per call: `inspect_tree`, `press`,
`navigate_to`, `screenshot`, `app_state`, `run_flow`, `net_requests`, `net_mock`.

| Tool | Parameters | Use it to |
|---|---|---|
| `list_devices` | none | See known devices and which one this session targets (model, firmware, reachability). |
| `device_doctor` | none | Check developer mode, ECP mode, firmware, video mode; returns exact fix text. |
| `inspect_tree` | `selector` (optional), `maxNodes` (optional, 1-500) | Read the live SceneGraph. With a selector returns only matches; an empty match is a normal result. |
| `press` | `key` (required), `count` (optional, 1-20, default 1) | Press a remote key: `Up`, `Down`, `Left`, `Right`, `Select`, `Back`, `Home`, or `Lit_<char>`. |
| `navigate_to` | `selector` (required), `maxPresses` (optional, 1-30) | Move D-pad focus onto the first matching node. Returns keys pressed and the final focused node. |
| `screenshot` | none | Capture the sideloaded app as an inline image. Needs the dev password configured out of band. |
| `app_state` | none | Read the app's self-published state snapshot (instrumented builds only). |
| `run_flow` | `path` (required) | Run one `*.e2e.yaml` flow, path relative to the project root; returns per-step results. |
| `net_requests` | `method` (optional), `url` (optional), `status` (optional, 100-599), `limit` (optional, 1-500) | List requests seen by the session's net proxy: method, url, status, duration, whether a mock answered it. Auth headers and tokens are redacted. |
| `net_mock` | `match` (required), `respond` (required), `times` (optional, 1-1000) | Answer matching requests with a canned response. `match` takes a URL glob and an optional method; `respond` takes status, JSON or text body, headers, delay. |

### Net tools

`net_requests` and `net_mock` take the device lease like the other device tools and refuse with `DEVICE_BUSY` when
it is held. URL globs: at most 256 characters and 8 `*`. A session takes at most 100 mocks. A mock lives until the MCP session ends; it cannot be made permanent. Secrets are redacted in the output.
**Limitation:** the MCP session's net proxy has no hub mounted, so live app traffic does not reach these tools yet;
today they work on the proxy path only. Do not expect `net_requests` to show what a running app fetched, and do not
expect `net_mock` to change it. To see requests without a proxy, build with `instrument.net.observe: true` (set in
the brighttest config by the human): the app then prints one `[bt:net] url=...` line per request to the 8085
console, with no rewrite. The query, fragment and `user:password@` are dropped; path segments are printed as they are.

### The `selector` object

Used by `inspect_tree` and `navigate_to`. At least one key; all given keys must hold; prefer `id`.
Keys: `id`, `subtype`, `text`, `textContains`, `uri`, `visible`, `focusable`, `focused`, `index` (0-based,
picks the Nth match). No other keys are accepted.

## Lease and ordering

Every device tool call takes its own device lease and releases it when the call ends (one call per lease).
Calls in one session run one at a time. If another brighttest session holds the device the call fails fast with
`DEVICE_BUSY` and sends nothing; wait and retry, do not loop. Never try to bypass the lease. Presses are spaced
by a short gap, so `press` with a `count` is slower than one call.

## Budgets

- `inspect_tree` output is capped (nodes, bytes, text length); `truncated: true` means nodes were cut, so
  narrow the selector rather than asking for more.
- `press` and `navigate_to` share a per-session press cap; `run_flow` has a per-session run cap and a duration
  cap. These reset only with a new MCP session.
- Each call has a timeout; a call queued too long is dropped.
- `PowerOff`, `InputTuner`, `InputHDMI*` and `InputAV*` keys are refused.

## Typed errors

A failed call returns `isError` with a typed `code`. Common ones: `NO_DEVICE`, `DEVICE_UNREACHABLE`,
`DEVICE_BUSY`, `LEASE_LOST`, `INVALID_SELECTOR`, `INVALID_KEY`, `KEY_NOT_ALLOWED`, `FOCUS_FAILED` (carries the
last focused node), `PRESS_BUDGET_EXHAUSTED`, `FLOW_BUDGET_EXHAUSTED`, `FLOW_NOT_FOUND`, `PATH_REJECTED`,
`FLOW_INVALID`, `FLOW_FAILED` (names the failing step), `NO_DEV_PASSWORD`, `STATE_NOT_PUBLISHED`,
`QUEUE_TIMEOUT`, `TOOL_TIMEOUT`. Read the message: it states the fix. Do not retry a budget or validation
error unchanged.

## Suggested loop

1. `device_doctor` once, then `inspect_tree` to see where you are.
2. `navigate_to` a selector (or `press` for a known key sequence), then `inspect_tree` with a selector to verify.
3. `screenshot` only when the tree does not answer the question.
4. Once the behaviour is understood, write it down as a flow (see the `writing-e2e-flows` skill) and use
   `run_flow` to confirm it.

## When not to use it

- Full or repeated runs, CI, multi-device matrices: use `brighttest e2e` and the Rooibos lanes from the CLI.
- Headless logic tests: no device is involved; use the `writing-rooibos-tests` skill.
- Setup and first-run problems: use the `setting-up-brighttest` and `debugging-failing-tests` skills.
- Anything needing a password, host or file path as a tool argument: not supported by design.
