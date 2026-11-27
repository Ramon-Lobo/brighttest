# 10. Global context (seeding)

::: info At a glance
**What it is for:** giving an `@SGNode` widget the global app context (`config`, `user`, theme, translations) it reads
in `init()`, so it constructs on a real Roku as it does in the app.

**You will:**
- spot the crash that means "seed me"
- add `globalFields` to `brighttest.json`
- reclaim a device-only widget suite
- scope seeds per suite so they do not leak

**First file:** `brighttest.json` (`globalFields`)
:::

## The problem

In a real app the scene carries globals. In a bare `@SGNode` test it does not, so reads return `invalid`.

| Lane | Reading `invalid` globals |
|---|---|
| Headless brs-node | shrugs it off |
| Real Roku | strict: the widget crashes while constructing |

That mismatch is a top reason a widget spec is green headless yet device-only. **Global-field seeding** hands the
declared globals to the test scene *before* the widget is built.

## When you need it

On `--device` or `--cross-check`, while a widget suite constructs, you see:

```
'Dot' Operator attempted with invalid BrightScript Component ... (runtime error &hec)
Type Mismatch. Operator "+" can't be applied to "Invalid" and "String". (runtime error &h18)
```

…and the same suite passes headless. The widget read `config.something` and `config` was `invalid`.

::: tip
Pure-logic and model suites never need this. Seed only when an **`@SGNode`** widget reads global context during
`init()`/render.
:::

## The `globalFields` option

Keyed by `@SGNode` type name, with `"*"` for values applied to every suite.

```json
{
  "sourceGlobs": ["manifest", "source/**/*", "components/**/*"],
  "globalFields": {
    "*":        { "config": null },
    "EpgTile":  { "config": { "images": { "staticBaseUrl": "https://img.example.com" } } },
    "PosterRow":{ "config": { "images": { "staticBaseUrl": "https://img.example.com" } } }
  }
}
```

| Rule | Detail |
|---|---|
| Top-level keys | `@SGNode` types (what you wrote in `@SGNode("EpgTile")`). |
| Values | `{ fieldName: value }` maps set as **scene fields**, so `getGlobalField("config")` returns them. |
| Order | `"*"` applies to every suite **first**; the per-type entry applies **after** (it overrides). |
| `null` | **Resets a field to `invalid`.** Put fields in `"*"` as `null` for a clean baseline, so one suite's `config` does not leak into the next. |

That is the whole API.

## Tutorial: reclaiming a crashing widget

Bring a device-only `EpgTile` suite back.

1. **Confirm the crash.** Run just that suite on the device:

   ```sh
   brighttest --device --host $ROKU_IP --password $ROKU_PW --config epg-only.json
   ```

   ```
   ... (runtime error &hec) in pkg:/components/shared/utils.brs(88)
   ```

2. **Find what the widget reads.** Open the backtrace file/line. `getImageUrl` does:

   ```brightscript
   unscaledImageEndpoint = config.images.staticBaseUrl + "/base/"
   ```

   It needs the **nested** `config.images.staticBaseUrl`. `config = {}` is not enough: `{}.images` is still
   `invalid`. Read the real code, not a guess; chained access means seed the whole path.

3. **Seed it** in `brighttest.json`:

   ```json
   "globalFields": {
     "*":       { "config": null },
     "EpgTile": { "config": { "images": { "staticBaseUrl": "https://img.example.com",
                                          "thumbnailBaseUrl": "https://thumbs.example.com;" } } }
   }
   ```

4. **Verify.** Cross-check; both lanes should agree:

   ```sh
   brighttest --cross-check --host $ROKU_IP --password $ROKU_PW --config epg-only.json
   ```

   ```
   DIVERGENT : 0
   ✓ No divergence. Headless results match the device for all N shared tests.
   ```

5. **Reclaim.** Move the spec from your device-only folder into the main suite. It now runs in the default
   cross-lane-green suite.

## Why per-suite scoping matters

One shared seed can fix one suite and break another.

`EpgTile` needs `config`; `VideoTooltip`'s assertions assume `config = invalid`. Keyed entries plus the `"*"` reset let
both coexist:

```json
"globalFields": {
  "*":            { "config": null },                         // every suite starts with config = invalid
  "EpgTile":      { "config": { "images": { … } } },          // EpgTile gets a real config
  "VideoTooltip": { }                                          // inherits "*" → config stays invalid
}
```

`VideoTooltip` needs no entry: omitting it, or `{}`, keeps the `"*"` baseline.

## How it works

::: warning Requires the patched rooibos (default)
Patch `ROO-04` of `@ramonlobo/rooibos-roku` applies `globalFields`; brighttest uses it by default. On stock
`rooibos-roku` the seed file is ignored: one `lacks ROO-04` warning per run, and a seeded widget still reads `invalid`.
See [Engines and patches](/guide/engines#patches-stock-rooibos-lacks).
:::

1. brighttest writes `globalFields` to `pkg:/rooibos_global_seed.json` and injects it into the built channel (a
   build-time file entry; **your app source is never modified**).
2. Rooibos reads it at startup and, **before creating each `@SGNode` node**, applies `"*"` then that node's entry to
   the test scene.
3. The widget's `init()` runs and `getGlobalField(x)` (which reads `scene.getField(x)`) returns your value.

## Gotchas

| Gotcha | What to do |
|---|---|
| **Seed the exact path the code reads.** | A `&h18` "Type Mismatch … Invalid and String" after a `&hec` usually means you seeded one level and the code went deeper. Re-read the backtrace. |
| **Values are JSON.** | Seed associative arrays, arrays, strings, numbers, booleans and `null` (→ `invalid`). Not a live node or function. |
| **Only global-context crashes.** | A grid throwing *"No itemComponentName defined"* (`&h28`) needs content/`itemComponentName` on the node, not a global. |
| **"Agree" ≠ "pass".** | `--cross-check` reports `agree` when both lanes match, including both failing. Before reclaiming, confirm the suite **passes** in the default lane. |

## Related

- [SceneGraph & async tests](/writing-tests/scenegraph-async): writing `@SGNode` suites
- [Headless vs device](/writing-tests/headless-vs-device): cross-check and `@deviceOnly`
- [State fixtures](/writing-tests/state-fixtures): seed `m.global` from a captured snapshot
- [Engines and patches](/guide/engines#patches-stock-rooibos-lacks): what stock rooibos lacks

**Full guide:** [Global context](full:/writing-tests/global-context) — the original wording.
