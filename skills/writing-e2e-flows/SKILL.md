---
name: writing-e2e-flows
description: Use when writing, running, or debugging brighttest end-to-end UI flows (*.e2e.yaml) that drive a real Roku over ECP — launching the channel, moving focus with the D-pad, typing text, and asserting on the live SceneGraph. Also use when the user points at a node on screen and wants an assertion built for it: `inspect <selector>` dumps all of that node's fields and generates ready-to-paste (or auto-appended) assertions. Covers the author-first workflow (inspect → write → run), the flow file format, selectors, focus navigation, authoring tools (inspect/record/stamp), scaling across devices, and the pitfalls unique to Roku's focus-based, no-tap model.
license: MIT
metadata:
  source: brighttest
---

# Writing brighttest E2E flows

`brighttest e2e` is a **deterministic, author-first UI testing lane** for Roku. Where the Rooibos lanes
test your BrightScript *logic* (headless or on device), the e2e lane tests the *running app* the way a
person would: it launches the channel, reads what's actually on screen, drives the remote, and asserts on
the resulting UI — on a **real device**. Think Maestro, adapted to Roku's focus-based, no-tap model.

No model is in the loop: you write a readable YAML flow and watch it run. It's fully deterministic and
CI-ready. For *logic* tests, use the `writing-rooibos-tests` skill instead — this lane is **additive**,
covering the handful of critical journeys only a real device can prove.

## How it works (all stock ECP — nothing to install on the device)

- **Read** the screen — `GET /query/sgnodes/all` returns the live SceneGraph tree; selectors match against it.
- **Act** — `POST /keypress/<key>` drives the remote (Up/Down/Left/Right/Select/Back, text via `Lit_`).
- **Select** — a node's built-in `id` (surfaced as the `name=` attribute) is the stable hook; `text`/`subtype` work with no app changes.
- **See** — the dev screenshot endpoint captures per-step PNG/JPG artifacts.

## Requirements — check these first, they cause most "it won't connect" failures

1. A Roku in **developer mode** on the same LAN (its IP + dev password).
2. **ECP Network access = Permissive** — `Settings → System → Advanced system settings → Control by mobile
   apps → Network access → Permissive`. Without it, `sgnodes`/`keypress` are refused (`Limited mode` / HTTP 403).
3. The **normal app build sideloaded**, *not* the Rooibos test build (that build pegs the render thread).

## The author-first workflow

Always author against what's really on screen — never guess ids.

```bash
# 1. See the live tree — discover ids / text / subtypes to target
npx brighttest e2e inspect --host <roku-ip> --app dev

# 2. Write flows/<journey>.e2e.yaml (see below)

# 3. Run it (screenshots default to one per step)
npx brighttest e2e run flows/<journey>.e2e.yaml --host <roku-ip> --password <dev-pw>
```

Output is the same grouped ✓/✗ view as the other lanes, with expected-vs-actual detail and a line number
on failure. Exit code: `0` success · `1` failed step · `2` usage/preflight error.

## Building an assertion for a node you see on screen

When the user points at something on screen and asks for an assertion, **inspect that specific node first**
— never guess its fields. Pass a selector to `inspect` and it switches from the tree summary to a per-node
detail view: every field Roku dumps for the node, plus ready-to-paste assertions built from its *actual*
state (visible text becomes the `equals:` value, a focused node gets an `assertFocused`, and so on).

```bash
# Target the node by id / text / subtype / focus — any combination narrows it (AND):
npx brighttest e2e inspect --host <ip> --id playButton
npx brighttest e2e inspect --host <ip> --text "Play"
npx brighttest e2e inspect --host <ip> --focused          # "the thing I've got selected right now"
```

```
Node  Button #playButton "Play"
  fields (all sgnodes attrs):
    name    = playButton
    text    = Play
    focused = true
    visible = true
    bounds  = {820, 400, 280, 64}
  match: unique (1 node)

  Suggested assertions (copy into a flow):
    - assertVisible: { id: playButton }
    - assertText: { id: playButton, equals: Play }
    - assertFocused: { id: playButton }
```

If the node's best selector isn't unique, the suggestion is disambiguated with `index:` automatically, and
the `match:` line says how many nodes share it — so the user can confirm they're asserting on the right one
before committing. **Append** the assertion straight into a flow with `--out` (created if missing):

```bash
npx brighttest e2e inspect --host <ip> --id playButton --out flows/home.e2e.yaml --assert text
#   → appended to flows/home.e2e.yaml   - assertText: { id: playButton, equals: Play }
```

`--assert` picks which one: `visible` (default) · `text` · `focused` · `gone`. As the agent, the good loop
is: run `inspect <selector>` → show the user the fields and the suggested assertions → on their confirmation
append the one they want (or paste it at the right point in the flow yourself). Full detail in
[authoring.md](references/authoring.md).

## Minimum viable flow

```yaml
# flows/home.e2e.yaml
appId: dev                          # channel to launch (default: dev); --app overrides
config: { timeout: 8 }              # optional per-flow overrides (currently: timeout, seconds)
steps:
  - launch
  - assertVisible: { id: homeScreen }
  - focus: { id: settingsTile }     # D-pad path-find onto the node (does NOT Select)
  - press: Select
  - assertVisible: { id: settingsScreen }
  - assertText: { id: headerLabel, equals: "Settings" }
  - back
  - assertVisible: { id: homeScreen }
```

A step is a **bare word** (`launch`, `back`, `home`) or a **single-key map** (`press: Select`,
`assertVisible: { id: x }`). It's a deliberately small YAML subset — anything outside it raises a clear,
line-referenced error rather than being silently misparsed.

## The rules that bite hardest

Follow these five or your flows will fail to connect, flake, or silently pass. Symptoms and fixes are in
[pitfalls.md](references/pitfalls.md).

1. **Selectors use `id`, not `testId`.** `sgnodes` only dumps a fixed set of built-in fields; a node's `id`
   surfaces as `name=`. A dedicated `testId` is **invisible**. No ids in the app? Use `text`/`subtype`, add
   ids by hand, or auto-inject them with `stamp` — see [authoring.md](references/authoring.md).
2. **There is no tap.** "Click X" means moving focus to X with the D-pad. Use `focus: <selector>`, then a
   separate `press: Select`. `focus` only navigates.
3. **Lead with a `focus:` to a known anchor.** `focus` drives from wherever focus *currently* is, and
   relaunching a running channel does **not** reset focus. Don't assume the initial focus position.
4. **Prefer assertions over sleeps.** `assertVisible`/`assertGone`/`assertText` **poll** until satisfied or
   the step timeout elapses, so screens get time to settle — you rarely need `waitFor`. A flow is fail-fast:
   it stops at its first failing step.
5. **Stamp a copy, never the shipping build.** Injected ids are for tests only; keep the release build
   clean and prefer meaningful hand-written ids on the nodes you assert on most.

## Reference files — read the one you need

- **[references/flow-reference.md](references/flow-reference.md)** — every step, all selector keys/filters,
  focus navigation tuning, text entry, and a complete search-flow example. Read this while writing a flow.
- **[references/authoring.md](references/authoring.md)** — `inspect`, interactive `record`, and `stamp`
  (making an un-annotated app selectable, incl. the BrighterScript plugin form). Read this to go from a
  running app to a flow.
- **[references/scaling-ci.md](references/scaling-ci.md)** — screenshots, session video, multi-device
  sharding (incl. per-host `ip:pw`), the deep-link `--content-id` matrix, and the self-hosted CI workflow.
- **[references/pitfalls.md](references/pitfalls.md)** — every common mistake as Symptom → Cause → Fix.
  Read this when a flow won't connect, flakes, or a selector never matches.
