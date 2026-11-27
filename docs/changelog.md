# Changelog

All notable changes for users of brighttest. Internal refactors, tests and CI changes are left out.
Versions follow semver; while on 0.x, a minor release may contain breaking changes, always listed first.


## Unreleased {#unreleased}

### Breaking changes
- **Device lane:** a device run now passes only when Rooibos prints its final `[Rooibos Result]` line; a run that
  stopped partway after some tests passed used to pass and now fails. A crashed test (device and cross-check lanes) now
  counts as a failure and gets a failure line in the device summary. [Upgrade notes](#upgrade-0-8-0)
- **Reporting:** the run fails when Rooibos's final test report has a CRASH or FAIL entry that the totals missed.
  [Upgrade notes](#upgrade-0-8-0)
- **Reporting:** a run where an `@async` case inside an `@SGNode` suite never finishes, so the later cases are dropped, used
  to exit 0 with fewer cases counted. It now fails and lists the dropped cases. [Upgrade notes](#upgrade-0-8-0)
- **Reporting:** a headless scene run where the engine crashed partway (`EXIT_BRIGHTSCRIPT_CRASH`) or aborted with a
  native `FATAL ERROR` used to exit 0 with the cases streamed so far counted as passed. It now fails, says the run
  crashed, and reports the case that was running as failed (also in JUnit). A headless coverage run that prints no LCOV
  block now fails with "coverage requested but no LCOV in output" instead of exiting 0 without a coverage file.
  [Upgrade notes](#upgrade-0-8-0)
- **Studio:** `brighttest studio` no longer connects to the last device used. Without `--host` it uses `ROKU_HOST`, or
  the one cached device; with several cached devices it refuses to start. It also refuses to start when it has a
  device but no dev password (from `--password`, `ROKU_PASSWORD`, a project `.env` or the device cache); before, it
  started and failed later. [Upgrade notes](#upgrade-0-8-0)
- **E2E:** launch param values must be strings, numbers or booleans. A value that is an object, array or `null`
  (for example params nested under a `params:` key, which used to be sent as `params=[object Object]`) now fails
  the flow before the launch is sent. `brighttest e2e lint` also catches it, with no device. [Upgrade notes](#upgrade-0-8-0)
- **Headless scene lanes:** `@SGNode` specs and `--coverage` now take the device identity from the `deviceInfo` block when the engine supports `--device-data` (`@ramonlobo/brs-node` 2.7.1-bt.1 or later). A project with an existing `deviceInfo` block now gets the block's model, resolution and connection inside `@SGNode` specs instead of the engine defaults. With an engine without the flag, brighttest warns once and keeps the engine defaults.

### Security
- **Studio and devices:** Studio rejects cross-origin and non-JSON requests to its local API, and requests with a
  non-local `Host` header ([Studio guide](./guide/studio.md)). The device credential cache is written atomically with
  owner-only permissions.

### Security
- **Studio and devices:** Studio rejects cross-origin and non-JSON requests to its local API, and requests with a
  non-local `Host` header ([Studio guide](./guide/studio.md)). The device credential cache is written atomically with
  owner-only permissions.
- **Agent guard hook:** also denies a raw ECP `curl` whose host is an environment variable (`$ROKU_HOST`,
  `${ROKU_HOST:-x}`) when the path mutates the device or the port is 8060; read-only `/query` reads stay allowed
  ([sharing a device](./guide/device-lease.md)).

### Features
- **Instrument:** new `instrument.strictAccept` list of globs. An `excluded-candidate` entry in an excluded file that matches it no longer fails `instrument build --strict`; any other exclude still fails. A value that is not an array of glob strings is a config error.
- **Instrument:** `instrument build --sideload --reuse` skips the rebuild and installs the newest stored build when the source fingerprint, flags and hub token are unchanged; rebuild only after your own code changes.
- **Device lane:** `--device --lcov` now writes function (`FN`/`FNDA`) and branch (`BRDA`) records as well as lines when the engine supports `--coverage-dir` (rooibos 5.17.0 or newer), so CI tools can show function and branch coverage. Older engines keep line records only.
- **Studio:** the Inspect page is now a grid of tiles (monitor, flow, remote, node, tree, selector, state, actions, network) that you can drag, resize, minimize, hide and restore from a Tiles menu, with presets and Reset; the layout is saved per browser. The tab test ids (`inspector-panel`, `tab-node`, `tab-tree`, `tab-selector`, `tab-state`, `tab-actions`, `tab-net`) are gone; use the `tile-*` and `tiles-*` ids listed in the [Studio guide](./guide/studio.md).
- **Instrument:** `instrument build --from <dir|zip>` instruments an already-built package for apps with their own build step, and `assess` recommends it when it finds a packaging script or placeholder tokens. [Guide](/guide/instrument#apps-with-their-own-build-step-from)
- **E2E and Studio:** `assertState` takes `layer: node` or `layer: m` with `node: { id }` and reads that node through
  the hub; the Node tab's State view has a **+ assert** button that adds the step. [App state](./e2e/app-state.md)
- **Net:** `instrument build --net` keeps the hub token it baked in a 0600 file under `.brighttest/hub-tokens/`, keyed by the package sha256, and `brighttest net token --ensure` reuses it (or generates one) after a lost shell, printing only the file path and the package hash prefix, never the token.
- **Setup:** `brighttest setup` finds a Roku (or takes `--host`), checks it like `doctor`, and saves `ROKU_HOST` to the project `.env` after a prompt (`--write` for agents, `--print` never writes). It adds `.env` to `.gitignore`, prints the export line for bash, zsh, fish, PowerShell and cmd, and never asks for, stores or prints the dev password.
- **Doctor:** `brighttest doctor` now prints an `environment:` section (and `environment` in `--json`) for `ROKU_HOST`, `ROKU_PASSWORD`, `BRIGHTTEST_HUB_TOKEN` and the `BRIGHTTEST_*` settings in use: set or not, where from, a clear problem for a malformed value, never a secret value. A missing host points to `brighttest setup`.
- **Studio:** Run becomes a Stop button while a flow runs (`Cmd+.` or `Ctrl+.` also stops it). The stopped step and the Runs page show a **stopped** state, and a second run while one is active says so instead of failing silently.
- **Studio:** the Settings page now shows the effective settings instead of a placeholder: the device and where it came from (`--host`, environment, `.env`, cache, Devices page), a **Test connection** button (device info only, no lease), whether a dev password is known (never the value), lease timings with their source, whether the instrument hub is running and why not, whether `BRIGHTTEST_HUB_TOKEN` is set (never the value), folders, port, redaction paths and versions. New read-only route `GET /api/settings` and `POST /api/settings/check`.
- **Studio:** Settings can **Save as project default** (writes `ROKU_HOST` to `.env`, current or cached device only; never the password) and **Reset Studio preferences in this browser** (removes only `bt.studio.*` keys, after a confirm). New route `POST /api/settings/host`.
- **Studio:** the Node tab has a **State** view that reads and edits the selected node's fields or its component's `m`
  through the app's agent (value tree, ack chip, refusal hints, node links, **+ setState step**), opened from the Node
  tab switch, a Tree row (**state**) or the right-click menu (**Inspect state**). New test ids `node-view-state`,
  `tree-node-state`, `menu-inspect-state` and `node-state-*`. Needs an instrumented build and the hub.
- **Studio:** the node overlay is now sized correctly on an hd app (manifest `ui_resolutions=hd`) on a 1080p output on firmware 16, where the root scene and its built-in Poster report 1920x1080 next to the app's 1280x720 content. The boxes were drawn at two thirds scale there.
- **Studio:** an **overlay** switch in the header (Inspect and Record) hides the node outlines to show only the device
  picture. It is on by default and remembered per browser. While off, clicking the picture selects nothing (the selection
  is kept) and Studio stops reading the tree unless the Node, Tree or Selector tab is open (then once a second), which
  leaves the device free for screenshots and key presses. New test id `toggle-overlay`.
- **Studio:** a flow started with Run can be stopped: `POST /api/run/stop` with the run id ends it between steps or mid-step (a polling step such as `waitFor` stops within about 250 ms), saves it as **stopped** (not failed) and keeps the device lease. Closing the page stops the run too, and a second Run while one is active answers 409 `RUN_IN_PROGRESS`. A queued `setState`, `snapshot`, `restore` or `callFunc` is not recalled and may still apply. ([Studio guide](./guide/studio.md))
- **Instrumentation and app state:** `brighttest instrument build | verify | census` builds an instrumented copy of
  your app (no source edits) with a state agent that reads and writes scene, global, node, `m` and registry state, with
  redaction (including masking of `redact.paths` state in Studio's live tree and saved run traces) and a publish rate
  cap. `census` redacts absolute and home paths from errors and report text
  ([guide](./guide/instrument.md), [app state](./e2e/app-state.md)).
- **Studio simulator:** `brs-node` (stock, `~2.7.1`) now ships as a brighttest dependency, so `brighttest studio
  --simulator` works with no extra install. A `brs-node` in your own project still wins. A fresh install grows by about
  50 MB ([guide](./guide/studio.md)).
- **Studio:** state inspector with edit in place, snapshots, diff and export/import; action log with time travel;
  network panel; lease badge, queue and device pool (uses `deviceLease.pool` when configured); stable test ids and
  accessible labels on the main controls so browser agents can drive it ([guide](./guide/studio.md)).
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
  `noSystemDialog`; per-step timing; `--ecp-port`; faster selector reads on large trees; `brighttest e2e lint <flow...>`
  checks flow files without a device ([flow reference](./e2e/flows.md)).
- **Adoption:** `brighttest assess` writes a read-only readiness report (blockers, secret and risky-pattern scans,
  Markdown output) and redacts absolute and home paths; `init --brownfield` merges into an existing `brighttest.json`
  (valid siblings are kept) and `--dry-run` prints the planned changes and writes nothing; `init --greenfield` (store
  and HTTP templates); `skills install` adds an always-on safety block, installs agent definitions for Claude and
  Copilot, and can merge an optional guard hook and MCP entry; `skills --check` for CI
  ([assess](./guide/assess.md), [agent skills](./guide/agent-skills.md), [CLI reference](./guide/cli-reference.md)).
- **Agent surface (MCP):** `brighttest mcp` stdio server with a leased network window (`net_requests`, `net_mock`),
  app-state tools on the session hub window (`app_state_get`, `app_state_set`, `app_state_snapshot`) and read-only
  profiling tools (`perf_summary`, `perf_trace_summary`) ([guide](./guide/mcp.md)).
- **Devices and lease:** `brighttest device lock | renew | unlock | with | status | watch | hook | reset | log` to share a
  device safely, with a device pool (`--device any`), queue ETA and a warning when the dev channel runs with no lease
  holder; `device status` and `device watch` reject unknown flags and a bad `--tail`, and exit 78 on an unusable lease
  directory; `brighttest doctor` (device readiness, engine capability table, hub checks). `--device` and
  `--cross-check` take the host and password from `ROKU_HOST` / `ROKU_PASSWORD` or the device cache (when exactly one
  device is cached), so the flags are optional ([sharing a device](./guide/device-lease.md),
  [CLI reference](./guide/cli-reference.md)).
- **Spec helpers and config:** `BTState_load` and `BTState_seedGlobals` for snapshot fixtures ([state fixtures](./writing-tests/state-fixtures.md));
  `BTMedia` for headless Video and Audio state ([media state](./writing-tests/media-state.md)). `deviceInfo` sets the
  headless engine identity and accepts `friendlyName` (up to 256 characters) and `country` (two uppercase letters,
  reported as the country code).
- **Studio:** a new read route `GET /api/state/node?id=&layer=node|m[&path=][&depth=][&raw=1]` returns one node's fields or
  a component's `m` through the agent's `get` op (no app rebuild, no device request). Values are masked like the State tab,
  agent refusals (`NODE_NOT_FOUND`, `M_NOT_AVAILABLE`, `STATE_TOO_LARGE`, ...) pass through with their code, and a read
  that gets no answer in 4 s is `504 ACK_TIMEOUT`. The node inspector UI follows.

### Improvements
- **Studio:** when another session holds the device, a full-width warning banner names the holder and how long it has had the device, with one **Take the device back** button (**Take the device** if Studio never held it). The same button appears in the header and in the State, Action log and Node state notices, shows "Waiting, you are #N" with a spinner while queued, and never interrupts the holder.
- **E2E:** with `instrument.lineMap` on, the failure bundle's crash backtrace frames gain `sourceLine` (the package `line` stays) and the crash summary shows the source line; with no usable line map, `error.json` says so in `lineMapNote`.
- **Instrument build:** the package now includes everything under `rootDir` that the Roku packager would ship (images,
  fonts, root files, callee files outside `source/` and `components/`), minus dotfiles, tests and tool config. Before, the
  compile-only default left them out and the build still reported success with an unusable package. Set
  `instrument.files` to choose another set; it does not change the headless lanes' `sourceGlobs`. After each build a
  warning gives counts of files under `rootDir` that are not in the package (for example `images/: 443 not packaged`)
  and lists `pkg:/` paths in the code that point at missing files.
- **Instrument build:** bsc whole-program validation errors (`1104`, `1140`, `1067`, ...) no longer fail the build.
  Only plugin errors (`BT9xxx`) and parse errors fail; the rest are warnings, deduplicated, with a per-code count and a
  paste-ready `"diagnosticFilters": [...]` line, and a note that they are compiler checks, not Roku runtime errors.
  `--fail-on-bsc-errors` restores the old strict behaviour. `diagnosticFilters` is now documented (config reference,
  instrument guide and skill, `instrument build --help`).
- **Network:** `unmatched: passthrough` with an empty `upstreamHosts` now fails in `e2e lint`, before `e2e run` touches
  the device, in `--net-unmatched passthrough` runs and in the MCP network tools, with `passthrough needs
  config.net.upstreamHosts; with an empty list every request is refused (403)`. A failing step prints the requests the
  allow-list refused (`12 requests refused by the passthrough allow-list: host (n), ...`) and the failure bundle keeps the
  line as `net-refused.txt`. The flow reference now says `upstreamHosts` is required for any passthrough.
- **Network:** flows inherit `instrument.net` from `brighttest.json` (`fixtures`, `unmatched`, `upstreamHosts`, `redact`);
  the flow's `config.net` overrides per key. Studio's Run merges them the same way, so the allow-list is written once.
- **Studio:** prints `hub: on (port N, passthrough to K hosts)` or `hub: off (why)` at startup and warns on an empty
  passthrough allow-list. The Network panel shows requests refused by the allow-list as their own `refused` state, with the
  host to add and a button that copies the `upstreamHosts` entry. `--password` is marked discouraged in favour of
  `ROKU_PASSWORD`.
- **MCP network tools:** the session network proxy now reads `instrument.net.upstreamHosts` and `instrument.net.unmatched`
  like Studio does. A request to an allowed host used to show as a 403 refused in `net_requests` while Studio showed it
  as a passthrough.
- **Instrument:** the agent `get` op takes an optional `depth` (1 to 6, never deeper than the configured cap) for shallow node and `m` reads; deeper values come back as `$truncated:depth` markers and the answer carries the applied `depth`. Builds that ignore it still answer a full read.
- **Studio:** the flow editor now completes all 33 flow steps, including `setState`, with each step's keys and allowed
  values (such as `layer:`). The list comes from the same step catalog the flow parser uses, so it cannot drift.
- **E2E:** every flow step is now listed once in `lib/e2e/step-catalog.js`, which the parser uses as its allow-list
  (an unlisted step is still `unknown step`) and which `state` and `net` steps read their allowed map keys from. A test
  fails when a step is added to the parser or runner without a catalog entry, or is missing from the flows doc or the
  flow-reference skill. No change to flow syntax. ([flows](./e2e/flows.md#steps))
- **E2E:** `e2e run`, `inspect` and `record` now find the device the same way as `doctor`, the device lanes, Studio and MCP: `--host`, then `ROKU_HOST` in the shell, then `ROKU_HOST` in the project `.env`, then the one cached device (and its password from `ROKU_PASSWORD` or the cache). Before, only `--host` and the shell variable counted. With several cached devices and no host, `e2e run` refuses instead of guessing. `brighttest doctor` now prints where the host came from (`--host`, shell, `.env` or cache) and warns when it chose among several cached devices or when `ROKU_HOST` holds `ip:pw` or a list, which only `e2e` accepts.
- **E2E:** preflight fails fast on unreachable, Limited or dev-disabled devices, and only for the affected host in a
  multi-device run; falls back to the app UI query when SceneGraph reads keep failing. The `snapshot` step takes
  `nodes`, a list of node ids, so `restore` can write node fields back ([flows](./e2e/flows.md),
  [app state](./e2e/app-state.md)).
- **Device lane:** a run that stops early now says why (no device output for N s, or a runtime error in a named
  suite) instead of a generic deploy or device error ([CI integration](./guide/ci.md)).
- **Skills:** the shipped skills are refreshed against the current device, MCP, Studio, e2e and init behavior, and a test
  now checks their limits (idle timeout, hook ports, MCP caps, exit codes) against the code. `skills install` migrates
  older flattened installs to the current layout (see upgrade notes).
- **Warnings:** the headless lane warns when it meets a Task component. With a stock engine or stock Rooibos, brighttest
  prints one warning when `globalFields` seeding or a bare `@deviceOnly` will be ignored
  ([engines](./guide/engines.md)).
- **Engines:** the headless engine and the Rooibos fork are pinned to exact `-bt.1` builds (`@ramonlobo/brs-node`
  2.7.1-bt.1, `@ramonlobo/rooibos-roku` 5.17.0-bt.1, Rooibos 5.17). The engine's undocumented `rt-http-fixtures.json`
  hook is removed (use the network fault proxy, see [net faults](./guide/net-faults.md)), and floats now print the way
  a device prints them, so output that compared against the old float text may differ.

### Fixes
- **Studio:** node boxes now line up with the picture for apps whose manifest sets `ui_resolutions=hd`. They were drawn at
  two thirds scale because Studio used the TV output mode (1080p) instead of the 1280x720 space the app lays out in.
- **Studio:** started through `npx brighttest studio`, Studio now stops within a few seconds when the npm process that
  started it dies from a signal npm cannot forward (SIGKILL, a timeout wrapper), instead of keeping the port and the
  lease. Studio also shuts down cleanly on SIGHUP.
- **Instrument:** the app agent retries a failed hello to the hub after 2, 2, 5 and 5 s (then every 30 s) instead of 30 s,
  so the first `app_state_set` no longer waits about 22 s. Rebuild the instrumented app.
- **Instrument:** `instrument.state.redact.paths` is now applied on the device to dispatch-payload values of a wrapped
  dispatch, so those values no longer cross the LAN and `?raw=1` shows the placeholder. Rebuild the instrumented app.
- **Docs:** the device lease guide, the multi-agent guide and the device-safety skill now give the order of operations: `device lock` presses Home twice, so lock, install, then launch (or `device lock --no-hygiene`), and `e2e run` launches but never installs.
- **MCP:** the session hub window now works when the MCP server runs inside `brighttest device with`; it no longer fails with `LEASE_LOST` on every call.
- **Doctor:** `brighttest doctor` now checks the hub port and host from `instrument.hub` in `brighttest.json` (default port 8790), binds that exact port, and reports an invalid `instrument.hub` as a failing `hub-config` check. `--json` adds `hub.portSource` and `hub.hostSource`.
- **MCP:** `net_requests` and `net_mock` now fail with `NET_CONFIG`, naming the file, when `brighttest.json` exists but cannot be parsed, instead of silently refusing every request with a 403. The docs now say the config is read once per session and that the first `app_state_set` can wait for the app agent hello.
- **Sideload:** `instrument build --sideload` (and the installer calls behind `e2e` Delete, screenshots and inspect) no longer fails with `fetch failed` / EPIPE when the device closes the connection after its authentication challenge. Both requests send `Connection: close`, the challenge for a package is a bodyless request so the package is uploaded once, and a failed install request now goes through the documented Delete-and-retry-once path. The message names the failing step and the error code (for example `POST /plugin_install (authenticated) failed: EPIPE`), never the password.
- **Assess:** the summary and `census.json` no longer seem to disagree on the task count: assess prints `N tasks (M extend Task directly)` and adds `census.directTasks`; `census.md` labels both numbers. A truncated scan now names the skipped files (sensitive names and files over the size cap, with the reason, the cap and the size) in the text summary, `assess.md` and `scan.skipped` in JSON; sensitive files are listed by path only.
- **CLI:** `brighttest skills list | head` (any command whose reader closes the pipe early) no longer prints an `Error: write EPIPE` stack trace; it exits 0 quietly. Other stdout write errors still show.
- **CLI:** `brighttest mcp --help` now lists all 15 tools (it left out `app_state_get`, `app_state_set` and `app_state_snapshot`); the list is read from the tool registry.
- **Feature report:** the Notes column of the members table showed `[object Object]` for nodes with notes (for example a node that was not classified). Notes now render as readable text for a string, a list, or an object with `text` or `message`.
- **Studio:** the Run button now runs `waitForAgent`, `setState`, `snapshot`, `restore`, `callFunc` and the network steps (`mockHttp`, `waitForRequest`, `assertRequest`, `recordHttp`, `clearHttp`) through Studio's instrument hub, set up as `e2e run` does; they used to fail with `STATE_NO_HUB`. A flow that needs the hub when Studio has none (no `BRIGHTTEST_HUB_TOKEN`, pool mode, hub failed) now fails before its first step with the hub's own message. The flow's net rules are removed and the proxy's unmatched mode is restored after the run, and the per-step screenshot and tree capture go through the lease-guarded device.
- **Init:** `brighttest init` no longer writes `!source/main.brs` into `sourceGlobs` when the app has a plain `source/main.brs`. The exclusion removed the file from every lane: helpers defined in it failed to compile in tests, and `--coverage` left it out of the coverage total. The default scene lane still drops it at run time. Existing `brighttest.json` files keep their entry; delete it if you want the file back on the other lanes.
- **Engines:** `BRIGHTTEST_ENGINES=<package>` now resolves each engine kind's own package. A package name of the other kind picks the same flavor (patched or stock) of this kind, and the not-found hint names the package that was looked up.
- **Headless coverage with the state agent:** `--coverage` no longer fails now and then (about 1 run in 14) after a 150 to 230 second stall with `RUN CRASHED`. The injected runtime is no longer coverage-instrumented.
- **E2E and Studio:** focus navigation keeps pressing through a keyboard-style control whose cursor moves inside one focused
  node; the focused selector picks the deepest node; launch with params reaches an already running channel
  ([flow reference](./e2e/flows.md)). Studio serves the last tree instead of an error on transient read failures.

### Upgrade notes {#upgrade-0-8-0}
- Re-run `npx brighttest skills install` once; see [Migrating from older installs](./guide/agent-skills.md#migrating-from-older-flattened-installs).
- If CI starts failing on the device lane, look for runs that stopped before the final result line, and for tests that
  crashed; they used to count as passes. See [CI integration](./guide/ci.md).
- If a run now fails on a CRASH or FAIL entry in Rooibos's final test report (for example a crash in an `@SGNode`
  `beforeEach`) while the totals said Success, fix that spec.
- If a headless scene run now fails with RUN CRASHED, fix the runtime error printed just above the
  `EXIT_BRIGHTSCRIPT_CRASH` line.
- If a run now fails because an `@async` case in an `@SGNode` suite never finished, make that case call `m.done()` before
  its timeout. See [SceneGraph async tests](./writing-tests/scenegraph-async.md).
- Studio: pass `--host <ip>` (or set `ROKU_HOST`) when several devices are cached, and make sure the dev password is
  available (`--password`, `ROKU_PASSWORD`, a project `.env` or the device cache). `brighttest devices` finds Rokus on your network (SSDP) and saves the dev
  password; Studio can then connect without `--host` only when that is the only cached device.
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

First tagged release. It lists only what was added after the untagged npm releases 0.1.0 to 0.2.0, which are not
repeated here. Those releases shipped the headless, device and cross-check lanes, the live reporter, the coverage
table, `@deviceOnly`, global context, agent skills, `init` and several ANSI output fixes.

### Breaking changes
- **CLI:** requires Node 22 or later (the engine crashes on Node 18 and 20). [Upgrade notes](#upgrade-0-3-0)

### Features
- **E2E:** on-device lane (`brighttest e2e`) with scripted flows, `record` to scaffold a flow, focus path-finding and
  text entry, build-time id injection, multi-device runs with a deep-link matrix and per-host passwords, and `--video`
  session replay ([overview](./e2e/index.md), [flow reference](./e2e/flows.md)).

### Fixes
- **Reporter:** tests with long names are counted correctly.

### Upgrade notes {#upgrade-0-3-0}
- Upgrade to Node 22 or later.

[Full diff](https://github.com/Ramon-Lobo/brighttest/compare/a8fe9d2...v0.3.0)
