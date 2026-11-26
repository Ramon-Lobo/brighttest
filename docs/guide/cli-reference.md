# CLI reference

Every subcommand and flag of `brighttest`, as printed by `brighttest --help` and each `brighttest <command> --help`.
When this page and `--help` disagree, `--help` (and `bin/cli.js`) wins; please report the difference.

```text
brighttest [lane flags]          headless / --coverage / --device / --cross-check runs
brighttest init                  scaffold a project
brighttest skills <action>       install AI-agent skills
brighttest instrument <action>   build / verify / census an instrumented debug package
brighttest e2e <action>          on-device UI flows
brighttest studio                local web app mirroring a device
brighttest net convert           HAR to net rules
brighttest assess [<dir>]        read-only project assessment
brighttest features graph        dependency graph of an app's files and components
brighttest features check        validate a feature tree against its graph
brighttest doctor                device capability check
brighttest mcp                   MCP stdio server for AI agents
brighttest devices               discover Rokus, cache credentials
brighttest device <action>       the device lease
```

Durations (`--wait`, `--max`, `--expect`, `--idle`) are `90s`, `10m`, `1h` or plain milliseconds. Flags accept
`--flag value`. Most value flags also accept `--flag=value`. The exceptions are `--config`/`-c` and `--pass` (main lane), the lease flags of `instrument` (`--wait`, `--max`, `--expect`, `--as`, `--purpose`), `--pass` for `e2e` and `studio`, and `--textContains` for `e2e` (use `--text-contains=`): use the space form for these. Most of what is verified on hardware is stated on the page of the
feature; nothing on this page is a claim of device verification.

## Test lanes: `brighttest [flags]`

| Invocation | Lane |
|---|---|
| `brighttest` | Headless on the brs-node simulator (default, no device). Runs `@SGNode` suites too |
| `brighttest --no-sgnode` | Headless, SceneGraph-off driver, skips `@SGNode` suites (faster). Alias `--skip-sgnode` |
| `brighttest --coverage [--lcov [path]]` | Headless with coverage and LCOV (no device) |
| `brighttest --device --host <ip> --password <pw>` | On-device run with coverage |
| `brighttest --cross-check --host <ip> --password <pw>` | Headless plus device, diffed (fails on any divergence) |

| Flag | Meaning |
|---|---|
| `-d`, `--device` | Run on a Roku (deploys, runs Rooibos, reports coverage) |
| `--device any` (also `--device=any`, `-d any`) | First free device of `deviceLease.pool`, FIFO across the pool; `--host` wins. See [the pool](/guide/device-lease#a-pool-of-devices-device-any) |
| `--coverage` | Headless coverage run |
| `--cross-check` | Headless vs device diff |
| `--no-sgnode` | Skip `@SGNode` suites |
| `--host <ip>` (also `ip:pw`) | Device IP. Else `ROKU_HOST`, a project `.env`, then the device cache. Several cached devices and none chosen is an error, not a guess |
| `--password <pw>` (`--pass`) | Dev password. Else `ROKU_PASSWORD`, the device cache |
| `--lcov [path]` | Write LCOV (default `coverage/lcov.info`); headless `--coverage` and device lanes |
| `--junit <path>` | Write JUnit XML (headless lanes) |
| `--timeout <sec>` | Overall watchdog (headless 300 s, device 900 s by default) |
| `--idle-timeout <sec>` | Device idle watchdog: abort after this many seconds with no device output (default 120, `0` disables; config `deviceIdleTimeout`; the flag wins). See [troubleshooting](/guide/troubleshooting#device-run-aborted-no-device-output-for-ns-idle-watchdog) |
| `--net-record [file]` | Headless only: pass requests through to `instrument.net.upstreamHosts` and record a HAR (default `.brighttest/net/<run>.har`) |
| `--net-unmatched <fail\|passthrough>` | Headless only: what to do with a request no rule matches (`fail` is the default when fixtures exist). The two net flags with `--device` or `--cross-check` exit 2 |
| `--instrument` | Headless only: same as `instrument.enabled: true` for one run (state agent; net only when configured). Takes no value. With `--device` or `--cross-check` it exits 2; with `--no-sgnode` on the default lane it exits 2 |
| `--wait <dur>` | Device lease: queue time (default 30m, `0` = fail if busy, exit 75) |
| `--as <agent>`, `--purpose <text>` | Device lease: holder label and purpose (`BRIGHTTEST_AGENT`, `BRIGHTTEST_PURPOSE`) |
| `--no-lease` | Skip the lease (warns, audited; not for agents) |
| `-c`, `--config <path>` | `brighttest.json` (default `./brighttest.json`) |
| `-v`, `--version` / `-h`, `--help` | Print the version / help and exit 0 |

Exit codes: `0` all tests passed, `1` a failure (including a crashed test, a device run with no result line, a
timeout or idle abort), `2` usage or engine-resolution error (an unreadable `brighttest.json` currently exits 1; a `--config` path that does not exist is ignored and the defaults are used), and the lease codes `75`, `77`, `78`
([device lease](/guide/device-lease#exit-codes)). The engine build is chosen by `BRIGHTTEST_ENGINES`
(`auto|patched|stock|<package>`) or `engines` in `brighttest.json`; the environment wins. A package name of the other engine kind picks the same flavor of this kind.

Device-lane header: the device lane prints `building, deploying to <host>, and running…` and never prints the serial number.

## `brighttest init`

```text
brighttest init [--force]
brighttest init --brownfield [--force] [--dry-run]
brighttest init --greenfield [--force]
```

Creates `brighttest.json`, `source/tests/Example.spec.bs`, git-ignore entries and an npm `test` script. Existing files
are kept unless `--force`.

- `--brownfield`: for an app you will not edit. Runs the [instrument census](/guide/instrument), writes the `instrument`
  block of `brighttest.json` (with `state.registrySections` proposed from the census), adds `.brighttest/` and
  `*.bt-instrumented.zip` to `.gitignore`, and adds no example spec or npm script. An existing `brighttest.json` is merged
  (below). `--force` replaces the instrument block. `--dry-run` prints the planned changes and writes nothing.
- `--greenfield`: for an app built with brighttest in mind. Also copies `BTStore.brs` and `BTHttp.brs` into
  `source/brighttest/` and adds `BT_AGENT=false` to `bs_const`. With `--greenfield`, `--force` refreshes only the two
  templates. Cannot be combined with `--brownfield`.

### Merging into an existing brighttest.json

`init --brownfield` is safe to run on a project that already has `brighttest.json`. It reads the file, checks the keys init
sets (`rootDir`, `sourceGlobs`, `testsFilePattern`, `stagingDir`, `instrument.strict`, `instrument.exclude`,
`instrument.state` with `registrySections`) and changes only what is needed:

| File state | Result |
|---|---|
| Valid and complete | Not rewritten (bytes and mtime unchanged). Prints `brighttest.json: unchanged (valid)` |
| Key missing | Added with the detected default |
| Value of the wrong type | Replaced with the default (a list keeps its string entries) |
| Valid value that differs from what detection would propose | Kept |
| Unknown keys | Kept, in order |
| Not valid JSON | Exit 1, nothing written |

Each change prints as `added|changed <key>: <old> -> <new>`. When it writes, the previous file is kept as `brighttest.json.bak`
and the file's indentation is preserved.

## `brighttest skills`

```text
skills install   [--agent <a>] [--skill <name>] [--force]
skills update    [--ref <branch|tag>] [--agent <a>] ...
skills export    [--out <dir>] [--force]
skills list
skills uninstall [--agent <a>] [--skill <name>] [--force]
skills --check
```

| Flag | Meaning |
|---|---|
| `--agent <a>` | `claude`, `cursor`, `agents`, `copilot`, `windsurf`, `cline`, `zed`, `agentskills`, `opencode`, `hermes` or `all`. Omit to auto-detect |
| `--skill <name>` | One skill only |
| `--ref <ref>` | (`update`) branch or tag to fetch (default `main`) |
| `--skills-dir <d>` | (`agentskills` target) skill root (default `.agents/skills`) |
| `-o`, `--out <dir>` | (`export`) destination (default `./brighttest-skills`) |
| `--no-safety` | (`install`, `update`) skip the always-on safety block |
| `--no-agents` | (`install`, `update`, `uninstall`) skip subagent definitions (`.claude/agents/<name>.md`, claude target) |
| `--with-hook` | (`install`, claude) merge the device-lease guard hook into `.claude/settings.json` |
| `--with-mcp` | (`install`, claude) merge the brighttest MCP server into `.mcp.json` |
| `--check` | Exit 1 if `skills/manifest.json` drifted from the `skills/` tree (no writes; for CI) |
| `-f`, `--force` | Overwrite files not created by brighttest |

See [Agent skills](/guide/agent-skills).

## `brighttest instrument`

```text
instrument build [--out <zip>] [--strict | --no-strict] [--net] [--verbose] [--sideload --host <ip>] [--config <path>]
instrument verify <zip|dir>
instrument census [--json] [--out <dir>] [--config <path>]
```

| Flag | Meaning |
|---|---|
| `-o`, `--out <zip>` | Package path (default `<stagingDir>/instrument/app.bt-instrumented.zip`); written only after every check passed |
| `--net` | Bake the hub token from `BRIGHTTEST_HUB_TOKEN` (32 hex); exit 1 when unset or malformed |
| `--strict` / `--no-strict` | Fail (exit 4) when something could not be instrumented / override the config |
| `--verbose` | List every informational entry |
| `--sideload` | After a successful build, install under the device lease (needs `--host`; password from `ROKU_PASSWORD`). Retries once after Delete |
| `--host <ip>` | Device for `--sideload` (never guessed from the cache) |
| `--wait`, `--max`, `--expect <dur>`, `--as <name>`, `--purpose <text>` | Device lease options |
| `-c`, `--config <p>` | `brighttest.json` |
| `--json`, `--out <dir>` | (`census`) JSON output; also write the census report files |

Exit codes: `0` ok, `1` build failure (also auth, TCP-80 and installer failures with `--sideload`), `2` usage,
`3` (`verify`) instrumentation markers found, `4` strict-mode failure, `75/77/78` lease codes. See
[Instrumented builds](/guide/instrument).

## `brighttest e2e`

```text
e2e run <flow…>        run *.e2e.yaml files (or directories of them)
e2e inspect [selector] dump the live tree, or detail one node
e2e record [-o file]   interactively drive the device and scaffold a flow
e2e lint <flow…>       warn about selectors that cannot match
e2e stamp <src> -o <d> copy a project, injecting ids onto un-annotated nodes
```

| Flag | Applies to | Meaning |
|---|---|---|
| `--host <ip[:pw][,…]>` | all device actions | Device(s) or `ROKU_HOST`. Several hosts shard the flows across devices in parallel; `ip:pw` gives a per-device password |
| `--ecp-port <n>` | all | ECP port (or `ROKU_ECP_PORT`, default 8060), for stubs and fakes |
| `--password <pw>` (`--pass`) | all | Dev password (or `ROKU_PASSWORD`); screenshots need it |
| `--app <id>` | run, inspect, record | Channel to launch (default `dev`; also the flow's `appId`) |
| `--content-id <a,b,…>` | run | Deep-link matrix: each flow once per content id |
| `--media-type <t>` | run | Media type paired with `--content-id` |
| `--timeout <sec>` | run | Per-assertion wait (default 10) |
| `--screenshots <dir>` | run | Output directory (default `<stagingDir>/e2e/screenshots`) |
| `--screenshots-mode <all\|failure\|off>` | run | Per step (default), only on failure, or none |
| `--video [mp4\|gif]` | run | Assemble the screenshots into a video (needs ffmpeg) |
| `--reset-device` | run | Per host: Delete, Home, check the app launches; drop a host that fails twice |
| `--no-hygiene` | run | Skip the Home x2 press after taking the lease |
| `--fail-on-skip` | run | Exit 1 if a flow or step was skipped by `requires:` |
| `--junit <file>` | run | JUnit XML, one suite per flow file; exit codes unchanged |
| `-o`, `--out <file>` | record, inspect, stamp | Where the scaffold, appended assertion, or stamped copy goes |
| `--id`, `--subtype`, `--text`, `--text-contains` (`--textContains`), `--uri`, `--index <n>`, `--focused` | inspect | Narrow to one node (AND); prints every field and suggested assertions |
| `--assert <visible\|text\|focused\|gone\|field>` | inspect | With `--out`, which assertion to append (default `visible`) |
| `--field <name>` | inspect | With `--assert field`, the field to capture |
| `--wait <dur>`, `--as <agent>`, `--purpose <text>` | device actions | Device lease options (the wait is per device) |
| `--no-lease` | device actions | Skip the lease (warns, audited; not for agents) |

Unknown flags to `e2e` are ignored without a message, so check spelling. Exit codes for `run`: `0` all passed, `1` a flow
failed (also `--fail-on-skip` with a skip, or no flow ran), `2` usage or device-setup error, `75`, `77`, `78` the [device lease exit codes](/guide/device-lease#exit-codes).
`lint` exits 0 with warnings. See the [flow reference](/e2e/flows), [authoring](/e2e/authoring) and
[scaling and CI](/e2e/scaling).

## `brighttest studio`

```text
studio --host <ip> [--password <pw>] [--port 8700] [--app dev] [--flows-dir flows] [--open]
studio --simulator [--port 8700] [--flows-dir flows] [--open]
```

`--host` (or `ROKU_HOST`), `--password` (`--pass`, or `ROKU_PASSWORD`), `--port <n>` (default 8700; if busy and `--port` was not given, the first free of
8701-8709; an explicit busy `--port` fails), `--app <id>` (default `dev`), `--flows-dir <dir>` (default `./flows`),
`-o`, `--open` (open the browser). Studio takes the [device lease](/guide/device-lease#studio) while you use it. See the [Studio guide](/guide/studio).

`--simulator` runs Studio against the local brs-node simulator instead of a device (state-only; see [Simulator target](/guide/studio#simulator-target-no-device)). It uses the stock engine (`brs-node`, shipped as a brighttest dependency) unless `engines.brsNode` or `BRIGHTTEST_ENGINES` says otherwise, takes no value, and exits 2 when combined with `--host` or a device pool. `--password` is ignored with it. Exit codes: 2 usage error or UI not built, 1 other failures.

## `brighttest net convert`

```text
net convert <file.har> [-o <rules.json>]
```

Turns a recorded HAR into a rules file (rule ids `har-1..n`); prints to stdout without `-o`. Redacted values stay
redacted. Exit 1 for an unreadable or non-HAR input. See [network faults](/guide/net-faults).

## `brighttest assess`

```text
assess [<dir>] [--json] [--out <dir>] [-c|--config <config>]
```

Read-only, offline assessment of a project (default: the current directory). `--json` prints the
`brighttest-assess/v1` document; `--out <dir>` also writes `assess.json`, `assess.md`, `census.json`, `census.md`
(refused inside `source/` or `components/`). Exit codes: `0` report produced (findings never change it), `1` internal
error, `2` usage error, missing `<dir>`, bad config or refused `--out`. See [Assess a project](/guide/assess).

## `brighttest features`

The `mapping-a-roku-app` agent skill drives these three commands; see [Map the app](/guide/feature-tree#mapping-with-an-agent).

```text
features graph [<dir>] [--out <dir>] [--json] [-c|--config <config>]
```

Read-only, offline map of an app (default: the current directory). Writes `graph.json`
(`brighttest-feature-graph/v1`) to `<stagingDir>/features/` (default `.brighttest/features/`)
or to `--out`, and prints a short summary; `--json` prints the graph instead.
Exit codes: `0` graph produced, `1` internal error, `2` usage error (missing `<dir>`,
bad config or refused `--out` inside `source/` or `components/`). See
[Map the app](/guide/feature-tree).

```text
features check [<tree.json>] [--graph <graph.json>] [--json] [--partial]
```

Read-only. Validates a `brighttest-feature-tree/v1` document against its graph with rules V1 to V9: shape and
caps, binding to this exact graph, every file in exactly one feature or in `ignored`, a component with its XML file,
feature ids, testability overrides, proposed tests, plain text, and the recommended path. `<tree.json>` defaults to
`<stagingDir>/features/tree.json` and `--graph` to the `graph.json` beside it. `--json` prints
`{ ok, errors, warnings, findings[{severity, rule, code, pointer, message}] }`; `--partial` allows files not yet
assigned. Exit codes: `0` valid (warnings allowed), `1` internal error, `2` usage error or unreadable input, `3` tree
invalid or stale.

```text
features render [<tree.json>] [--graph <graph.json>] [--out <file.html>] [--auto] [--junit <file>]... [--lcov <file>]...
```

Validates the tree like `check`, then writes one self-contained `report.html` (default: beside the tree). `--auto`
renders the generated skeleton tree, so no agent is needed; do not combine it with `<tree.json>`. Run it from the
project root: the CI checklist and the "code changed since the graph" banner read the project in the current
directory. Exit codes: `0` written, `1` internal error, `2` usage error, unreadable input or `--out` refused (inside
`source/` or `components/`), `3` tree invalid or stale (nothing is written). See [Map the app](/guide/feature-tree).

`--junit` and `--lcov` (repeatable) overlay run evidence. The JUnit must come from brighttest (cases map to specs by
`@suite` title) or carry `file` attributes. A spec whose cases pass marks its nodes `ran-headless`; `ran-device` only
comes from a JUnit marked `brighttest.lane=device` (per suite) or the e2e suite name, and `--device --junit` writes
that marker (e2e flows are not graph spec nodes). LCOV shows `executed (lcov N% of M lines)` and gives no level,
because it carries no lane. See [Map the app](/guide/feature-tree#run-evidence-from-junit-and-lcov).

## `brighttest doctor`

```text
doctor [--host <ip>] [--ecp-port <n>] [--json] [--show-serial]
doctor --engines [--json]
```

Reads the device-info only (no password, no lease, no keypresses) and prints the exact fix for anything wrong; the
serial is hidden unless `--show-serial`. `--engines` runs the engine-capability probe with the resolved brs-node and
contacts no device. Exit `0` all checks passed, `1` a check failed or the device is unreachable (with `--engines`:
the probe failed or disagrees with the package metadata), `2` usage. See [troubleshooting](/guide/troubleshooting#brighttest-doctor-is-the-device-ready).

## `brighttest mcp`

```text
mcp
```

Takes no arguments. Serves newline-delimited JSON-RPC 2.0 on stdin/stdout (logs on stderr), contract
`brighttest-mcp/v1`. The device comes only from `ROKU_HOST`, `ROKU_PASSWORD`, the project `.env` and the device cache.
Exit `0` on a clean end of input, `1` internal error, `2` usage. See [the MCP guide](/guide/mcp) for the tool list.

## `brighttest devices`

Discovers Rokus on the LAN (4 s) and lists them with model and address. In a terminal it then offers to save one: it asks
for the dev password (unless cached), checks the device answers, and caches it so later commands need no `--host`.
Exit 1 when the chosen device cannot be reached. It takes no lease (discovery is a single read).

## `brighttest device`

The [device lease](/guide/device-lease) commands.

```text
device status [--host <h>] [--json]
device with [options] -- <cmd…>
device with --device any -- <cmd…>
device lock [--host <h>] [options] [--json]
device renew [--lease <token>]
device unlock [--lease <token>]
device unlock --force --host <h> --reason "…" [--kill]
device reset [--host <ip[:pw]>] [options]
device hook
device log [--host <h>] [--tail <n>] [--json]
```

| Flag | Meaning |
|---|---|
| `--password <pw>` (`--pass`) | (`with`, `lock`, `reset`) dev password, else `ROKU_PASSWORD` or the cache |
| `--host <ip[:pw]>` | Device (else `ROKU_HOST`, the cached device). The child of `with` gets `ROKU_HOST`, `ROKU_PASSWORD`, `BRIGHTTEST_LEASE` |
| `--as <agent>`, `--purpose <text>` | Holder label and purpose (`BRIGHTTEST_AGENT`, `BRIGHTTEST_PURPOSE`) |
| `--wait <dur>` | Queue time (`BRIGHTTEST_LEASE_WAIT`, default 30m; `0` = fail if busy) |
| `--max <dur>` | Hard cap on the hold (default 60m; for `lock`, the session cap, default 45m); `with` stops the command at the cap (exit 77) |
| `--expect <dur>` | Expected hold, shown to waiters as an ETA |
| `--lease <token>` | (`with`, `renew`, `unlock`) use that session lease (same as `BRIGHTTEST_LEASE`) |
| `--idle <dur>` | (`lock`) session idle TTL (default 10m), renewed by every use |
| `--no-hygiene` | Skip the Home x2 press after acquiring |
| `--keepalive[=sec]` | (`with`) send an ECP `Fwd` every `<sec>` (default 240, min 60, `0` off) while the command runs |
| `--device any` | (`with`) first free device of `deviceLease.pool`; `lock` and the others reject it (exit 2) |
| `--ecp-port <n>` | ECP port (`ROKU_ECP_PORT`); part of the address lease key when not 8060 (the identity key ignores it) |
| `--force`, `--reason <text>`, `--kill` | (`unlock`) human override; `--reason` is required for a live holder, `--kill` also stops its processes. Audited |
| `--tail <n>`, `--json` | (`log`) last `n` audit lines, as JSON; `--json` also applies to `status` and `lock` |

Exit codes: the wrapped command's own code, `75` busy or wait timed out, `77` lease lost, expired or not held, `78` lease
directory unusable (`BRIGHTTEST_LEASE_DIR`, default `~/.brighttest/leases`), `2` usage. `device hook` always exits 0.
`device reset` exits 0 when Home is reached and 1 otherwise.

While a command waits, stderr shows `[brighttest lease] <host> is held by <agent> ... You are #N in queue.` once and then
every 30 s (details in the lease guide). `device reset` is described in [Resetting a stuck device](/guide/device-lease#resetting-a-stuck-device-device-reset).

## Environment variables

| Variable | Used by | Meaning |
|---|---|---|
| `ROKU_HOST`, `ROKU_PASSWORD` | all device commands | Device address and dev password |
| `ROKU_ECP_PORT` | e2e, device, doctor | ECP port (default 8060) |
| `ROKU_LOG_PORT` | e2e log capture | Console port for `assertLog` (default 8085) |
| `BRIGHTTEST_AGENT`, `BRIGHTTEST_PURPOSE` | lease | Holder label and purpose |
| `BRIGHTTEST_LEASE_WAIT` | lease | Default queue time |
| `BRIGHTTEST_LEASE_DIR` | lease | Lease directory (default `~/.brighttest/leases`) |
| `BRIGHTTEST_LEASE` | lease | A held lease token (session or inherited from `device with`) |
| `BRIGHTTEST_HOOK_TIMEOUT_MS` | `device hook` | Hook time budget in ms (default 4000) |
| `BRIGHTTEST_NO_LEASE=1` | lease | Same as `--no-lease`; never for agents |
| `BRIGHTTEST_LEASE_NO_FOREGROUND_CHECK=1` | lease | Turn off the foreground advisory |
| `BRIGHTTEST_ENGINES` | all lanes | `auto`, `patched`, `stock` or a package name (a package of the other engine kind picks the same flavor of this kind); wins over config |
| `BRIGHTTEST_HUB_TOKEN` | instrument, e2e, mcp, studio | 32 hex hub token shared by the build and the hub |
| `BRIGHTTEST_DOCTOR_HUB_PROBE=1` | doctor | Opt in to the device-to-hub reach probe (needs `ROKU_PASSWORD`; replaces the dev channel) |
| `BRIGHTTEST_CACHE` | devices | Device cache path (default `~/.brighttest/devices.json`) |
| `BRIGHTTEST_STATE_DIR` | studio | Where Studio keeps its Perfetto record (default `~/.brighttest`) |
| `BRIGHTTEST_DEBUG` | studio | Extra Studio server diagnostics on stderr |
