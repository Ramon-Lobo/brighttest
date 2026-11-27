# Media state (headless)

::: info At a glance
**What it is for:** driving a SceneGraph `Video` or `Audio` node through buffering, playing, paused, stopped, finished
and error in a headless spec, then asserting how your app reacts.

**You will:**
- import the `BTMedia_*` driver
- step a node through states, one explicit call at a time
- assert your app's reaction
- know what stays device-only

**First file:** a spec that imports `pkg:/source/bt/BTMedia.brs`
:::

## How it works

Headless lanes only (`brighttest`, `brighttest --coverage`).

- Nothing plays. The helper writes ordinary node fields, one explicit step at a time.
- No timers and no wall clock, so the spec is repeatable.

::: warning Simulated, not device
On brs-node a `Video` node never leaves `state = "none"` after `control = "play"`; the helper moves it for you. A
passing spec shows your app handles the sequence the spec chose, not that the device emits it. Confirm with a device
flow.
:::

## Use it

Import the driver at the top of the spec. brighttest stages it as `source/bt/BTMedia.brs` whenever a spec mentions
`BTMedia_`; your project tree is untouched.

```brightscript
import "pkg:/source/bt/BTMedia.brs"

namespace tests
  @suite("player")
  @SGNode("Player")
  class PlayerSpec extends rooibos.BaseTestSuite
    @it("shows the spinner while buffering")
    function _()
      v = m.top.findNode("vid")
      BTMedia_load(v)
      m.assertTrue(m.top.spinnerVisible)
      BTMedia_play(v, { duration: 4 })
      m.assertFalse(m.top.spinnerVisible)
    end function
  end class
end namespace
```

- Works in an `@SGNode` suite and in a plain suite (on a node from `createObject("roSGNode", "Video")`).
- Runnable example: `test/fixtures/media-driver/`.

## Functions

Each takes the `Video` or `Audio` node first and returns an associative array of the fields it wrote. Misuse (not a
`Video`/`Audio` node, `tick` with no duration, an unknown `control`) throws a string, so a wrong step fails the test.

| Function | Effect |
|---|---|
| `BTMedia_load(node, steps = [0, 33, 66, 100])` | `state = "buffering"`, then one `bufferingStatus` write per step (`prebufferDone` from 33). |
| `BTMedia_play(node, opts = {})` | `state = "playing"`. `opts.duration` sets `duration`; otherwise `content.length` when present. |
| `BTMedia_tick(node, seconds)` | Advances `position` in steps of `notificationInterval` (default 0.5 s), one write per step, clamped to `duration`. Reaching `duration` sets `finished`, or wraps to 0 when `loop` is true. |
| `BTMedia_pause(node)` / `BTMedia_resume(node)` | `paused` / `playing`. |
| `BTMedia_stop(node)` | `stopped` (`stopping` first when `asyncStopSemantics` is true). |
| `BTMedia_finish(node)` | `position = duration`, `state = "finished"`. |
| `BTMedia_fail(node, code, msg = "", info = {})` | `errorCode`, `errorMsg` (and `errorStr`, `errorInfo` on `Video`) first, then `state = "error"`. |
| `BTMedia_next(node, index)` | Playlist: `contentIndex = index`. |
| `BTMedia_sync(node)` | Reads the `control` your app last set and applies it: `play` / `replay` = load then play; `prebuffer` = load; `pause`, `resume`, `stop` as above; `none` = nothing. |

::: warning Reserved prefix
A function of your own named `BTMedia_...` breaks the build with a duplicate-name diagnostic.
:::

## What to know

| Topic | Detail |
|---|---|
| **Observers run synchronously** | A function-name `observeField` callback runs inside the field write, so after `BTMedia_play(v)` the app's `onState` has already run. No flush or `wait`. Measured on brs-node 2.2.0 and 2.7.0 (spike C16-T1). |
| **Plain suites + `createObject` Video** | A function-name `observeField` fails with "no active host node". Use the port form (`observeField("state", port)`), or put the observer in an `@SGNode` suite. |
| **Numeric types follow the engine** | `position` may read back as Float or Double; `duration` keeps the type you wrote. Compare with a tolerance, e.g. `m.assertTrue(abs(v.position - 3) < 0.001)`, not `assertEqual`. |
| **`--no-sgnode` has no `roSGNode`** | The fast lane cannot create `Video`/`Audio` nodes, so a `BTMedia_` spec fails there; brighttest prints a note. Use the default lane (when the project has `@SGNode` specs) or `--coverage`. |
| **Writes only work headless** | On a device media fields are read-only to BrightScript. `--device` skips every `BTMedia_` spec and prints `[brighttest] skipped (headless-only media driver): <path>`. `--cross-check` lists them as headless-only, not a divergence. |

## What a spec can assert

- Your app's reaction to each state: its own fields, spinner or dialog visibility, focus, the `control` values it set
  (read `node.control` after each step), the next item, registry writes such as a saved resume position, and progress
  calls driven by `position` / `duration`.
- Error handling for the `errorCode` and `errorStr` values the spec chooses.

## What stays device-only

::: warning Needs a device
- Real playback: decoding, buffering time and order on real streams, start-up time, bitrate and stream info, live
  windows, trick play, captions, track discovery, DRM and ads.
- The real error codes a stream produces.
- `roVideoPlayer`, `roAudioPlayer` and `SoundEffect`: not covered by this helper.
- State ordering beyond "`play` leads to `buffering`" comes from the Roku node docs, not device evidence.
:::

**Known engine gap (not fixed here):** the engine's `Audio` node maps a failure to `"failed"` and has no `"stopped"`
mapping; the Roku docs list `error` and `stopped`. The helper follows the docs, so an `Audio` spec may see a state the
engine would not produce on its own.

## Related

- [Headless vs device](/writing-tests/headless-vs-device): lanes and cross-check
- [SceneGraph & async tests](/writing-tests/scenegraph-async): `@SGNode` suites
- [HTTP fixtures](/writing-tests/http-fixtures): the other headless-only helper

**Full guide:** [Media state](full:/writing-tests/media-state) — the original wording.
