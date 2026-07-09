# Design: `brighttest e2e` — on-device end-to-end UI testing

Status: **draft / RFC** · Branch: `feat/e2e` · Prereq spike: `experiments/FINDINGS.md` (confirmed on device)

## Context & goal

brighttest today runs Rooibos **unit/integration** specs (headless + on-device coverage). This adds a
distinct, complementary capability: **deterministic end-to-end UI tests on a real device** — launch the
app, read what's on screen, drive the remote (Up/Down/Left/Right/Select/Back/text), and assert on the
resulting UI. Think Maestro, adapted to Roku's D-pad, focus-based model.

Two hard requirements from the request:

1. **Author-first, not AI-first.** A human writes a readable flow file and watches it run on the device.
   The executor is fully deterministic; no model is in the loop. (AI may *help author* flows later — never
   required.)
2. **Reuse what Roku gives us.** The spike confirmed we need no on-device library injection: `sgnodes`
   (read) + `keypress` (act) + `node-id` query (select) are stock ECP.

## Confirmed primitives (see FINDINGS.md)

- Read screen: `GET /query/sgnodes/all` → full node tree (subtype, `focused`, `bounds`, `translation`,
  `visible`, `text`, `uri`, `children`). `roots` and `nodes?node-id=<id>` variants too.
- Act: `POST /keypress/<key>` (Up/Down/Left/Right/Select/Back/Home/Play/Info/Search/Enter/Backspace,
  `Lit_<char>` for text, Volume/Input keys). `POST /launch/<dev|id>?contentID=…&MediaType=…` for deep links.
- Visual proof: dev screenshot endpoint (needs dev password) for per-step / on-failure PNGs.
- Constraints: channel must be running; `sgnodes` is a render-thread RPC that **times out when busy** →
  retry+settle; app should set `id`s; dev mode + host/password (already used by `--device`).

## Architecture

```
flow (.yaml/.json)
   │  parse
   ▼
Flow runner ──uses──> Device driver (ECP over HTTP: keypress / launch / input / screenshot)
   │                     │
   │                     └─> sgnodes reader  (fetch + retry/backoff + settle-wait + XML→JSON tree)
   │
   ├─> Selector engine    (match nodes by id | subtype | text | index | field; visible/focused filters)
   ├─> Focus navigator    (closed loop: read focus+bounds → press toward target → re-read → Select)
   └─> Reporter (reuse lib/reporter.js palette + step ✓/✗, failure detail, screenshot artifacts)
```

New modules (all core `fs`/`path` + global `fetch`, matching the no-dependency ethos):

- `lib/e2e/ecp.js` — device driver: `keypress`, `launch`, `input`, `screenshot`, `deviceInfo`.
- `lib/e2e/sgnodes.js` — fetch `sgnodes/all`, retry on RPC-timeout with backoff, wait-until-settled
  (two consecutive identical trees or a stable focused node), parse XML → a lightweight node tree.
- `lib/e2e/select.js` — selector matching over the tree.
- `lib/e2e/navigate.js` — focus path-finding.
- `lib/e2e/flow.js` — parse + validate a flow file into steps.
- `lib/e2e/run.js` — the lane: execute steps, assert, report, exit code. Wired into `bin/cli.js` as
  `brighttest e2e …` (a positional subcommand, like `skills`/`init`).

## The flow DSL (author-first)

YAML (or JSON), one ordered list of steps. Deterministic and readable:

```yaml
# flows/home-to-settings.e2e.yaml
appId: dev            # dev channel (default), or a published channel id
config: {}            # optional per-flow overrides (timeouts, device)

steps:
  - launch                                     # launch appId (optionally: launch: { contentId, mediaType })
  - assertVisible: { id: homeScreen }          # poll sgnodes until present (timeout) else fail
  - focus:        { id: settingsTile }         # arrow-key path-find to this node
  - press: Select
  - assertVisible: { id: settingsScreen }
  - assertText:   { id: headerLabel, equals: "Settings" }
  - press: Back
  - assertVisible: { id: homeScreen }
  - screenshot: back-home.png                  # artifact (optional)
```

Step vocabulary (Phase 1 unless noted):

| Step | Meaning |
|---|---|
| `launch` / `launch: {contentId, mediaType}` | Start the app / deep link |
| `press: <Key>` / `press: {key, count}` | One or N keypresses |
| `pressUntil: {key, visible: <selector>, max}` | Repeat a key until a selector appears (e.g. scroll a row) |
| `focus: <selector>` *(Phase 2)* | Move focus onto a node via path-finding, then stop |
| `text: "hello"` | Type via `Lit_` (on-screen keyboards) |
| `assertVisible` / `assertGone: <selector>` | Presence assertions (with `waitFor` timeout) |
| `assertText: {…, equals\|contains}` | Text assertion on a node |
| `assertFocused: <selector>` | The node is currently `focused="true"` |
| `waitFor: {selector, timeout}` | Explicit wait |
| `screenshot: <name>` | Save a PNG artifact |
| `back` / `home` | Convenience for `press: Back` / `Home` |

## Selectors

A selector matches nodes in the parsed tree:

```yaml
{ id: settingsTile }                 # → GET /query/sgnodes/nodes?node-id=settingsTile (direct, fastest)
{ subtype: Poster, text: "Play" }    # by node type + field
{ text: "Continue watching" }        # by visible text
{ subtype: RowList, index: 0 }       # nth match
```

Every selector can be constrained by `visible: true` / `focusable: true`. `id` is preferred (stable,
directly queryable); the others are fallbacks so flows can be written before ids are added.

## Test IDs — making the app selectable

The spike found **zero `id`s** in the live tree, so this is a real prerequisite. Options, in order of
effort:

1. **Manual `id` on key nodes** — set `id="settingsTile"` in the component XML/BrightScript for the nodes a
   flow targets. Small, explicit, and immediately queryable via `sgnodes/nodes?node-id=`.
2. **A `testId` convention** — if teams don't want to reuse `id` (some code keys off it), add a custom
   `testId` field to base components; the selector engine reads it like any field. Slightly more work in
   the app.
3. **Auto-injection at build (Phase 3, optional)** — brighttest already runs a BrighterScript build for
   its other lanes. A bsc plugin could stamp `id`s onto nodes (derived from the field/variable name that
   holds them) in an E2E build, so teams get selectors without hand-annotating everything. Investigate
   feasibility; keep manual ids as the baseline.

## Focus navigation (the interesting part)

Roku has no tap. `focus: <target>` runs a closed loop:

1. Read the tree; find the `focused="true"` node and the target's `bounds`.
2. If target is already focused → done.
3. Choose a direction from the geometry (target mostly right → `Right`; below → `Down`; etc.).
4. Press once; wait for settle; re-read.
5. If the focused node changed and is "closer" to the target, continue; if it didn't change (edge) or we
   exceed `maxPresses`, try the orthogonal axis, then fail with a clear message + screenshot.

This is bounded and deterministic. Apps with custom/uneven focus handling are the edge cases; the
max-press guard + orthogonal retry + a good error (with the tree dump) keep failures debuggable. Where an
app exposes a "jump to id" affordance, `pressUntil` is a simpler alternative.

## Robustness (from spike constraints)

- **Retry/backoff** every `sgnodes` call on `Plugin RPC event timed out` (transient render-thread busy).
- **Settle-wait**: after an action, poll until two consecutive trees agree (or the focused node is stable)
  before asserting — screens transition over frames.
- **Preflight**: verify the device is reachable and a channel is running; fail fast with guidance if
  `sgnodes` reports `Channel not running`.
- **Not the test build**: E2E targets the normal app build (the test build pegs the thread). Document this.

## CLI surface

```
brighttest e2e run <flow...>        # run one or more flow files
brighttest e2e run flows/           # a directory of *.e2e.yaml
brighttest e2e inspect              # dump the live sgnodes tree (authoring aid: find ids/text/subtypes)
brighttest e2e record               # (Phase 3) capture keypresses → scaffold a flow

Options: --host <ip> --password <pw> (reuse --device conventions; also ROKU_HOST/ROKU_PASSWORD env),
         --app <id> (default dev), --timeout <sec>, --screenshots <dir>, --json/--junit (reuse reporters).
```

Reuses: device host/password handling, `lib/reporter.js` (grouped ✓/✗, failure detail), JUnit output,
and the positional-subcommand pattern already added for `skills`/`init`.

## Phasing & effort

- **Phase 1 — scripted E2E (small).** `ecp.js`, `sgnodes.js` (retry+settle+parse), `select.js`,
  `flow.js`, `run.js`; steps: launch/press/pressUntil/assertVisible/assertGone/assertText/waitFor/
  screenshot/back/home; `e2e inspect`. Delivers Maestro-like scripted flows end to end.
- **Phase 2 — smart navigation (medium).** `focus:` path-finding, `assertFocused`, text entry, per-step
  screenshots + on-failure artifacts, richer settle heuristics.
- **Phase 3 — authoring & scale (medium).** `e2e record`, optional build-time `id` auto-injection,
  parallel/multi-device, deep-link matrices, CI recipe (self-hosted runner near a device).

## Open questions

- **Test IDs policy:** reuse `id` vs a dedicated `testId` field vs build-time auto-injection — which do we
  standardize on? (Affects app-side changes.)
- **Screenshots:** worth the dev-password round-trip per step, or only on failure?
- **Flow format:** YAML (needs a tiny parser or a dep) vs JSON (zero-dep, less pretty). Leaning JSON core
  with an optional YAML front-end to keep the no-dependency promise.
- **Scope of the first milestone:** ship Phase 1 against one flow + `inspect`, then iterate.

## Non-goals (for now)

Coordinate/tap gestures (Roku has none), testing arbitrary published channels (works best on your own dev
build), and replacing the Rooibos unit/integration lanes (this is additive).
