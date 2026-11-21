# HTTP fixtures (headless)

brighttest can answer your app's HTTP calls from rules instead of the network, in the **headless lanes only**
(`brighttest`, `brighttest --coverage`). A spec says what a URL should return, runs the code under test, then asks
which requests were made. Nothing leaves your machine unless you allow it.

It works by rewriting `roUrlTransfer.setUrl(...)` call sites in your own source files so that the request goes to a
loopback server that brighttest starts for the run. That server matches each request against your rules and replies
with a mock, an injected fault, or (only when you allow the host) the real origin.

## What works today

| You want to | Use |
|---|---|
| Mock responses for every spec in the run | `instrument.net.fixtures` in `brighttest.json` (rules or HAR files) |
| Mock or fault responses for one test | `BTNet_mock`, `BTNet_fault`, `BTNet_useFixture` in the spec |
| Assert on what the app sent | `BTNet_requests` |
| Record real traffic once and replay it offline | `--net-record`, then list the HAR under `fixtures` |
| Decide what happens to a request no rule matches | `instrument.net.unmatched` or `--net-unmatched` |
| See every request of the last run | `.brighttest/net/last-run.ndjson` |

Not supported: the device lane (see [On the device](#on-the-device)), requests that do not go through a rewritten
`setUrl` call (see [Limits](#limits)), and `@SGNode` specs that rely on `BTNet_*` from the render thread (not verified;
use config fixtures there).

## Rules

The same rule object is used in rule files, in HAR conversion and in `BTNet_mock` / `BTNet_fault`.

```json
{ "rules": [
  { "method": "GET", "url": "https://api.example.com/v1/home*", "status": 200, "json": { "rows": [] } },
  { "url": "**/v1/search*", "responses": [ { "status": 503 }, { "status": 200, "file": "fixtures/net/search.json" } ] },
  { "url": "**/v1/config", "fault": { "kind": "timeout" } }
] }
```

| Key | Meaning |
|---|---|
| `method` | A method or an array of them. Default: any. |
| `url` | Glob, required. Matched against `scheme://host[:port]/path`; a pattern that starts with `/` matches the path only. `*` stays within one path segment, `**` crosses segments. A `?key=glob` part lists query pairs that must be present. Without one, the query is ignored. |
| `reqHeaders`, `reqBody` | Extra match conditions: header globs; body as a string (contains) or `{ contains, regex, json: { "$.a.b": value } }`. |
| `times` | Stop matching after N hits. |
| `status`, `headers` | Response status (default 200) and headers. |
| `body`, `json`, `file`, `bodyBase64` | The response body; use one. `file` is relative to the project root and confined to it. |
| `delayMs` | Wait before answering. |
| `fault` or `kind` | `timeout`, `reset`, or `status` (with `status`). Optional `holdMs`, `partialBytes`. | Device failure codes: see [Network fault model](/guide/net-faults). |
| `responses` | A sequence: one entry per match, the last repeating. |
| `passthrough: true` | Send this match to the real origin (the host must be allowed, see below). |

The first matching rule wins. Rules added by a spec come before config fixtures, newest first, so a test can override
a fixture. Config fixtures keep their declaration order.

## Config fixtures

```json
{
  "instrument": {
    "net": {
      "fixtures": ["fixtures/net/*.rules.json", "fixtures/net/*.har"],
      "unmatched": "fail",
      "upstreamHosts": ["api.staging.example.com"],
      "redact": { "headers": [], "query": [], "jsonPaths": ["$.user.email"] }
    }
  }
}
```

- `fixtures`: globs inside the project root (a pattern outside it, or one that matches nothing, is an error). Files
  can be rule files or HAR 1.2.
- `unmatched`: `fail` answers a request no rule matched with status 599 and lists it in the failure summary.
  `passthrough` sends it to the real origin. The default is `fail` once any config fixture is loaded, and
  `passthrough` otherwise; set it explicitly. A passthrough to a host not in `upstreamHosts` is refused, never fetched.
- `upstreamHosts`: the only hosts a passthrough may reach (`host` or `host:port`). Private and loopback addresses are
  refused unless listed.
- `redact`: removes secrets from the NDJSON and from recorded HARs. `jsonPaths` apply to request bodies and to JSON response bodies, including a response that echoes the request (the paths are also tried on nested objects and on JSON held in a string value). Non-JSON bodies are not changed.

The net server starts when the run needs it: a `--net-*` flag, an `instrument.net` block (or `"net": true`), or any
spec that mentions `BTNet_`. Otherwise a headless run is unchanged.

## The `BTNet_` API in a spec

The functions exist in headless spec builds when the run uses net. Each call is one small request to the loopback
server and throws a string if it cannot complete (a bad rule says why), so a wrong rule fails the test instead of
passing silently.

```brightscript
BTNet_reset()                                    ' drop spec rules, hide the request log so far
BTNet_mock({ method: "GET", url: "https://api.example.com/v1/home*", status: 200, json: { rows: [] } })
BTNet_mock({ url: "**/v1/search*", responses: [{ status: 503 }, { status: 200, body: "{}" }] })
BTNet_fault({ url: "**/v1/config", kind: "timeout" })     ' kind: timeout | reset | status (with status:)
BTNet_useFixture("fixtures/net/home.har")        ' rules or HAR, path relative to the project root
reqs = BTNet_requests({ method: "POST", url: "**/v1/track" })   ' filter is optional
```

`BTNet_requests` returns an array of `{ id, method, url, headers, body, status, ms, rule, source, error }`, only for
requests made since the last `BTNet_reset`. `source` is `mock`, `fixture`, `fault`, `unmatched` or `passthrough`.
Headers and bodies are the raw ones, not redacted.

A complete test:

```brightscript
namespace tests
  @suite("tracking")
  class TrackingTests extends rooibos.BaseTestSuite

    @describe("track")

    @beforeEach
    function reset()
      BTNet_reset()
    end function

    @it("posts one event")
    function _()
      BTNet_mock({ url: "https://api.example.com/v1/track", status: 204 })
      sendTrack("play")
      reqs = BTNet_requests({ method: "POST", url: "**/v1/track" })
      m.assertEqual(reqs.count(), 1)
      m.assertEqual(reqs[0].status, 204)
    end function

  end class
end namespace
```

**Per-test scoping.** Rules and the request log are scoped by `BTNet_reset()`, not automatically: call it in a
`@beforeEach` (as above) so each test starts clean. Rules from `fixtures` in `brighttest.json` always stay.

**Key case.** BrightScript associative arrays are case-insensitive. brighttest restores the spelling of the rule's own
keys (`delayMs`, `reqHeaders`, ...), but the contents of `json` and `headers` are sent as BrightScript hands them over.
If a response must keep exact key case, pass it as `body:` text or use `file:`.

**Assertions.** There is no `assertStringContains` in Rooibos 5.16; test a body with
`m.assertTrue(Instr(1, text, "needle") > 0)` or `m.assertEqual`.

## Record and replay

```bash
brighttest --net-record                 # HAR under .brighttest/net/<run>.har
brighttest --net-record fixtures/net/home.har
```

`--net-record [file]` passes requests through to `instrument.net.upstreamHosts` and writes a redacted HAR when the
run ends. It needs `upstreamHosts` (exit 2 without it). Add the HAR to `fixtures`, drop the flag, and the suite
replays offline.

## Flags

| Flag | Effect |
|---|---|
| `--net-record [file]` | Record passthrough traffic to a HAR (headless lanes only). |
| `--net-unmatched fail\|passthrough` | Override `instrument.net.unmatched` for this run. |

Both exit 2 with `--device` or `--cross-check`.

## Run output

Every net run writes `.brighttest/net/last-run.ndjson` (redacted), one event per line: `net.request`, `net.response`
and `net.error` (`kind` is `unmatched`, `upstream`, `fault:timeout`, `fault:reset`). Failing requests are also listed
under "Network failures" at the end of the run. Requests a test deliberately leaves unmatched appear there too.

Requests no rule matched are also listed under "Unmatched requests (N)" as method and path only (no query, headers
or bodies).

## Turning a HAR into rules

```bash
brighttest net convert .brighttest/net/run.har -o fixtures/net/home.rules.json
```

`net convert` writes one rule per HAR entry (`har-1`, `har-2`, ...), in recorded order, with method, url, status,
headers and body (`json` for JSON bodies). Edit the file by hand, then list it under `instrument.net.fixtures`. A URL
requested more than once gets `times: 1` on all but the last rule so replay serves the responses in recorded order.
Values the recorder redacted stay redacted (redacted query values become `*`, redacted headers are blanked), and
entries whose body still holds a redacted value are reported on stderr. Without `-o` the rules print to stdout. An
unreadable or non-HAR input exits 1 with a message.

## On the device

`BTNet_*` specs are headless-only. With `--device`, a spec file that uses `BTNet_` is left out of the build and the
CLI prints `skipped (headless-only network fixtures): <path>`. `--cross-check` runs them on the headless leg only and
reports them as headless-only, not as a divergence.

## Limits

- Only `setUrl` calls in your own files are rewritten (and `getUrl` is wrapped so comparisons keep working). URLs set
  any other way (`CreateObject(var)`, `ifHttpAgent` on nodes, video and poster URIs) are not intercepted.
- Faults model what the device reports, but a headless engine may not give the identical response code for
  `timeout`/`reset` as hardware. Treat them as logic tests, and use the device lane for fidelity.
- The `tmp:/rt-http-fixtures.json` hook of the old simulator fork is not part of this feature and may go away.
