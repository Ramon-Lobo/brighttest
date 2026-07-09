# Design: `brighttest e2e` — on-device end-to-end UI testing

Status: **draft / RFC** · Branch: `feat/e2e` · Prereq spike: `experiments/FINDINGS.md` (confirmed on device)

## Decisions (resolved)

- **Selectors: support both a dedicated `testId` and the built-in `id`.** `testId` is the recommended,
  test-only hook (doesn't affect app behaviour); `id` is supported too and gets the fast
  `sgnodes/nodes?node-id=` lookup. See [Test IDs](#test-ids--making-the-app-selectable).
- **Flow format: YAML or Gherkin/Cucumber** (dropping the earlier JSON-core idea). Both compile to one
  internal step model, so the front-end is pluggable. See [The flow format](#the-flow-format-author-first).
  Remaining sub-decision: ship YAML first, Gherkin first, or both.

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
flow (.yaml / .feature)
   │  parse → shared step model
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
- `lib/e2e/flow.js` — front-ends (YAML and Gherkin) that parse + validate a flow file into the shared step
  model; the runner never sees the source format.
- `lib/e2e/run.js` — the lane: execute steps, assert, report, exit code. Wired into `bin/cli.js` as
  `brighttest e2e …` (a positional subcommand, like `skills`/`init`).

## The flow format (author-first)

Two candidate front-ends, **YAML** and **Gherkin/Cucumber**, both parsing to one internal **step model**
(the IR the runner executes). Keeping the runner format-agnostic means we can ship one now and add the
other later without touching the executor — and teams can even mix per-file by extension
(`*.e2e.yaml` / `*.feature`).

### Option A — YAML (Maestro-style, imperative)

```yaml
# flows/home-to-settings.e2e.yaml
appId: dev            # dev channel (default), or a published channel id
config: {}            # optional per-flow overrides (timeouts, device)

steps:
  - launch                                       # launch appId (optionally: launch: { contentId, mediaType })
  - assertVisible: { testId: homeScreen }        # poll sgnodes until present (timeout) else fail
  - focus:        { testId: settingsTile }       # arrow-key path-find to this node
  - press: Select
  - assertVisible: { testId: settingsScreen }
  - assertText:   { testId: headerLabel, equals: "Settings" }
  - press: Back
  - assertVisible: { testId: homeScreen }
  - screenshot: back-home.png                    # artifact (optional)
```

Direct, low-ceremony, closest to the Maestro analogy. Needs a YAML parser (lazy-loaded `yaml` dep, or a
small subset parser) — pulled in only for the e2e lane.

### Option B — Gherkin / Cucumber (Given/When/Then, BA-readable)

```gherkin
# flows/home-to-settings.feature
Feature: Settings navigation

  Scenario: Open settings from home
    Given the app is launched
    And I see "homeScreen"
    When I focus "settingsTile" and press Select
    Then I see "settingsScreen"
    And "headerLabel" shows "Settings"
    When I press Back
    Then I see "homeScreen"
```

Reads like spec English and suits non-devs writing flows, at the cost of a **step-definition layer** that
maps each phrase to an action. We ship a built-in step library (the phrases above) covering the standard
vocabulary; projects can add their own step defs later. Parser: the official `@cucumber/gherkin` (lighter
than full `@cucumber/cucumber`) or a minimal Gherkin reader — lazy-loaded for the e2e lane.

**Recommendation:** build the internal step model + runner first, add **YAML** as the initial front-end
(fastest to a working demo, matches the Maestro mental model), then layer **Gherkin** on the same IR for
teams who want the Cucumber style. Either can be first — this is the one remaining sub-decision.

### Step vocabulary (the shared model — both front-ends target this)

Phase 1 unless noted:

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
{ testId: settingsTile }             # dedicated test hook (preferred) — matched from the sgnodes tree
{ id: settingsTile }                 # built-in id → GET /query/sgnodes/nodes?node-id=settingsTile (fast path)
{ subtype: Poster, text: "Play" }    # by node type + field
{ text: "Continue watching" }        # by visible text
{ subtype: RowList, index: 0 }       # nth match
```

Resolution:

- **`{ id }`** uses the direct `sgnodes/nodes?node-id=` endpoint (fastest, exact) and falls back to
  matching the `id` attribute in the full tree.
- **`{ testId }`** matches the `testId` attribute in the fetched tree (no dedicated endpoint — the
  `node-id` query only targets the built-in `id`).
- The rest (`subtype`, `text`, `uri`, `index`) work with no app changes, so flows can be written before
  any ids exist. Any selector can be constrained by `visible: true` / `focusable: true`.

Preference order for stability: `testId` → `id` → text/subtype.

## Test IDs — making the app selectable

The spike found **zero `id`s** in the live tree, so this is a real prerequisite. **We support both a
dedicated `testId` and the built-in `id`** (decision above):

1. **`testId` — the recommended hook.** Add a custom `testId` field to base components (or the specific
   nodes flows target) and set it in XML/BrightScript. It's test-only, so it never collides with app code
   that keys off `id`. The selector engine reads it from the `sgnodes` tree like any other field.
   - **Verify (Phase 1):** confirm custom fields like `testId` actually surface in `sgnodes/all` on the
     target firmware. If a plain custom field isn't dumped, fall back to declaring `testId` in the
     component **interface** (`<field id="testId" type="string" />`) or to option 2.
2. **`id` — supported and fast.** Where a node already has a meaningful `id`, use it: `{ id: … }` resolves
   through the direct `sgnodes/nodes?node-id=` endpoint. Good when an id already exists and is stable.
3. **Auto-injection at build (Phase 3, optional).** brighttest already runs a BrighterScript build for its
   other lanes; a bsc plugin could stamp `testId`s onto nodes (derived from the field/variable name that
   holds them) in an E2E build, so teams get selectors without hand-annotating everything. Keep manual
   `testId`/`id` as the baseline.

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

- **Flow front-end order:** ship **YAML** first, **Gherkin/Cucumber** first, or both together? (Runner/IR
  is shared either way — recommendation: YAML first, then Gherkin.)
- **`testId` visibility:** confirm on the spike that a custom `testId` field appears in `sgnodes/all`;
  decide interface-declared field vs plain field if not (see Test IDs).
- **Screenshots:** per-step (dev-password round-trip each time) or only on failure?
- **First milestone scope:** Phase 1 against one real flow + `e2e inspect`, then iterate.

_Resolved: selectors support both `testId` (preferred) and `id`; flow format is YAML or Gherkin over a
shared step model (JSON-core idea dropped)._

## Non-goals (for now)

Coordinate/tap gestures (Roku has none), testing arbitrary published channels (works best on your own dev
build), and replacing the Rooibos unit/integration lanes (this is additive).
