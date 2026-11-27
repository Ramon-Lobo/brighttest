# 9. Headless vs device

::: info At a glance
**What it is for:** knowing which lane a test can run in, so most tests stay in the fast headless lane.

**You will:**
- pick a run mode (default, `--no-sgnode`, `--coverage`, `--device`, `--cross-check`)
- check what each lane can test
- mark hardware-only tests `@deviceOnly`
- cross-check headless against the device
- set a headless device identity with `deviceInfo`

**First command:** `npx brighttest`
:::

## Run modes

Each command trades speed for coverage and fidelity.

| Command | Device? | Coverage? | Node (`@SGNode`) tests? | Speed |
|---|---|---|---|---|
| `brighttest` (default) | no | no | **yes (headless)** | fast¹ |
| `brighttest --no-sgnode` | no | no | skipped | fastest |
| `brighttest --coverage` | no | **yes (+LCOV)** | **yes (headless)** | slower (runs a scene) |
| `brighttest --coverage --no-sgnode` | no | yes (+LCOV) | skipped | slower |
| `brighttest --device …` | yes | yes (+LCOV) | **yes** | slowest |
| `brighttest --cross-check …` | yes | — | both lanes | slowest (both lanes) |

¹ With `@SGNode` specs, the default lane boots a SceneGraph scene and runs them headless. With no node specs, or with
`--no-sgnode`, it uses the faster SceneGraph-off driver. Node tests run **by default**; `--no-sgnode` is the opt-out.

`--cross-check` runs suites in both lanes, diffs the results and fails on any difference. See
[Verifying fidelity](#verifying-fidelity-cross-check).

## The capability matrix

What each lane can test.

| Your test touches… | Headless (default) | Headless `--coverage` | Device |
|---|---|---|---|
| Pure logic: math, parsing, formatting, validation, state | ✅ | ✅ | ✅ |
| Strings, arrays, associative arrays | ✅ | ✅ | ✅ |
| `roByteArray`, base64, `roRegex`, `roDateTime` | ✅ | ✅ | ✅ |
| Crypto: `roEVPDigest` (md5), `roHMAC`, `roEVPCipher` | ✅ | ✅ | ✅ |
| **Code coverage / LCOV** | — | ✅ **(no device!)** | ✅ |
| `@SGNode` component **logic**: call funcs/subs, computed state | ✅¹ | ✅ | ✅ |
| `@SGNode` **`onChange` observer cascades**: set field, handler reacts | ✅¹ | ✅ | ✅ |
| Real wall-clock render timing: animations, Task I/O, live remote input | ⚠️ simulated | ⚠️ simulated | ✅ (reference) |

¹ Only `--no-sgnode` turns these two rows into ❌ for the default lane.

Coverage and full `@SGNode` behaviour, `onChange` cascades included, are **no longer device-only**. Two patches make
them faithful: node suites complete, and `onChange` fires synchronously. A complex widget cross-checked at **95/95, 0
divergent**. Only **real wall-clock timing** stays device-only. The device lane is the **fidelity reference**;
`--cross-check` polices it.

::: tip Headless coverage + node tests, no device required
`brighttest --coverage` runs the **stock Rooibos runner on the brs-node simulator** (SceneGraph enabled), writes LCOV
**and** runs `@SGNode` suites (via a [rooibos-roku patch](full:/maintainers#sgnode-headless-patch) brighttest ships).
It is slower than the default lane (it boots a scene). Use it for coverage and node tests, including in CI with no
hardware.
:::

### Device lane rules

| Rule | Value |
|---|---|
| No `[Rooibos Result]` line printed | failure |
| A crashed test | counts as a failure |
| `--idle-timeout` (no output) | aborts after 120 seconds by default |
| `--timeout` (whole run) | 900 seconds by default |
| A second run | queues behind the [device lease](/guide/device-lease), does not replace the first |

All flags: [CLI reference](/guide/cli-reference).

## Why the split exists

Each lane runs a different driver.

- **Default:** a light driver on brs-node with SceneGraph off. Fastest, but no coverage (coverage reports through a
  SceneGraph collector node).
- **`--coverage`:** brs-node SceneGraph on, running Rooibos's real scene-based runner, so the collector's field
  observers work. Result: coverage + LCOV headless.
- **`@SGNode` tests** also run in full in `--coverage`. Two gaps were closed by shipped patches:

| Gap | Cause | Fix |
|---|---|---|
| Node suites did not *complete* | Rooibos's promise library relies on a field observer brs-node rejects | [rooibos-roku patch](full:/maintainers#sgnode-headless-patch) |
| XML `onChange` did not *fire* mid-test | brs-node batches notifications | [brs-node patch](full:/maintainers#brs-node-onchange-patch) dispatches them synchronously, like real Roku |

Still best verified on **device**: behaviour tied to real wall-clock render timing. There is no desktop Roku emulator,
but coverage and full `@SGNode` testing no longer need hardware.

## Deciding where a test runs

You usually do not mark tests for a lane.

1. Does the test need a real SceneGraph node or coverage? **No:** headless, your default. Fast, runs in CI, no hardware.
2. **Yes:** device, run with `--device`. Gate it to merge or nightly in CI.

A test runs headless if its code works on the simulator. The device lane runs *everything* and adds coverage. The
exception: a test that only makes sense on hardware. Mark it [`@deviceOnly`](#device-only-tests-deviceonly) so headless
lanes skip it instead of failing on a simulator-vs-firmware difference.

**Playback state.** A spec that moves a `Video` or `Audio` node through buffering, playing or error uses the
headless-only [`BTMedia_*` helper](/writing-tests/media-state). `--device` skips it; `--cross-check` lists it as
headless-only.

## Device-only tests (`@deviceOnly`) {#device-only-tests-deviceonly}

Mark a single test, group or suite that is real only on hardware: real render/animation timing, a firmware quirk the
simulator does not reproduce, or a node that only initializes correctly on a device.

```brightscript
@it("plays the fade-in over real frames")
@deviceOnly
function _()
    ...
end function
```

| Lane | `@deviceOnly` tests |
|---|---|
| Headless (`brighttest`, `brighttest --coverage`) | **skipped** |
| Device (`brighttest --device`) | **run** |
| `--cross-check` | reported as *device-only* (expected, not a divergence) |

It works on a suite, a `@describe` group or a single `@it`:

```brightscript
@suite("Real playback")
@deviceOnly                      ' every test in this suite is device-only
class PlaybackTests extends rooibos.BaseTestSuite
```

- `@deviceOnly` equals `@tags("deviceOnly")`. Headless lanes pass `tags: ['!deviceOnly']` to Rooibos.

::: warning Bare `@deviceOnly` needs the patched rooibos (default)
On stock `rooibos-roku` it is not an annotation, so the test runs headless; brighttest warns with `file:line` on the
headless lanes. On stock, write `@tags("deviceOnly")`.
:::

::: tip Reach for this sparingly
Prefer extracting logic into a pure function (see [Designing for the fast lane](#designing-for-the-fast-lane)).
`@deviceOnly` is for what genuinely cannot be a faithful headless test, not a way to dodge a failing assertion.
:::

## Designing for the fast lane

**Keep business logic in pure functions, out of node code.** Then almost everything is headless-testable.

::: code-group
```brightscript [Before: logic in the node]
sub onPriceChanged()
    if m.top.price > 100 then
        m.top.badge = "premium"
    else
        m.top.badge = "standard"
    end if
end sub
```
```brightscript [After: pure function + thin node]
' pure — headless-testable
function tierForPrice(price as integer) as string
    if price > 100 then return "premium"
    return "standard"
end function

sub onPriceChanged()
    m.top.badge = tierForPrice(m.top.price)   ' node stays thin
end sub
```
:::

`tierForPrice` gets fast, parameterized headless tests; the node needs at most a thin device test.

## Verifying fidelity (cross-check)

brs-node is a re-implementation, not real firmware, so a test can rarely behave differently on device. Example:
`roEVPDigest` returns `""` for an empty-string md5 on hardware but the correct hash on the simulator.

```bash
npx brighttest --cross-check --host <roku-ip> --password <dev-pw>
```

It runs every non-node suite **both** headless and on the device, matches tests by name, and reports:

```
agree            : 76   (same result in both lanes)
device-only      : 0    (ran on device but not headless)
DIVERGENT        : 0    (headless ≠ device — fidelity risk)
✓ No divergence. Headless results match the device for all 76 shared tests.
```

Because `@SGNode` suites now run headless too, they are cross-checked as well. The example includes the project's
Theme node suite, identical in both lanes.

- Each divergent test is listed with its headless and device result, and the run fails (exit ≠ 0).
- Run it periodically (for example nightly). It turns "the simulator might differ" into a monitored risk.

## Practical workflow

When to run which lane.

| When | Run |
|---|---|
| Every change | `npx brighttest` (headless, `@SGNode` included). Add `--no-sgnode` for a sub-second pure-logic loop. |
| Coverage in CI (no device) | `npx brighttest --coverage --lcov coverage/lcov.info` |
| Before merge / nightly | `npx brighttest --device …` (on-device coverage + real render timing) and `npx brighttest --cross-check …` |

## Device identity (`deviceInfo`)

Make headless `roDeviceInfo` report a chosen device, so branches on `GetUIResolution()` or `GetConnectionType()` take
that device's path.

- No block: the engine's own identity (model `8000X`, 720p UI, wired).
- Every key is optional; unknown keys are an error.
- **Setting any key switches the other keys' defaults** to Roku Ultra values (model `4850X`, 1080p UI, Wi-Fi).

```json
{ "deviceInfo": { "uiResolution": "720p", "connectionType": "WiredConnection" } }
```

| Key | Values | Default once a block is set |
| --- | --- | --- |
| `model` | model string, e.g. `4850X` | `4850X` |
| `uiResolution` | `480p`, `720p`, `1080p` | `1080p` |
| `connectionType` | `WiredConnection`, `WiFiConnection` | `WiFiConnection` |
| `locale` | any `xx_YY` string, e.g. `fr_CA` | engine default (`en_US`) |
| `osVersion` | engine's encoded firmware string, e.g. `48G.04E05531A` (15.0.4 build 5531) | engine default |
| `friendlyName` | any non-empty string | engine default |
| `country` | two-letter uppercase code, e.g. `CA` (reported as the country code) | engine default |

::: warning Limits
- **Scene lanes need an engine with `device-data`.** `@SGNode` specs and `--coverage` pass the block with
  `--device-data`, which exists only in patched `@ramonlobo/brs-node` 2.7.1-bt.1 or later. On stock, or patched before
  2.7.1-bt.1, brighttest warns once and scene lanes keep the engine identity (`8000X`, 720p, wired).
- **`model` cannot simulate a TV.** The models table is not available here: `GetModelType` is always `STB`,
  `GetModelDisplayName` is `Roku (<model>)`.
- **`locale`:** translations ship only for `de_DE`, `es_ES`, `es_MX`, `fr_CA`, `it_IT`, `pt_BR`, plus built-in
  `en_US`. Other values are accepted but have no terms.
- Do not put secrets in this block.
:::

## Common questions

| Question | Answer |
|---|---|
| Can I get coverage headless? | Yes: `brighttest --coverage` gives coverage + LCOV with no device. |
| My crypto test: headless or device? | Headless works: brs-node implements `roEVPDigest`/`roHMAC`. |
| Can I run `@SGNode` tests without a device? | Yes, in the **default** lane and under `--coverage`, `onChange` cascades included. Only real wall-clock timing (animations, Task I/O) needs `--device`; use `--cross-check` to confirm fidelity. |
| Can I skip `@SGNode` suites for a faster run? | Yes: `npx brighttest --no-sgnode` uses the SceneGraph-off driver. It is the only case where the default lane skips node tests. |

## Related

- [SceneGraph & async tests](/writing-tests/scenegraph-async): writing `@SGNode` suites
- [Media state](/writing-tests/media-state): the headless-only `BTMedia_*` helper
- [Global context](/writing-tests/global-context): fixing widget crashes that only show on device
- [Device lease](/guide/device-lease): how device runs queue
- [CLI reference](/guide/cli-reference): every flag

**Full guide:** [Headless vs device](full:/writing-tests/headless-vs-device) — the original wording.
