# State fixtures (headless)

::: info At a glance
**What it is for:** starting a headless `@SGNode` spec with `m.global` in the state a real device was in.

**You will:**
- save a Studio snapshot as a fixture file
- load it and seed `m.global` in a spec
- know which fields are skipped

**First file:** `fixtures/state/<name>.json`
:::

## Save a fixture

1. In Studio's State tab, take a snapshot.
2. Use "save as spec fixture". Studio writes `fixtures/state/<name>.json` in your project:

```json
{ "v": 1, "name": "premium",
  "layers": { "global": { "user": { "tier": "premium", "signedIn": true } },
              "scene": { "nav": { "screen": "HomeScreen" } } } }
```

A flow's `snapshot: premium` step captures the same layered data.

::: warning Redaction
The file is redacted by default (`<redacted:key>` replaces secret-looking values). A fixture saved with `raw: true` is
**not** redacted: its secrets are in the file, which ships in the test package and is committed with your project. Do
not save raw fixtures into a repository.
:::

## Use it in a spec

Import the helper. brighttest stages it as `source/bt/BTState.brs` whenever a spec mentions `BTState_load` or
`BTState_seedGlobals`, and ships `fixtures/state/**` as `pkg:/fixtures/state/`. Your project tree is untouched; a
project with no such spec builds exactly as before.

```brightscript
import "pkg:/source/bt/BTState.brs"

namespace tests
  @suite("badge")
  @SGNode("Badge")
  class BadgeSpec extends rooibos.BaseTestSuite
    protected override function beforeEach()
      snap = BTState_load("pkg:/fixtures/state/premium.json")
      m.seeded = BTState_seedGlobals(snap.layers.global)
    end function

    @it("shows the premium tier")
    function _()
      m.top.callFunc("refresh")
      m.assertEqual(m.top.label, "Tier: premium")
    end function
  end class
end namespace
```

Runnable example: `test/fixtures/state-fixtures/`.

| Function | Returns |
|---|---|
| `BTState_load(path)` | The parsed document; layers are under `snap.layers`. |
| `BTState_seedGlobals(snap.layers.global)` | Writes the `global` layer onto `m.global`; returns `{ written: [...], skipped: [...] }`. Only the global layer is written; `scene`, `registry` and other layers are never applied. |

## What is skipped

`BTState_seedGlobals` follows the agent's restore rules. It skips, and lists in `skipped`:

- built-in fields (`change`, `focusable`, `focusedChild`, `id`) and `null` values;
- markers `<redacted:...>`, `$truncated:...`, `$type:...` and `{"$node": ...}`, also nested in an object or array;
- a value whose type does not match an existing field (a string onto a number, a fraction onto a whole number).

Other fields are updated, or created when `m.global` lacks them. Names are written as saved; Roku lowercases them when
you read them back.

## Caveats

::: warning
- **Verify the fixture path.** A typo makes `BTState_load` throw. In a `beforeEach` that shows as a `CRASH` line in
  the Rooibos output and fails the run. Later tests in that group are still skipped, and the summary can read
  `Total 0`, until the Rooibos fix ships.
- **Simulated state, not a device run.** The spec shows your app reacts correctly to that state, not that the device
  reaches it.
:::

Headless and device lanes both stage the helper; the fixtures only matter where the spec runs.

## Related

- [Global context](/writing-tests/global-context): seed scene fields per `@SGNode` type from config
- [SceneGraph & async tests](/writing-tests/scenegraph-async): `@SGNode` suites
- [Studio](/guide/studio): taking snapshots

**Full guide:** [State fixtures](full:/writing-tests/state-fixtures) — the original wording.
