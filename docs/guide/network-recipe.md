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

An agent can add a rule without a file through the MCP tool `net_mock` (see the limitation below): it takes `match` (`url` glob, optional `method`) and
`respond` (`status`, `json` or `body`, `headers`, `delayMs`). The mock lives until the MCP session ends.

## 2. Observe the requests

- Spec or flow: `BTNet_requests()` or the `waitForRequest` / `assertRequest` steps. After a run, the redacted log is
  in `.brighttest/net/last-run.ndjson`.
- Agent: the MCP tool `net_requests` lists method, url, status, duration, whether a mock answered (`mocked`), and the
  headers with credentials redacted. Filter by `method`, `url` glob or `status`.
- No proxy path available (a backend that cannot go through the hub): build with observe-only mode. Set
  `instrument.net.observe: true` in your brighttest config. The build then never contacts the hub and never rewrites a
  URL. It prints one line per HTTP(S) request to the 8085 debug console:

  ```text
  [bt:net] url=https://api.example.test/v1/home?
  ```

  The query string and fragment are dropped (a trailing `?` says a query was present), because they often carry
  tokens. The line has no method or status; it only tells you that the request happened. Read it through
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

- **MCP net tools do not see live traffic yet.** The MCP session's proxy has no hub mounted, so `net_requests` and
  `net_mock` only work on the proxy path (tests and stubs), not against a running app. Use the spec, flow or
  observe-only routes above for real traffic.
- Observe-only breadcrumbs and the MCP net tools have been tested headless and against stubs only. A check on a real
  device is still open (TP-NET-31).
- Mocks and faults need the hub; they do nothing in an observe-only build.
