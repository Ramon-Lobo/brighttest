# Network recipe: mock, observe, fault

A short, manual recipe for working on one endpoint at the network level: answer it with a mock, watch the requests
the app makes, then make it fail. It uses the same rule format as the [network fixtures](/writing-tests/http-fixtures)
and the [fault model](/guide/net-faults). The build must be instrumented for the network (`brighttest instrument build
--net`) so the app's HTTP calls go through the brighttest hub.

## 1. Mock one endpoint

Write one rule file in your project, for example `fixtures/net/catalog.json`:

```json
[{ "method": "GET", "url": "**/catalog", "status": 200, "json": { "items": [{ "title": "Mocked" }] } }]
```

Load it from a spec with `BTNet_useFixture("fixtures/net/catalog.json")`, from a flow with `net: { fixtures: [...] }`,
or add the same rule on the fly with `BTNet_mock({ url: "**/catalog", json: ... })`. The first matching rule wins and a
rule added later is tried first. `times: 1` stops a rule after one hit.

An agent can add a rule without a file through the MCP tool `net_mock` (see the net window under Limits): it takes `match` (`url` glob, optional `method`) and
`respond` (`status`, `json` or `body`, `headers`, `delayMs`). The mock lives until the MCP session ends.

## 2. Observe the requests

- Spec or flow: `BTNet_requests()` or the `waitForRequest` / `assertRequest` steps. After a run, the redacted log is
  in `.brighttest/net/last-run.ndjson`.
- Agent: the MCP tool `net_requests` lists method, url, status, duration, whether a mock answered (`mocked`), and the
  headers with credentials redacted. Filter by `method`, `url` glob or `status`.
- No proxy path available (a backend that cannot go through the hub): build with observe-only mode. Set
  `instrument.net.observe: true` in your brighttest config. The build then never contacts the hub and never rewrites a
  URL. It prints one line per HTTP(S) URL the app sets on a transfer (one line per URL set, not per completed
  request) to the 8085 debug console:

  ```text
  [bt:net] url=https://api.example.test/v1/home?
  ```

  The query string, the fragment and any `user:password@` in the authority are dropped (a trailing `?` says a query
  was present), because they often carry secrets. Path segments are printed as they are, so do not put secrets in a path. The line has no method or status; it only tells you that the request happened. Read it through
  brighttest's log capture or any client on port 8085.

## 3. Make it fail

Change the rule to a fault, or add one next to it:

```json
[{ "url": "**/catalog", "fault": "timeout", "holdMs": 5000 }]
```

`reset`, `timeout` and `status` are described in the [fault model](/guide/net-faults), including the device failure
code the app sees. Run the screen again, then check the app's error state and the request log. Remove the rule (or end
the session or flow) to go back to the real endpoint.

## Limits

- **The MCP net tools see live traffic only through the session hub.** The first `net_requests` or `net_mock` call opens
  a net window: one device lease for the session plus a hub of its own on `instrument.hub.port`. It is released after
  10 minutes without a device call, at the lease cap, on lease loss or at session end, and the hub closes with it.
  Mocks stay until the session ends. The MCP server needs `BRIGHTTEST_HUB_TOKEN` in its environment, set to the same value
  as for `instrument build --net` ([the hub token](./instrument#the-hub-token---net-and-brighttest-hub-token)); otherwise the
  app's requests are refused. See [MCP](./mcp) for details.
- Observe-only breadcrumbs and the MCP net tools have been tested headless and against stubs only. A check on a real
  device is still open (TP-NET-31).
- Mocks and faults need the hub; they do nothing in an observe-only build.
