# Instrumented builds (debug only)

`brighttest instrument build` builds your app through brighterscript with the **instrument plugin** and writes a
package for debugging. The plugin rewrites a **staged copy**: your source tree is never modified, and the build adds
the instrumentation runtime and a generated `source/bt/BT_config.brs` (a fresh 128-bit token per build) to the package
only.

::: warning Never ship this package
An instrumented package carries debug-only code. The release gate `instrument verify` exits **3** when it finds any
instrumentation marker. Build the store package without `instrument build`.
:::

```bash
npx brighttest instrument build                       # -> .brighttest/instrument/app.bt-instrumented.zip
npx brighttest instrument build --out .brighttest/debug.bt-instrumented.zip --strict
```

## Example: the sample app

`examples/sample-app/brighttest.json` is shaped for the unit lanes: it excludes `source/main.brs` and includes the
specs. An instrument build needs the opposite, so the example ships `brighttest.instrument.json` (includes `main.brs`,
excludes `source/tests/**`). `rootDir` resolves against the **current directory**, so run from the app folder and pass
the config:

```bash
cd examples/sample-app
node ../../bin/cli.js instrument build --config brighttest.instrument.json
# -> .brighttest/instrument/app.bt-instrumented.zip
```

In your own project the same recipe is `npx brighttest instrument build --config brighttest.instrument.json`.

## What a build does

1. Builds to a **temporary** package path (`deploy` is never passed to brighterscript).
2. Runs the gates, in order. A failing gate means **no package is written** and the build never reaches a device:
   1. any plugin or brighterscript error diagnostic (`BT9001` reserved name, `BT9002` plugin order, `BT9003`
      staged output invalid, `BT9004` plugin reused, `BT9005` invalid net config, bsc errors);
   2. `BT9003 staged-output-invalid`: a rewritten file that no longer parses;
   3. with **strict** on, any report entry that counts as "could not instrument" (table below).
3. Only then moves the package to `--out`. An older package at `--out` is left untouched by a failed build.

stderr on failure has one line per blocking item and a final line:

```text
BT9003 staged-output-invalid source/net.brs:12 (bsc 1081, net)
strict: excluded-candidate source/vendor2/x.brs:2 file is in an excluded glob and contains setUrl/getUrl call sites ...
instrument build failed: 1 error(s), no package written
```

### Exit codes

| Code | Meaning |
|---|---|
| 0 | package written |
| 1 | build failure (brighterscript or plugin error, `BT9003`) |
| 2 | usage error |
| 3 | reserved for `instrument verify` (instrumentation found) |
| 4 | strict-mode failure: the build is valid but something could not be instrumented |

With `--sideload`, exit 1 also covers an authentication, port-80 or installer failure, and the device-lease codes apply
(75 busy or wait timeout, 77 lease lost, 78 lease directory problem).

### Sideloading the package

```sh
ROKU_PASSWORD=... npx brighttest instrument build --sideload --host 192.0.2.5
```

After a successful build, `--sideload` installs the package through the device's dev installer (port 80, Digest auth),
inside the device lease so it never collides with another brighttest lane on the same device.

- `--host` is required; the device is never guessed from the cache. The dev password comes from `ROKU_PASSWORD` (or
  `--host ip:password`, or the credential cache entry for that host). It is never printed.
- Port 80 is checked first; if it is closed, the command exits 1 and tells you to enable Developer Mode.
- If the installer reports a failure, the installed app is deleted and the install is retried once.
- Lease options: `--wait`, `--max`, `--expect`, `--as`, `--purpose` (same meaning as `brighttest device with`).
  The lease cannot be bypassed for this command.

## Release gate: `instrument verify`

```bash
npx brighttest instrument verify build/store.zip      # a zip or an unpacked directory
```

Exit **0** when the package is clean, **3** when any instrumentation marker is found (the markers and their paths are
printed to stderr), **2** on a missing or unreadable input. Run it in CI on the package you are about to publish.
`BT_AGENT=false` and the greenfield libraries (`BTStore`, `BTHttp`) are not markers.

The markers are, by `kind`: `manifest-key` (a `bt_instrumented` key in `manifest`), `bs-const` (`BT_AGENT=true` in
`bs_const`), `runtime-file` (any file under `source/bt/` or `components/bt/`), `component-xml` (`BT_Agent` in a component
XML) and `string` (`__bt_agent` or `__bt_boot` in a `.brs`, `.bs` or `.xml` file). Exit 2 covers a path that does not
exist, a file that is not a readable zip, and a missing argument.

## `BT_op` and the `m` layer

The build adds a `BT_op` function to the root of every instrumented component chain, so the agent can read and write
a component's own `m` (`layer: m` in `setState`; see [App state](../e2e/app-state.md)). Components that extend an
instrumented one inherit it, so no duplicate-function diagnostic appears. `BT_op` is on by default; `"instrument": {
"op": false }` turns it off. A user function named `BT_op` fails the build (`BT9001`).

## Census: `instrument census`

```bash
npx brighttest instrument census                       # markdown report to stdout
npx brighttest instrument census --json --out .brighttest/census   # JSON to stdout, census.json + census.md in the dir
npx brighttest instrument census --config path/to/brighttest.json     # read that config file instead of ./brighttest.json
```

A `brighttest.json` (or `--config` file) that is malformed, not a JSON object, or unreadable makes census exit 2 with a message on stderr; it is never treated as empty. `--config` with no value is a usage error (exit 2).

Census scans `source/` and `components/` under the `rootDir` from `brighttest.json` (the same root build and instrument use). Only when `brighttest.json` sets no `rootDir` does census fall back to the `rootDir` of a `bsconfig.json` in the project root (direct or through `extends`); that fallback is a census-only hint, because build and instrument do not read `bsconfig.json`. A `rootDir` or `extends` that resolves outside the project root is ignored, and a symlinked `source/`, `components/` or `manifest` that resolves outside it is not read and is reported as skipped, so census never reads outside the project root. A symlinked `manifest` is not read even when it points inside the root, and a folder named `.env*` under `source/` or `components/` is skipped.

A static scan of the app in the current directory (no device, no network, nothing in your tree is written unless
`--out` is given): Scenes, Tasks, `m.global.addFields` keys, registry section literals, `setUrl` and `CreateObject`
sites, and a "could not instrument" section. Inline-CDATA Scenes are reported only.

## Brownfield setup: `init --brownfield`

```bash
npx brighttest init --brownfield [--force]
```

For an existing app you do not want to edit. It runs the census, writes the `instrument` block into `brighttest.json`
(`strict: false`, and `state.registrySections` proposed from the registry sections the census found), and adds
`.brighttest/` and `*.bt-instrumented.zip` to `.gitignore`. It adds no example spec and no npm test script. An existing
`instrument` block is kept unless you pass `--force`.

## Greenfield setup: `init --greenfield`

```bash
npx brighttest init --greenfield [--force]
```

For an app you build with brighttest in mind. On top of the normal `init` scaffold it:

- copies `BTStore.brs` and `BTHttp.brs` into `source/brighttest/`. Each file starts with a version header line
  (`' brighttest-template: BTStore v1`). Specs under `source/` can call `BTStore_create` directly in the fast lane.
- adds `BT_AGENT=false` to `bs_const` in `manifest` (existing consts are kept; the name is matched case-insensitively,
  an existing `BT_AGENT` const is never duplicated or flipped, and CRLF line endings are preserved).

Scene and Task components include the files with a script tag:

```xml
<script type="text/brightscript" uri="pkg:/source/brighttest/BTStore.brs" />
<script type="text/brightscript" uri="pkg:/source/brighttest/BTHttp.brs" />
```

`examples/greenfield-app/` is a worked example of the result (see [Example apps](./examples)).

Re-running is safe: existing files are kept. `--force` refreshes only the two templates; it never overwrites
`brighttest.json` or `source/tests/Example.spec.bs`. It cannot be combined with `--brownfield`.

Current limitations (the full design is not implemented yet):

- The templates have no `#if BT_AGENT` branches, so they emit no `state.action` events and serve no `dispatch` or
  `restore` ops, and `BTHttp_url` is the identity function.
- `BTStore_dispatch` called from a Task thread does not reduce and returns `{}`; Tasks set `m.global.btAction` instead.
- `BTStore_replay` ignores `options.effects` (reducers only), and there is no `m.global.btEffect`.

## Configuration

`brighttest.json`, all optional. This block shows every top-level key of `instrument` with its default:

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
| `strict` | A "could not instrument" entry fails the build (exit 4). `--strict` / `--no-strict` override it per run. | `false` |
| `exclude` | Globs of files the plugin leaves alone (relative to `rootDir`). The default exclusions (Rooibos, `roku_modules`, vendor, specs) apply on top. | `[]` |
| `net` | `true` or `false` turns the `setUrl` / `getUrl` rewrite on or off. An object configures it: `unknown`, `receivers` (see below), plus the headless net keys `fixtures`, `unmatched`, `upstreamHosts`, `redact`, `observe`. Any other type is `BT9005`. | `true` |
| `scene` | Bootstrap every non-excluded Scene `init` and ship the state agent. `false` also drops the agent components. | `true` |
| `op` | Add the `BT_op` function to instrumented component chains (the `m` layer). | `true` |
| `hub` | `host` and `port` the device dials. Unset `host` uses this machine's LAN address (the literal `"auto"` is rejected). `port` is an integer 1 to 65535. | LAN address, `8790` |
| `state` | State agent settings: `registrySections`, `redact.paths`, `caps`, `publish.maxBytes`, `publish.intervalMs`, `callable`, `dispatch`, `tasks`. See [App state](../e2e/app-state.md) and "How the agent applies a write" below. A bad `redact`, `callable`, `dispatch`, `tasks` or `publish` value fails the build (exit 1) with a message naming the key; invalid `caps` values and `registrySections` entries fall back to defaults or are dropped. | `{}` |

`instrument.exclude` is the only spelling to use. A top-level `instrumentExclude` array is a deprecated alias that the config loader still merges into `instrument.exclude` (deduplicated), and `brighttest assess` lists it under `deprecatedKeys`; do not write it in new configs.

### What counts for strict

`strict` is **off** by default; `--strict` / `--no-strict` override it per run. The CI recipe turns it on:

```yaml
- run: npx brighttest instrument build --strict --out .brighttest/debug.bt-instrumented.zip   # exit 4 = policy, exit 1 = broken build
```

| Report entry (`kind`) | Fails strict |
|---|---|
| `excluded-candidate` in a file **you** excluded | yes |
| `excluded-candidate` in a default-excluded path (`source/rooibos/**`, `source/vendor/**`, `roku_modules/**`, specs, ...) | no, informational |
| `empty-init`, `inline-cdata-scene`, `unknown-scene-subtype`, `init-in-excluded-file`, `init-shared-with-excluded-scene` (via import or via `extends`) | yes |
| `indexed-seturl`, `indexed-geturl`, `bare-geturl`, `xml-parse-failed` | yes |
| `net-receiver-unknown` (only emitted with `net.unknown: "report"`) | yes |
| `wrap-target-unknown` (a `state.dispatch` or `state.tasks` name that matches nothing, or a dispatch function used as a value) | yes |
| `rewritten-shared-with-excluded`, `net-receiver-excluded`, `callfunc-seturl`, `net-render-thread` | no, informational |
| anything not listed | yes (fail closed) |

`--verbose` lists the informational entries of a successful build.

### `setUrl` and `getUrl` rewrites

The plugin rewrites `setUrl(url)` (one argument) and `getUrl()` calls so the URL goes through the hub. The member name is
the gate; the receiver is then classified from static evidence in the same function or file as `confirmed`
(the receiver is assigned from `CreateObject("roUrlTransfer")`), `likely` (declared `as roUrlTransfer`, or a name such as
`xfer`, `transfer`, `http`, `req`, `request`), `unknown` or `excluded` (a receiver of another type). Confirmed, likely
and unknown sites are rewritten; excluded ones are left alone and reported as the informational `net-receiver-excluded`.
`getUrl` follows the `setUrl` of the same receiver in the same function. Two settings tune this:

```json
{ "instrument": { "net": { "unknown": "report", "receivers": { "allow": ["**/api.brs#client"], "deny": ["m.cache*"] } } } }
```

- `unknown`: `"rewrite"` (default) rewrites unknown receivers; `"report"` skips them and records `net-receiver-unknown`
  (this fails strict).
- `receivers.allow` / `receivers.deny`: arrays of `<receiver glob>` or `<file glob>#<receiver glob>`. Receiver text is
  matched lower-case. An allow match overrides `excluded`; deny wins over allow. In a file glob `*` does not cross `/`, so
  write `**/name.brs#x` to match below a folder.
- Not rewritten, and reported: an indexed member call (`x["setUrl"](url)`, kinds `indexed-seturl` / `indexed-geturl`) and a
  `getUrl()` used as a bare statement, whose result is discarded (`bare-geturl`); these fail strict. `callFunc("setUrl", url)` is
  informational (`callfunc-seturl`).
- `setUrl` in an **inline CDATA** `<script>` is invisible to brighterscript, so it is neither rewritten nor reported by the
  build; only the census lists it. An inline-CDATA **Scene** is reported as `inline-cdata-scene` (fails strict) and is not
  bootstrapped.

### Media URLs

`BT_url(url)` routes a media URL (a stream or image URL that a node fetches itself) through the hub. You write the call
by hand, because the plugin only rewrites `setUrl` and `getUrl` on `roUrlTransfer`.

- **Wrap the call in a Task.** On the render thread `BT_url` is the identity on device: `roUrlTransfer` is not available
  there on some firmware, so the first-use hello fails and the URL comes back unchanged. Resolve the URL in a Task and
  hand the result to the node through a field.
- **Guard it with `#if BT_AGENT` and set `BT_AGENT=false` in `bs_const`.** `BT_url` exists only in the instrumented build,
  so an unguarded call does not compile in a production build.
- **The limit.** A call in a Scene or any other component that does not extend `Task` is a no-op on device. The build
  reports it as the informational `net-render-thread` entry (file, line and the hint "render-thread BT_url is the identity
  on device; wrap the URL in a Task"); for a Task it reports calls in `init` and in `observeField` callbacks it
  registers (best effort). It never fails strict. Calls the plugin inserts itself are not reported.
- **Failed hello.** A failed hello is cached for 30 s and retried, with one console line per retry.

## Headless network fixtures: flags, config and run records

The headless test lanes (`brighttest`, `brighttest --coverage`, the scene lanes) can route the app's `roUrlTransfer`
traffic through an in-process proxy that serves mocks and fixtures. It switches on when any of these is present: a
`--net-record` or `--net-unmatched` flag, `instrument.net` set to `true` or to an object with a `fixtures`, `unmatched`,
`upstreamHosts` or `redact` key, or a `*.spec.bs` file that mentions `BTNet_*`. Without them a headless run is unchanged.

### `--net-record [file]`

Passes requests that no rule matches through to the hosts listed in `instrument.net.upstreamHosts` and records those
passthrough exchanges to a HAR file (redacted by `instrument.net.redact`). Mocked, fixture, fault and refused requests are
not recorded. The default path is `<stagingDir>/net/<run>.har` (`.brighttest/net/<timestamp>.har`); pass a path
(`--net-record out.har` or `--net-record=out.har`) to choose another. Recording implies `unmatched: "passthrough"` unless you
set a policy. It refuses to start without `upstreamHosts` (exit 2, `net: net.record requires net.upstreamHosts ...`). Output:

```
[brighttest] net: recording passthrough traffic to /path/to/project/.brighttest/net/2026-01-01T00-00-00-000Z.har; upstream hosts: api.example.test
[brighttest] net: recorded 3 request(s) to /path/to/project/.brighttest/net/2026-01-01T00-00-00-000Z.har
```

### `--net-unmatched <fail|passthrough>`

Sets what happens to a request that no rule matches (`--net-unmatched=passthrough` also works). `fail` answers the app
with HTTP 599 and a hint body, and records a `net.error` of kind `unmatched`. `passthrough` sends it upstream, but only to
`upstreamHosts` (anything else is refused with 403 and a `net.error` of kind `upstream`). Precedence: the flag, then
`instrument.net.unmatched`, then `passthrough` when recording, then `fail` once any rule config (a fixture file) is loaded, and
`passthrough` otherwise. Any other value exits 2 (`--net-unmatched must be "fail" or "passthrough"`).

The flag does not change the exit code by itself: the app sees the 599, so a spec that depends on the call fails in the
usual way. At the end of the run the failing requests are printed, up to 20, and the rest are in the NDJSON file:

```
  Network failures (1)
    unmatched: GET http://api.example.test/v1/items
```

Both flags apply to the headless lanes only; with `--device` or `--cross-check` they exit 2
(`--net-record / --net-unmatched apply to the headless lanes only ...`).

### `instrument.net.observe`

```json
{ "instrument": { "net": { "observe": true } } }
```

Observe-only mode for builds whose traffic cannot go through the hub. The instrumented build never contacts the hub and
never rewrites a URL; it prints one line per URL set on a transfer to the 8085 console:
`[bt:net] url=https://api.example.test/v1/home?`. The query, fragment and `user:password@` are dropped (a trailing `?`
marks a query); path segments are printed as they are. Mocks, faults and fixtures do nothing in such a build. Any value
other than `true` leaves the mode off. See the [network recipe](./network-recipe).

### `instrument.net.fixtures`

```json
{ "instrument": { "net": { "fixtures": ["fixtures/net/*.json", "fixtures/extra/**/*.har"], "upstreamHosts": ["api.example.test"] } } }
```

An array of glob strings (`*`, `**`, `?`), each resolved relative to the project root (the directory of `brighttest.json`).
Each pattern's matches are sorted and patterns load in the order declared, so earlier rule files are added first. Absolute
patterns, patterns containing `..`, and files that resolve (through symlinks) outside the project root are rejected. The
`node_modules`, `.git` and `.brighttest` directories are not searched. A pattern that matches no file, or a value that is
not an array of strings, is an error: the run prints `[brighttest] net: instrument.net.fixtures pattern "<glob>" matched no
files` and exits 2 before any test runs.

### Run NDJSON

Every net run writes `<stagingDir>/net/last-run.ndjson` (`.brighttest/net/last-run.ndjson`), one JSON object per line,
overwritten each run, with URLs and headers redacted. Fields on every line: `v` (always 1), `ts` (ISO time), `kind`, and
`data`, which always carries `lane: "headless"`.

| `kind` | `data` fields |
|---|---|
| `net.request` | `id`, `method`, `url`, `headers`, `rule` (matched rule id or `null`), `bodyRef` (optional) |
| `net.response` | `id`, `status`, `headers`, `bytes`, `source` (`mock`, `fixture`, `passthrough`), `timings` (`wait`, `receive`), `bodyRef` (optional) |
| `net.error` | `id`, `kind` (`unmatched`, `upstream`, `fault:reset`, `fault:timeout`), `detail`, `refused` (only on refused passthrough) |

```json
{"v":1,"ts":"2026-01-01T00:00:00.000Z","kind":"net.request","data":{"id":"r-1","method":"GET","url":"http://api.example.test/v1/items","headers":{},"rule":null,"lane":"headless"}}
{"v":1,"ts":"2026-01-01T00:00:00.050Z","kind":"net.error","data":{"id":"r-1","kind":"unmatched","detail":"GET http://api.example.test/v1/items","lane":"headless"}}
```

### `BTNet_` specs are skipped on `--device`

On the device lane (`--device`, and the device leg of `--cross-check`), every `*.spec.bs` file under the project root whose
text matches `\bBTNet_\w+` is excluded from the build, and each one prints
`[brighttest] skipped (headless-only network fixtures): <path>`. The scan skips `node_modules`, `.brighttest`, `.git` and
`out`. It works per file, not per suite, so keep `BTNet_` calls in their own spec files. `--cross-check` reports their
suites as `headless-only`, not as a divergence.

## The LAN hub on a device, and `doctor`

The hub that headless runs start on loopback also has a LAN form for a real device. It is tied to the device lease, with
no second lease:

- `e2e run` starts it for a host only after that host's lease is held, binds all interfaces, and stops it before it
  releases the lease. If the lease is lost or expires, the hub stops itself. A run with the lease bypassed gets no hub.
  It is opt-in for now (`net` in the config).
- It answers only the leased device's IP (and only a private LAN address). Any other peer gets a bare `404`, and the run
  prints one line per peer: `[brighttest hub] refused a request from <ip>: the hub for <device> answers only that device`.
  A second session asking for the same device's hub in the same process is refused (`PEER_LOCKED`) and the first hub is
  not touched.
- `brighttest doctor --host <ip>` adds a `hub-bind` check: it opens and closes a TCP listener on all interfaces. It
  proves only that this machine can listen. A failed bind prints its own `fix:` line. The ECP fix texts are unchanged.

By default doctor does **not** prove the device can reach the hub (a firewall or Wi-Fi isolation can still block it) and
says so: `hub reach: not tested (set BRIGHTTEST_DOCTOR_HUB_PROBE=1 and ROKU_PASSWORD; replaces the dev channel)`.

### Proving device-to-hub reach: `BRIGHTTEST_DOCTOR_HUB_PROBE=1`

```
export ROKU_PASSWORD=<dev password>
BRIGHTTEST_DOCTOR_HUB_PROBE=1 brighttest doctor --host <ip>
```

This opt-in probe **replaces the app in the device's dev channel slot** with a tiny `brighttest hub probe` channel, reads
`ROKU_PASSWORD`, and takes the device lease (re-entrant under `brighttest device with`). The probe channel asks this
machine's LAN address on the hub port (8790) for a one-off URL, and a short-lived listener checks that the request came
from the device. Afterwards doctor presses Home and prints `dev channel now holds the brighttest probe; re-sideload your
app`. It uses the default port and the detected LAN address; `brighttest.json` is not read.

The `hub reach` result is one of:

| State | Meaning | Check and exit |
|---|---|---|
| `reached` | the device's request arrived | `hub-reach` passes |
| `not-reached` | probe installed and running, no request arrived within 15 s | `hub-reach` fails with a `fix:` line, exit 1 |
| `not-tested` | the probe did not run or could not finish | no check, exit unchanged |

`not-tested` carries a reason (`--json`: `hub.reachReason`): `not-requested`, `device-unreachable`, `developer-disabled`,
`no-password`, `port-busy` (something already listens on the hub port), `lease-busy`, `sideload-failed`. `--json` also
carries `hub.reach` and `hub.reachProven` (true only for `reached`). The `not-reached` fix: allow inbound TCP on the hub
port for node in the local firewall, keep this machine and the device on the same network without Wi-Fi client or guest
isolation, make sure no VPN captures the LAN route, and set `instrument.hub.host` when the machine has several
interfaces. Doctor never changes any of these settings.

### The hub token: `--net` and `BRIGHTTEST_HUB_TOKEN`

`instrument build --net` bakes a hub token into the package, and the e2e run's hub accepts only that token. You choose the
token with the `BRIGHTTEST_HUB_TOKEN` environment variable.

```
export BRIGHTTEST_HUB_TOKEN=<32 lowercase hex characters>
brighttest instrument build --net --sideload
brighttest e2e run ...   # same shell, same value
```

- The value must be exactly 32 lowercase hex characters. With `--net`, a missing or malformed value stops the build
  (exit 1): `instrument build --net needs a hub token: set BRIGHTTEST_HUB_TOKEN to 32 lowercase hex characters (the e2e run's hub accepts the same value)`.
- Export the same value for the `e2e run` that uses network steps. A build and a run with different values do not match.
- The build bakes the value in. After you change it, rebuild and sideload again; an installed build keeps its old token.
- The token is a secret. Keep it out of the repository, `brighttest.json`, flow files and logs; set it in your shell or CI
  secret store.

## Network steps in e2e flows

A flow can mock and check the app's HTTP traffic on a device. The steps need an instrumented build
(`brighttest instrument build --net --sideload`) and the LAN hub above; `e2e run` starts the hub (and its proxy) inside the
host's lease when a flow uses any of them or sets `config.net`.

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

- `mockHttp` takes the same rule keys as the headless `BTNet_` rules (`status`, `file`, `json`, `body`, `headers`, `responses`,
  `fault`, `delayMs`, `times`, `reqHeaders`, `reqBody`). `file:` is relative to the project root and confined to it.
- `waitForRequest` polls the request log (seconds; default is the flow `timeout`). `assertRequest` passes when the number of
  matching requests is `count` (default: at least one). Both read the hub's log in-process, so they cost no ECP traffic.
  Both match on `method`, `url` (glob), `status` and `bodyContains` (request body).
  A miss says what was expected, what was seen, and lists up to five logged `METHOD /path` lines (no queries, headers or bodies).
- `clearHttp` drops this flow's rules and hides the log so far. Rules and fixtures a flow adds are dropped when it ends, and a
  flow never sees an earlier flow's requests.
- `recordHttp: { file }` opens a recording window on the proxy and `recordHttp: stop` closes it and writes the HAR (redacted,
  same format as before). Only passthrough exchanges that begin after the start and finish before the stop are kept; traffic
  before, after or in flight across the edges is not. An open recording is closed and written when the flow ends, so it
  never stays on after a failed step. The window buffer is bounded (500 exchanges / 64 MB); past that, `stop` fails with a
  "recording buffer overflow" error and nothing is written. It refuses without `config.net.upstreamHosts`.
- `config.net` keys: `fixtures` (list of files in the project root, flow-scoped), `unmatched` (`fail` | `passthrough`; default
  `fail` when fixtures are listed, else `passthrough`), `upstreamHosts`, `record`, `redact`. A bad value is a flow parse error.
- **Fail fast.** A flow with network steps and no hub (lease bypassed, hub failed to start) fails before the device is touched.
  On a build that is not instrumented, the run fails right after `launch` (within 5 s) with
  ``no agent.hello/BT_url handshake seen: build with `brighttest instrument build --net` `` instead of waiting for step timeouts.

## Hub state routes

The hub also carries host-side state writes and relays them to the agent. Same token, peer and lease rules as the other
routes: a wrong token or peer is a bare `404`, a lost lease is `423`, a wrong `?session=` is `409 {resync}`.

| Method and path | Purpose |
|---|---|
| `POST /bt/<token>/state` | Queue one command `{op, args, ack?}` (`ack` is `applied`, the default, or `reflected`). `202 {id, seq, session}`. A body over 64 KB is `413 {error: "STATE_TOO_LARGE"}`, never truncated; a bad op or body is `400 {error: "BAD_COMMAND"}`. |
| `GET /bt/<token>/state[?id=<cmd id>]` | Command status (`pending`, `done`, `failed`, `timeout`, `abandoned`), gaps, and the last redacted `state.snapshot`. Open commands time out on a hub timer and when this is read. |

### How the agent applies a write

The agent's Task says hello, keeps one `GET /bt/<token>/cmd?after=<seq>&session=<id>` long-poll open (`200` commands,
`204` idle, `409 {resync}`) and the render-thread agent applies the commands in seq order. It answers with `cmd.ack`
events on `POST /bt/<token>/events`: `received`, then `applied` (with `ok`, `result` or an `error` such as
`TYPE_MISMATCH: field count holds a number; got a string`), then `reflected` once the `__bt_agent` Label was
republished (only when the command asked for `ack: reflected`). A session mismatch is `409` and nothing is replayed.

- Ops: `ping`, `get`, `set`, `merge`, `snapshot`, `restore`, `registry.read`, `registry.write`, `callFunc`, `subscribe`.
  `focus` focuses the node `args.node.id` (`NODE_NOT_FOUND` when no node has that id). `dispatch` is allowed hub-side;
  the BTStore dispatch op belongs to the greenfield store (not built yet), the wrap below is the app-side route. Any other op
  answers `op not allowed`. There is no file system op and no registry delete.
- Dispatch events and Task snapshots (config `instrument.state.dispatch` and `instrument.state.tasks`, see below).
- `instrument.state.dispatch: ["fn"]` wraps each non-excluded function with that name: the build renames the original to
  `__bt_orig_<fn>` and appends a wrapper with the original name and parameters (defaulted parameters keep their default
  expression, so omitting an argument behaves as before). Around each call the wrapper hashes the global fields and
  publishes a `state.action` event with `type` and `payload` (first argument, when it is an object), `hashBefore` and
  `hashAfter`. Limitation: the wrapper is a plain function, so a target used as a value (`store = { dispatch: fn }`,
  then `store.dispatch(a)`) would lose its `m` binding. Such a target is not wrapped and is reported as
  `wrap-target-unknown` (it trips `strict`); wrap a function that is called by name. The payload is masked by key name
  on the device; `redact.paths` is applied host-side only.
  Actions that Tasks send through `m.global.btAction` reach `BTStore_onAction` and `BTStore_dispatch` directly and skip
  `AppStore.dispatch`, so the wrap does not log them; `AppStore.dispatch` is the entry point the log sees.
  Defaults are copied as written, so in a `.bs` file only plain-literal defaults (and empty `{}` / `[]`) are wrapped; a
  function whose default uses an enum, const, namespace, template string or call is reported as `wrap-target-unknown`.
  A wrapper that cannot be built is reported the same way and the function stays unwrapped.
  Hash limits: the hash is a CRC32 of the serialized global fields, so a change to a masked secret-looking key, or to
  content beyond the serializer caps (depth, array items, string length), does not change `hashBefore`/`hashAfter`. Its
  cost (two global serializations per dispatch) was measured on a device: about 10 ms per dispatch with a
  normal global, about 118 ms with 516 global fields. The hash covers `m.global` fields only: an app whose store state
  lives outside `m.global` (a scene or node `m`, module variables) shows equal `hashBefore` and `hashAfter` for every
  action. On a device the event keys arrive lowercased (`hashbefore`, `hashafter`); Studio accepts both spellings and
  shows camelCase. `payload` is read only under that key: an app that passes the data under another key (for example
  `value`) shows a null payload.
- `instrument.state.tasks: ["TaskComponent"]` wraps the Task's entry function (the name assigned with
  `m.top.functionName = "..."` in `init`) and publishes the Task's `m` at entry and exit under the `task` layer
  (the Studio layer view hides these fields, but `get --layer global` does return the raw `__btEv` and `__btTask_*`
  fields). There is no automatic timer snapshot, because a Task blocked in
  `wait` cannot be interrupted; an app that wants mid-run snapshots calls `BT_taskSnap(m.global, "<name>", "timer", m)`.
  Rules for that manual call: put it inside `#if BT_AGENT` ... `#end if` and set `BT_AGENT=false` in the manifest
  `bs_const`, because `BT_taskSnap` exists only in the instrumented build and a production build would not compile
  without the guard. A long-lived Task whose entry function never returns gets the `entry` snapshot only; `exit` is
  published when the entry function returns. Each call serializes the Task's `m` with the caps and sets a global field
  (a render-thread rendezvous), so call it at most about once per second, never per message in a hot loop.
- Studio action log, time travel and fixtures (routes under `/api/state/`, all behind the device lease: a write while
  another agent holds it answers `423 LOCKED`).
  - `GET /api/state/actions[?raw=1]` lists the `state.action` events, oldest first: `entry` (log seq), `ts`, `source`,
    `type`, `payload` (masked unless `raw=1`), `hashBefore`, `hashAfter`, `changed` and `snapshot` (null until recorded).
  - `POST /api/state/actions {"action":"record"}` snapshots the live state onto the newest entry (`act-<seq>`); an older
    `entry` answers `409 STALE_ENTRY`, an empty log `404 NOT_FOUND`.
  - `POST /api/state/actions {"action":"travel","entry":<n>}` restores the snapshot recorded on that entry (202). An
    unknown entry answers `404 NOT_FOUND`, an entry with no snapshot `409 NO_SNAPSHOT`. Only state is restored; network
    calls, registry writes and Task effects are not undone.
  - `GET /api/state/fixtures` lists `fixtures/state/*.json` under the project root. `POST /api/state/fixtures
    {"action":"save","name":"n","snapshot":"s","raw":false}` writes a stored snapshot (masked unless `raw` is true);
    `{"action":"load","name":"n"}` reads one back into the snapshot store (`404` when missing, `400` for an unknown
    layer or bad name). File format: `{"v":1,"name":"n","layers":{...}}`.
- Layers: `global`, `scene`, `node` (`node: {id}`), and `registry` for `get`. `set` is type-checked against the
  current value, never writes below a node reference (`PATH_UNDER_NODE`), and a field a node does not have is
  `FIELD_NOT_FOUND` (only `global` creates fields). A refused write leaves the app running.
- Registry writes go to `instrument.state.registrySections` only, and are flushed. `callFunc` runs only the names in
  the config's `callFuncAllow` list, which the build writes from `instrument.state.callable` (empty by default; see
  [app state](../e2e/app-state.md)).
- `snapshot {name}` stores the layers host-side; `restore {name}` writes them back. Restore is best effort: values that
  were cut, redacted (`<redacted:...>`) or are node references are skipped and listed, fields added after the snapshot
  are listed in `added` and left in place, and an object field comes back whole.
- Payloads over 64 KB, in a command or in a result, fail with `STATE_TOO_LARGE` and are never truncated.
- With a live hub session and no `subscribe`r the agent samples every 5 s (ten times `publish.intervalMs`); subscribed,
  or with no hub, it samples every `publish.intervalMs` (500 ms by default).

Agent `cmd.ack` events on `POST events` complete commands. Queued commands are logged as `cmd.sent` events with values
under sensitive keys (and `instrument.state.redact.paths`) masked before they reach `events.ndjson`.

### ECP `/input` mailbox fallback

When no hub is reachable, a host can still send a command through the device's ECP `POST /input` endpoint:
`device.input(command, { token })` in `lib/e2e/ecp.js`. The agent's `roInput` receiver reassembles the command and applies
it through the same op allow-list as the hub path.

- **Token.** Every chunk carries `tk=<token>`, the per-build hub token baked at build time (see
  [the hub token](#the-hub-token-net-and-brighttest-hub-token)). The agent compares it in constant time and drops a
  chunk with a wrong or missing token silently: no ack, no state. `tk` is the secret hub token itself, sent in the clear in
  the request line, so an app must never log or forward unknown `roInput` or deep-link keys (the debug console on port
  8085 is readable on the LAN). The mailbox works only with a `--net` build and `BRIGHTTEST_HUB_TOKEN` set: a build
  without `--net` bakes a random token that is never printed, so `device.input` cannot authenticate. The caller must supply the token (`{ token }` or
  `createDevice({ hubToken })`); `input()` refuses to send without one.
- **No hub session.** The agent accepts mailbox commands only while no hub session is live; with a live hub, use the
  hub routes. A mailbox command has no hub `seq` and no ack channel, so the agent does not queue acks for it. The last
  mailbox result `{ id, phase, ok }` (phase `applied` or `reflected`) is published in the `__bt_agent` Label as `input`.
- **Limits.** Each request carries at most 3,500 percent-encoded characters (the device refuses a request line over
  4,082), no body, and is spaced 220 ms from the previous one. A command takes at most 64 chunks. The receiver joins
  chunks by `seq`, ignores a repeated chunk or an already-applied chunk id (the last 32 are remembered), never runs a
  partial command, and drops an incomplete sequence after 10 s without a new chunk. At most 8 sequences are kept; a new
  one evicts the oldest.
- **The app's own `roInput` also receives these events.** The `bt`, `tk`, `s`, `n` and `d` keys arrive in the app's
  `roInput` like any deep-link parameter, so a handler there must ignore keys it does not know.

## Rules to know

- **Single build.** One build uses one fresh `Program` and one plugin instance. There is no watch mode; reusing a plugin
  instance for a second Program is the error `BT9004 plugin-reused`.
- **Plugin order.** The instrument plugin must run **after** the Rooibos coverage plugin, otherwise Scene `init` lines
  drop out of coverage (`BT9002`). Plugins after it may edit function bodies; their edits are kept.
- **Scene `init`.** Rewritten as `sub init() : BT_bootstrap(m.top)` with the original body on the following lines. A Scene
  excluded by you that extends an instrumented Scene stops that base `init` from being wrapped
  (`init-shared-with-excluded-scene`, `via: "extends"`); un-exclude the child to bootstrap the base.
- **`setUrl` in inline CDATA scripts** is invisible to brighterscript, so the plugin cannot rewrite or report it. Only the
  census lists it (a census-only section). `callFunc("setUrl", url)` is reported as the informational `callfunc-seturl`
  and is never rewritten (it cannot work on a real `roUrlTransfer`).
- **Line numbers** of rewritten files are not the source's; map crash lines before you read them.
