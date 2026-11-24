# Changelog

All notable changes for users of brighttest. Internal refactors, tests and CI changes are left out.
Versions follow semver; while on 0.x, a minor release may contain breaking changes, always listed first.

## Unreleased {#unreleased}

### Breaking changes
- **Device lane:** a test now passes only when the device prints its result line. Runs that ended without one used to
  pass and now fail. [Upgrade notes](#upgrade-0-8-0)
- **Device and cross-check lanes:** a crashed test now counts as a failure and gets a failure line in the device
  summary. [Upgrade notes](#upgrade-0-8-0)
- **Reporting:** the run fails when the report tree shows a crash or failure that the summary missed.
  [Upgrade notes](#upgrade-0-8-0)
- **Devices:** with several cached devices and none named, the CLI now fails instead of picking the last one. Name the
  device with `--host` or `ROKU_HOST`. [Upgrade notes](#upgrade-0-8-0)
- **E2E:** launch params must be strings; object values are rejected. [Upgrade notes](#upgrade-0-8-0)

### Security
- **Studio:** rejects cross-origin and non-JSON requests to its local API.
- **Studio:** masks app state named in `redact.paths` in the live tree and in saved run traces.
- **Devices:** the credential cache is written atomically with owner-only permissions.
- **Assess:** absolute and home paths are redacted from census errors and report text.

### Features
- **Instrumentation and app state:** `brighttest instrument build | verify | census` builds an instrumented copy of
  your app (no source edits) with a state agent that reads and writes scene, global, node, `m` and registry state, with
  redaction and a publish rate cap ([guide](./guide/instrument.md), [app state](./e2e/app-state.md)).
- **Studio:** state inspector with edit in place, snapshots, diff and export/import; action log with time travel;
  network panel; Perfetto capture kept per device with auto-restart and a frame-budget summary; graphics frame rate and
  console status in the perf view; lease badge, queue and device pool ([guide](./guide/studio.md)).
- **Network faults:** an instrumented build routes app HTTP through a fault proxy with rules, HAR recording and
  `brighttest net convert` (HAR to rules); `BTNet_` spec API and `--net-record` / `--net-unmatched` in the headless
  lanes; e2e steps `mockHttp`, `waitForRequest`, `assertRequest`, `recordHttp` and `clearHttp`
  ([fault model](./guide/net-faults.md), [recipe](./guide/network-recipe.md)).
- **E2E:** app-state steps (`assertState`, `waitForAgent`, `setState`, `snapshot`, `restore`, `callFunc`) with typed
  error codes; launch readiness gate; fast `APP_CRASHED` failure; `--reset-device`; log capture with `assertLog` and
  `expectNoLog` plus failure bundles; `--junit`; `--fail-on-skip`; flow `requires`, `holdKey`, key validation and
  `noSystemDialog`; per-step timing; `--ecp-port`; faster selector reads on large trees ([flow reference](./e2e/flows.md)).
- **Adoption:** `brighttest assess` writes a read-only readiness report (blockers, secret and risky-pattern scans,
  Markdown output); `init --brownfield` and `init --greenfield` (store and HTTP templates); `skills install` for more
  agents with an always-on safety block, agent definitions and an optional guard hook; `skills --check` for CI
  ([assess](./guide/assess.md), [agent skills](./guide/agent-skills.md)).
- **Agent surface (MCP):** `brighttest mcp` stdio server, including a leased network window with `net_requests` and
  `net_mock` tools ([guide](./guide/mcp.md)).
- **Devices and lease:** `brighttest device lock | renew | unlock | with | status | hook` to share a device safely, with
  a device pool (`--device any`), queue ETA and a warning when the dev channel runs with no lease holder;
  `brighttest doctor` (device readiness, engine capability table, hub checks); idle watchdog (`--idle-timeout`)
  ([sharing a device](./guide/device-lease.md)).
- **Spec helpers:** `BTState_load` and `BTState_seedGlobals` for snapshot fixtures ([state fixtures](./writing-tests/state-fixtures.md));
  `BTMedia` for headless Video and Audio state ([media state](./writing-tests/media-state.md)); `deviceInfo` config for
  the headless engine identity.

### Improvements
- **E2E:** preflight fails fast on unreachable, Limited or dev-disabled devices, and only for the affected host in a
  multi-device run; falls back to the app UI query when SceneGraph reads keep failing.
- **Skills:** `skills install` migrates older flattened installs to the current layout (see upgrade notes).
- **Coverage:** warns when the headless lane meets a Task component.

### Fixes
- **E2E:** focus moves through composite focus; the focused selector picks the deepest node; launch with params
  reaches an already running channel; replayed debugger prompts are ignored.
- **Device lane:** clearer stall and runtime-error messages; heartbeat lines no longer reset the idle watchdog.
- **Studio:** serves the last tree instead of an error on transient read failures; refuses to start without its built
  UI and says how to build it.
- **CLI:** piped JSON output is no longer cut off at exit; `lib/spec-api` and `lib/instrument` ship in the package.

### Upgrade notes {#upgrade-0-8-0}
- Re-run `npx brighttest skills install` once; see [Migrating from older installs](./guide/agent-skills.md#migrating-from-older-flattened-installs).
- If CI starts failing on the device lane, look for tests that crashed or printed no result line; they used to count as
  passes. See [CI integration](./guide/ci.md) and [sharing a device](./guide/device-lease.md).
- If the run now fails on a CRASH or FAIL the summary missed, fix the failing spec; the report tree is the source.
- With several cached devices, pass `--host <ip>` or set `ROKU_HOST`.
- E2E flows: write launch param values as strings ([flow reference](./e2e/flows.md)).

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
- **Devices:** credential resolution and caching, and SSDP discovery.

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

### Features
- **Lanes:** headless, device and cross-check lanes with a live reporter and a per-file coverage table
  ([CI](./guide/ci.md)).
- **Config:** `@deviceOnly` tests are skipped on headless lanes; global-context seeding for `@SGNode` device tests
  ([global context](./writing-tests/global-context.md), [headless vs device](./writing-tests/headless-vs-device.md)).
- **Adoption:** agent skills and `brighttest init` ([agent skills](./guide/agent-skills.md)).
- **E2E:** on-device lane (`brighttest e2e`) with scripted flows, `record` to scaffold a flow, focus path-finding and
  text entry, build-time id injection, multi-device runs with a deep-link matrix and per-host passwords, and `--video`
  session replay ([overview](./e2e/index.md), [flow reference](./e2e/flows.md)).

### Improvements
- **CLI:** requires Node 22 or later.

### Fixes
- **Reporter:** tests with long names are counted correctly.
- **Coverage:** ANSI escapes no longer break cross-check test names or LCOV parsing.

[Full diff](https://github.com/Ramon-Lobo/brighttest/compare/1172a35...v0.3.0)
