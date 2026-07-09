# E2E spike — findings

Spike scripts: `ecp-spike.mjs`, `capture-tree.mjs`. Run against a real Roku Ultra (firmware **15.2.4**,
1080p) on the LAN. Goal: confirm we can (1) read the on-screen SceneGraph tree, (2) act on it via the
remote, and (3) select elements — the primitives an E2E lane needs. **Confirmed.**

## What works (verified on device)

| Capability | Endpoint | Result |
|---|---|---|
| Device/firmware info | `GET /query/device-info` | ✅ 200 — Roku Ultra, fw 15.2.4 (>> OS 12, so `sgnodes` tree supported) |
| Launch a channel | `POST /launch/dev` | ✅ 200/204 — dev channel launched |
| Press remote keys | `POST /keypress/<Up\|Down\|Left\|Right\|Select\|Back\|Home\|…>` | ✅ 200/202 accepted |
| **Read the screen** | `GET /query/sgnodes/all` | ✅ returned a **208 KB tree, 1,483 nodes, 77 subtypes** (Poster×99, Rectangle×76, Label×70, LayoutGroup×64, ContentMetaData×23, Animation×25…), with `text=` values |
| Find by id | `GET /query/sgnodes/nodes?node-id=<id>` | available (Roku docs) — the selector path once ids exist |

## Node schema (from Roku ECP docs, confirmed against the tree)

Each node is an XML element named by its **subtype** (e.g. `<Poster …/>`, `<Label …/>`) with attributes:
`_sn`, `_psn`, `bounds`, `children`, `name`, `opacity`, `visible`, `focusable`, `focused`, `thread`,
`extends`, `translation`, `uri`, `color`, `text`, `loadStatus`, `bscref`/`osref`/`rcid` (internal refs).

→ We get **focus** (`focused="true"`), **geometry** (`bounds`, `translation`), **visibility**, **text**,
**uri**, and **subtype** for free. That's enough for selectors + focus-pathfinding.

## Key constraints discovered (shape the design)

1. **`sgnodes` only works while a channel is running.** On the Roku home screen it returns
   `FAILED: Channel not running: active UI`.
2. **`sgnodes` is an RPC on the app's render thread and times out when that thread is busy** — we hit
   `query-sgnodes command exception: Plugin RPC event timed out` repeatedly while the channel was busy.
   The runner must **retry with backoff** and **wait for the UI to settle** after each action. The current
   installed dev build is the *test* build (auto-runs the full Rooibos suite on launch), which pegs the
   thread — so E2E must target a **normal, responsive app build**, not the test build.
3. **The app sets no `id`s today** — `id=` count was **0** across 1,483 nodes. So reliable selection needs
   **test IDs added to components** (`id="…"`), which then makes `sgnodes/nodes?node-id=…` a direct lookup.
4. **Navigation is D-pad focus, not tap** — no coordinate tap exists. "Click X" = move focus to X (arrow
   presses computed from `focused` + `bounds`), then `Select`.
5. Requires **developer mode** (same host/password the `--device` lane already uses). ECP itself needs no
   auth; the dev screenshot endpoint does.

## Conclusion

All three asks are feasible on stock firmware with no on-device library injection — `sgnodes` (read) +
`keypress` (act) + `node-id` query (select). The real engineering is: settle/retry logic, focus
path-finding, a deterministic flow format, and getting test IDs onto components. See `design/e2e-lane.md`.
