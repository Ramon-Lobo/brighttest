# Media state (headless)

A headless spec can drive a SceneGraph `Video` or `Audio` node through buffering, playing, paused, stopped,
finished and error, then assert how your app reacts. The `BTMedia_*` helper does this in the headless lanes only
(`brighttest`, `brighttest --coverage`). Nothing plays: the helper writes ordinary node fields, one explicit step at
a time, with no timers and no wall clock, so the spec is repeatable.

**Simulated, not device.** On brs-node a `Video` node never leaves `state = "none"` after `control = "play"`; the
helper moves it for you. A passing spec shows your app handles the sequence the spec chose. It does not show the
device emits that sequence. Confirm with a device flow.

## Use it

Import the driver at the top of the spec. brighttest stages it into the build as `source/bt/BTMedia.brs` whenever a
spec mentions `BTMedia_`; your project tree is untouched.

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

It works in a plain suite (on a node you create with `createObject("roSGNode", "Video")`) and in an `@SGNode` suite.
A runnable example is `test/fixtures/media-driver/`.

## Functions

Every function takes the `Video` or `Audio` node first, returns an associative array of the fields it wrote, and
throws a string when misused (not a `Video`/`Audio` node, `tick` with no duration, an unknown `control`), so a
wrong step fails the test.

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

The `BTMedia_` prefix is reserved: a function of your own with that prefix breaks the build with a duplicate-name
diagnostic.

## What to know

- **Observers run synchronously.** A function-name `observeField` callback runs inside the field write, so after
  `BTMedia_play(v)` the app's `onState` has already run. No flush or `wait` is needed. Measured on brs-node 2.2.0 and
  2.7.0 (spike C16-T1).
- **Plain suites cannot use a function-name `observeField` on a `createObject` Video node.** It fails with "no active
  host node". Use the port form (`observeField("state", port)`), or put the observer in an `@SGNode` suite.
- **Numeric types follow the engine.** `position` may read back as a Float or Double, and `duration` keeps the type
  you wrote. Compare with a tolerance, for example `m.assertTrue(abs(v.position - 3) < 0.001)`, not `assertEqual`.
- **`--no-sgnode` has no `roSGNode`.** The fast lane cannot create `Video` or `Audio` nodes, so a `BTMedia_` spec fails
  there. brighttest prints a note. Run these specs on the default lane (when the project has `@SGNode` specs) or with
  `--coverage`.
- **Writes only work headless.** On a device the media fields are read-only to BrightScript, so the helper cannot
  work there. `--device` skips every spec that uses `BTMedia_` and prints
  `[brighttest] skipped (headless-only media driver): <path>`. `--cross-check` lists them as headless-only, not as a
  divergence.

## What a spec can assert

- Your app's reaction to each state: its own fields, spinner or dialog visibility, focus, the `control` values it set
  (read `node.control` after each step), the next item, registry writes such as a saved resume position, and
  progress calls driven by `position` / `duration`.
- Error handling for the `errorCode` and `errorStr` values the spec chooses.

## What stays device-only

Real playback: decoding, buffering time and order on real streams, start-up time, bitrate and stream info, live
windows, trick play, captions, track discovery, DRM and ads; the real error codes a stream produces; and
`roVideoPlayer`, `roAudioPlayer` and `SoundEffect`, which this helper does not cover. State ordering beyond
"`play` leads to `buffering`" comes from the Roku node docs, not from device evidence.

Known engine gap (not fixed here): the engine's `Audio` node maps a failure to `"failed"` and has no `"stopped"`
mapping, while the Roku docs list `error` and `stopped`. The helper follows the docs, so an `Audio` spec may see a
state the engine would not produce on its own.
