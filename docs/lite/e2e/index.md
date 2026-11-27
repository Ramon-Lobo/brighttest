# End-to-end (on device)

::: info At a glance
**What it is for:** testing the running app on a real Roku the way a person would, with YAML flows.

**You will:**
- Check the device requirements
- Write and run a first flow
- Read timing, exit codes and the hub events file
- Learn what Studio and its Network panel do

**First command:** `npx brighttest e2e inspect --host <roku-ip> --app dev`
:::

## What the lane is

A **deterministic, author-first UI testing lane**: it launches the channel, reads the screen, drives the remote and
asserts on the UI on a **real device**. Rooibos lanes test logic; this tests the running app. Think Maestro, adapted
to Roku's focus-based, no-tap model. No model is in the loop.

::: warning `e2e run` never installs the app
Install first (`brighttest instrument build --sideload` or `brighttest builds install --latest`). With `device lock`,
install and launch after the lock, because it presses Home on acquire (or use `device lock --no-hygiene`).
:::

## How it works

Stock Roku ECP only; nothing to install on the device.

| Job | How |
|---|---|
| Read | `GET /query/sgnodes/all`: live SceneGraph tree (subtype, bounds, focus, text, …) |
| Act | `POST /keypress/<key>`: Up/Down/Left/Right/Select/Back, text via `Lit_` |
| Select | Node `id` (dumped as `name=`) is the stable hook; text and subtype need no app changes |
| See | Dev screenshot endpoint: per-step PNG/JPG |

## Requirements

1. A Roku in **developer mode** on the same LAN (IP and developer password).
2. **ECP Network access = Permissive**: `Settings → System → Advanced system settings → Control by mobile apps →
   Network access → Permissive`. Otherwise `sgnodes` and `keypress` are refused (`Limited mode` / HTTP 403).
3. The **normal app build**, not the Rooibos test build (it pegs the render thread).

## Quick start

1. See what is on screen: `npx brighttest e2e inspect --host <roku-ip> --app dev`
2. Write `flows/home.e2e.yaml`:

   ```yaml
   appId: dev
   steps:
     - launch
     - assertVisible: { id: homeScreen }
     - focus: { id: settingsTile }     # arrow-key path-finding to the node
     - press: Select
     - assertText: { id: headerLabel, equals: "Settings" }
     - back
     - assertVisible: { id: homeScreen }
   ```

3. Run it (one screenshot per step by default):
   `npx brighttest e2e run flows/home.e2e.yaml --host <roku-ip> --password <dev-password>`

Output is the grouped ✓/✗ view of the other lanes, with expected-vs-actual and a line number on failure. Exit `0`
success, `1` failed step, `2` usage/preflight error.

### Step timing and the hub events file

Each step line shows `step time: 12 ms` (`Date.now()` around the step, not its screenshot). The run ends with
`timing: 3 step(s) 41 ms · run 52 ms · runner overhead 11 ms`.

- **run**: device-run wall time (preflight, device lease wait, hub start, steps, screenshots, log reader).
- **runner overhead**: run minus step times, so a busy-lease wait counts here. Multi-device values are summed.
- Timing never affects exit codes or results.

When the instrument hub runs (network or state steps), `hub-events.ndjson` is written to the `--screenshots`
directory (per-device subdirectory with several devices). No hub, no file. One JSON object per line with ISO `ts`:

| Kind | Fields |
|---|---|
| Request | `method`, `path`, `status`, `bytes`, `source`, from net proxy events `request METHOD PATH -> status (N response bytes, source …)` (the e2e LAN hub never prints them) |
| Proxy error | `status: null`, line `request METHOD PATH failed (kind)` |
| Log / event | `kind: "log"`; `kind: "event"` with `src`, `name`, small `data` |

::: details Privacy of the file
`path` is not redacted; only the query string is dropped. For `src: "agent"` events only non-object `id`, `seq`,
`op`, `ok`, `error` and `phase` are written, so app data never reaches the file.
:::

## Studio

`brighttest studio --host <roku-ip>` opens a local app (default `http://localhost:8700`) mirroring a running Roku.
Flags, security and the State inspector: [Studio guide](/guide/studio).

| Page | What it does |
|---|---|
| Inspect | Screenshot with node overlay; Node / Tree / Selector / State tabs; remote pad (D-pad, Select, Back, Home, text) |
| Runs | Run flows and step through a time-travel trace |
| Record | Capture presses and assertions into flows in `--flows-dir` (default `./flows`) |
| Devices | Discover and switch devices |
| Profile | Sessions with markers, Perfetto export, `.bsprof` import |
| Settings | Placeholder, no working controls yet |

::: warning Build the UI first
Run `npm run studio:build` first; without the bundle `brighttest studio` exits with code 2.
:::

### Network panel

An Inspect tab showing HTTP traffic seen by the instrument hub's net proxy.

- Studio starts the hub only when launched with a device host (a device switched to later gets none), while it holds
  the lease; it stops on release. Host/port: `instrument.hub.host`, `instrument.hub.port`. Token:
  `BRIGHTTEST_HUB_TOKEN` (32 lowercase hex); without a valid one no hub starts and the panel names the variable.
- `/api/net/*` and `/api/bt/stream` answer 503 `NO_HUB` with no hub, 423 with no lease.
- Reads `instrument.net` like headless: `upstreamHosts` (allow-list), `unmatched` (`fail` or `passthrough`),
  `redact`. `record` is off and `instrument.net.fixtures` are not loaded; live rules are the rule surface.
- A Studio Run merges the flow's `config.net` over `instrument.net` (flow wins per key) like `e2e run`, and adds the
  flow's `upstreamHosts` to the allow-list.
- Startup prints `hub: on (port N, passthrough to K hosts)` or `hub: off (reason)`; warns on an empty allow-list.

::: warning Refusals and bad values
An allow-list refusal shows as status `refused` with the host and a button to copy the `upstreamHosts` entry. A bad
value (such as an invalid `unmatched`) stops the hub: routes answer 503 `NO_HUB` and the panel shows the reason.
:::

| Feature | Behavior |
|---|---|
| Live stream | `GET /api/bt/stream`; list from `GET /api/net/requests` (newest 500). Row: method, status, host+path, size, ms, source, rule. Filter; Clear empties the view only |
| Mock this | Row response → `- mockHttp: {...}` step (`GET /api/net/mock-this`), inserted as an unsaved edit |
| Copy as rule JSON / Block (503) / Clear live rules | Copy the rule / add a live 503 rule / remove live rules |
| Export HAR | `brighttest-network.har` (HAR 1.2, redacted) from `GET /api/net/har`; newest kept within a size budget, `X-Brighttest-Truncated: 1` if any dropped |
| show secrets | Reloads with `?raw=1`, the only raw route (headers, query strings, bodies). Banner warns; do not share |

::: details Edge cases
- **Mock this** is disabled on rows with no completed exchange (unmatched, refused passthrough, failed); the endpoint
  answers `404 NOT_FOUND`. Bodies over the limit are refused: export the HAR and use `net convert`.
- Empty list: no hello yet (check the build has `--net` and the same token); after a hello, the hello time shows.
- Source: `lib/studio/server.js:536` (`handleNet`), `lib/studio/web/src/lib/Network.svelte`, `App.svelte`
  (`Placeholder`), and `bin/cli.js` checks `lib/studio/public/index.html`.
:::

### Local-only server

- `Host` must be `localhost`, `127.0.0.1` or `[::1]`.
- Cross-site requests or a non-loopback `Origin` on the Studio port: HTTP 403.
- Non-GET needs `Content-Type: application/json` (HTTP 415), except `POST /api/perf/bsprof`, which also takes
  `application/octet-stream`.
- Scripts must send those headers; LAN hostnames and reverse proxies are refused.

## Where to go next

::: tip This lane is additive
It complements Rooibos lanes. Keep unit tests fast and headless; use e2e for the few journeys only a device proves.
:::

## Related

- [Flow reference](/e2e/flows): file format, steps, selectors, focus, text entry
- [Authoring flows](/e2e/authoring): `inspect`, `record`, `stamp`
- [Scaling & CI](/e2e/scaling): multiple devices, deep-link matrices, screenshots/video, CI
- [App state](/e2e/app-state): assert on the app's own state

**Full guide:** [End-to-end (on device)](full:/e2e/) — the original wording.
