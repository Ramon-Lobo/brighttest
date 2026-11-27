# HTTP fixtures (headless)

::: info At a glance
**What it is for:** answering your app's HTTP calls from rules instead of the network, in the **headless lanes only**
(`brighttest`, `brighttest --coverage`).

**You will:**
- write rules that mock, fault or pass through requests
- load fixtures for the whole run, or mock per test with `BTNet_*`
- assert on the requests your app sent
- record real traffic once and replay it offline

**First file:** `brighttest.json` (`instrument.net`)
:::

## How it works

brighttest rewrites `roUrlTransfer.setUrl(...)` call sites in your own source files so requests go to a loopback
server it starts for the run. The server matches each request against your rules and replies with:

- a mock,
- an injected fault, or
- the real origin (only when you allow the host).

Nothing leaves your machine unless you allow it.

## What works today

Pick the tool for the job.

| You want to | Use |
|---|---|
| Mock responses for every spec in the run | `instrument.net.fixtures` in `brighttest.json` (rules or HAR files) |
| Mock or fault responses for one test | `BTNet_mock`, `BTNet_fault`, `BTNet_useFixture` in the spec |
| Assert on what the app sent | `BTNet_requests` |
| Record real traffic once and replay it offline | `--net-record`, then list the HAR under `fixtures` |
| Decide what happens to a request no rule matches | `instrument.net.unmatched` or `--net-unmatched` |
| See every request of the last run | `.brighttest/net/last-run.ndjson` |

::: warning Not supported
- The device lane (see [On the device](#on-the-device)).
- Requests that do not go through a rewritten `setUrl` call (see [Limits](#limits)).
- `@SGNode` specs that use `BTNet_*` from the render thread: not verified; use config fixtures there.
:::

## Rules

One rule object is used in rule files, HAR conversion, and `BTNet_mock` / `BTNet_fault`.

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
| `url` | Glob, required. Matched against `scheme://host[:port]/path`; a pattern starting with `/` matches the path only. `*` stays in one path segment, `**` crosses segments. A `?key=glob` part lists query pairs that must be present; without one, the query is ignored. |
| `reqHeaders`, `reqBody` | Extra match conditions: header globs; body as a string (contains) or `{ contains, regex, json: { "$.a.b": value } }`. |
| `times` | Stop matching after N hits. |
| `status`, `headers` | Response status (default 200) and headers. |
| `body`, `json`, `file`, `bodyBase64` | The response body; use one. `file` is relative to the project root and confined to it. |
| `delayMs` | Wait before answering. |
| `fault` or `kind` | `timeout`, `reset`, or `status` (with `status`). Optional `holdMs`, `partialBytes`. Device failure codes: see [Network fault model](/guide/net-faults). |
| `responses` | A sequence: one entry per match, the last repeating. |
| `passthrough: true` | Send this match to the real origin (the host must be allowed, see below). |

**Order:** the first matching rule wins. Spec rules come before config fixtures, newest first, so a test can override
a fixture. Config fixtures keep their declaration order.

## Config fixtures

Load rules for every spec in the run from `brighttest.json`.

```json
{
  "instrument": {
    "net": {
      "fixtures": ["fixtures/net/*.rules.json", "fixtures/net/*.har"],
      "unmatched": "fail",
      "upstreamHosts": ["api.staging.example.com"],
      "redact": { "headers": [], "query": [], "jsonPaths": ["$.user.email"], "bodyKeys": [] }
    }
  }
}
```

| Key | Meaning |
|---|---|
| `fixtures` | Globs inside the project root. A pattern outside it, or one matching nothing, is an error. Files are rule files or HAR 1.2. |
| `unmatched` | `fail`: answer an unmatched request with status 599 and list it in the failure summary. `passthrough`: send it to the real origin. Default: `fail` once any config fixture is loaded, else `passthrough`. Set it explicitly. A passthrough to a host not in `upstreamHosts` is refused, never fetched. |
| `upstreamHosts` | The only hosts a passthrough may reach (`host` or `host:port`). Required for any `passthrough`. An empty list refuses every request with 403, so it is an error. Private and loopback addresses are refused unless listed. |
| `redact` | Removes secrets from the NDJSON and recorded HARs. See below. |

Flows inherit `instrument.net` and override per key with `config.net`.

**When the net server starts:** a `--net-*` flag, an `instrument.net` block (or `"net": true`), or any spec that
mentions `BTNet_`. Otherwise a headless run is unchanged.

### Redaction

What each `redact` key masks.

| Key | Behaviour |
|---|---|
| `jsonPaths` | Applies to JSON request bodies and JSON response bodies, including a response that echoes the request. Paths are also tried on nested objects and on JSON held in a string value. Runs before `bodyKeys`. |
| `query` | `redact.query` also redacts form-encoded (`application/x-www-form-urlencoded`) body fields by field name (the default names are included). `jsonPaths` never touches form bodies. |
| `bodyKeys` | Opt-in, empty by default. Key names to mask anywhere in a JSON request or response body: any depth, in arrays, inside JSON held in a string value (an echoed body). Also masks form-body fields with a listed name. |
| `enabled: false` | Turns every kind of redaction off. |

`bodyKeys` details:

- Matching is case-insensitive on the whole name after removing `_` and `-`: `token` matches `Token`, not `tokens`.
- The whole value becomes the `<redacted:name>` placeholder.
- **No default names.** A body `token` or `password` is written as is until you list it, for example
  `"bodyKeys": ["token", "access_token", "password"]`.
- The same list applies to Studio Mock this, the Studio HAR export and proxy recordings.
- Must be an array of strings (a bad value is an error at start); an empty array is off.
- Never changes URL query parameters; only JSON bodies and form-body field names.
- A leading byte-order mark is removed before reading JSON. A response saved to a HAR under a non-text content type is
  redacted first when it parses as JSON.
- Other non-JSON bodies are not changed.

::: warning Not redacted by `bodyKeys` or `jsonPaths`
Multipart bodies, NDJSON, JSONP, JSON cut off at the capture limit, form bodies sent without a form content type, and
compressed bodies.

When a value is masked the JSON is re-serialised, so large-integer precision elsewhere in that body can change. A body
nested too deep to re-serialise is replaced whole by `<redacted:body>`.
:::

## The `BTNet_` API in a spec

Mock, fault and inspect requests per test.

The functions exist in headless spec builds when the run uses net. Each call is one small request to the loopback
server. It throws a string if it cannot complete (a bad rule says why), so a wrong rule fails the test.

```brightscript
BTNet_reset()                                    ' drop spec rules, hide the request log so far
BTNet_mock({ method: "GET", url: "https://api.example.com/v1/home*", status: 200, json: { rows: [] } })
BTNet_mock({ url: "**/v1/search*", responses: [{ status: 503 }, { status: 200, body: "{}" }] })
BTNet_fault({ url: "**/v1/config", kind: "timeout" })     ' kind: timeout | reset | status (with status:)
BTNet_useFixture("fixtures/net/home.har")        ' rules or HAR, path relative to the project root
reqs = BTNet_requests({ method: "POST", url: "**/v1/track" })   ' filter is optional
```

`BTNet_requests` returns an array of `{ id, method, url, headers, body, status, ms, rule, source, error }`:

- only requests made since the last `BTNet_reset`;
- `source` is `mock`, `fixture`, `fault`, `unmatched` or `passthrough`;
- headers and bodies are raw, not redacted.

### A complete test

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

### Gotchas

| Topic | What to know |
|---|---|
| Per-test scoping | Rules and the request log are scoped by `BTNet_reset()`, not automatically. Call it in `@beforeEach`. Rules from `fixtures` in `brighttest.json` always stay. |
| Key case | BrightScript associative arrays are case-insensitive. brighttest restores the rule's own keys (`delayMs`, `reqHeaders`, ...), but `json` and `headers` contents are sent as BrightScript hands them over. For exact key case, use `body:` text or `file:`. |
| Assertions | Rooibos 5.16 has no `assertStringContains`. Use `m.assertTrue(Instr(1, text, "needle") > 0)` or `m.assertEqual`. |

## Record and replay

Capture real traffic once, then run offline.

```bash
brighttest --net-record                 # HAR under .brighttest/net/<run>.har
brighttest --net-record fixtures/net/home.har
```

1. Run with `--net-record [file]`. Requests pass through to `instrument.net.upstreamHosts`; a redacted HAR is written
   when the run ends. It needs `upstreamHosts` (exit 2 without it).
2. Add the HAR to `fixtures`.
3. Drop the flag. The suite replays offline.

## Flags

| Flag | Effect |
|---|---|
| `--net-record [file]` | Record passthrough traffic to a HAR (headless lanes only). |
| `--net-unmatched fail\|passthrough` | Override `instrument.net.unmatched` for this run. |

Both exit 2 with `--device` or `--cross-check`.

## Run output

Where to see what happened.

- `.brighttest/net/last-run.ndjson` (redacted), written by every net run, one event per line: `net.request`,
  `net.response`, `net.error` (`kind` is `unmatched`, `upstream`, `fault:timeout`, `fault:reset`).
- **"Network failures"** at the end of the run: failing requests, including ones a test deliberately leaves unmatched.
- **"Unmatched requests (N)"**: requests no rule matched, as method and path only (no query, headers or bodies).

## Turning a HAR into rules

```bash
brighttest net convert .brighttest/net/run.har -o fixtures/net/home.rules.json
```

- One rule per HAR entry (`har-1`, `har-2`, ...), in recorded order: method, url, status, headers, body (`json` for
  JSON bodies).
- Edit the file by hand, then list it under `instrument.net.fixtures`.
- A URL requested more than once gets `times: 1` on all but the last rule, so replay serves responses in recorded order.
- Redacted values stay redacted: query values become `*`, headers are blanked. Entries whose body still holds a
  redacted value are reported on stderr.
- Without `-o` the rules print to stdout.
- An unreadable or non-HAR input exits 1 with a message.

## On the device

`BTNet_*` specs are headless-only.

| Lane | What happens |
|---|---|
| `--device` | A spec file using `BTNet_` is left out of the build; the CLI prints `skipped (headless-only network fixtures): <path>`. |
| `--cross-check` | Runs them on the headless leg only and reports them as headless-only, not as a divergence. |

## Limits

::: warning
- Only `setUrl` calls in your own files are rewritten (`getUrl` is wrapped so comparisons keep working). URLs set any
  other way (`CreateObject(var)`, `ifHttpAgent` on nodes, video and poster URIs) are not intercepted.
- Faults model what the device reports, but a headless engine may not give the identical response code for
  `timeout`/`reset`. Treat them as logic tests; use the device lane for fidelity.
- The `tmp:/rt-http-fixtures.json` hook of the old simulator fork was removed in the `2.7.1-bt.1` engine. It is not
  part of this feature, and nothing reads that file.
:::

## Related

- [Network fault model](/guide/net-faults): device failure codes for faults
- [Headless vs device](/writing-tests/headless-vs-device): what each lane can test
- [State fixtures](/writing-tests/state-fixtures): seeding app state from a snapshot

**Full guide:** [HTTP fixtures](full:/writing-tests/http-fixtures) — the original wording.
