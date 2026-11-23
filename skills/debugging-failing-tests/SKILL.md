---
name: debugging-failing-tests
description: Use when a brighttest run fails, produces no results, hangs, passes headless but fails on device, or when coverage looks wrong — how to read the output, isolate the cause, use --cross-check for fidelity, seed global context for device crashes, and test the Task/API layer.
triggers: test run fails; no test results; run hangs; passes headless but fails on device; coverage looks wrong; cross-check mismatch; device crash in test; flaky rooibos test
when-not-to-use: Do not use to author new specs (use writing-rooibos-tests), to debug a failing e2e flow step (use writing-e2e-flows), or to inspect a live device through MCP (use using-brighttest-mcp).
license: MIT
metadata:
  source: brighttest
---

# Debugging failing brighttest runs

A workflow for turning a red run into a fixed one. For authoring rules and the full pitfalls list, see the
`writing-rooibos-tests` skill.

## Read the output first

brighttest prints a Jest-style report: suites grouped by file, a `✓`/`✗` per test as it runs, then a
**Failures** section listing each failure with its `file:line`, a code frame of the failing test, and the
assertion reason, followed by a totals line. Start at the Failures section — the reason usually names the
problem directly (e.g. `expected "true (Boolean)" to be false`).

## Decision tree

1. **Build error / `Use of uninitialized variable`** → the spec isn't under a compiled path. Move it to
   `source/tests/`. Or the `rooibos` plugin didn't load (`Cannot find name 'rooibos'`) — check the project builds.
2. **A test is missing from the results** (counts don't add up) → an `@it` detached from its function, or a
   very long test name pushing the `(PASS)`/`(FAIL)` marker off the fixed-width line. Attach the `@it`
   directly above its function; shorten the name.
3. **"no result / 0 passed 0 failed"** → the run didn't complete. Re-run; check the output tail brighttest
   prints. Common causes are a build failure or a spec that crashes the interpreter on load.
4. **The run hangs / times out** → usually an async `@SGNode` test waiting on a signal that never fires, or
   an infinite loop. The watchdog kills it (headless 300s / device 900s). Add a timeout to the wait, or
   `--timeout <sec>` to change the budget.
5. **`assertEqual` fails on values that look equal** → type-strict numeric comparison. Compare floats to
   float literals, or use `m.assertTrue(a = b)` for value-only numeric equality.
6. **Passes headless, fails/crashes on `--device`** → see "Global-context crashes" below.
7. **Exit 75 (busy) or 77 (lease lost) on a device lane** → not a test failure. 75 = *device in use*: another holder kept the
   device past `--wait` (run `npx brighttest device status` to see who). 77 = the lease was lost or reached
   its deadline; re-run. *Device unreachable* is different: a connection error naming the IP, exit 1 —
   check the IP, network and developer mode.

## Confirm a test actually tests something

A test that "always passes" may not exercise the code. Temporarily break the code or flip the expectation,
confirm the test goes red, then restore. A test you haven't seen fail isn't protecting you.

## Global-context crashes (green headless, red on device)

A `@SGNode` widget that reads global app context (`config`, `user`, theme) during `init()` gets `invalid`
in a bare test scene. Headless tolerates it; a real device is strict and crashes while constructing:

```
'Dot' Operator attempted with invalid BrightScript Component ... (runtime error &hec)
Type Mismatch. Operator "+" can't be applied to "Invalid" and "String". (runtime error &h18)
```

**Fix:** seed the exact field path the code reads via `globalFields` in `brighttest.json`, keyed by
`@SGNode` type with a `"*"` catch-all that resets each field to `invalid` per suite:

```json
"globalFields": {
  "*":       { "config": null },
  "EpgTile": { "config": { "images": { "staticBaseUrl": "https://img.example.com" } } }
}
```

Read the backtrace: if the code does `config.images.staticBaseUrl`, seeding `config = {}` isn't enough —
seed the whole nested path. A grid throwing *"No itemComponentName defined"* (`&h28`) is a different fix:
it needs content / `itemComponentName` set on the node, not a global.

## Verify simulator fidelity with `--cross-check`

If you suspect the headless simulator behaves differently from hardware:

```sh
brighttest --cross-check --host <ip> --password <pw>
```

It runs every suite on **both** lanes and reports `agree` / `device-only` / `DIVERGENT`. Any divergent test
fails the run and is listed with its headless-vs-device result.

- **"agree" ≠ "pass".** `agree` means both lanes gave the *same* result — including both **failing**.
  Before trusting a reclaimed suite, confirm it's actually green in the default lane.
- A test that's genuinely hardware-only should be marked `@deviceOnly` so headless lanes skip it instead of
  reporting a false divergence.

## Coverage looks wrong

- **No coverage from `brighttest`** → the default lane skips coverage for speed. Use `--coverage`.
- **Percentage looks low** → coverage reflects only the lines your tests exercised; a big untested file is
  accurately low. It's line/statement coverage only (no branch/function data).

## Testing the Task / API layer

Task nodes can't be `@SGNode`-tested (their run loop blocks). Test request-building and response-parsing as
**pure functions** headless, and keep the Task itself a thin shell that calls tested functions.

In the headless lanes brighttest can answer HTTP calls from rules (full guide: `docs/writing-tests/http-fixtures.md`):

- Per test, in the spec: `BTNet_reset()` in `@beforeEach`, then `BTNet_mock({ url, status, json|body|file, responses })`,
  `BTNet_fault({ url, kind: "timeout"|"reset"|"status", status })`, `BTNet_useFixture("fixtures/net/x.har")`, and
  `BTNet_requests({ method, url })` to assert what the app sent. A rejected rule throws, so the test fails loudly.
- For the whole run: `instrument.net.fixtures` (rule or HAR globs), `unmatched` (`fail` answers 599 and lists it),
  `upstreamHosts` (the only hosts a passthrough may reach). `--net-record [file]` records a HAR; `--net-unmatched`
  overrides the policy.
- Every net run writes `.brighttest/net/last-run.ndjson`; failing requests print under "Network failures".
- Only `setUrl` calls in your own files are intercepted. `BTNet_*` specs run headless only: `--device` skips them and
  `--cross-check` reports them as headless-only. Rooibos 5.16 has no `assertStringContains`; use
  `m.assertTrue(Instr(1, text, "x") > 0)`.

Still keep request-building and response-parsing as pure functions where you can; use fixtures for the Task or client
glue around them.

## When stuck: shrink the surface

Isolate the failing suite by pointing `--config` at a cut-down `brighttest.json` (or temporarily `@only`
the suite/test — never commit `@only`). A single-suite run makes the failure fast to reproduce and read.

For device stalls at about 10 minutes, Limited ECP, port 8085 conflicts and lease exit codes, see the `using-a-roku-device-safely` skill.
