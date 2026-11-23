# BTNet rules: what the net mock may and may not do

Source: `docs/writing-tests/http-fixtures.md`. Read it for the full rule table; this page keeps the limits an agent
must respect. Network fault codes: `docs/guide/net-faults.md`.

## What it does

brighttest rewrites `roUrlTransfer.setUrl(...)` calls in the project's own files (the staged build, not the source
tree) so requests go to a loopback server started for the run. That server answers from rules: a mock, an injected
fault, or (only for an allowed host) the real origin.

## May

- Mock any method and URL glob with `status`, `headers`, and one of `body`, `json`, `file`, `bodyBase64`; add
  `delayMs`, `times`, or a `responses` sequence.
- Inject `fault` kinds `timeout`, `reset`, `status`.
- Load rules or HAR 1.2 files from `instrument.net.fixtures` (globs inside the project root) or `BTNet_useFixture(path)`.
- Read what the app sent with `BTNet_requests` (filter by method and URL glob). `source` says `mock`, `fixture`,
  `fault`, `unmatched` or `passthrough`.
- Set the policy for requests no rule matched: `instrument.net.unmatched` or `--net-unmatched fail|passthrough`.
  `fail` answers 599 and lists the request in the run output.

## May not

- Reach a host that is not in `instrument.net.upstreamHosts`. A passthrough to any other host is refused. Private
  and loopback addresses are refused unless listed. Do not add a host to the list without the human's OK.
- Intercept URLs set any way other than `setUrl` in the project's own files (`CreateObject(var)`, `ifHttpAgent` on
  nodes, video and poster URIs).
- Run on a device (`--device` skips the spec) or with `--cross-check` beyond the headless leg.
- Promise device-identical failures: headless `timeout` and `reset` may give a different code than hardware.
- Read `file:` outside the project root.

## Habits

- Call `BTNet_reset()` in `@beforeEach`. Rules and the request log are not scoped per test automatically.
- The first matching rule wins; rules added by a spec come before config fixtures, newest first.
- `BTNet_*` throws a string on a bad rule, so a wrong rule fails the test.
- A key's case inside `json` and `headers` is not kept (BrightScript associative arrays are case-insensitive). If
  case matters, use `body:` text or `file:`.
- Rooibos 5.16 has no `assertStringContains`; use `m.assertTrue(Instr(1, text, "needle") > 0)`.
- `.brighttest/net/last-run.ndjson` is redacted; `BTNet_requests` returns raw headers and bodies. Do not paste
  either into a report without checking for secrets.

## Example rule file

Use generic hosts in anything you write down.

```json
{ "rules": [
  { "method": "GET", "url": "https://api.example.test/v1/home*", "status": 200, "json": { "rows": [] } },
  { "url": "**/v1/config", "fault": { "kind": "timeout" } }
] }
```

Unverified: `@SGNode` specs calling `BTNet_*` from the render thread (the guide marks this not verified; use config
fixtures there).
