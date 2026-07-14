# End-to-end (on device)

`brighttest e2e` is a **deterministic, author-first UI testing lane** for Roku. Where the Rooibos lanes
test your BrightScript logic, the e2e lane tests the running app the way a person would: it launches the
channel, reads what's actually on screen, drives the remote (D-pad, Select, text), and asserts on the
resulting UI — on a **real device**. Think Maestro, adapted to Roku's focus-based, no-tap model.

It is fully deterministic — you write a readable flow file and watch it run. No model is in the loop.

## How it works

Everything rides on stock Roku ECP — no on-device test library to install:

- **Read the screen** — `GET /query/sgnodes/all` returns the live SceneGraph tree (subtype, bounds,
  focus, text, …). Selectors match against it.
- **Act** — `POST /keypress/<key>` drives the remote (Up/Down/Left/Right/Select/Back, text via `Lit_`).
- **Select** — a node's built-in `id` (dumped as the `name=` attribute) is the stable hook; text and
  subtype work with no app changes.
- **See** — the dev screenshot endpoint captures per-step PNG/JPG artifacts.

## Requirements

- A Roku in **developer mode** on the same LAN (its IP + developer password).
- **ECP Network access = Permissive** — `Settings → System → Advanced system settings → Control by
  mobile apps → Network access → Permissive`. Without this, `sgnodes` and `keypress` are refused
  (`Limited mode` / HTTP 403).
- The **normal app build** (not the Rooibos test build, which pegs the render thread).

## Quick start

```bash
# 1. See what's on screen right now (find ids / text / subtypes to target)
npx brighttest e2e inspect --host <roku-ip> --app dev

# 2. Write a flow (flows/home.e2e.yaml)
```

```yaml
appId: dev
steps:
  - launch
  - assertVisible: { id: homeScreen }
  - focus: { id: settingsTile }     # arrow-key path-finding to the node
  - press: Select
  - assertVisible: { id: settingsScreen }
  - assertText: { id: headerLabel, equals: "Settings" }
  - back
  - assertVisible: { id: homeScreen }
```

```bash
# 3. Run it (screenshots default to one per step)
npx brighttest e2e run flows/home.e2e.yaml --host <roku-ip> --password <dev-pw>
```

Output is the same grouped ✓/✗ view as the other lanes, with expected-vs-actual detail and a line number
on failure. Exit code is `0` on success, `1` on a failed step, `2` on a usage/preflight error — CI-ready.

## Where to go next

- **[Flow reference](/e2e/flows)** — the flow file format, every step, selectors, focus navigation, text entry.
- **[Authoring flows](/e2e/authoring)** — `inspect`, `record`, and making an app selectable (`stamp`).
- **[Scaling & CI](/e2e/scaling)** — multiple devices, deep-link matrices, screenshots/video, and CI.

::: tip This lane is additive
It doesn't replace the Rooibos unit/integration lanes — it complements them. Keep unit tests fast and
headless; use e2e for the handful of critical user journeys that only a real device can prove.
:::
