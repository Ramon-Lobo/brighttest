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
npx brighttest instrument build --out build/debug.zip --strict
```

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
`BT_AGENT=false` and the greenfield libraries are not markers.

## Census: `instrument census`

```bash
npx brighttest instrument census                       # markdown report to stdout
npx brighttest instrument census --json --out .brighttest/census   # JSON to stdout, census.json + census.md in the dir
```

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

## Configuration

`brighttest.json`, all optional:

```json
{
  "instrument": {
    "strict": false,
    "exclude": ["source/vendor/**"],
    "net": true,
    "scene": true,
    "op": true,
    "hub": { "host": "auto", "port": 8790 }
  }
}
```

`strict` is **off** by default; `--strict` / `--no-strict` override it per run. The CI recipe turns it on:

```yaml
- run: npx brighttest instrument build --strict --out build/debug.zip   # exit 4 = policy, exit 1 = broken build
```

### What counts for strict

| Report entry (`kind`) | Fails strict |
|---|---|
| `excluded-candidate` in a file **you** excluded | yes |
| `excluded-candidate` in a default-excluded path (`source/rooibos/**`, `source/vendor/**`, `roku_modules/**`, specs, ...) | no, informational |
| `empty-init`, `inline-cdata-scene`, `unknown-scene-subtype`, `init-in-excluded-file`, `init-shared-with-excluded-scene` (via import or via `extends`) | yes |
| `indexed-seturl`, `indexed-geturl`, `bare-geturl`, `xml-parse-failed` | yes |
| `net-receiver-unknown` (only emitted with `net.unknown: "report"`) | yes |
| `rewritten-shared-with-excluded`, `net-receiver-excluded`, `callfunc-seturl` | no, informational |
| anything not listed | yes (fail closed) |

`--verbose` lists the informational entries of a successful build.

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
