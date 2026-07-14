# Design: `brighttest e2e` — on-device end-to-end UI testing

Status: **draft / RFC** · Branch: `feat/e2e` · Prereq spike: `experiments/FINDINGS.md` (confirmed on device)

## Decisions (resolved)

- **Selectors: the built-in `id` is the hook.** Probe 2 (see FINDINGS.md) proved a dedicated `testId`
  field is **invisible to `sgnodes`** — custom fields aren't dumped, however they're declared. Only a
  fixed set of built-in fields surface, and the node's `id` appears there as the **`name=`** attribute
  *and* resolves via the fast `sgnodes/nodes?node-id=` path. So the earlier "prefer a test-only `testId`"
  decision is dropped: teams set the built-in `id`. See [Test IDs](#test-ids--making-the-app-selectable).
- **Flow format: YAML** (dropping the earlier JSON-core idea). Compiles to one internal step model, so
  the front-end stays pluggable. **YAML is the shipping front-end**; a **Gherkin/Cucumber** front-end on
  the same IR is parked in a *maybe* bucket — revisit only if teams ask for the BA-readable style. See
  [The flow format](#the-flow-format-author-first).

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
  `visible`, `text`, `uri`, `children`, and the node's `id` as **`name=`**). `roots` and
  `nodes?node-id=<id>` variants too. Only built-in fields are dumped — custom fields do not appear.
- Act: `POST /keypress/<key>` (Up/Down/Left/Right/Select/Back/Home/Play/Info/Search/Enter/Backspace,
  `Lit_<char>` for text, Volume/Input keys). `POST /launch/<dev|id>?contentID=…&MediaType=…` for deep links.
- Visual proof: dev screenshot endpoint (needs dev password) for per-step / on-failure PNGs.
- Constraints: channel must be running; `sgnodes` is a render-thread RPC that **times out when busy** →
  retry+settle; app should set `id`s; dev mode + host/password (already used by `--device`); ECP
  **network access must be Permissive** or `sgnodes`/`keypress` are refused (Limited-mode 403).

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
  - assertVisible: { id: homeScreen }            # poll sgnodes until present (timeout) else fail
  - focus:        { id: settingsTile }           # arrow-key path-find to this node
  - press: Select
  - assertVisible: { id: settingsScreen }
  - assertText:   { id: headerLabel, equals: "Settings" }
  - press: Back
  - assertVisible: { id: homeScreen }
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

**Decided:** build the internal step model + runner first, ship **YAML** as the initial front-end
(fastest to a working demo, matches the Maestro mental model), then layer **Gherkin** on the same IR for
teams who want the Cucumber style.

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
{ id: settingsTile }                 # built-in id → GET /query/sgnodes/nodes?node-id=settingsTile (fast path)
{ subtype: Poster, text: "Play" }    # by node type + field
{ text: "Continue watching" }        # by visible text
{ subtype: RowList, index: 0 }       # nth match
```

Resolution:

- **`{ id }`** uses the direct `sgnodes/nodes?node-id=` endpoint (fastest, exact) and falls back to
  matching the **`name=`** attribute in the full tree — because `sgnodes` serializes a node's `id` as
  `name` (proven in probe 2). This is the only stable named hook; a dedicated `testId` field is **not**
  available (custom fields aren't dumped).
- The rest (`subtype`, `text`, `uri`, `index`) work with no app changes, so flows can be written before
  any ids exist. Any selector can be constrained by `visible: true` / `focusable: true`.

Preference order for stability: `id` → text/subtype.

## Test IDs — making the app selectable

Probe 2 settled how this must work: a custom `testId` field is **invisible to `sgnodes`** (tested five
ways — interface-declared, runtime `addField`, inline attribute, code-created node — none surfaced), so
the hook is the **built-in `id`**, which `sgnodes` dumps as `name=` and resolves via `node-id=`.

1. **`id` — the hook.** Set a stable, meaningful `id` on the nodes flows target (in XML or BrightScript).
   `{ id: … }` resolves through the direct `sgnodes/nodes?node-id=` endpoint and matches `name=` in the
   full tree. This is the only reliable named selector.
   - Caveat: `id` is a real SceneGraph field, so pick values that don't collide with app logic that keys
     off `id`. A convention like an `e2e_`/`qa_` prefix keeps test hooks obvious and namespaced.
2. **Text / subtype / index — zero-annotation fallback.** Works with no app changes, so flows can be
   written before any ids exist; less stable across copy/layout changes.
3. **Auto-injection at build (Phase 3 — _implemented_).** `lib/e2e/stamp-ids.js` stamps a stable
   `id` (`e2e_<Subtype>_<n>`) onto every id-less SceneGraph node in a component's `<children>`, so an
   un-annotated app becomes fully selectable. Two entry points: a **BrighterScript plugin** (add to a
   bsconfig's `plugins`; rewrites XML in `beforeFileParse`) and a **source transform** exposed as
   `brighttest e2e stamp <src> --out <dir>`. Nodes that already have an `id` are left alone (manual ids
   win; re-running is idempotent). Verified on device: injected ids surface as `name=` and are selectable.

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
  `sgnodes` reports `Channel not running`, and if it reports `ECP command not allowed in Limited mode`
  (or `keypress` returns 403) point the user at **Control by mobile apps → Network access → Permissive**.
- **Not the test build**: E2E targets the normal app build (the test build pegs the thread). Document this.

## Screenshots

**Decided: per-step by default, configurable down to on-failure-only.** Each captured step saves a PNG
from the dev screenshot endpoint (dev-password round-trip) into `--screenshots <dir>`, giving a visual
filmstrip of the run; the reporter links the failing step's shot in its failure detail. Because every
capture is a device round-trip, `--screenshots-mode` tunes the cost:

```
--screenshots-mode all       # default — one PNG per step (filmstrip)
--screenshots-mode failure   # only capture when a step fails (cheapest)
--screenshots-mode off       # never capture
```

(`--screenshots <dir>` sets the output dir; absent → a run-scoped default under the artifacts dir.)

## CLI surface

```
brighttest e2e run <flow...>        # run one or more flow files
brighttest e2e run flows/           # a directory of *.e2e.yaml
brighttest e2e inspect              # dump the live sgnodes tree (authoring aid: find ids/text/subtypes)
brighttest e2e record [-o <file>]   # interactively drive the device → scaffold a flow
brighttest e2e stamp <src> -o <dir> # copy a project, injecting ids onto un-annotated nodes (E2E build)

Options: --host <ip[:pw][,ip[:pw]…]> --password <pw> (reuse --device conventions; also ROKU_HOST/
         ROKU_PASSWORD env; multiple hosts shard flows across devices in parallel; inline ip:pw gives a
         per-device password), --app <id> (default dev),
         --content-id <a,b,…> --media-type <t> (deep-link matrix), --timeout <sec>, --screenshots <dir>,
         --screenshots-mode <all|failure|off> (default all), --out <file> (record).
```

Reuses: device host/password handling, `lib/reporter.js` (grouped ✓/✗, failure detail), JUnit output,
and the positional-subcommand pattern already added for `skills`/`init`.

## Phasing & effort

- **Phase 1 — scripted E2E (small).** `ecp.js`, `sgnodes.js` (retry+settle+parse), `select.js`,
  `flow.js` (YAML front-end), `run.js`; steps: launch/press/pressUntil/assertVisible/assertGone/
  assertText/waitFor/screenshot/back/home; `id`/text/subtype selectors; screenshots (`all` default +
  `failure`/`off` modes); `e2e inspect`. Delivers Maestro-like scripted flows end to end.
- **Phase 2 — smart navigation (medium).** `focus:` path-finding, `assertFocused`, **text entry into
  input fields**, richer settle heuristics. (Gherkin front-end moved to a *maybe* bucket.)
  - **Text entry — two approaches to weigh.** (1) *Keyboard-less* `Lit_` direct injection (the Phase 1
    `text` step) — fast, no navigation; relies on the focused field/keyboard accepting ECP character
    keys. (2) *On-screen keyboard navigation* — `focus` each key on the virtual keyboard grid and
    `Select`, char by char — slow and brittle but works when a custom keyboard ignores `Lit_`. Verify
    (1) against a real `Keyboard`/input on the target firmware; keep (2) as a fallback (e.g. a
    `typeOnKeyboard` step) only if (1) proves insufficient. See open questions.
- **Phase 3 — authoring & scale (_implemented_).** `e2e record` (interactive scaffolder), build-time
  `id` auto-injection (`stamp-ids.js` plugin + `e2e stamp`), multi-device parallel runs (`--host` accepts
  a comma list; flows shard across devices), deep-link matrices (`--content-id a,b,…` runs each flow per
  contentId), and a CI recipe (`.github/workflows/e2e-device.yml` — manual, self-hosted runner near a
  device). Multi-device sharding is verified live on two Roku Ultras (3 flows across 2 devices in
  parallel, 35/35 steps). Devices with different dev passwords are supported via inline `--host ip:pw`
  (falling back to `--password`), so screenshots/video work across a mixed fleet — also verified live.

## Open questions

- **First milestone scope:** Phase 1 against one real flow + `e2e inspect`, then iterate.
- **Real-app `id` coverage:** re-audit the actual CBS build for `name=` (i.e. set `id`s) — the old "0 ids"
  was a grep artifact — to gauge how much manual `id` annotation Phase 1 needs before flows are stable.
- _(Resolved, probe 3)_ **Text entry:** keyboard-less `Lit_` injection lands text in a real `Keyboard`
  on fw 15.2.4 (spaces + Backspace included) — the `text` step suffices; no `typeOnKeyboard` fallback
  needed unless a custom keyboard ignores `Lit_`.

_Resolved: selectors use the built-in **`id`** (surfaced as `name=`, resolved via `node-id=`); a dedicated
`testId` field is not viable — custom fields aren't dumped by `sgnodes` (probe 2). Flow format is YAML
first, Gherkin later, over a shared step model (JSON-core idea dropped). Screenshots per-step by default,
configurable to `failure`/`off`._

## Non-goals (for now)

Coordinate/tap gestures (Roku has none), testing arbitrary published channels (works best on your own dev
build), and replacing the Rooibos unit/integration lanes (this is additive).
