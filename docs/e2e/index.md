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

## Studio

`brighttest studio --host <roku-ip>` opens a local web app (default `http://localhost:8700`) that mirrors a
running Roku. Its pages:

- **Inspect** — live screenshot with a node overlay, and Node / Tree / Selector / State tabs next to a
  remote pad (D-pad, Select, Back, Home, text).
- **Runs** — run flows on the device and step through a time-travel trace of each run.
- **Record** — capture remote presses and assertions into a flow; flows are read from and written to
  `--flows-dir` (default `./flows`).
- **Devices** — discover and switch Roku devices.
- **Profile** — performance sessions with markers, exportable as a Perfetto trace; `.bsprof` files can be imported.
- **Settings** — a placeholder page that lists planned options; it has no working controls yet (`lib/studio/web/src/App.svelte`, `Placeholder`).

The Studio UI bundle must be built before `brighttest studio` will start: run `npm run studio:build` first. Without it the command exits with code 2 (`bin/cli.js`, checks `lib/studio/public/index.html`).

### Network panel

The Network view is a tab next to Node / Tree / Selector / State on the Inspect page (`lib/studio/web/src/App.svelte`, `lib/studio/web/src/lib/Network.svelte`). It shows the HTTP traffic seen by the instrument hub's net proxy. It needs the device lease: Studio starts the instrument hub itself, only when it was started with a device host (`lib/studio/server.js:536`; a device added or switched to later gets no hub), while it holds the lease (host and port from `instrument.hub.host` and `instrument.hub.port`, token from `BRIGHTTEST_HUB_TOKEN`, 32 lowercase hex) and stops it when the lease is released. Without a valid `BRIGHTTEST_HUB_TOKEN` the hub is not started and the panel shows a message naming that variable. Without a hub the `/api/net/*` and `/api/bt/stream` routes answer 503 `NO_HUB`; without the lease they answer 423 (`lib/studio/server.js`, `handleNet`).

- **Live stream.** Rows arrive over the hub event stream (`GET /api/bt/stream`) and the list is loaded from `GET /api/net/requests` (newest 500). Each row shows method, status, host and path, size, ms, source and the matching rule. The view has a text filter and a Clear button that empties the view only.
- **Mock this.** Select a row and press **Mock this** to turn the recorded response into a `- mockHttp: {...}` step (`GET /api/net/mock-this`). The step is inserted into the flow editor as an unsaved edit. Responses over the body limit are refused with a message to export the HAR and use `net convert`. **Copy as rule JSON** copies the same rule, **Block (503)** adds a live 503 rule for the path, and **Clear live rules** removes live rules.
- **Export HAR.** Downloads `brighttest-network.har` (HAR 1.2, redacted) from `GET /api/net/har`. The newest exchanges are kept until a size budget is spent; if older ones were dropped the response carries the header `X-Brighttest-Truncated: 1`.
- **Raw toggle.** Values are redacted by default. **show secrets** reloads the list with `?raw=1`, which is the only route that returns raw headers, query strings and bodies. A banner warns that the view is unredacted; do not share it.
- **Empty list.** When the hub is up but no device has dialled it, the panel says no hello has arrived yet (check the build has `--net` and the same hub token). After a hello with no traffic, it shows the hello time instead.

The server is meant for the local machine only. It answers only requests whose `Host` is `localhost`,
`127.0.0.1` or `[::1]`, refuses cross-site browser requests and any `Origin` that is not loopback on the
Studio port (HTTP 403), and accepts non-GET requests only with `Content-Type: application/json`
(HTTP 415 otherwise). The one exception is `POST /api/perf/bsprof`, which also accepts
`application/octet-stream` for `.bsprof` import. Scripts that call the API must send those headers;
reaching Studio through a LAN hostname or a reverse proxy will be refused.

## Where to go next

- **[Flow reference](/e2e/flows)** — the flow file format, every step, selectors, focus navigation, text entry.
- **[Authoring flows](/e2e/authoring)** — `inspect`, `record`, and making an app selectable (`stamp`).
- **[Scaling & CI](/e2e/scaling)** — multiple devices, deep-link matrices, screenshots/video, and CI.

::: tip This lane is additive
It doesn't replace the Rooibos unit/integration lanes — it complements them. Keep unit tests fast and
headless; use e2e for the handful of critical user journeys that only a real device can prove.
:::
