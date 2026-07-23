# E2E pitfalls — Symptom → Cause → Fix

The mistakes that make a flow fail to connect, flake, or falsely pass. For the step/selector reference see
[flow-reference.md](flow-reference.md); for `inspect`/`record`/`stamp` see [authoring.md](authoring.md).

## Connection & preflight

- **`Limited mode` / HTTP 403 on `sgnodes` or `keypress`** → the device isn't Permissive. Set `Settings →
  System → Advanced system settings → Control by mobile apps → Network access → Permissive`.
- **`Channel not running`** → nothing is sideloaded, or the app exited. Pass `--app dev` (or add a `launch`
  step) so the run launches it first.
- **Connects but every read is stale / the render thread is stuck** → you sideloaded the **Rooibos test
  build**, which pegs the render thread. Sideload the **normal app build** for e2e.
- **Exit code 2 before any step runs** → a usage/preflight error (missing `--host`, bad
  `--screenshots-mode`, unparseable flow). Read the message — it names the problem.

## Selectors that never match

- **A selector matches nothing even though the node is clearly on screen** → you're selecting on `testId`
  (or another custom field). `sgnodes` only dumps built-in fields; the app's `id` surfaces as `name=`. Use
  `{ id: … }`, or fall back to `{ text: … }` / `{ subtype: … }`.
- **No ids anywhere in `inspect`** → the app sets none. Add ids by hand to the nodes you target, or
  auto-inject with `stamp` (stamp a *copy* for the e2e build). See authoring.
- **A selector matches the wrong one of several identical nodes** → narrow with a second key or `index: N`
  (0-based), e.g. `{ subtype: RowList, index: 0 }`.

## Focus & navigation

- **`focus:` walks the wrong way or gives up at `maxPresses`** → focus started somewhere unexpected.
  Relaunching a *running* channel does not reset focus, and `focus` drives from wherever it currently is.
  Lead the flow with a `focus:` to a known anchor. For large grids, raise `maxPresses`.
- **`press: Select` does nothing** → you expected a tap. There is no tap: `focus` only *navigates*; you must
  follow it with a separate `press: Select`.
- **Text lands in the wrong field or appends to old text** → you didn't focus the field first, or a
  `Keyboard` persisted text across relaunch. `focus:` the field, then clear with
  `press: { key: Backspace, count: N }` before `text:`.

## Timing & flakiness

- **An assertion fails intermittently right after a transition** → don't add sleeps. Assertions already
  poll until the step timeout (`config.timeout` / `--timeout`, default 10s). Raise the timeout for a slow
  screen, or assert on the element that proves the screen is ready.
- **A whole flow stops early** → flows are fail-fast: the first failing step ends the flow. Read the
  reported `file:line` and the failure screenshot.

## Falsely passing

- **A flow "passes" without proving anything** → it has actions but no `assert*` after the meaningful state
  change. Every journey should assert the screen it navigated to (`assertVisible` + an `assertText` on a
  label), not just that keypresses were sent.

## Artifacts

- **No screenshots produced** → the screenshot endpoint needs the dev `--password`; mode may be `off`; or a
  mixed fleet has a host without an inline `ip:pw`. Give each device a password and set `--screenshots-mode
  all` (or `failure`).
- **`--video` silently produced nothing** → **ffmpeg** isn't on `PATH`. Install it, or drop `--video` and
  keep the per-step screenshots.
