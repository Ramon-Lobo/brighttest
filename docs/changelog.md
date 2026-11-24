# Changelog

All notable changes for users of brighttest. Internal refactors, tests and CI changes are left out.
Versions follow semver; while on 0.x, a minor release may contain breaking changes, always listed first.


## Unreleased {#unreleased}

### Breaking changes
- **Device lane:** a device run now passes only when Rooibos prints its final `[Rooibos Result]` line. A run that
  stopped partway after some tests passed used to pass and now fails. [Upgrade notes](#upgrade-0-8-0)
- **Device and cross-check lanes:** a crashed test now counts as a failure and gets a failure line in the device
  summary. [Upgrade notes](#upgrade-0-8-0)
- **Reporting:** the run fails when Rooibos's final test report has a CRASH or FAIL entry that the totals missed.
  [Upgrade notes](#upgrade-0-8-0)
- **Studio:** with several cached devices and no `--host`, `brighttest studio` now refuses to start instead of
  connecting to the last device used. It also needs a dev password whenever it connects to a device, including with an
  explicit `--host`. [Upgrade notes](#upgrade-0-8-0)
- **E2E:** launch params must be strings, numbers or booleans; objects, arrays and `null` are rejected when the flow is
  parsed (they used to be sent as `[object Object]`). [Upgrade notes](#upgrade-0-8-0)

### Security
- **Studio:** rejects cross-origin and non-JSON requests to its local API, and requests with a non-local `Host` header
  ([Studio guide](./guide/studio.md)).
- **Devices:** the credential cache is written atomically with owner-only permissions.

### Features
- **Instrumentation and app state:** `brighttest instrument build | verify | census` builds an instrumented copy of
  your app (no source edits) with a state agent that reads and writes scene, global, node, `m` and registry state, with
  redaction (including masking of `redact.paths` state in Studio's live tree and saved run traces) and a publish rate
  cap. `census` redacts absolute and home paths from errors and report text
  ([guide](./guide/instrument.md), [app state](./e2e/app-state.md)).
- **Studio:** state inspector with edit in place, snapshots, diff and export/import; action log with time travel;
  network panel; lease badge, queue and device pool ([guide](./guide/studio.md)).
- **Studio Profile page:** performance sampling, `.bsprof` profiler pull and import, a Perfetto system trace (kept per
  device, with auto-restart and a frame-budget summary), SceneGraph console commands and graphics frame rate. The node
  overlay now matches what the device draws ([guide](./guide/studio.md)).
- **Network faults:** an instrumented build routes app HTTP through a fault proxy with rules, HAR recording and
  `brighttest net convert` (HAR to rules); `BTNet_` spec API and `--net-record` / `--net-unmatched` in the headless
  lanes; e2e steps `mockHttp`, `waitForRequest`, `assertRequest`, `recordHttp` and `clearHttp`
  ([fault model](./guide/net-faults.md), [recipe](./guide/network-recipe.md)).
- **E2E:** app-state steps (`assertState`, `waitForAgent`, `setState`, `snapshot`, `restore`, `callFunc`) with typed
  error codes; launch readiness gate; fast `APP_CRASHED` failure; `--reset-device`; log capture with `assertLog` and
  `expectNoLog` plus failure bundles; `--junit`; `--fail-on-skip`; flow `requires`, `holdKey`, key validation and
  `noSystemDialog`; per-step timing; `--ecp-port`; faster selector reads on large trees ([flow reference](./e2e/flows.md)).
- **E2E lint:** `brighttest e2e lint <flow...>` checks flow files without a device ([flow reference](./e2e/flows.md)).
- **Adoption:** `brighttest assess` writes a read-only readiness report (blockers, secret and risky-pattern scans,
  Markdown output) and redacts absolute and home paths; `init --brownfield` and `init --greenfield` (store and HTTP
  templates); `skills install` adds an always-on safety block, installs agent definitions for Claude and Copilot, and
  can merge an optional guard hook and MCP entry; `skills --check` for CI
  ([assess](./guide/assess.md), [agent skills](./guide/agent-skills.md)).
- **Agent surface (MCP):** `brighttest mcp` stdio server, including a leased network window with `net_requests` and
  `net_mock` tools ([guide](./guide/mcp.md)).
- **Devices and lease:** `brighttest device lock | renew | unlock | with | status | hook | reset | log` to share a
  device safely, with a device pool (`--device any`), queue ETA and a warning when the dev channel runs with no lease
  holder; `brighttest doctor` (device readiness, engine capability table, hub checks)
  ([sharing a device](./guide/device-lease.md)).
- **Device lane:** `--device` and `--cross-check` take the host and password from `ROKU_HOST` / `ROKU_PASSWORD` or the
  device cache (when exactly one device is cached), so the flags are optional ([CLI reference](./guide/cli-reference.md)).
- **Spec helpers:** `BTState_load` and `BTState_seedGlobals` for snapshot fixtures ([state fixtures](./writing-tests/state-fixtures.md));
  `BTMedia` for headless Video and Audio state ([media state](./writing-tests/media-state.md)).
- **Config:** `deviceInfo` sets the headless engine identity.

### Improvements
- **E2E:** preflight fails fast on unreachable, Limited or dev-disabled devices, and only for the affected host in a
  multi-device run; falls back to the app UI query when SceneGraph reads keep failing.
- **Device lane:** a run that stops early now says why (no device output for N s, or a runtime error in a named
  suite) instead of a generic deploy or device error ([CI integration](./guide/ci.md)).
- **Skills:** `skills install` migrates older flattened installs to the current layout (see upgrade notes).
- **Headless lane:** warns when it meets a Task component.

### Fixes
- **E2E:** focus moves through composite focus; the focused selector picks the deepest node; launch with params
  reaches an already running channel ([flow reference](./e2e/flows.md)).
- **Studio:** serves the last tree instead of an error on transient read failures.

### Upgrade notes {#upgrade-0-8-0}
- Re-run `npx brighttest skills install` once; see [Migrating from older installs](./guide/agent-skills.md#migrating-from-older-flattened-installs).
- If CI starts failing on the device lane, look for runs that stopped before the final result line, and for tests that
  crashed; they used to count as passes. See [CI integration](./guide/ci.md).
- If a run now fails on a CRASH or FAIL entry in Rooibos's final test report (for example a crash in an `@SGNode`
  `beforeEach`) while the totals said Success, fix that spec.
- Studio: pass `--host <ip>` (or set `ROKU_HOST`) when several devices are cached, and give the dev password with
  `--password` or `ROKU_PASSWORD`. `brighttest devices` finds Rokus on your network (SSDP) and saves the dev password
  so Studio can connect without `--host`.
- E2E flows: give launch params as flat keys with string, number or boolean values ([flow reference](./e2e/flows.md)).

## v0.7.0 - 2026-07-23 {#v0-7-0}

### Features
- **E2E:** assert playback state through the ECP media player, with steadier reads while video plays
  ([flow reference](./e2e/flows.md)).
- **CLI:** `brighttest -v` / `--version` prints the installed version.
- **Examples:** a streaming sample app with on-device video e2e.

[Full diff](https://github.com/Ramon-Lobo/brighttest/compare/v0.6.0...v0.7.0)

## v0.6.0 - 2026-07-23 {#v0-6-0}

### Features
- **Studio:** `brighttest studio` opens a live device mirror with a node overlay, a flow editor with an on-device
  runner, and run history with trace frames kept on disk.
- **E2E:** `runFlow` step for reusable subflows ([flow reference](./e2e/flows.md)).
- **Devices:** `brighttest devices` finds Rokus on your network (SSDP) and saves the dev password so Studio can connect
  without `--host`.

[Full diff](https://github.com/Ramon-Lobo/brighttest/compare/v0.5.0...v0.6.0)

## v0.5.0 - 2026-07-23 {#v0-5-0}

### Features
- **E2E:** `wait` and `assertField` steps; `inspect` shows field and child detail ([flow reference](./e2e/flows.md)).

[Full diff](https://github.com/Ramon-Lobo/brighttest/compare/v0.4.0...v0.5.0)

## v0.4.0 - 2026-07-23 {#v0-4-0}

### Features
- **E2E:** inspect a node's fields and build assertions from them, with a flow authoring skill
  ([authoring](./e2e/authoring.md)).

[Full diff](https://github.com/Ramon-Lobo/brighttest/compare/v0.3.0...v0.4.0)

## v0.3.0 - 2026-07-14 {#v0-3-0}

First tagged release. It also covers the untagged npm releases 0.1.0 to 0.2.0.

### Breaking changes
- **CLI:** requires Node 22 or later (the engine crashes on Node 18 and 20). [Upgrade notes](#upgrade-0-3-0)

### Features
- **Lanes:** headless, device and cross-check lanes with a live reporter and a per-file coverage table
  ([CI](./guide/ci.md)).
- **Config:** `@deviceOnly` tests are skipped on headless lanes; global-context seeding for `@SGNode` device tests
  ([global context](./writing-tests/global-context.md), [headless vs device](./writing-tests/headless-vs-device.md)).
- **Adoption:** agent skills and `brighttest init` ([agent skills](./guide/agent-skills.md)).
- **E2E:** on-device lane (`brighttest e2e`) with scripted flows, `record` to scaffold a flow, focus path-finding and
  text entry, build-time id injection, multi-device runs with a deep-link matrix and per-host passwords, and `--video`
  session replay ([overview](./e2e/index.md), [flow reference](./e2e/flows.md)).

### Fixes
- **Reporter:** tests with long names are counted correctly.
- **Coverage:** ANSI escapes no longer break cross-check test names or LCOV parsing.

### Upgrade notes {#upgrade-0-3-0}
- Upgrade to Node 22 or later.

[Full diff](https://github.com/Ramon-Lobo/brighttest/compare/1172a35...v0.3.0)
