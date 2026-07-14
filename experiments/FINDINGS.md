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

## Key constraints discovered (shape the design)

1. **`sgnodes` only works while a channel is running.** On the Roku home screen it returns
   `FAILED: Channel not running: active UI`.
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
