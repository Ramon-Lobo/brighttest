# E2E spike — findings

Spike scripts: `ecp-spike.mjs`, `capture-tree.mjs`, plus the `testId` probe channel
(`scratchpad/testid-probe`, not committed). Run against a real Roku Ultra (firmware **15.2.4**,
1080p) on the LAN. Goal: confirm we can (1) read the on-screen SceneGraph tree, (2) act on it via the
remote, and (3) select elements — the primitives an E2E lane needs. **Confirmed.**

## What works (verified on device)

| Capability | Endpoint | Result |
|---|---|---|
| Device/firmware info | `GET /query/device-info` | ✅ 200 — Roku Ultra, fw 15.2.4 (>> OS 12, so `sgnodes` tree supported) |
| Launch a channel | `POST /launch/dev` | ✅ 200/204 — dev channel launched |
| Press remote keys | `POST /keypress/<Up\|Down\|Left\|Right\|Select\|Back\|Home\|…>` | ✅ 200/202 accepted |
| **Read the screen** | `GET /query/sgnodes/all` | ✅ returned a **208 KB tree, 1,483 nodes, 77 subtypes** (Poster×99, Rectangle×76, Label×70, LayoutGroup×64, ContentMetaData×23, Animation×25…), with `text=` values |
| Find by id | `GET /query/sgnodes/nodes?node-id=<id>` | ✅ confirmed (probe 2) — resolves a node's built-in `id`; the selector fast path |

## Node schema (from Roku ECP docs, confirmed against the tree)

Each node is an XML element named by its **subtype** (e.g. `<Poster …/>`, `<Label …/>`) with attributes:
`_sn`, `_psn`, `bounds`, `children`, `name`, `opacity`, `visible`, `focusable`, `focused`, `thread`,
`extends`, `translation`, `uri`, `color`, `text`, `loadStatus`, `bscref`/`osref`/`rcid` (internal refs).

→ We get **focus** (`focused="true"`), **geometry** (`bounds`, `translation`), **visibility**, **text**,
**uri**, and **subtype** for free. That's enough for selectors + focus-pathfinding.

**The node's `id` field is dumped as the `name=` attribute** (not `id=`). This is only a *fixed* set of
built-in fields — see probe 2 below; **arbitrary custom fields are not dumped at all**.

## Probe 2 — do custom `testId` fields surface? (verified on device)

Sideloaded a 9-node probe channel (`scratchpad/testid-probe`) that set a test hook five different ways,
then read `sgnodes/all`. Result: **only the built-in `id` surfaces (as `name=`); no custom field does.**

| Case | How the hook was set | In `sgnodes/all`? |
|---|---|---|
| A | built-in `id="…"` in XML on a stock node | ✅ as **`name="…"`** |
| B | `testId` declared on the component `<interface>`, set in XML | ❌ absent |
| C | `addField("testId", …)` on a stock node at runtime, set | ❌ absent |
| D | undeclared `testId="…"` attribute inline in XML | ❌ absent |
| E | code-created node + `addField("testId")` + set | ❌ absent |

`node-id=labelBuiltinId` and `node-id=widgetIfaceField` both **resolved** via
`GET /query/sgnodes/nodes?node-id=<id>` — confirming that query matches the built-in `id`.

**Consequence for the design:** a dedicated `testId` field is not viable (invisible to `sgnodes`). The
selector hook must be the built-in **`id`**, matched against `name=` in the tree, with `node-id=` as the
fast path. Any build-time stamping must write `id`, not a custom field.

## Probe 3 — text entry: keyboard-less `Lit_` vs on-screen navigation (verified on device)

Sideloaded a `Keyboard` fixture (`scratchpad/kb-fixture`) and typed into it purely via ECP `Lit_`
keypresses — **without** moving focus over the on-screen key grid. Result: **keyboard-less injection
works**, including spaces and `Backspace`.

- `POST /keypress/Lit_<char>` types directly into the focused `Keyboard`; its `text` updated to
  `hello world` with the D-pad cursor never touching a key (visual proof captured).
- **Gotcha:** the char must be URL-encoded **exactly once**. Pre-encoding then re-encoding turns a space
  into `Lit_%2520` → **HTTP 400** (letters were unaffected, which masked the bug). Fixed in `ecp.js`.
- `Backspace` clears the field; useful because a `Keyboard` **persists its text** across relaunches
  (launch doesn't re-init), so deterministic flows should clear before typing.
- A `Keyboard` expands to internal nodes (`VKBGrid`, posters); the deepest focused node is the grid, so
  target the `Keyboard`'s own `id` when focusing it.

**Consequence for the design:** the Phase 1 `text` step (Lit_ injection) is sufficient for the standard
Roku keyboard — no key-grid navigation needed. An on-screen `typeOnKeyboard` fallback is only warranted
if a custom keyboard ignores `Lit_`; not needed here.

## Key constraints discovered (shape the design)

1. **`sgnodes` only works while a channel is running.** On the Roku home screen it returns
   `FAILED: Channel not running` (older firmware appended `: active UI`; the exact tail on 16.0.4 was not captured). Match on the `Channel not running` prefix. Other endpoints (`active-app`, `device-info`) still answer on the home screen.
2. **`sgnodes` is an RPC on the app's render thread and times out when that thread is busy** — we hit
   `query-sgnodes command exception: Plugin RPC event timed out` repeatedly while the channel was busy.
   The runner must **retry with backoff** and **wait for the UI to settle** after each action. The current
   installed dev build is the *test* build (auto-runs the full Rooibos suite on launch), which pegs the
   thread — so E2E must target a **normal, responsive app build**, not the test build.
3. **Reliable selection needs `id`s on components** (`id="…"`), which surface as `name=` and make
   `sgnodes/nodes?node-id=…` a direct lookup. (The original spike's "`id=` count was 0 across 1,483
   nodes" was a **measurement artifact** — it grepped `id="…"`, but Roku serializes the id field as
   `name="…"`. Re-check the real app against `name=` before assuming it's unlabelled. Custom `testId`
   fields are a dead end — see probe 2.)
4. **Navigation is D-pad focus, not tap** — no coordinate tap exists. "Click X" = move focus to X (arrow
   presses computed from `focused` + `bounds`), then `Select`.
5. Requires **developer mode** (same host/password the `--device` lane already uses). ECP itself needs no
   auth; the dev screenshot endpoint does.
6. **ECP network access must be Permissive.** `sgnodes` and `keypress` are refused
   (`ECP command not allowed in Limited mode.` / HTTP 403) unless the device's
   **Settings → System → Advanced → Control by mobile apps → Network access** is set to **Permissive**.
   The lane's preflight should detect this and fail with that exact guidance.

## Conclusion

All three asks are feasible on stock firmware with no on-device library injection — `sgnodes` (read) +
`keypress` (act) + `node-id` query (select). The real engineering is: settle/retry logic, focus
path-finding, a deterministic flow format, and getting test IDs onto components. See `design/e2e-lane.md`.

## Device verification batch 2026-11-19 — Roku Ultra 4850CA, firmware 16.0.4 (build 853)

**Verified on device (fw 16.0.4, 2026-11-19).** Raw data and repro were kept in the owner's local planning folder, not in this repo.

- brighttest lanes pass: `--device` 13/13, `--cross-check` 13 agree / 0 divergent, e2e `search` and `play-a-title` 3/3 each. Studio overlay math matches a screenshot.
- `/query/app-ui` has the same nodes/bounds/text/names as `sgnodes/all`; it omits plain `Node` children and `_sn,_psn,osref,bscref,thread`, adds `index`, wraps in `<topscreen><screen type="SGScreen">`. When the app thread is blocked it returns HTTP 200 with `<error>Internal error</error>`; sgnodes returns `FAILED ... Plugin RPC event timed out` after ~7 s.
- Custom fields (interface, `addField`, assoc arrays) are not in either dump; `Group` is dumped as `RenderableNode`; `>` is not escaped in attribute values, `<` is `&lt;`.
- Hidden `Label` text up to 256 KB is dumped intact (`sgnodes/all` 851 ms / 526 KB at 256 KB; `nodes?node-id=` 470 ms). Tree of 1,500 nodes: 0.33 s / 178 KB; 6,000: ~3.5 s / 715 KB; 16,000: 3.4 s / 1.9 MB.
- `POST /input?k=v`: reaches main-thread `roInput` and Task-owned `roInput` (both); ordered; query value limit ~4,000 chars (4,200 -> 400); POST body ignored; unencoded `:` `/` -> 404. `POST /launch/dev?k=v` while running relaunches the app.
- `getAll()`/`getRoots()` exist (`getAll` over 16k nodes 50 ms); `callFunc` on a running Task works. `GET /query/registry/<id>` -> `FAILED: Device not keyed`.
- 8080 console commands (no set/eval): chanperf, free, fps_display, loaded_textures, logrendezvous [on|off], plugins, press, r2d2_bitmaps, sgnodes, sgperf, target, type, bsprof-*, clear_launch_caches, genkey, showkey, remove_plugin. **Default target is `main`**; send `target <channel title>` before `sgperf`/`loaded_textures`/`chanperf`.
- 8085 replays buffered history on connect; 5,000 lines in ~5.5 s received with 0 loss; a runtime error drops it to `Brightscript Debugger>` and freezes the app (Home press exits).
- `active-app` shapes on 16.0.4: `<app>Roku</app>` (idle), `native-ui` (transient, ~340 ms after Home), `Roku Dynamic Menu` id 562859 type home. Installer Delete 1.3 s; sideload returns after the app is up; screenshot works immediately after sideload; ECP `capture-screen*` 404; Home screen -> `Screenshot not ok`.
- Cold `POST /launch/dev` from Home: first `sgnodes/all` stalls ~7 s then `FAILED`, next call OK.
- roUrlTransfer (LAN hub): 200/200 sync and async OK (avg 16 / 11 ms). Codes: refused -7, DNS -6, reset -52, redirect loop -47 (16), too-slow -28, TLS name mismatch -60, HTTP 4xx/5xx with retained body; no total timeout (caller cancels). Sync API has no `GetResponseCode`. 10 MB GET, 8 MB POST OK.
- Engine fidelity: invalid->scalar field resets to type default; vector/rect/floatarray/translation elements are floats; `Poster.loadDisplayMode` lowercased; detached `findNode` returns the node; `Label.forceUpperCase` does not exist; `Str(3000000000&)`=`" 3e+09"`; `for each` over AA is key-sorted; `Eval` is a compile error without `rsg_version=1.1`; `GetLastRun` absent; `roUserInfo/roProfile/roPerfetto` exist; `ContentNode.update()` and `FromISO8601String()` are subs (using the return throws).
- brighttest bugs seen: Studio sgdebug lacks `target`, `logrendezvous status` invalid, perf cadence ~2 s for 1 s interval (details and repro in the brief).

## Device matrix

Devices used for brighttest device verification. Serials, LAN addresses and passwords are never recorded.

| Device | Model | Firmware (build) | ECP mode | Dev mode | Recorded | Source |
|---|---|---|---|---|---|---|
| 1 | Roku Ultra 4850CA | 16.0.4 (853) | not recorded | enabled | 2026-11-19 | device verification batch above |
| 2 | Roku Ultra 4850CA | 16.0.4 (853) | permissive | enabled | 2026-11-23 | `brighttest doctor`: reachable, ecp-mode, developer-mode, hub-bind all pass; hub reach not proven by doctor (TP-NET-20) |

**Verified on device (fw 16.0.4, 2026-11-23).** The second device matches the first on model and firmware, so the 16.0.4 baseline holds for both.
