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
