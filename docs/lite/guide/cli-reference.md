# CLI reference

::: info At a glance
**What it is for:** every `brighttest` subcommand and flag, as `--help` prints them.

**You will:**
- find a command's synopsis and flags
- look up its exit codes
- check which environment variable it reads

**First command:** `npx brighttest --help`
:::

If this page and `--help` (or `bin/cli.js`) disagree, `--help` wins; please report the difference. Nothing here claims device verification: that is stated on each feature's page.

## Flag syntax

How values are passed.

- Durations (`--wait`, `--max`, `--expect`, `--idle`): `90s`, `10m`, `1h` or plain milliseconds.
- `--flag value` always works; most value flags also take `--flag=value`.
- Space form only: `--config`/`-c` and `--pass` (main lane); the `instrument` lease flags (`--wait`, `--max`, `--expect`, `--as`, `--purpose`); `--pass` for `e2e` and `studio`; `--textContains` for `e2e` (use `--text-contains=`).

## Test lanes: `brighttest [flags]`

Headless (default), coverage, device or cross-check runs.

```text
brighttest                                         headless on brs-node, runs @SGNode suites too
brighttest --no-sgnode                             headless, SceneGraph-off driver, skips @SGNode (faster); alias --skip-sgnode
brighttest --coverage [--lcov [path]]              headless with coverage and LCOV
brighttest --device --host <ip> --password <pw>    on a Roku, with coverage
brighttest --cross-check --host <ip> --password <pw>   headless plus device, diffed (fails on any divergence)
```

| Flag | Meaning |
|---|---|
| `-d`, `--device` | Run on a Roku (deploy, run Rooibos, report coverage) |
| `--device any` (`--device=any`, `-d any`) | First free device of `deviceLease.pool`, FIFO; `--host` wins ([pool](/guide/device-lease#a-pool-of-devices-device-any)) |
| `--coverage` / `--cross-check` / `--no-sgnode` | Headless coverage / headless vs device diff / skip `@SGNode` |
| `--host <ip>` (or `ip:pw`) | Else `ROKU_HOST`, project `.env`, device cache. Several cached and none chosen is an error, not a guess |
| `--password <pw>` (`--pass`) | Else `ROKU_PASSWORD`, the cache |
| `--lcov [path]` | LCOV (default `coverage/lcov.info`); `--coverage` and device lanes |
| `--junit <path>` | JUnit XML (headless lanes) |
| `--timeout <sec>` | Overall watchdog (headless 300 s, device 900 s) |
| `--idle-timeout <sec>` | Abort after this long with no device output (default 120, `0` off; config `deviceIdleTimeout`, flag wins). See [troubleshooting](/guide/troubleshooting#device-run-aborted-no-device-output-for-ns-idle-watchdog) |
| `--net-record [file]` | Headless: pass requests to `instrument.net.upstreamHosts`, record a HAR (default `.brighttest/net/<run>.har`) |
| `--net-unmatched <fail\|passthrough>` | Headless: unmatched requests (`fail` is default when fixtures exist) |
| `--instrument` | Headless: `instrument.enabled: true` for one run (state agent; net only when configured). No value |
| `--wait <dur>` | Lease queue time (default 30m; `0` = fail if busy, exit 75) |
| `--as <agent>`, `--purpose <text>` | Lease holder and purpose (`BRIGHTTEST_AGENT`, `BRIGHTTEST_PURPOSE`) |
| `--no-lease` | Skip the lease (warns, audited; not for agents) |
| `-c`, `--config <path>` | Default `./brighttest.json` |
| `-v`, `--version` / `-h`, `--help` | Print and exit 0 |

::: warning Exit 2 combinations
The two net flags or `--instrument` with `--device` or `--cross-check` exit 2. `--instrument` with `--no-sgnode` on the default lane also exits 2.
:::

**Exit codes:** `0` all passed · `1` a failure (crashed test, device run with no result line, timeout, idle abort; also an unreadable `brighttest.json`) · `2` usage or engine-resolution error (a `--config` path that does not exist is ignored, defaults used) · `75`, `77`, `78` [lease codes](/guide/device-lease#exit-codes).

- **Engines:** `BRIGHTTEST_ENGINES` (`auto|patched|stock|<package>`) or `engines` in `brighttest.json`; the environment wins. A package of the other engine kind picks the same flavor of this kind.
- **Device header:** prints `building, deploying to <host>, and running…`, never the serial number.

## `brighttest init`

Scaffold `brighttest.json`, `source/tests/Example.spec.bs`, git-ignore entries and an npm `test` script. Existing files are kept unless `--force`.

```text
brighttest init [--force]
brighttest init --brownfield [--force] [--dry-run]
brighttest init --greenfield [--force]
```

| Flag | Meaning |
|---|---|
| `--brownfield` | App you will not edit: runs the [instrument census](/guide/instrument), writes the `instrument` block (`state.registrySections` from the census), adds `.brighttest/`, `*.bt-instrumented.zip`, `brighttest.json.bak` to `.gitignore`. No example spec or npm script. Merges an existing file (below); `--force` replaces the instrument block |
| `--dry-run` | Brownfield only (else exit 2): print the plan, write nothing |
| `--greenfield` | App built for brighttest: also copies `BTStore.brs`, `BTHttp.brs` into `source/brighttest/`, adds `BT_AGENT=false` to `bs_const`. `--force` refreshes only those templates. Not with `--brownfield` |

### Merging into an existing brighttest.json

`init --brownfield` checks the keys it sets (`rootDir`, `sourceGlobs`, `testsFilePattern`, `stagingDir`, `instrument.strict`, `instrument.exclude`, `instrument.state` with `registrySections`) and changes only what is needed.

| File state | Result |
|---|---|
| Valid and complete | Untouched (bytes, mtime); prints `brighttest.json: unchanged (valid)` |
| Key missing | Added with the detected default |
| Wrong type | Default (lists keep valid entries; `sourceGlobs` keeps `{src, dest}` objects; `strict: "true"` becomes `true`) |
| Right type, invalid content (e.g. duplicate `instrument.state.callable` name) | Kept, reported `needs attention: <key>: <message>`; still invalid until you fix it |
| Valid but differs from detection | Kept |
| Unknown keys | Kept, in order |
| Not valid JSON | Exit 1, nothing written |

A write prints `brighttest.json: updated (N changes)` and one `added|changed <key>: <old> -> <new>` line each, keeps `brighttest.json.bak`, and preserves indentation and LF/CRLF.

## `brighttest skills`

Install AI-agent skills ([Agent skills](/guide/agent-skills)).

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
| `--agent <a>` | `claude`, `cursor`, `agents`, `copilot`, `windsurf`, `cline`, `zed`, `agentskills`, `opencode`, `hermes`, `all`; omit to auto-detect |
| `--skill <name>` | One skill only |
| `--ref <ref>` | (`update`) branch or tag (default `main`) |
| `--skills-dir <d>` | (`agentskills`) root (default `.agents/skills`) |
| `-o`, `--out <dir>` | (`export`) default `./brighttest-skills` |
| `--no-safety` | (`install`, `update`) skip the safety block |
| `--no-agents` | (`install`, `update`, `uninstall`) skip subagents (`.claude/agents/<name>.md`) |
| `--with-hook` / `--with-mcp` | (`install`, claude) merge the lease guard hook into `.claude/settings.json` / the MCP server into `.mcp.json` |
| `--check` | Exit 1 if `skills/manifest.json` drifted from `skills/` (no writes; CI) |
| `-f`, `--force` | Overwrite files brighttest did not create |

## `brighttest instrument`

Build, verify or census a debug package ([Instrumented builds](/guide/instrument)).

```text
instrument build [--out <zip>] [--strict | --no-strict] [--from <dir|zip>] [--fail-on-bsc-errors] [--net] [--verbose] [--sideload [--reuse] --host <ip>] [--config <path>]
instrument verify <zip|dir>
instrument census [--json] [--out <dir>] [--config <path>]
```

| Flag | Meaning |
|---|---|
| `-o`, `--out <zip>` | Default `<stagingDir>/instrument/app.bt-instrumented.zip`; written only after every check passed |
| `--from <dir\|zip>` | Instrument a built package ([own build step](/guide/instrument#apps-with-their-own-build-step-from)). Dir needs `manifest` plus `source/` or `components/`; zip unpacks to temp with path and size checks; input never written |
| `--net` | Bake `BRIGHTTEST_HUB_TOKEN` (32 hex); exit 1 if unset or malformed |
| `--strict` / `--no-strict` | Exit 4 if something could not be instrumented / override config |
| `--fail-on-bsc-errors` | Fail on every bsc error. Default: only `BT9xxx` and parse errors fail; others warn with a per-code histogram and a `diagnosticFilters` line ([bsc diagnostics](/guide/instrument#bsc-diagnostics-and-diagnosticfilters)) |
| `--verbose` | Every informational entry and bsc warning |
| `--sideload` | Install after the build, under the lease (needs `--host`; password `ROKU_PASSWORD`). Retries once after Delete |
| `--reuse` | With `--sideload`: install the newest stored build instead of rebuilding (tip below) |
| `--host <ip>` | `--sideload` device, never guessed from the cache |
| `--wait`, `--max`, `--expect <dur>`, `--as <name>`, `--purpose <text>` | Lease options |
| `-c`, `--config <p>` | `brighttest.json` |
| `--json`, `--out <dir>` | (`census`) JSON; write report files |

::: tip In --help, not yet in the full reference page
`--reuse` skips the rebuild when the source fingerprint, flags and hub token are unchanged; it rebuilds only after your own code changes. Not with `--from`.
:::

**Exit codes:** `0` ok · `1` build failure (with `--sideload` also auth, TCP-80, installer) · `2` usage · `3` (`verify`) markers found · `4` strict failure · `75/77/78` lease.

## `brighttest e2e`

On-device UI flows ([flows](/e2e/flows), [authoring](/e2e/authoring), [scaling and CI](/e2e/scaling)).

```text
e2e run <flow…>        run *.e2e.yaml files (or directories of them)
e2e inspect [selector] dump the live tree, or detail one node
e2e record [-o file]   interactively drive the device and scaffold a flow
e2e lint <flow…>       warn about selectors that cannot match
e2e stamp <src> -o <d> copy a project, injecting ids onto un-annotated nodes
```

| Flag | For | Meaning |
|---|---|---|
| `--host <ip[:pw][,…]>` | device actions | Else `ROKU_HOST` (shell, then `.env`), then the one cached device (several, none chosen: error). Several hosts shard flows in parallel; `ip:pw` per device |
| `--ecp-port <n>` | all | `ROKU_ECP_PORT`, default 8060; for stubs and fakes |
| `--password <pw>` (`--pass`) | all | Or `ROKU_PASSWORD`; screenshots need it |
| `--app <id>` | run, inspect, record | Default `dev`; also the flow's `appId` |
| `--content-id <a,b,…>`, `--media-type <t>` | run | Deep-link matrix: each flow once per id, with its media type |
| `--timeout <sec>` | run | Per-assertion wait (default 10) |
| `--screenshots <dir>` | run | Default `<stagingDir>/e2e/screenshots` |
| `--screenshots-mode <all\|failure\|off>` | run | Default per step |
| `--video [mp4\|gif]` | run | Video from screenshots (needs ffmpeg) |
| `--reset-device` | run | Per host: Delete, Home, check launch; drop a host failing twice |
| `--no-hygiene` | run | Skip Home x2 after the lease |
| `--fail-on-skip` | run | Exit 1 on a `requires:` skip |
| `--junit <file>` | run | One suite per flow file; exit codes unchanged |
| `-o`, `--out <file>` | record, inspect, stamp | Scaffold, appended assertion or stamped copy |
| `--id`, `--subtype`, `--text`, `--text-contains` (`--textContains`), `--uri`, `--index <n>`, `--focused` | inspect | Narrow to one node (AND); prints fields and suggested assertions |
| `--assert <visible\|text\|focused\|gone\|field>` | inspect | With `--out`, assertion to append (default `visible`) |
| `--field <name>` | inspect | With `--assert field` |
| `--wait <dur>`, `--as <agent>`, `--purpose <text>` | device actions | Lease options (wait is per device) |
| `--no-lease` | device actions | Skip the lease (warns, audited; not for agents) |

::: warning Unknown flags are silent
`e2e` ignores unknown flags without a message. Check spelling.
:::

**Exit codes (`run`):** `0` passed · `1` a flow failed (also `--fail-on-skip` with a skip, or no flow ran) · `2` usage or device setup · `75`, `77`, `78` [lease](/guide/device-lease#exit-codes). `lint` exits 0 with warnings.

## `brighttest studio`

Local web app mirroring a device ([Studio guide](/guide/studio)). Takes the [device lease](/guide/device-lease#studio) while in use.

```text
studio --host <ip> [--port 8700] [--app dev] [--as <agent>] [--flows-dir flows] [--open]
studio --simulator [--port 8700] [--flows-dir flows] [--open]
```

| Flag | Meaning |
|---|---|
| `--host` / `--password` (`--pass`) | Or `ROKU_HOST` / `ROKU_PASSWORD` |
| `--port <n>` | Default 8700; if busy and not given, first free of 8701-8709; an explicit busy `--port` fails |
| `--app <id>` / `--flows-dir <dir>` | Default `dev` / `./flows` |
| `--as <agent>` | Lease holder label (tip below) |
| `-o`, `--open` | Open the browser |
| `--simulator` | Local brs-node simulator, state-only ([Simulator target](/guide/studio#simulator-target-no-device)). Auto engine (the patched engine when installed, else the stock `brs-node`, a brighttest dependency) unless `engines.brsNode` or `BRIGHTTEST_ENGINES`. No value; exit 2 with `--host` or a pool; ignores `--password` |

Exit codes: 2 usage or UI not built, 1 other failures.

::: tip In --help, not yet in the full reference page
`--as <agent>` labels this Studio's lease (or `BRIGHTTEST_AGENT`), e.g. `dev#2`, `qa:run-123`. `--help` also discourages `--password` (visible in the process list); use `ROKU_PASSWORD`.
:::

## `brighttest builds`

The build history store ([Builds](/guide/builds): store, retention, Studio Builds page).

```text
builds list [--json] [--all] [--kind store|instrumented] [--tag <t>] [--pinned]
builds show <id|prefix> [--json]
builds add <zip> [--label <text>] [--note <text>] [--tag <t>]... [--json]
builds install <id|prefix|zip> | --latest [--host <ip>] [--wait <dur>] [--as <agent>] [--purpose <text>] [--allow-token-mismatch] [--json]
builds pin|unpin <id>     builds edit <id> [--label ..] [--note ..] [--tag ..] [--untag ..]
builds rm <id> [--force]  builds prune [--dry-run] [--json]
```

- Store: project `.brighttest/builds`, or `BRIGHTTEST_BUILDS_DIR` / `--builds-dir`. Id: `b` plus 12 hex; any unique 4+ character prefix.
- `install --latest` re-installs the newest `instrument build` output; a zip is added to the store first.
- Host only from `--host` or `ROKU_HOST` (shell or `.env`), never the cache. Install takes the [device lease](/guide/device-lease).

**Exit codes:** 0 ok · 1 failed (install, pinned `rm`) · 2 usage, no host, unknown or ambiguous id · 5 package rejected (invalid, unsafe, no manifest, blob missing or corrupt) · 75 lease busy · 77 store unusable or lease lost · 78 configuration error.

::: tip In --help, not yet in the full reference page
`--allow-token-mismatch`: an instrumented build whose hub token differs from `BRIGHTTEST_HUB_TOKEN` (shell or `.env`), or with that unset, stops with `TOKEN_MISMATCH` (exit 2) unless you pass it. Only the enum prints, never a token. `--help` also lists `--config <path>` and says `--builds-dir` must be absolute.
:::

## `brighttest net convert`

HAR to rules ([network faults](/guide/net-faults)).

```text
net convert <file.har> [-o <rules.json>]
```

Rule ids `har-1..n`; stdout without `-o`; redacted values stay redacted. Exit 1 for unreadable or non-HAR input.

## `brighttest net token`

Keep the hub token per package.

```text
net token --ensure
```

1. `instrument build --net` stores its token in `.brighttest/hub-tokens/<package-sha256>.json` (mode 0600; token, hash, timestamp only).
2. `--ensure` reuses the latest build's token, or generates and stores one.
3. It prints the file path, package hash prefix (12 hex) and `created` or `reused`, never the token. Load it with the `export` line it prints.

No-op when `BRIGHTTEST_HUB_TOKEN` is set. Exit 2 without `--ensure`.

## `brighttest assess`

Read-only, offline project assessment ([Assess a project](/guide/assess)).

```text
assess [<dir>] [--json] [--out <dir>] [-c|--config <config>]
```

- `<dir>` defaults to the current directory. `--json` prints `brighttest-assess/v1`.
- `--out <dir>` also writes `assess.json`, `assess.md`, `census.json`, `census.md` (refused inside `source/` or `components/`).
- **Exit codes:** `0` report produced (findings never change it) · `1` internal · `2` usage, missing `<dir>`, bad config or refused `--out`.

## `brighttest features`

Graph, check and render; driven by the `mapping-a-roku-app` skill ([Map the app](/guide/feature-tree#mapping-with-an-agent)).

### features graph

```text
features graph [<dir>] [--out <dir>] [--json] [-c|--config <config>]
```

Read-only, offline. Writes `graph.json` (`brighttest-feature-graph/v1`) to `<stagingDir>/features/` (default `.brighttest/features/`) or `--out`, with a summary; `--json` prints the graph. **Exit:** `0` produced · `1` internal · `2` usage (missing `<dir>`, bad config, `--out` inside `source/` or `components/`). See [Map the app](/guide/feature-tree).

### features check

```text
features check [<tree.json>] [--graph <graph.json>] [--json] [--partial]
```

Read-only. Validates a `brighttest-feature-tree/v1` tree with rules V1 to V9: shape and caps, binding to this graph, each file in one feature or `ignored`, component with its XML, ids, testability overrides, proposed tests, plain text, recommended path.

- `<tree.json>` defaults to `<stagingDir>/features/tree.json`; `--graph` to the `graph.json` beside it. `--partial` allows unassigned files.
- `--json`: `{ ok, errors, warnings, findings[{severity, rule, code, pointer, message}] }`.
- **Exit:** `0` valid (warnings ok) · `1` internal · `2` usage or unreadable input · `3` invalid or stale.

### features render

```text
features render [<tree.json>] [--graph <graph.json>] [--out <file.html>] [--auto] [--junit <file>]... [--lcov <file>]...
```

Validates like `check`, then writes one self-contained `report.html` (default beside the tree).

- `--auto` renders the generated skeleton tree (no agent); not with `<tree.json>`.
- Run from the project root: the CI checklist and "code changed since the graph" banner read the current directory.
- **Exit:** `0` written · `1` internal · `2` usage, unreadable input or `--out` refused (inside `source/` or `components/`) · `3` invalid or stale (nothing written).

::: details Run evidence: `--junit` and `--lcov` (repeatable)
- JUnit must come from brighttest (cases map to specs by `@suite` title) or carry `file` attributes. Passing cases mark a spec's nodes `ran-headless`.
- `ran-device` only from a JUnit marked `brighttest.lane=device` (per suite) or the e2e suite name; `--device --junit` writes that marker. E2e flows are not graph spec nodes.
- LCOV shows `executed (lcov N% of M lines)` and no level (it has no lane). See [run evidence](/guide/feature-tree#run-evidence-from-junit-and-lcov).
:::

## `brighttest setup`

Make a Roku the project default.

```text
setup [--host <ip>] [--write | --print] [--shell bash|zsh|fish|sh|powershell|cmd|all]
      [--env-file <path>] [--ecp-port <n>] [--force] [--json]
```

1. Without `--host`, discovers Rokus (several with no terminal: exit 2 and the list).
2. Checks it like `doctor` (device info only: no lease, password or keypress).
3. Asks before writing `ROKU_HOST=<ip>` to the project `.env`. `--write` saves without asking; `--print` never writes; no terminal without `--write` never writes. Other lines (e.g. `ROKU_PASSWORD`) are kept.
4. Adds `.env` to `.gitignore` in a git work tree.
5. Prints export lines for bash/zsh/sh, fish, PowerShell, cmd (`--shell` picks one). Never edits a shell profile or runs `setx`.

- Never asks for, stores or prints the dev password; `--host ip:pw` and lists exit 2. It reports whether one is known and from where (set `ROKU_PASSWORD` or run `brighttest devices`).
- Warns when a differing shell `ROKU_HOST` overrides `.env`. `--force` writes even if a check fails.
- `--json`: `host`, `name`, `model`, `firmware`, `checks[]`, `passwordKnown`, `passwordSource`, `wrote`, `gitignore`, `lines`; no serial, password or token. Agents: `brighttest setup --host <ip> --write --json`.
- **Exit:** `0` done · `1` check failed (nothing written) · `2` usage or no host.

## `brighttest doctor`

Device capability check with the exact fix ([troubleshooting](/guide/troubleshooting#brighttest-doctor-is-the-device-ready)).

```text
doctor [--host <ip>] [--ecp-port <n>] [--json] [--show-serial]
doctor --engines [--json]
```

- Reads device-info only: no password, lease or keypresses. Serial hidden unless `--show-serial`.
- `--engines` probes the resolved brs-node; no device.
- **Exit:** `0` all passed · `1` a check failed or unreachable (`--engines`: probe failed or disagrees with package metadata) · `2` usage.

::: warning Several cached devices: pages disagree
The test lanes above treat several cached devices with none chosen as an error. The [troubleshooting page](/guide/troubleshooting#brighttest-doctor-is-the-device-ready) says `doctor` warns and uses the last cached one. Pass `--host` to be sure.
:::

## `brighttest issue`

Prepare text for a public issue. Local only: files or stdin (`-`, default) in, files or stdout out; no network, device or lease.

```text
issue redact [<file>... | -] [-o <file|dir>] [--project <dir>] [--json]
issue check  [<file>... | -] [--project <dir>] [--json]
issue collect [--host <ip>] [--include <path>]... [--out <dir>] [--area <area>] [--project <dir>] [--json]
```

- **`redact`** masks names, hosts, IPs, tokens, serials and personal paths with numbered placeholders (one mapping for all inputs). Writes stdout (one input) or `-o` (file, or directory for several), then checks it.
- **`check`** re-detects what redaction would still change and lints a [field report](/guide/reporting-issues): missing required sections, empty Actual behavior, severity outside `blocker`/`high`/`medium`/`low`, no brighttest version. Text without those headings is an attachment, not linted.
- Findings print on stderr as `file:line kind`, never the value, ending `fingerprint: bt-xxxxxxxx` (stable per area and first error line).
- Extra names to mask: `.brighttest/issue-deny.txt`, one per line.

### collect

Writes `<stagingDir>/issue/<YYYYMMDD-HHMMSS>/` (or `--out`):

- `environment.json`: brighttest, Node, OS, engine flavours and versions; names (never values) of set `BRIGHTTEST_*`/`ROKU_*` variables; `brighttest.json` keys; file counts.
- `ISSUE.md` skeleton with Environment filled in.
- `attachments/`: each `--include`, redacted (text only, 1 MB each, 5 MB total, no line over 64 KB). An e2e failure bundle gives only `error.json`, `log-tail.txt`, `net-refused.txt` (never `tree.xml` or screenshots); other directories are refused.
- `redaction.json`: counts per kind and what was left out, never a value.

`--host` adds model, firmware, class, ECP mode and developer mode from one device-info read (no lease, password or serial; address never written), its only network path. Warns if `.brighttest/` is not git-ignored; checks the folder before exiting.

**Exit:** `0` no findings (structure warnings don't fail) · `1` findings (`redact` still writes; `collect` found a survivor) · `2` usage. `--json`: `{ leaks: [{file,line,kind}], warnings, fingerprint, sections }` (`redact` adds `summary`).

## `brighttest mcp`

MCP stdio server ([MCP guide](/guide/mcp) for tools).

```text
mcp
```

No arguments. Newline-delimited JSON-RPC 2.0 on stdin/stdout (logs on stderr), contract `brighttest-mcp/v1`. Device only from `ROKU_HOST`, `ROKU_PASSWORD`, project `.env`, device cache. **Exit:** `0` clean end of input · `1` internal · `2` usage.

## `brighttest devices`

Discover Rokus on the LAN (4 s), list model and address. In a terminal, offers to save one: asks the dev password (unless cached), checks it answers, caches it so later commands need no `--host`. Exit 1 if unreachable. No lease (one read).

## `brighttest device`

The [device lease](/guide/device-lease) commands.

```text
device status [--host <h>] [--json]
device watch [--host <h>] [--once|--json|--plain] [--interval 2s] [--for <dur>] [--tail <n>] [--all] [--no-probe]
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

::: tip In --help, not yet in the full reference page
`device watch`: live, read-only board of devices, queues and recent runs. Flag meanings beyond the synopsis are not documented yet.
:::

| Flag | Meaning |
|---|---|
| `--password <pw>` (`--pass`) | (`with`, `lock`, `reset`) else `ROKU_PASSWORD` or cache |
| `--host <ip[:pw]>` | Else `ROKU_HOST`, cached device. `with`'s child gets `ROKU_HOST`, `ROKU_PASSWORD`, `BRIGHTTEST_LEASE` |
| `--as`, `--purpose` | `BRIGHTTEST_AGENT`, `BRIGHTTEST_PURPOSE` |
| `--wait <dur>` | `BRIGHTTEST_LEASE_WAIT`, default 30m; `0` = fail if busy |
| `--max <dur>` | Hold cap (default 60m; `lock` session cap 45m); `with` stops the command at it (exit 77) |
| `--expect <dur>` | ETA shown to waiters |
| `--lease <token>` | (`with`, `renew`, `unlock`) that session lease (= `BRIGHTTEST_LEASE`) |
| `--idle <dur>` | (`lock`) idle TTL (default 10m), renewed by use |
| `--no-hygiene` | Skip Home x2 after acquiring |
| `--keepalive[=sec]` | (`with`) ECP `Fwd` every `<sec>` (default 240, min 60, `0` off) |
| `--device any` | (`with`) first free of `deviceLease.pool`; others exit 2 |
| `--ecp-port <n>` | `ROKU_ECP_PORT`; in the address lease key when not 8060 (identity key ignores it) |
| `--force`, `--reason <text>`, `--kill` | (`unlock`) audited override; `--reason` required for a live holder; `--kill` stops its processes |
| `--tail <n>`, `--json` | (`log`) last `n` lines as JSON; `--json` also for `status`, `lock` |

**Exit:** the wrapped command's code · `75` busy or wait timed out · `77` lease lost, expired or not held · `78` lease dir unusable (`BRIGHTTEST_LEASE_DIR`, default `~/.brighttest/leases`) · `2` usage. `device hook` always exits 0; `device reset` exits 0 when Home is reached, else 1 ([Resetting a stuck device](/guide/device-lease#resetting-a-stuck-device-device-reset)).

While waiting, stderr shows `[brighttest lease] <host> is held by <agent> ... You are #N in queue.` once, then every 30 s.

## Environment variables

| Variable | Used by | Meaning |
|---|---|---|
| `ROKU_HOST`, `ROKU_PASSWORD` | device commands | Address, dev password |
| `ROKU_ECP_PORT` | e2e, device, doctor | Default 8060 |
| `ROKU_LOG_PORT` | e2e logs | `assertLog` console port (default 8085) |
| `BRIGHTTEST_AGENT`, `BRIGHTTEST_PURPOSE` | lease | Holder, purpose |
| `BRIGHTTEST_LEASE_WAIT` | lease | Default queue time |
| `BRIGHTTEST_LEASE_DIR` | lease | Default `~/.brighttest/leases` |
| `BRIGHTTEST_LEASE` | lease | Held token (session or from `device with`) |
| `BRIGHTTEST_HOOK_TIMEOUT_MS` | `device hook` | Budget, default 4000 ms |
| `BRIGHTTEST_NO_LEASE=1` | lease | = `--no-lease`; never for agents |
| `BRIGHTTEST_LEASE_NO_FOREGROUND_CHECK=1` | lease | Disable the foreground advisory |
| `BRIGHTTEST_ENGINES` | lanes | `auto`, `patched`, `stock` or a package (other kind: same flavor); wins over config |
| `BRIGHTTEST_HUB_TOKEN` | instrument, e2e, mcp, studio | 32 hex token shared by build and hub |
| `BRIGHTTEST_DOCTOR_HUB_PROBE=1` | doctor | Device-to-hub probe (needs `ROKU_PASSWORD`; replaces the dev channel) |
| `BRIGHTTEST_BUILDS_DIR` | builds | Store directory |
| `BRIGHTTEST_CACHE` | devices | Default `~/.brighttest/devices.json` |
| `BRIGHTTEST_STATE_DIR` | studio | Perfetto record (default `~/.brighttest`) |
| `BRIGHTTEST_DEBUG` | studio | Extra server diagnostics on stderr |

## Related

- [Quick start](/guide/getting-started): install and run a first test
- [Device lease](/guide/device-lease): queueing, sessions, lease exit codes
- [Troubleshooting](/guide/troubleshooting): errors and fixes

**Full guide:** [CLI reference](full:/guide/cli-reference) — the original wording.
