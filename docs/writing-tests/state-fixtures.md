# State fixtures (headless)

A state snapshot captured from a real run can seed a headless `@SGNode` spec. Studio saves the snapshot as a file,
the spec loads it, and `m.global` starts the test in the state the device was in.

## Save a fixture

In Studio's State tab, take a snapshot and use "save as spec fixture". Studio writes
`fixtures/state/<name>.json` in your project:

```json
{ "v": 1, "name": "premium",
  "layers": { "global": { "user": { "tier": "premium", "signedIn": true } },
              "scene": { "nav": { "screen": "HomeScreen" } } } }
```

A flow's `snapshot: premium` step captures the same layered data.

**Redaction.** The saved file is redacted by default (`<redacted:key>` in place of secret-looking values). A fixture
saved with `raw: true` is **not** redacted: its secrets are in the file, and the file ships in the test package and
gets committed with your project. Do not save raw fixtures into a repository.

## Use it in a spec

Import the helper at the top of the spec. brighttest stages it as `source/bt/BTState.brs` whenever a spec mentions
`BTState_load` or `BTState_seedGlobals`, and ships `fixtures/state/**` into the package as `pkg:/fixtures/state/`.
Your project tree is untouched. A project with no such spec builds exactly as before.

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

A runnable example is `test/fixtures/state-fixtures/`.

- `BTState_load(path)` returns the parsed document. The layers are under `snap.layers`.
- `BTState_seedGlobals(snap.layers.global)` writes the `global` layer onto `m.global` and returns
  `{ written: [...], skipped: [...] }`. Only the global layer is written; `scene`, `registry` and the other layers
  are never applied.

## What is skipped

`BTState_seedGlobals` follows the same rules as the agent's restore. It skips, and lists in `skipped`:

- built-in fields (`change`, `focusable`, `focusedChild`, `id`) and `null` values;
- markers: `<redacted:...>`, `$truncated:...`, `$type:...` and `{"$node": ...}`, also when nested in an object or array;
- a value whose type does not match an existing field (a string onto a number, a fraction onto a whole number).

Other fields are updated, or created when `m.global` does not have them. Field names are written as saved; Roku
lowercases them when you read them back.

## Caveats

- **Verify the fixture path.** A path typo makes `BTState_load` throw. In a `beforeEach` the throw shows as a `CRASH`
  line in the Rooibos output and fails the run. Later tests in that group are still skipped, and the summary can read
  `Total 0`, until the Rooibos fix ships.
- **Simulated state, not a device run.** The spec shows your app reacts correctly to that state. It does not show the
  device reaches it.
- Headless and device lanes both stage the helper; the fixtures only matter where the spec runs.
