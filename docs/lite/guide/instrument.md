# Instrumented builds (debug only)

::: info At a glance
**What it is for:** a debug package built with the **instrument plugin**, so brighttest can read and write app state and route network traffic through a hub.

**You will:**
- build and sideload an instrumented package
- gate releases with `instrument verify`
- set up a brownfield or greenfield app
- mock network traffic in headless tests and e2e flows

**First command:** `npx brighttest instrument build`
:::

## Build a package

`brighttest instrument build` builds through brighterscript with the plugin. The plugin rewrites a **staged copy**; your tree is never modified. Only the package gets the runtime and a generated `source/bt/BT_config.brs` (fresh 128-bit token per build).

::: warning Never ship this package
It carries debug-only code. `instrument verify` exits **3** on any marker. Build the store package without `instrument build`.
:::

```bash
npx brighttest instrument build                       # -> .brighttest/instrument/app.bt-instrumented.zip
npx brighttest instrument build --out .brighttest/debug.bt-instrumented.zip --strict
```

## Example: the sample app

Instrument builds need the opposite globs from unit lanes, so the example ships a second config.

- `examples/sample-app/brighttest.json` (unit lanes) excludes `source/main.brs`, includes specs.
- `brighttest.instrument.json` includes `main.brs`, excludes `source/tests/**`.
- `rootDir` resolves against the **current directory**: run from the app folder.

```bash
cd examples/sample-app
node ../../bin/cli.js instrument build --config brighttest.instrument.json
# -> .brighttest/instrument/app.bt-instrumented.zip
```

Own project: `npx brighttest instrument build --config brighttest.instrument.json`.

## What a build does

Gates run before anything is written, so a failed build never reaches a device.

1. Build to a **temporary** path (`deploy` is never passed to brighterscript).
2. Gates, in order; any failure means **no package is written**:
   1. plugin or brighterscript error diagnostics: `BT9001` reserved name, `BT9002` plugin order, `BT9003` staged output invalid, `BT9004` plugin reused, `BT9005` invalid net config, bsc errors;
   2. `BT9003 staged-output-invalid`: a rewritten file no longer parses;
   3. with **strict**, any "could not instrument" entry ([table](#what-counts-for-strict)).
3. Move to `--out`. A failed build leaves an older package there untouched.

```text
BT9003 staged-output-invalid source/net.brs:12 (bsc 1081, net)
strict: excluded-candidate source/vendor2/x.brs:2 file is in an excluded glob and contains setUrl/getUrl call sites ...
instrument build failed: 1 error(s), no package written
```

### Exit codes

| Code | Meaning |
|---|---|
| 0 | package written |
| 1 | build failure (brighterscript/plugin error, `BT9003`); with `--sideload` also auth, port-80 or installer failure |
| 2 | usage error |
| 3 | reserved for `instrument verify` (instrumentation found) |
| 4 | strict failure: valid build, something not instrumented |
| 75 / 77 / 78 | `--sideload` lease codes: busy or wait timeout / lease lost / lease directory problem |

### Sideloading the package

`--sideload` installs after a successful build via the dev installer (port 80, Digest auth), inside the device lease.

```sh
ROKU_PASSWORD=<dev-password> npx brighttest instrument build --sideload --host 192.0.2.5
```

| Topic | Behaviour |
|---|---|
| `--host` | Required; never guessed from the cache. |
| Password | `ROKU_PASSWORD`, `--host ip:password`, or the host's credential cache. Never printed. |
| Port 80 | Checked first; closed exits 1 telling you to enable Developer Mode. |
| Installer failure | App deleted, install retried once. |
| Builds store | Recorded unless `builds.record` is `false`; install result appended. Success prints `on the device now: ...`. |
| Lease | `--wait`, `--max`, `--expect`, `--as`, `--purpose` (as `brighttest device with`). Cannot be bypassed. |
| `--reuse` | Installs the newest stored build when the source fingerprint (all project files, build-shaping config, hub address, flags, tool versions), flags and (with `--net`) hub token are unchanged; else rebuilds. Not with `--from`. |

Reinstall later: `brighttest builds install <id|--latest>` ([Builds](/guide/builds)).

## Release gate: `instrument verify`

Run in CI on the package you will publish.

```bash
npx brighttest instrument verify build/store.zip      # a zip or an unpacked directory
```

Exit **0** clean; **3** marker found (markers and paths on stderr); **2** missing argument, nonexistent path, or unreadable zip.

| Marker `kind` | Finds |
|---|---|
| `manifest-key` | `bt_instrumented` key in `manifest` |
| `bs-const` | `BT_AGENT=true` in `bs_const` |
| `runtime-file` | any file under `source/bt/` or `components/bt/` |
| `component-xml` | `BT_Agent` in a component XML |
| `string` | `__bt_agent` or `__bt_boot` in `.brs`, `.bs` or `.xml` |

Not markers: `BT_AGENT=false`, the greenfield libraries (`BTStore`, `BTHttp`).

## `BT_op` and the `m` layer

The build adds `BT_op` at the root of every instrumented component chain so the agent can read and write a component's `m` (`layer: m` in `setState`; [App state](/e2e/app-state)).

- Extending components inherit it (no duplicate-function diagnostic).
- On by default; `"instrument": { "op": false }` disables it.
- A user function named `BT_op` fails the build (`BT9001`).

## Census: `instrument census`

Static scan: no device, no network, nothing written unless `--out` is given.

```bash
npx brighttest instrument census                       # markdown to stdout
npx brighttest instrument census --json --out .brighttest/census   # JSON to stdout, census.json + census.md in the dir
npx brighttest instrument census --config path/to/brighttest.json
```

- **Reports:** Scenes, Tasks, `m.global.addFields` keys, registry section literals, `setUrl` and `CreateObject` sites, a "could not instrument" section. Inline-CDATA Scenes are reported only.
- **Scans** `source/` and `components/` under `brighttest.json` `rootDir`. Only if unset, falls back to a root `bsconfig.json` `rootDir` (direct or via `extends`): a census-only hint, since build and instrument ignore `bsconfig.json`.
- **Bad config:** a malformed, non-object or unreadable config exits 2 (never treated as empty). `--config` with no value: exit 2.

::: details Never reads outside the project root
- A `rootDir` or `extends` resolving outside is ignored.
- A symlinked `source/`, `components/` or `manifest` resolving outside is skipped and reported. A symlinked `manifest` is never read, even inside.
- Folders named `.env*` under `source/` or `components/` are skipped.
:::

## Brownfield setup: `init --brownfield`

For an existing app you do not want to edit.

```bash
npx brighttest init --brownfield [--force] [--dry-run]
```

It runs the census, writes the `instrument` block (`strict: false`, `state.registrySections` from found registry sections), and adds `.brighttest/` and `*.bt-instrumented.zip` to `.gitignore`. No example spec, no npm test script. An existing `brighttest.json` is merged, never overwritten ([merging](/guide/cli-reference#merging-into-an-existing-brighttest-json)).

1. Run it first, on a copy of the app, before `instrument build`.
2. If the globs were written for test lanes (omit `source/main.brs`, or include `certs/**`), leave that file alone and pass a separate config: `npx brighttest instrument build --config bt-instrument.json --out debug.bt-instrumented.zip`.
3. Keep strict off for the first run so a package is produced; add `--strict` once it exits 0.

## Greenfield setup: `init --greenfield`

For an app built with brighttest in mind.

```bash
npx brighttest init --greenfield [--force]
```

On top of the normal scaffold it:
- copies `BTStore.brs` and `BTHttp.brs` into `source/brighttest/`, each with a version header (`' brighttest-template: BTStore v1`). Specs under `source/` can call `BTStore_create` in the fast lane;
- adds `BT_AGENT=false` to manifest `bs_const` (existing consts kept, name case-insensitive, an existing `BT_AGENT` never duplicated or flipped, CRLF preserved).

```xml
<script type="text/brightscript" uri="pkg:/source/brighttest/BTStore.brs" />
<script type="text/brightscript" uri="pkg:/source/brighttest/BTHttp.brs" />
```

Scene and Task components include them as above. Example: `examples/greenfield-app/` ([Example apps](/guide/examples)). Re-running keeps files; `--force` refreshes only the two templates (never `brighttest.json` or `source/tests/Example.spec.bs`) and cannot combine with `--brownfield`.

::: warning Current limitations (design not fully implemented)
- No `#if BT_AGENT` branches: no `state.action` events, no `dispatch`/`restore` ops; `BTHttp_url` is the identity.
- `BTStore_dispatch` from a Task does not reduce and returns `{}`; Tasks set `m.global.btAction`.
- `BTStore_replay` ignores `options.effects` (reducers only); no `m.global.btEffect`.
:::

## Configuration

All `instrument` keys are optional. Top-level defaults:

```json
{
  "instrument": {
    "strict": false,
    "exclude": [],
    "net": true,
    "scene": true,
    "op": true,
    "hub": { "port": 8790 },
    "state": {}
  }
}
```

| Key | Meaning | Default |
|---|---|---|
| `strict` | "Could not instrument" fails the build (exit 4). `--strict` / `--no-strict` per run. | `false` |
| `files` | Globs or `{ src, dest }` of package contents. Unset: what the Roku packager ships under `rootDir` (images, fonts, root JSON, callee files outside `source/`/`components/`) minus dotfiles/dot folders, `node_modules`, specs (`source/tests/**`, `*.spec.*`), tool config (`brighttest.json`, `bsconfig.json`, `package*.json`), zips, staging dir. Ignores `sourceGlobs`, so headless lanes are unaffected. | that set |
| `exclude` | Globs (from `rootDir`) the plugin leaves alone; default exclusions (Rooibos, `roku_modules`, vendor, specs) also apply. | `[]` |
| `strictAccept` | Globs of files excluded on purpose: their `excluded-candidate` stops failing `--strict` (stays informational). Excludes nothing; other kinds unaffected. Must be non-empty strings. | `[]` |
| `net` | `true`/`false` toggles the `setUrl`/`getUrl` rewrite. Object: `unknown`, `receivers`, and headless keys `fixtures`, `unmatched`, `upstreamHosts`, `redact`, `observe`. Other types: `BT9005`. | `true` |
| `scene` | Bootstrap non-excluded Scene `init`s and ship the agent; `false` drops agent components. | `true` |
| `op` | Add `BT_op`. | `true` |
| `hub` | `host`/`port` the device dials. No `host` = LAN address (`"auto"` rejected). `port` 1 to 65535. | LAN, `8790` |
| `lineMap` | See [Line map](#line-map). | `false` |
| `state` | `registrySections`, `redact.paths`, `caps`, `publish.maxBytes`, `publish.intervalMs`, `callable`, `dispatch`, `tasks` ([App state](/e2e/app-state), [agent writes](#how-the-agent-applies-a-write)). Bad `redact`/`callable`/`dispatch`/`tasks`/`publish`: exit 1 naming the key; bad `caps`/`registrySections` fall back or are dropped. | `{}` |

::: tip Deprecated `instrumentExclude`
A top-level `instrumentExclude` is still merged into `instrument.exclude` (deduplicated) and listed by `brighttest assess` under `deprecatedKeys`. Use `instrument.exclude` in new configs.
:::

### Package contents and warnings

After each build brighttest warns (never fails) about files left out.

- Per top folder, e.g. `images/: 443 not packaged` (dotfiles, tests, tool config not counted).
- The first few `pkg:/` literals in packaged `.brs`/`.xml` that point at missing files.
- `instrument.exclude` only stops the rewrite: excluded files are still compiled by bsc and shipped.

### Apps with their own build step: `--from`

If a script builds the package or fills placeholders (`{{NAME}}`, `__NAME__`), run it, then instrument its output.

```bash
npm run build                                   # writes dist/ (or a zip)
npx brighttest instrument build --from dist
npx brighttest instrument build --from build/app.zip --out debug.bt-instrumented.zip
```

- Input needs `manifest` and `source/` or `components/` at top level (zip root).
- Zips unpack to a fresh temp folder (removed afterwards); refused on `..` or absolute entries, or over 20000 entries / 512 MB unpacked.
- Input never written to; packaging, `--net`, `--sideload`, exit codes as normal. Bad input: exit 1, `--from <input>: <reason>`.
- `brighttest assess` prints an advisory `build:` line suggesting `--from` when `package.json` has a `build`, `package` or `bundle` script, or the manifest/config has placeholders (exit unchanged).

### bsc diagnostics and `diagnosticFilters`

Apps not written for brighterscript can report hundreds of compiler errors (`1104`, `1140`, `1067`, `1068`, `1054`...) that are not Roku runtime errors.

- The build fails only on plugin errors (`BT9001` to `BT9006`, incl. `BT9003`) and parse errors in rewritable files.
- Other bsc errors are warnings: first ten listed (all with `--verbose`; duplicates across scopes once), then per-code counts and a paste-ready line.
- `--fail-on-bsc-errors`: any bsc error fails (no package, same histogram).
- `diagnosticFilters`: top-level array of bsc codes (`1107` always filtered), hidden in instrument builds and headless and device lanes.

```text
instrument build: 694 bsc diagnostic(s) reported as warnings: compiler checks, not Roku runtime errors (the package is not affected)
  by code: 1104=339, 1140=299, 1067=18
  to silence them add to brighttest.json (also applies to the headless lanes): "diagnosticFilters": [1067, 1104, 1140]
```

### Line map

Rewritten files have different line numbers (blank lines dropped, inline `if` and one-line AA literals expanded); untouched files are byte-identical.

| `instrument.lineMap` | Writes |
|---|---|
| `true` | `bt-linemap.json` in the output package's directory |
| string | that path, relative to the project root (use `../maps/bt-linemap.json` or absolute) |
| other value, empty string, staging-dir path (symlinks/case resolved), or in-root path outside the output dir | `BT9006` |

- **Format:** `{ "schema": 1, "files": { "<pkgPath>": [[stagedLine, sourceLine], ...] } }`, rewritten files only, from brighterscript's source map. Unpositioned staged lines take the nearest preceding mapping; look up by exact staged line.
- **e2e bundles** use it when set and the file exists (`true` reads it beside the default package, `<stagingDir>/instrument`): crash frames in `error.json` keep `line` and gain `sourceLine`; the summary ends `(source line N)`; unmapped frames unchanged. No usable map: a one-line `lineMapNote`.

::: warning Line map caveats
- Written outside the package after transpile; the zip is identical either way.
- In-root paths are refused (the next whole-tree build would package it), except the output dir; same for the staging dir.
- A map from a build that later failed a gate is not removed: trust it only after success. Or build with the plugin off to compare.
:::

### What counts for strict

`strict` is **off** by default. The CI recipe turns it on:

```yaml
- run: npx brighttest instrument build --strict --out .brighttest/debug.bt-instrumented.zip   # exit 4 = policy, exit 1 = broken build
```

| Report entry (`kind`) | Fails strict |
|---|---|
| `excluded-candidate` in a file **you** excluded | yes, unless in `instrument.strictAccept` |
| `excluded-candidate` in a default-excluded path (`source/rooibos/**`, `source/vendor/**`, `roku_modules/**`, specs...) | no |
| `empty-init`, `inline-cdata-scene`, `unknown-scene-subtype`, `init-in-excluded-file`, `init-shared-with-excluded-scene` (import or `extends`) | yes |
| `indexed-seturl`, `indexed-geturl`, `bare-geturl`, `xml-parse-failed` | yes |
| `net-receiver-unknown` (only with `net.unknown: "report"`) | yes |
| `wrap-target-unknown` (unmatched `state.dispatch`/`state.tasks` name, or dispatch function used as a value) | yes |
| `rewritten-shared-with-excluded`, `net-receiver-excluded`, `callfunc-seturl`, `net-render-thread` | no |
| anything else | yes (fail closed) |

`--verbose` lists informational entries of a successful build.

### `setUrl` and `getUrl` rewrites

One-argument `setUrl(url)` and `getUrl()` are rewritten to go through the hub; `getUrl` follows the same receiver's `setUrl` in the function.

| Receiver class | Static evidence | Rewritten |
|---|---|---|
| `confirmed` | assigned from `CreateObject("roUrlTransfer")` | yes |
| `likely` | `as roUrlTransfer`, or named `xfer`, `transfer`, `http`, `req`, `request` | yes |
| `unknown` | none | yes |
| `excluded` | another type | no (`net-receiver-excluded`) |

```json
{ "instrument": { "net": { "unknown": "report", "receivers": { "allow": ["**/api.brs#client"], "deny": ["m.cache*"] } } } }
```

- `unknown`: `"rewrite"` (default) or `"report"` (skip, record `net-receiver-unknown`, fails strict).
- `receivers.allow` / `receivers.deny`: `<receiver glob>` or `<file glob>#<receiver glob>`, matched lower-case. Allow overrides `excluded`; deny beats allow. `*` does not cross `/`: write `**/name.brs#x`.
- Not rewritten: `x["setUrl"](url)` (`indexed-seturl`/`indexed-geturl`) and discarded bare `getUrl()` (`bare-geturl`), which fail strict; `callFunc("setUrl", url)` (informational `callfunc-seturl`).
- Inline **CDATA** `setUrl` is invisible to brighterscript: not rewritten or reported, census only. An inline-CDATA **Scene** is `inline-cdata-scene` (fails strict), not bootstrapped.

### Media URLs

`BT_url(url)` routes a media URL (stream or image a node fetches) through the hub. You add it by hand.

1. **Call it in a Task**, then pass the result through a field. On the render thread it is the identity on device (`roUrlTransfer` missing on some firmware, so the hello fails).
2. **Guard with `#if BT_AGENT`** and set `BT_AGENT=false` in `bs_const`: it exists only in instrumented builds.

::: warning Limits
- In a Scene or other non-`Task` component it is a device no-op, reported as informational `net-render-thread` ("render-thread BT_url is the identity on device; wrap the URL in a Task"). In Tasks, calls in `init` and its `observeField` callbacks are reported (best effort). Never fails strict; plugin-inserted calls not reported.
- A failed hello is cached 30 s, then retried (one console line each).
:::

## In headless tests

`instrument.enabled` (default `false`) turns the instrument on for headless lanes (`brighttest`, `brighttest --coverage`, scene lanes); `instrument build` ignores it.

::: code-group
```sh [CLI]
npx brighttest --instrument   # true for one run, even if config says false
```
```json [brighttest.json]
"instrument": {
  "enabled": true,
  "state": true,
  "net": { "fixtures": [] },
  "exclude": ["source/vendor/**"]
}
```
:::

| Topic | With `enabled: true` |
|---|---|
| Scene lane | Builds with the plugin and the in-process loopback hub (same as net fixtures). Uses the scene runner, not the faster SceneGraph-off driver, even without `@SGNode` specs. |
| `state` | `true` (default), `false` or options (`redact`, `callable`, `publish`, `caps`, `registrySections`). `false` = net only: `net` must be active or exit 2 "nothing to instrument". `enabled` never activates `net`. |
| Coverage | Slower. LCOV and percent count only your files: `source/bt/**` and `components/bt/**` are dropped (net-only too) and, on the coverage lane, not instrumented. Your own files there show no coverage. |
| `--no-sgnode` | Exit 2 before anything starts: `--no-sgnode runs no SceneGraph; the instrument state agent needs a scene lane`. Drop it or set `state: false`. |
| `--device`, `--cross-check` | Ignore it: `instrument.enabled applies to the headless lanes only; ignored by <lane>`. `--instrument` with them exits 2. Use `instrument build --sideload`. |

**Validation** (non-object block, wrong-type `enabled`/`state`, bad `state` options, `exclude` not strings): when enabled, exit 2 `[brighttest] instrument: <message>`, nothing built; otherwise one warning `[brighttest] instrument: <message> (ignored: instrument is not enabled for this run)`. `instrument build`, Studio and `doctor` never fail on these keys.

## Headless network fixtures: flags, config and run records

Headless lanes can route `roUrlTransfer` traffic through an in-process proxy serving mocks and fixtures. It switches on with any of:

- `--net-record` or `--net-unmatched`;
- `instrument.net` = `true`, or an object with `fixtures`, `unmatched`, `upstreamHosts` or `redact`;
- a runnable spec file mentioning `BTNet_*`.

::: details When a `BTNet_*` spec counts
- Not when every `BTNet_*` suite is `@ignore`d (annotation above or beside `@suite`, not in a comment or string), or the mention is only in a comment or string.
- Shared helper code outside `@ignore`d suites counts when a non-ignored suite exists.
- `testsFilePattern` is irrelevant: the Rooibos fork uses `includeFilters`.
- No opt-out for running specs: `@ignore` them for a plugin-free run.
- `enabled: true`, `state: false`, only `@ignore`d `BTNet_*` specs: exit 2 "nothing to instrument".
:::

### `--net-record [file]`

Records passthrough exchanges (unmatched requests sent to `instrument.net.upstreamHosts`) to a HAR, redacted by `instrument.net.redact`.

- Mocked, fixture, fault and refused requests are not recorded.
- Default `<stagingDir>/net/<run>.har` (`.brighttest/net/<timestamp>.har`); override with `--net-record out.har` or `=out.har`.
- Implies `unmatched: "passthrough"` unless set. No `upstreamHosts`: exit 2 (`net: net.record requires net.upstreamHosts ...`).

```
[brighttest] net: recording passthrough traffic to /path/to/project/.brighttest/net/2026-01-01T00-00-00-000Z.har; upstream hosts: api.example.test
[brighttest] net: recorded 3 request(s) to /path/to/project/.brighttest/net/2026-01-01T00-00-00-000Z.har
```

::: warning Tested against mock upstreams only
No TLS client certificate is presented; upstreams requiring one reject it, and support is not promised.
:::

### `--net-unmatched <fail|passthrough>`

What happens to an unmatched request (`=passthrough` form works). Other values exit 2 (`--net-unmatched must be "fail" or "passthrough"`).

| Value | Effect |
|---|---|
| `fail` | HTTP 599 with hint body; `net.error` kind `unmatched` |
| `passthrough` | upstream, only to `upstreamHosts`; others 403, `net.error` kind `upstream` |

- **Precedence:** flag, `instrument.net.unmatched`, `passthrough` when recording, `fail` once a fixture file is loaded, else `passthrough`.
- `passthrough` with no `upstreamHosts` exits 2: `passthrough needs config.net.upstreamHosts; with an empty list every request is refused (403)`.
- Studio's Network tab reads `upstreamHosts`, `unmatched`, `redact` the same way; `record` off, `fixtures` not loaded, bad values shown in the panel ([e2e](/e2e/)).
- Exit code unchanged: dependent specs fail on the 599. Up to 20 failures print at run end; the rest are in the NDJSON.

```
  Network failures (1)
    unmatched: GET http://api.example.test/v1/items
```

Both flags are headless only; with `--device` or `--cross-check` they exit 2 (`--net-record / --net-unmatched apply to the headless lanes only ...`).

### `instrument.net.observe`

`{ "instrument": { "net": { "observe": true } } }`: observe-only, for builds whose traffic cannot use the hub.

- Never contacts the hub or rewrites URLs; prints one 8085 console line per URL set: `[bt:net] url=https://api.example.test/v1/home?`.
- Query, fragment and `user:password@` dropped (trailing `?` marks a query); path segments kept.
- Mocks, faults, fixtures do nothing. Only `true` enables it. See [network recipe](/guide/network-recipe).

### `instrument.net.fixtures`

Glob strings (`*`, `**`, `?`) relative to the project root (directory of `brighttest.json`).

```json
{ "instrument": { "net": { "fixtures": ["fixtures/net/*.json", "fixtures/extra/**/*.har"], "upstreamHosts": ["api.example.test"] } } }
```

- Matches sorted per pattern; patterns load in order (earlier rules first).
- Rejected: absolute, `..`, symlinks out of the root. `node_modules`, `.git`, `.brighttest` not searched.
- No match or non-string array: `[brighttest] net: instrument.net.fixtures pattern "<glob>" matched no files`, exit 2 before tests.

### Run NDJSON

Each net run overwrites `<stagingDir>/net/last-run.ndjson` (`.brighttest/net/last-run.ndjson`), URLs and headers redacted. Every line: `v` (1), `ts` (ISO), `kind`, `data` (with `lane: "headless"`).

| `kind` | `data` fields |
|---|---|
| `net.request` | `id`, `method`, `url`, `headers`, `rule` (id or `null`), `bodyRef` (optional) |
| `net.response` | `id`, `status`, `headers`, `bytes`, `source` (`mock`, `fixture`, `passthrough`), `timings` (`wait`, `receive`), `bodyRef` (optional) |
| `net.error` | `id`, `kind` (`unmatched`, `upstream`, `fault:reset`, `fault:timeout`), `detail`, `refused` (refused passthrough only) |

```json
{"v":1,"ts":"2026-01-01T00:00:00.000Z","kind":"net.request","data":{"id":"r-1","method":"GET","url":"http://api.example.test/v1/items","headers":{},"rule":null,"lane":"headless"}}
{"v":1,"ts":"2026-01-01T00:00:00.050Z","kind":"net.error","data":{"id":"r-1","kind":"unmatched","detail":"GET http://api.example.test/v1/items","lane":"headless"}}
```

### `BTNet_` specs are skipped on `--device`

On `--device` (and the device leg of `--cross-check`), every `*.spec.bs` matching `\bBTNet_\w+` is excluded, printing `[brighttest] skipped (headless-only network fixtures): <path>`.

- Skips `node_modules`, `.brighttest`, `.git`, `out`.
- Per file, not per suite: keep `BTNet_` calls in their own files.
- `--cross-check` reports them `headless-only`, not a divergence.

## The LAN hub on a device, and `doctor`

The loopback hub has a LAN form for real devices, tied to the device lease (no second lease).

- **Lifecycle:** `e2e run` starts it only after holding the host's lease, binds all interfaces, stops it before release. Lost or expired lease stops it; a lease-bypassed run gets none. Opt-in (`net` in config).
- **Peers:** answers only the leased device's (private LAN) IP. Others get bare `404` and a line `[brighttest hub] refused a request from <ip>: the hub for <device> answers only that device`. A second same-device session in one process: `PEER_LOCKED`, first hub untouched.
- **`doctor`:** `brighttest doctor --host <ip>` adds `hub-bind` (open/close a listener on all interfaces), proving only that this machine can listen. Failures print a `fix:` line; ECP fix texts unchanged.

Doctor does **not** prove reach by default (firewall or Wi-Fi isolation may block it) and says `hub reach: not tested (set BRIGHTTEST_DOCTOR_HUB_PROBE=1 and ROKU_PASSWORD; replaces the dev channel)`.

### Proving device-to-hub reach: `BRIGHTTEST_DOCTOR_HUB_PROBE=1`

```
export ROKU_PASSWORD=<dev-password>
BRIGHTTEST_DOCTOR_HUB_PROBE=1 brighttest doctor --host <roku-ip>
```

::: warning Replaces your app in the dev channel slot
Afterwards doctor presses Home and prints `dev channel now holds the brighttest probe; re-sideload your app`.
:::

1. Takes the device lease (re-entrant under `brighttest device with`) using `ROKU_PASSWORD`.
2. Installs a `brighttest hub probe` channel that requests a one-off URL on this machine's LAN address, hub port 8790.
3. A short-lived listener checks the request came from the device. Default port and detected address; `brighttest.json` not read.

| `hub reach` | Meaning | Check and exit |
|---|---|---|
| `reached` | request arrived | `hub-reach` passes |
| `not-reached` | probe ran, nothing within 15 s | `hub-reach` fails with `fix:`, exit 1 |
| `not-tested` | probe did not run or finish | no check, exit unchanged |

- `not-tested` reasons (`hub.reachReason` in `--json`): `not-requested`, `device-unreachable`, `developer-disabled`, `no-password`, `port-busy` (hub port in use), `lease-busy`, `sideload-failed`. `--json` also has `hub.reach`, `hub.reachProven` (true only for `reached`).
- `not-reached` fix: allow inbound TCP on the hub port for node; same network, no client or guest isolation; no VPN on the LAN route; set `instrument.hub.host` with several interfaces. Doctor changes none of these.

### The hub token: `--net` and `BRIGHTTEST_HUB_TOKEN`

`instrument build --net` bakes in the token from `BRIGHTTEST_HUB_TOKEN`; the e2e hub accepts only that token.

```
export BRIGHTTEST_HUB_TOKEN=<32-hex-token>
brighttest instrument build --net --sideload
brighttest e2e run ...   # same shell, same value
```

- Exactly 32 lowercase hex characters. Missing or malformed with `--net`: exit 1, `instrument build --net needs a hub token: set BRIGHTTEST_HUB_TOKEN to 32 lowercase hex characters (the e2e run's hub accepts the same value)`.
- Use the same value for `e2e run`; changing it means rebuild and re-sideload (installed builds keep the old one).
- Kept in `.brighttest/hub-tokens/<package-sha256>.json` (mode 0600, git-ignored). `brighttest net token --ensure` prints the file, hash prefix (never the token) and the `export` line. Still mismatched: rebuild with `--net` after `net token --ensure`.
- It is a secret: keep it out of the repo, `brighttest.json`, flows and logs.

## Network steps in e2e flows

Flows can mock and check HTTP traffic on a device. Needs `brighttest instrument build --net --sideload`; `e2e run` starts the hub and proxy inside the lease when a flow uses a network step or `config.net`.

```yaml
appId: dev
config: { timeout: 8, net: { fixtures: [fixtures/net/home.json], unmatched: fail, upstreamHosts: [api.example.test] } }
steps:
  - mockHttp: { method: GET, url: "**/v1/home", status: 200, file: fixtures/net/home.json }
  - mockHttp: { url: "**/v1/search*", responses: [ { status: 503 }, { status: 200, file: fixtures/net/search.json } ] }
  - mockHttp: { url: "**/v1/config", fault: timeout }
  - launch
  - waitForRequest: { method: GET, url: "**/v1/home", timeout: 5 }
  - assertRequest: { method: POST, url: "**/v1/track", count: 1, bodyContains: play }
  - recordHttp: { file: out/session.har }
  - recordHttp: stop
  - clearHttp
```

| Step | Behaviour |
|---|---|
| `mockHttp` | `BTNet_` rule keys: `status`, `file`, `json`, `body`, `headers`, `responses`, `fault`, `delayMs`, `times`, `reqHeaders`, `reqBody`. `file:` confined to the project root. |
| `waitForRequest` | Polls the log (seconds; default flow `timeout`). |
| `assertRequest` | Passes when matches equal `count` (default at least one). |
| `clearHttp` | Drops the flow's rules, hides the log so far. |
| `recordHttp` | `{ file }` opens a window, `stop` writes the redacted HAR. Keeps passthrough exchanges fully inside the window. Needs `config.net.upstreamHosts`. |

- Wait/assert read the log in-process (no ECP) and match `method`, `url` (glob), `status`, `bodyContains`. A miss shows expected, seen, and up to five `METHOD /path` lines (no queries, headers, bodies).
- Flow rules and fixtures drop at flow end; flows never see earlier flows' requests.
- Open recordings are written at flow end, even after failure. Buffer 500 exchanges / 64 MB; past it `stop` fails "recording buffer overflow", nothing written.
- **`config.net`:** `fixtures` (flow-scoped root files), `unmatched` (`fail` | `passthrough`; `fail` with fixtures, else `passthrough`), `upstreamHosts`, `record`, `redact`. Bad values are parse errors. Passthrough with empty `upstreamHosts` errors in `e2e lint` and before `e2e run` touches the device.
- **Inheritance:** starts from `instrument.net` (`fixtures`, `unmatched`, `upstreamHosts`, `redact`; never `record`), overridden per key. Studio's Run merges the same way.
- **Refused:** a failed step prints `12 requests refused by the passthrough allow-list: host (n), ... Add them to config.net.upstreamHosts.`, also `net-refused.txt` and `netRefused` in `error.json`.
- **Fail fast:** no hub (bypassed lease, failed start) fails before touching the device. A non-instrumented build fails within 5 s of `launch`: ``no agent.hello/BT_url handshake seen: build with `brighttest instrument build --net` ``.

## Hub state routes

The hub relays host-side state writes to the agent, with the same token, peer and lease rules: wrong token or peer is bare `404`, lost lease `423`, wrong `?session=` `409 {resync}`.

| Method and path | Purpose |
|---|---|
| `POST /bt/<token>/state` | Queue `{op, args, ack?}` (`ack`: `applied` default, or `reflected`) → `202 {id, seq, session}`. Over 64 KB: `413 {error: "STATE_TOO_LARGE"}`, never truncated. Bad op/body: `400 {error: "BAD_COMMAND"}`. |
| `GET /bt/<token>/state[?id=<cmd id>]` | Status (`pending`, `done`, `failed`, `timeout`, `abandoned`), gaps, last redacted `state.snapshot`. Open commands time out on a hub timer and on read. |

### How the agent applies a write

The agent's Task holds a long-poll; the render-thread agent applies commands in seq order.

1. `GET /bt/<token>/cmd?after=<seq>&session=<id>`: `200` commands, `204` idle, `409 {resync}` (session mismatch; nothing replayed).
2. `cmd.ack` events on `POST /bt/<token>/events`: `received`; `applied` (`ok`, `result` or an `error` like `TYPE_MISMATCH: field count holds a number; got a string`); `reflected` after the `__bt_agent` Label republishes (only for `ack: reflected`).
3. Queued commands log as `cmd.sent` in `events.ndjson`, sensitive keys and `instrument.state.redact.paths` masked.

#### Ops and layers

| Topic | Rule |
|---|---|
| Ops | `ping`, `get`, `set`, `merge`, `snapshot`, `restore`, `registry.read`, `registry.write`, `callFunc`, `subscribe`; `focus` on `args.node.id` (`NODE_NOT_FOUND`). `dispatch` allowed hub-side, but the BTStore op is greenfield (not built); the wrap below is the app-side route. Others: `op not allowed`. No file system op, no registry delete. |
| Layers | `global`, `scene`, `node` (`node: {id}`); `registry` for `get`. |
| `set` | Type-checked; never below a node reference (`PATH_UNDER_NODE`); missing node field `FIELD_NOT_FOUND` (only `global` creates). Refusals leave the app running. |
| Registry | Writes only to `instrument.state.registrySections`, flushed. |
| `callFunc` | Only names in `callFuncAllow`, from `instrument.state.callable` (empty default; [app state](/e2e/app-state)). |
| `snapshot`/`restore` | `snapshot {name}` stores host-side; `restore {name}` is best effort: cut, `<redacted:...>` or node-reference values skipped and listed; newer fields listed in `added` and kept; object fields restored whole. |
| Size | Over 64 KB (command or result): `STATE_TOO_LARGE`, never truncated. |

#### Publish cadence and string caps

- Live session, no `subscribe`r: every 10 × `publish.intervalMs` (10 s at 1000 ms; 5 s at the 500 ms default). Subscribed or no hub: every `publish.intervalMs`.
- The hub's `watch()` (Studio, on each `GET /api/state`) queues a quiet `subscribe`, holds it 15 s after the last watch, then `subscribe {on:false}`; re-sent after an agent restart (new hello). Plain `e2e run` never watches.
- Strings are cut at about 2000 characters without a marker. Snapshots over `publish.maxBytes` drop whole fields, listed under `truncated`.

#### Dispatch wrap: `instrument.state.dispatch`

`["fn"]` renames each non-excluded `fn` to `__bt_orig_<fn>` and appends a same-signature wrapper (defaults keep their expressions) that hashes global fields around the call and publishes a `state.action`.

- Up to 64 queued events per agent tick; overflow counted in `dropped`. One global field, read-modify-write: simultaneous Task-thread events may rarely duplicate or vanish (fine for a debug log).
- Device masks payload by key name; `redact.paths` is host-side only.

| Event field | Content |
|---|---|
| `source` | `wrap:<function name>` |
| `type` | first argument's `type`, only if it is an associative array; otherwise no `type` and no `payload` (Studio: null) |
| `payload` | first argument's `payload` (state-read caps). Secret-looking keys become `<redacted:...>` on device. Studio masks again (key name, `redact.paths`); `?raw=1` skips only Studio's. Data under another key (e.g. `value`) shows null. |
| `hashBefore`, `hashAfter` | CRC32 hex of globals; Studio derives `changed` (null if either missing). Device sends `hashbefore`/`hashafter`; Studio accepts both. |
| `dropped` | first event of a batch: events lost to the 64 limit |

Studio lists the newest 200. Return values and later arguments are not logged.

::: warning Dispatch wrap limits
- A target used as a value (`store = { dispatch: fn }`, `store.dispatch(a)`) would lose `m`: not wrapped, `wrap-target-unknown` (trips strict).
- Actions via `m.global.btAction` hit `BTStore_onAction`/`BTStore_dispatch` directly, skipping `AppStore.dispatch`, so they are not logged.
- `.bs` defaults copy as written: only plain literals and empty `{}`/`[]` wrap; enum, const, namespace, template string or call defaults (or any unbuildable wrapper) give `wrap-target-unknown`, unwrapped.
- The hash covers `m.global` only; masked keys and content past serializer caps (depth, array items, string length) do not change it. State in scene/node `m` or module variables shows equal hashes.
- Measured on a device: about 10 ms per dispatch with a normal global, about 118 ms with 516 global fields.
:::

#### Task snapshots: `instrument.state.tasks`

`["TaskComponent"]` wraps the entry function (`m.top.functionName = "..."` in `init`) and publishes the Task's `m` at entry and exit under the `task` layer.

- Studio hides these; `get --layer global` returns raw `__btEv` and `__btTask_*`.
- No timer snapshot (a Task in `wait` cannot be interrupted). Call `BT_taskSnap(m.global, "<name>", "timer", m)` inside `#if BT_AGENT` ... `#end if` with `BT_AGENT=false` in `bs_const`, at most about once per second (it serializes `m` and sets a global field, a render-thread rendezvous).
- A Task that never returns gets only `entry`.

#### Studio state API

Under `/api/state/`, all behind the lease (write while another agent holds it: `423 LOCKED`).

| Route | Behaviour |
|---|---|
| `GET /api/state/node?id=<node id>&layer=node\|m[&path=a.b][&depth=N][&raw=1]` | Agent `get` (quiet, up to 4 s) for a node's fields or a component's `m`, by id (up to 256 characters; path up to 1 KB). `200 { id, layer, path, found, value, truncated, depth, redacted }`, masked by default. `depth` 1 to 6 cuts deeper values to `$truncated:depth` (node view "load" reads them); `depth: null` means a build that ignores it gave a full read. |
| `GET /api/state/actions[?raw=1]` | Events oldest first: `entry`, `ts`, `source`, `type`, `payload` (masked unless `raw=1`), `hashBefore`, `hashAfter`, `changed`, `snapshot` (null until recorded). |
| `POST /api/state/actions {"action":"record"}` | Snapshot onto the newest entry (`act-<seq>`); older `entry` `409 STALE_ENTRY`, empty log `404 NOT_FOUND`. |
| `POST /api/state/actions {"action":"travel","entry":<n>}` | Restore that snapshot (202); unknown `404 NOT_FOUND`, none `409 NO_SNAPSHOT`. State only: network, registry and Task effects are not undone. |
| `GET /api/state/fixtures` | Lists `fixtures/state/*.json`. |
| `POST /api/state/fixtures` | `{"action":"save","name":"n","snapshot":"s","raw":false}` (masked unless `raw`); `{"action":"load","name":"n"}` (`404` missing, `400` bad layer or name). Format `{"v":1,"name":"n","layers":{...}}`. |

Node-read errors pass through (`404 NODE_NOT_FOUND`, `409 M_NOT_AVAILABLE`/`M_PATH_FORBIDDEN`, `400 PATH_UNDER_NODE`, `413 STATE_TOO_LARGE`), plus `409 STATE_NOT_INSTRUMENTED`, `504 ACK_TIMEOUT`, `423 LOCKED`, `503 NO_HUB`.

### ECP `/input` mailbox fallback

Without a hub, send a command via ECP `POST /input`: `device.input(command, { token })` in `lib/e2e/ecp.js`. The agent's `roInput` receiver applies it through the same op allow-list.

| Topic | Rule |
|---|---|
| Token | Each chunk has `tk=<token>`, the per-build [hub token](#the-hub-token-net-and-brighttest-hub-token), compared in constant time; bad or missing: dropped silently. Needs `--net` and `BRIGHTTEST_HUB_TOKEN` (other builds bake an unprinted random token). Caller passes `{ token }` or `createDevice({ hubToken })`; `input()` refuses without one. |
| Session | Only while no hub session is live. No `seq`, no acks; last `{ id, phase, ok }` (`applied`/`reflected`) appears in the `__bt_agent` Label as `input`. |
| Limits | ≤3,500 percent-encoded characters per request (device limit 4,082), no body, 220 ms apart; ≤64 chunks per command, joined by `seq`; repeats and the last 32 applied ids ignored; never partial; incomplete sequences dropped after 10 s idle; ≤8 sequences, oldest evicted. |

::: warning The token travels in the clear
- `tk` is the secret token in the request line; never log or forward unknown `roInput` or deep-link keys (the 8085 console is LAN-readable).
- `bt`, `tk`, `s`, `n`, `d` reach your app's `roInput` like deep-link parameters: ignore unknown keys.
:::

## Rules to know

Constraints on every instrumented build.

| Rule | Detail |
|---|---|
| Single build | One fresh `Program`, one plugin instance; no watch mode. Reuse: `BT9004 plugin-reused`. |
| Plugin order | **After** the Rooibos coverage plugin, or Scene `init` lines drop from coverage (`BT9002`). Later plugins' body edits are kept. |
| Scene `init` | Becomes `sub init() : BT_bootstrap(m.top)` plus the original body. An excluded child Scene stops its base `init` being wrapped (`init-shared-with-excluded-scene`, `via: "extends"`); un-exclude it. |
| Inline CDATA `setUrl` | Not rewritten or reported; census only. `callFunc("setUrl", url)`: `callfunc-seturl`, never rewritten (cannot work on a real `roUrlTransfer`). |
| Line numbers | Not the source's; use the [Line map](#line-map). |

## Related

- [App state](/e2e/app-state): state through the agent
- [Network recipe](/guide/network-recipe): network mocking walkthrough
- [Builds](/guide/builds): builds store, `builds install`
- [Device lease](/guide/device-lease): lease options and codes

**Full guide:** [Instrumented builds (debug only)](full:/guide/instrument) — the original wording.
