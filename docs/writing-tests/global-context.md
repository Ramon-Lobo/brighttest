# 10. Global context (seeding)

Some SceneGraph widgets read **global app context** — `config`, `user`, theme, translations — from the
scene during `init()`. In a real app the scene carries those globals; in a bare `@SGNode` test it doesn't,
so the reads come back `invalid`. Headless brs-node shrugs that off, but a **real Roku is strict** and the
widget crashes while constructing. That mismatch is a top reason a widget spec is green headless yet
device-only.

**Global-field seeding** fixes it: you declare the globals a suite needs, roku-test hands them to the test
scene *before* the widget is built, and the widget constructs exactly as it would in-app.

## When you need it

You'll see one of these on `--device` or `--cross-check` while a widget suite constructs:

```
'Dot' Operator attempted with invalid BrightScript Component ... (runtime error &hec)
Type Mismatch. Operator "+" can't be applied to "Invalid" and "String". (runtime error &h18)
```

…and the same suite passes headless. The widget read `config.something` (or similar) and `config` was
`invalid`. That's the signal to seed.

> Pure-logic and model suites never need this. Reach for seeding only when a **`@SGNode`** widget reads
> global context during `init()`/render.

## The `globalFields` option

Add `globalFields` to your `roku-test.json`. It's **keyed by `@SGNode` type name**, with a special `"*"`
key for values applied to *every* suite:

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

- Top-level keys are `@SGNode` types (what you wrote in `@SGNode("EpgTile")`).
- Values are `{ fieldName: value }` maps set as **scene fields** — so a widget's
  `getGlobalField("config")` returns them.
- `"*"` is applied to every suite **first**; the per-type entry is applied **after** (it overrides).
- **`null` resets a field to `invalid`.** Put your fields in `"*"` as `null` so every suite starts from a
  clean baseline; then only the suites that need a value declare it. This is what keeps one suite's
  `config` from leaking into the next.

That's the whole API. Everything below is how to use it well.

## Tutorial: reclaiming a crashing widget

Say `EpgTile` is quarantined as device-only. Let's bring it back.

**1. Confirm the crash and read the error.** Run just that suite against the device:

```sh
roku-test --device --host $ROKU_IP --password $ROKU_PW --config epg-only.json
```

```
... (runtime error &hec) in pkg:/components/shared/utils.brs(88)
```

**2. Find what the widget reads.** Open the file/line from the backtrace. Here `getImageUrl` does:

```brightscript
unscaledImageEndpoint = config.images.staticBaseUrl + "/base/"
```

So it needs `config.images.staticBaseUrl` — a **nested** value. Seeding `config = {}` isn't enough;
`{}.images` is still `invalid`. Seed the actual path.

> **Read the real code, not a guess.** The crash tells you the exact field. Chained access
> (`config.images.staticBaseUrl`) means you must seed the whole path.

**3. Seed it.** In `roku-test.json`:

```json
"globalFields": {
  "*":       { "config": null },
  "EpgTile": { "config": { "images": { "staticBaseUrl": "https://img.example.com",
                                       "thumbnailBaseUrl": "https://thumbs.example.com;" } } }
}
```

**4. Verify.** Cross-check the suite — headless and device should now agree:

```sh
roku-test --cross-check --host $ROKU_IP --password $ROKU_PW --config epg-only.json
```

```
DIVERGENT : 0
✓ No divergence. Headless results match the device for all N shared tests.
```

**5. Reclaim.** Move the spec out of your device-only folder into the main suite. Done — it now runs in
the default cross-lane-green suite.

## Why per-suite scoping matters

A single shared seed is a trap: `config` might be exactly what `EpgTile` needs and exactly what
`VideoTooltip`'s tests must *not* have (its assertions assume `config = invalid`). Seed globally and you
fix one while breaking the other.

Because `globalFields` is keyed by type and `"*"` resets each field per suite, both coexist:

```json
"globalFields": {
  "*":            { "config": null },                         // every suite starts with config = invalid
  "EpgTile":      { "config": { "images": { … } } },          // EpgTile gets a real config
  "VideoTooltip": { }                                          // inherits "*" → config stays invalid
}
```

`VideoTooltip` doesn't even need an entry — omitting it (or leaving it `{}`) means it keeps the `"*"`
baseline.

## How it works

1. roku-test writes your `globalFields` to `pkg:/rooibos_global_seed.json` and injects it into the built
   channel (via a build-time file entry — **your app source is never modified**).
2. Rooibos reads it at startup and, **before creating each `@SGNode` node**, applies `"*"` then that
   node's entry to the test scene.
3. The widget's `init()` runs and `getGlobalField(x)` (which reads `scene.getField(x)`) returns your value.

## Gotchas

- **Seed the exact path the code reads.** A `&h18` "Type Mismatch … Invalid and String" after a `&hec`
  usually means you seeded one level but the code went a level deeper. Re-read the backtrace.
- **Values are JSON.** You can seed associative arrays, arrays, strings, numbers, booleans, and `null`
  (→ `invalid`). You can't seed a live node or function.
- **This only helps global-context crashes.** A grid that throws *"No itemComponentName defined"*
  (`&h28`) needs **content/`itemComponentName`** set on the node, not a global — that's a different fix.
- **"Agree" ≠ "pass".** `--cross-check` reports `agree` when both lanes give the *same* result — including
  both failing. Before reclaiming, confirm the suite actually **passes** (green in the default lane), not
  just that it's non-divergent.
