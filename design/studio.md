# brighttest studio — design & build plan

`brighttest studio` opens a local web app that mirrors a **running Roku**, lets you **visually inspect**
its live SceneGraph, **drive the remote**, and **author e2e tests** from what's on screen. It's a visual
front-end over the primitives the e2e lane already ships.

Status: **planning**. This doc is the roadmap; it will change as the Phase 0 spike teaches us things.

## Vision

1. **Visualize** — show the device screen and, overlaid on it, the live node tree. Hover/click a node to
   see its fields and children; highlight elements visually. (First feature.)
2. **Author** — turn selected nodes into assertions and build up a `*.e2e.yaml` flow, using the node state
   that's actually on the device right now.
3. **Control** — drive the device from the studio: D-pad, Select, Back, Home, text (full remote).

Later: run a flow live with step-by-step highlighting, a record mode, screenshot diffing, a device-less
brs-engine preview, multi-device.

## Decisions (locked)

| Area | Choice | Why |
|---|---|---|
| UI stack | **Vanilla HTML/CSS/JS + tiny Node HTTP server**, zero new deps, no build step | Matches brighttest's zero-runtime-dep ethos and how `scripts/roku-live-view.js` already works; ships in npm `files` cheaply |
| Rendering | **Screenshot mirror + sgnodes bounding-box overlay** | Truthful — the real device is the source of truth. ~1fps (ECP limit). Reuses the dev-screenshot driver |
| Update model | **Live auto-poll, settle-aware** | Feels like a live mirror; debounce/settle like the e2e runner to avoid stampeding the render thread |
| First deliverable | **Spike the overlay accuracy** | Coordinate mapping is the one make-or-break unknown; de-risk it before building UI around it |

Explicit non-goal for the mirror: **brs-engine in-browser rendering** — it would run a *separate* copy of
the app, not reflect the physical device's live state. Parked as a possible future device-less preview.

## What already exists (we're wrapping, not writing from scratch)

- `lib/e2e/ecp.js` — device driver: `keypress`, `launch`, `text`, `screenshot`, `deviceInfo`.
- `lib/e2e/sgnodes.js` — `/query/sgnodes/all` → parsed tree (`subtype`, `id`, `text`, `bounds{x,y,w,h}`,
  `attrs`, `children`, `focused`) + `waitForSettle`.
- `lib/e2e/select.js` — selector matching.
- `lib/e2e/navigate.js` — proves `bounds` are usable geometry (centers/distances).
- `lib/e2e/assert-builder.js` — suggest/build assertions from a node; append to a flow.
- `lib/e2e/record.js` — node → flow-YAML serializers.
- `scripts/roku-live-view.js` — an existing ~1fps screenshot MJPEG server (prior art / to fold in).

## Architecture

```
brighttest studio --host <ip> --password <pw> [--port 8700] [--app dev] [--open]
        │
        ▼
lib/studio/server.js   Node http (zero-dep): static files + JSON API, one device handle
        │  reuses
        ├── lib/e2e/ecp.js        screenshot / keypress / launch / deviceInfo
        ├── lib/e2e/sgnodes.js    live tree (+ settle)
        ├── lib/e2e/select.js     node matching
        └── lib/e2e/assert-builder.js + record.js   author + serialize flows
        │
        ▼
lib/studio/public/     index.html + app.js + studio.css (no bundler)
```

### JSON API (thin wrappers over lib/e2e)

| Endpoint | Does |
|---|---|
| `GET /api/device` | `deviceInfo()` + inferred scene resolution |
| `GET /api/screenshot` | proxies `device.screenshot()` bytes (jpg/png), cache-busted |
| `GET /api/tree` | `sg.fetchTree` (+ optional settle) → JSON tree with a stable per-node path |
| `POST /api/keypress` | `{key, count}` → `device.keypress` |
| `POST /api/launch` | `{app, contentId?, mediaType?}` → `device.launch` |
| `POST /api/select` | `{selector}` → `select.matchAll` (confirm a target) |
| `GET /api/flows` · `GET /api/flow?file=` | list / read existing `*.e2e.yaml` |
| `POST /api/flow` | append/save a step (via assert-builder + record serializers) |

ECP reads are **serialized through one queue** — the device render thread is single-threaded, so
overlapping screenshot + sgnodes calls must not stampede (sgnodes already retries with backoff).

### Client

- **Screen pane:** `<img>` (the screenshot) with an SVG/canvas overlay of node boxes on top.
- **Tree panel:** collapsible node tree; row hover ⇄ box highlight; click → select.
- **Inspector:** all `attrs` (the `inspect` field dump), child count, and suggested assertions (assert-builder)
  with "add" buttons.
- **Remote pad:** D-pad / Select / Back / Home / text, plus keyboard shortcuts → `/api/keypress`.
- **Flow builder:** ordered, editable list of authored steps → "Save to `flows/<name>.e2e.yaml`".
- **Live loop:** screenshot ~1fps; tree on an interval and after every action (settle-aware).

Note: Roku has no tap. **Clicking a node in the studio inspects/selects it for authoring** — it does *not*
interact with the device. To interact, use the remote pad (optionally: a future "focus this node" button
that runs `navigate.focusTo`).

### Coordinate mapping (the Phase 0 spike)

`sgnodes` `bounds` live in the SceneGraph design space (1280×720 HD or 1920×1080 FHD per the manifest);
the screenshot is a JPG at the device's output resolution. Overlay = scale bounds by
`(imgW/sceneW, imgH/sceneH)`.

Spike must answer:
- Is the root `Scene` node's `bounds` the full design resolution (so we can infer `sceneW/sceneH` from it)?
- Is the screenshot's pixel size the same or a scaled version?
- Are child `bounds` absolute (screen) or parent-relative? (`navigate.js` treats them as absolute — confirm.)
- Do `bounds` vs `translation` differ for our purposes?

Deliverable: `lib/studio/coords.js` (pure `boundsToPx(bounds, scene, img)` — unit-tested on synthetic data)
plus a **runnable minimal overlay page** so we can eyeball alignment on a real device (Home grid, Settings).

## Phases

- **Phase 0 — Spike (overlay accuracy).** `coords.js` + a minimal server route + a throwaway page that draws
  boxes over one screenshot from `/api/tree`. Validate alignment on a real Roku. Go/no-go + the scale formula.
- **Phase 1 — Visualize (Feature 1).** `brighttest studio` command, server, live screen + tree + overlay,
  hover/click inspector (fields, children, highlight). The core deliverable.
- **Phase 2 — Control (Feature 3).** Remote pad + keyboard → `/api/keypress`; live view reflects changes.
  (Small — `ecp.keypress` already exists.)
- **Phase 3 — Author (Feature 2).** Inspector → suggested assertions; flow builder; save/append
  `*.e2e.yaml`; optionally run a flow from the studio and show ✓/✗.
- **Phase 4+ — Future.** Live flow playback with highlighting, record mode, screenshot diffing, brs-engine
  device-less preview, multi-device.

## Risks & open questions

- **Coordinate mapping** — the spike; everything visual depends on it.
- **ECP throughput** — each screenshot is ≈1.1s and sgnodes RPC can time out under load; serialize + backoff.
  Live feel is capped ~1fps.
- **Dev-channel only** — the screenshot endpoint needs a sideloaded dev channel + password (non-dev channels
  404 / black); `roku-live-view.js` already maps these errors to hints — reuse that.
- **Local-only server** — bind `127.0.0.1`, no auth; it exposes device control on localhost. Document it.
- **Resolution variance across apps** — infer `sceneW/sceneH` per session from the Scene bounds.

## Testing

- Pure units: `coords.boundsToPx` (synthetic), API handlers with an **injected fake device** returning
  canned trees (the pattern already used in `test/e2e.test.js` / `test/e2e-record.test.js`), flow
  save/append (reuse assert-builder coverage).
- No hardware in CI; the visual overlay is validated manually on a device during the spike.

## Performance (Phase 0/1 findings — measured on a Roku Ultra, FHD)

Per-call latency, measured against the live device:

| Read | Cost | Notes |
|---|---|---|
| `/api/tree` (sgnodes) | **~18 ms** | cheap; poll it fast |
| `/api/screenshot` | **~1.1 s** | inherent: 2-step Digest-authed capture (≈4 round-trips) |
| `/api/device` | ~0.8 s | one-time |

**The slowness bug (fixed):** the first cut put both reads on **one serialized queue**, so the 18ms tree
waited behind the 1.1s screenshot; and the client ran two `setInterval`s that **piled requests up** faster
than they drained. Net effect: a remote press took ~4–6s to reflect.

**Fix:** each read type is **coalesced on its own independent lane** (a new call while one is in flight
shares that promise — never stacks), and the client uses **self-scheduling loops** (tree ~300ms, screenshot
~900ms) that wait for completion before rescheduling, plus tree **change-detection** (no re-render/flicker
when nothing changed). A keypress nudges both lanes immediately.

Result under concurrent screenshot load: tree reads **~15ms**, keypress **~35ms** → a press reflects in the
boxes in **~150ms**, screenshot catching up ~0.3–1s later. The screenshot's ~1.1s Digest cost is the next
optimization (persist the Digest nonce / session) but is no longer on the interactive path.

## Roadmap

Interactive "write a UI test, run it, watch it" tools like Maestro are an inspiration here, adapted to
Roku's focus-based model.

- **M1 Visualize** ✅ (done) — live screenshot mirror + resolved sgnodes overlay + hover/click inspector.
- **M2 Control** ✅ (done) — remote pad + keyboard, live view follows.
- **M3 Author** ✅ (done) — browse the project's real `*.e2e.yaml` flows, edit them in place, click a node
  → "+ add" `assertVisible`/`assertText`/`assertFocused` into the open flow; **Save writes the actual file**
  (parse-validated server-side, path-scoped to the flows dir).
- **M4 Test editor + runner** ✅ (done) — a **Run** button executes the flow on the device via SSE (reusing
  the e2e `execStep`), streaming **per-step ✓/✗** with the overlay **highlighting the current target**;
  stops at the first failure with its reason. This is "write a test in the tool, run it, watch it."
  Still open: id autocomplete in the editor, and expected/actual screenshot capture on failure.
- **M5 Record** — capture remote presses + on-demand assertions into a flow from the studio (a nicer,
  visual successor to `e2e record`).
- **M6 Selector assistant** — flag ambiguous selectors, suggest the stable one (id→text→subtype+index), and
  a "focus this node" action that runs `navigate.focusTo`.
- **M7 Polish** — flow library browser (open/edit existing flows), reorder/edit steps, multi-device picker,
  screenshot diffing.
- **Parked: device-less mode** — run the app in-browser for hardware-free authoring (see the brs-engine
  spike below).

## Spike: brs-engine as a rendering path

**Question:** could [brs-engine](https://github.com/lvcabral/brs-engine) (the browser BrightScript
simulator) render the app faster than the ~1fps screenshot mirror?

**Findings (verified against brs-engine's own docs, July 2026):**
- SceneGraph support exists but is **experimental** — it lives on a `scenegraph` branch via a separate
  `brs-scenegraph` extension package. Basic nodes are implemented (Scene, Group, Label, Poster, LayoutGroup,
  ArrayGrid-based lists, dialogs); **"all other nodes are either mocked or not implemented,"** there's **no
  animation support** (incl. grid/list focus animation), Task threading is capped, and RenderThreadQueue
  isn't implemented.
- Its own docs state it **"won't reliably run arbitrary SceneGraph applications"** — unimplemented/custom
  components fall back to plain `Node` with no rendering.
- Architecturally it runs a **separate in-browser instance** of the app; it does **not** reflect the
  physical device's live focus/navigation/data. So it can't be a *mirror* — at best a parallel simulation
  that would drift.

**Recommendation: do not use brs-engine for the mirror.**
- The interactive slowness is already solved without it (tree ~15ms; sub-second reflection). The remaining
  ~1.1s screenshot cost is off the interactive path and is better addressed by Digest-session reuse.
- brs-engine's fidelity gap (custom components, animations) makes it unsuitable as a faithful render of a
  real CBS-scale SceneGraph app today.
- **Where it could fit later:** an optional **device-less preview/authoring mode** (M-parked) — run *your*
  app in-browser at native frame rate for authoring without hardware — but only once its SceneGraph support
  matures and only for apps within its supported node set. Track the `scenegraph` branch; revisit then.

## Proposed file layout

```
bin/cli.js                    # add `studio` dispatch + parseStudioArgs + STUDIO_HELP
lib/studio/server.js          # http server + static serving + API
lib/studio/api.js             # request handlers (device-injectable, testable)
lib/studio/coords.js          # sgnodes bounds → screenshot px (pure, tested)
lib/studio/public/{index.html,app.js,studio.css}
test/studio.test.js           # coords + api handler units
docs/studio/index.md          # docs page
package.json                  # add lib/studio to "files"
```
