# Session video — feasibility study

Can the e2e lane record **video** of a session instead of only per-step screenshots? Studied against a
real Roku Ultra (fw 15.2.4). Short answer: **yes, as an assembled slideshow of captured frames** — which
is now shipped behind `--video` — but true smooth-motion capture is **not possible over ECP alone** and
needs external hardware.

## What Roku exposes

- **No video-out over ECP.** There is no ECP endpoint that streams or records the screen. The only visual
  capture is the **dev screenshot** endpoint (`plugin_inspect` → `/pkgs/dev.jpg`, HTTP Digest auth).
- **Screenshots are slow.** Measured **~1.07–1.2 s per frame** end to end (generate + digest-authed
  fetch) → **~0.9 fps**, ~34 KB/frame at 1080p. That is a hard ceiling for a screenshot-based approach:
  the `plugin_inspect` "generate" step is required for a fresh frame, and each of the two requests carries
  its own Digest challenge round-trip.
- **Render-thread contention.** Screenshots and `sgnodes` both hit the app's render thread. Capturing
  aggressively in parallel with assertions would slow/destabilise the very reads the run depends on.

## Options considered

| Approach | Motion quality | Cost / deps | Verdict |
|---|---|---|---|
| **Per-step frames → assemble** (ship) | Slideshow (1 frame/step) | Reuses screenshots we already take; ffmpeg optional | ✅ Shipped as `--video` |
| Continuous timelapse during run | ~1 fps, choppy | Background capture loop; competes with sgnodes for the render thread | ⚠️ Deferred — low value at 1 fps, adds instability risk |
| External HDMI capture card + ffmpeg | True 30/60 fps | Extra hardware; ffmpeg reads the capture device, not ECP | 📄 Documented as the option for real video |

## Decision — `--video`

Ship the pragmatic, zero-risk version: assemble the **per-step screenshots** the run already captures into
one video per flow.

- `brighttest e2e run … --video [mp4|gif]` → `lib/e2e/video.js` runs **ffmpeg** (optional external tool;
  if absent we skip with a note) over the ordered frames, holding each ~1.5 s. Output lands next to the
  screenshots as `<flow>.mp4` (namespaced per matrix/device run).
- This is a **labelled step-by-step replay** — ideal as a failure/audit artifact (upload it from CI), not
  a substitute for watching the device. It faithfully shows every state the flow asserted on.

Verified on device: a 5-step flow produced a valid 1080p→960p MP4 from its frames.

## If you need real motion video

Point ffmpeg at an **HDMI capture device** (a cheap USB capture dongle between the Roku and a display) and
record in parallel with the run — e.g. `ffmpeg -f avfoundation -i "<device>" out.mp4` on macOS. That path
gives full-frame-rate video but is outside brighttest's software-only scope; a self-hosted CI runner with
a capture card is the natural home for it. We may add a `--video-source <ffmpeg-input>` passthrough later
if there's demand.

## Follow-ups (not done)

- Optional continuous timelapse mode (`--video-mode timelapse`) if 1 fps proves useful for animations.
- `--video-source` passthrough for HDMI capture on CI runners.
