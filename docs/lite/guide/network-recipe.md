# Network recipe: mock, observe, fault

::: info At a glance
**What it is for:** mocking one endpoint, watching the app's requests, then making it fail.

**You will:**
- Mock an endpoint with a rule
- Read the request log
- Turn the rule into a fault

**First command:** `brighttest instrument build --net` (routes the app's HTTP through the brighttest hub)
:::

Rules share the format of [network fixtures](/writing-tests/http-fixtures) and the [fault model](/guide/net-faults).

## 1. Mock one endpoint

Write a rule file, for example `fixtures/net/catalog.json`:

```json
[{ "method": "GET", "url": "**/catalog", "status": 200, "json": { "items": [{ "title": "Mocked" }] } }]
```

| Load it from | How |
|---|---|
| A spec | `BTNet_useFixture("fixtures/net/catalog.json")`, or on the fly `BTNet_mock({ url: "**/catalog", json: ... })` |
| A flow | `net: { fixtures: [...] }` |
| An agent (no file) | MCP tool `net_mock`: `match` (`url` glob, optional `method`), `respond` (`status`, `json` or `body`, `headers`, `delayMs`). Lives until the MCP session ends; opens the net window ([Limits](#limits)) |

The first matching rule wins; a later rule is tried first. `times: 1` stops a rule after one hit.

## 2. Observe the requests

| Where | How |
|---|---|
| Spec or flow | `BTNet_requests()`, or `waitForRequest` / `assertRequest` steps. Redacted log after a run: `.brighttest/net/last-run.ndjson` |
| Agent | MCP `net_requests`: method, url, status, duration, `mocked`, headers with credentials redacted. Filter by `method`, `url` glob or `status` |
| No proxy path (backend cannot use the hub) | Observe-only build, below |

### Observe-only mode

Set `instrument.net.observe: true` in your brighttest config. The build never contacts the hub or rewrites a URL. It prints to the 8085 debug console one line per HTTP(S) URL set on a transfer (not per completed request):

```text
[bt:net] url=https://api.example.test/v1/home?
```

No method or status: it only shows the request happened. Read it via brighttest's log capture or any client on port 8085.

::: warning Redaction
Query string, fragment and any `user:password@` are dropped (a trailing `?` means a query existed). Path segments print as-is, so keep secrets out of paths.
:::

## 3. Make it fail

1. Change the rule to a fault, or add one beside it:

   ```json
   [{ "url": "**/catalog", "fault": { "kind": "timeout", "holdMs": 5000 } }]
   ```

   `holdMs` goes in `fault`, or flat with `kind` on the rule. `"fault": "timeout"` alone holds for the default 120000 ms.
2. Run the screen again; check the app's error state and the request log.
3. Remove the rule (or end the session or flow) to restore the real endpoint.

`reset`, `timeout`, `status` and their device failure codes: [fault model](/guide/net-faults).

## Limits

- **The MCP net tools see live traffic only through the session hub.** The first `net_requests` or `net_mock` call opens a net window: one session device lease plus its own hub on `instrument.hub.port`.
- The window is released after 10 minutes without a device call, at the lease cap, on lease loss or at session end; the hub closes with it. Mocks last until session end.
- The MCP server needs `BRIGHTTEST_HUB_TOKEN`, equal to the value used for `instrument build --net` ([the hub token](/guide/instrument#the-hub-token---net-and-brighttest-hub-token)), or the app's requests are refused. See [MCP](/guide/mcp).
- The session hub logs `[brighttest hub] ...` lines to MCP stderr: start, each request (method, path without query, status, bytes), stop. No bodies.
- Mocks and faults need the hub: they do nothing in an observe-only build.

::: warning Not verified on a device
Observe-only breadcrumbs and the MCP net tools are tested headless and against stubs only.
:::

## Related

- [Network fault model](/guide/net-faults): fault kinds and codes

**Full guide:** [Network recipe: mock, observe, fault](full:/guide/network-recipe) — the original wording.
