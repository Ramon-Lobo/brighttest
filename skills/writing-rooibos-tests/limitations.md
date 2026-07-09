# Limitations & workarounds

What the headless lane can and can't do, and how to handle each.

## Capability matrix

| Your test touches… | Headless (default) | Headless `--coverage` | Device |
|---|---|---|---|
| Pure logic — math, parsing, formatting, validation, state | ✅ | ✅ | ✅ |
| Strings, arrays, associative arrays | ✅ | ✅ | ✅ |
| `roByteArray`, base64, `roRegex`, `roDateTime` | ✅ | ✅ | ✅ |
| Crypto — `roEVPDigest` (md5), `roHMAC`, `roEVPCipher` | ✅ | ✅ | ✅ |
| **Code coverage / LCOV** | — | ✅ (no device!) | ✅ |
| `@SGNode` component **logic** — call funcs/subs, computed state | ✅ | ✅ | ✅ |
| `@SGNode` **`onChange` observer cascades** — set field → handler reacts | ✅ | ✅ | ✅ |
| Real wall-clock render timing — animations, Task I/O, live remote input | ⚠️ simulated | ⚠️ simulated | ✅ (reference) |

**Coverage and full `@SGNode` behavior — including `onChange` cascades — are NOT device-only.** They run
headless. Only behavior tied to real wall-clock timing genuinely needs hardware.

## Coverage is line-based only

- Coverage is line/statement coverage (LCOV `DA/LF/LH`). There is **no branch or function coverage** — the
  underlying interpreter doesn't instrument it.
- Coverage reflects only the lines your tests actually exercised; a low percentage on a big untested file is
  accurate, not a bug.
- Get coverage with `brighttest --coverage --lcov coverage/lcov.info`. The default lane never produces it.

## `@SGNode` tests need a scene (handled for you)

- `@SGNode` suites can't run on the fast SceneGraph-off driver. Run them with the default lane or
  `--coverage` (both boot a scene headless), or `--device`.
- **Workaround-first mindset:** keep logic in pure functions and test those headless; keep `@SGNode` suites
  thin and rare. Extract, don't accumulate node tests.

## `@deviceOnly` — the residue that only makes sense on hardware

Some behavior is real only on a device (animation timing that plays out over frames, a firmware quirk the
simulator doesn't reproduce). Rather than quarantine a whole spec file, mark the individual test, group, or
suite `@deviceOnly`:

```brightscript
@it("plays the fade-in over real frames")
@deviceOnly
function _()
  ' ...
end function
```

- **Headless lanes** (`brighttest`, `--coverage`) **skip** `@deviceOnly`.
- **The device lane** (`--device`) **runs** it.
- **`--cross-check`** reports it as *device-only* (expected, not a divergence).
- It works at suite, `@describe`, or `@it` level, and is exactly equivalent to `@tags("deviceOnly")`.
- **Use sparingly.** Prefer extracting a pure function you can test headless. `@deviceOnly` is for behavior
  that genuinely can't be a faithful headless test — not a way to silence a failing assertion.

## Widgets that read global context crash on device → seed `globalFields`

Some `@SGNode` widgets read global app context (`config`, `user`, theme) from the scene during `init()`.
A bare `@SGNode` test scene doesn't carry those globals, so reads return `invalid`. Headless brs-node
tolerates it, but a **real device is strict** and the widget crashes while constructing — a top reason a
spec is green headless yet device-only.

- **Symptom (on `--device`/`--cross-check`):**
  `'Dot' Operator attempted with invalid BrightScript Component ... (runtime error &hec)` or
  `Type Mismatch. Operator "+" can't be applied to "Invalid" and "String". (runtime error &h18)`,
  while the same suite passes headless.
- **Fix:** add `globalFields` to `brighttest.json`, keyed by `@SGNode` type name, with a `"*"` catch-all:

```json
{
  "globalFields": {
    "*":        { "config": null },
    "EpgTile":  { "config": { "images": { "staticBaseUrl": "https://img.example.com" } } }
  }
}
```

- `"*"` is applied to every suite first; the per-type entry overrides it. `null` resets a field to
  `invalid`, giving every suite a clean baseline so one suite's `config` can't leak into the next.
- **Seed the exact nested path the code reads.** If the code does `config.images.staticBaseUrl`, seeding
  `config = {}` is not enough — `{}.images` is still `invalid`. Read the backtrace and seed the whole path.
- Values are JSON (AAs, arrays, strings, numbers, booleans, `null`). You cannot seed a live node or function.
- This only fixes global-context crashes. A grid throwing *"No itemComponentName defined"* (`&h28`) needs
  content / `itemComponentName` set on the node — a different fix.

## Simulator fidelity — `--cross-check`

The headless simulator is a re-implementation, not the real firmware, so in rare cases a test can behave
differently on a device (e.g. `roEVPDigest` on an empty string). Run
`brighttest --cross-check --host <ip> --password <pw>` to run every suite on **both** lanes and diff:

```
agree            : 76   (same result in both lanes)
device-only      : 0    (ran on device but not headless)
DIVERGENT        : 0    (headless ≠ device — fidelity risk)
```

- Any divergent test fails the run. Run it periodically (e.g. nightly) to know immediately if the simulator
  stops being a faithful proxy.
- **"agree" ≠ "pass".** `agree` means both lanes gave the *same* result — including both failing. Before
  trusting a reclaimed suite, confirm it actually passes green in the default lane.
