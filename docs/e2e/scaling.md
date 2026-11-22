# Scaling & CI

## Screenshots

Every run captures screenshots for a visual record. Control it with `--screenshots-mode`:

```bash
npx brighttest e2e run flows/ --host <ip> --password <pw> --screenshots-mode all      # one per step (default)
npx brighttest e2e run flows/ --host <ip> --password <pw> --screenshots-mode failure  # only when a step fails
npx brighttest e2e run flows/ --host <ip> --password <pw> --screenshots-mode off       # none
```

`--screenshots <dir>` sets the output directory (default: `<stagingDir>/e2e/screenshots`). Screenshots
need the dev `--password`. An explicit `screenshot:` step in a flow always captures (unless mode is `off`).

## Session video

`--video` assembles the per-step screenshots into one slideshow video per flow (needs **ffmpeg** on
`PATH`; absent, it's skipped with a note):

```bash
npx brighttest e2e run flows/ --host <ip> --password <pw> --video       # <flow>.mp4
npx brighttest e2e run flows/ --host <ip> --password <pw> --video gif    # animated GIF
```

::: warning It's a step-by-step replay, not smooth motion
Roku has no video-out over ECP, and the dev screenshot endpoint tops out at ~1 fps. `--video` gives a
labelled replay of the states your flow asserted on — great as a CI/failure artifact. For true
frame-rate video, record an **HDMI capture device** with ffmpeg alongside the run. See
[experiments/VIDEO-FINDINGS.md](https://github.com/Ramon-Lobo/brighttest/blob/main/experiments/VIDEO-FINDINGS.md).
:::

## Multiple devices

Pass a comma list to `--host` (or set `ROKU_HOST=a,b,c`). Flows shard round-robin across the devices and
run in **parallel**, one device per host, cutting wall-clock on large suites:

```bash
npx brighttest e2e run flows/ --host 10.0.0.5,10.0.0.6,10.0.0.7 --password <pw>
```

A single device streams live; multiple devices buffer per device and print in host order so output stays
readable. The final tally aggregates across all devices.

Devices with **different dev passwords** take an inline password per host as `ip:pw` (a host without one
falls back to `--password` / `ROKU_PASSWORD`). This is what lets screenshots/video work across a mixed
fleet — ECP navigation itself needs no auth, but the screenshot endpoint does:

```bash
npx brighttest e2e run flows/ --host 10.0.0.5:Test1234,10.0.0.6:0000 --screenshots-mode all
```

### Shared devices

Each device is leased for the duration of its share of the run ([device lease](/guide/device-lease)). A
device that another process is using makes only its own flows wait; the other devices start at once, and
no run holds one device while waiting for another, so sharded runs cannot deadlock. A run that cannot get a
device within `--wait` (default 30m) exits **75**. `npx brighttest device status` shows who has each device.

### Resetting devices and dropping dead ones: `--reset-device`

```bash
npx brighttest e2e run flows/ --host 10.0.0.5:pw,10.0.0.6:pw --reset-device
```

Before planning, each host (in its own lease window) gets an attempt: installer `Delete`, Home, wait for a Home
screen (see `device reset` in the [device lease guide](/guide/device-lease)), then a launch of the app
(`--app`, default `dev`) to check the device leaves Home. A host that fails **2 consecutive attempts** (it
never left Home, or the reset itself failed) is marked dead: the run prints one line naming it and the
reason, and its flows go to the remaining hosts. If every host is dead the run exits 1 without running flows.
The Delete removes the sideloaded app, so this flag suits CI setups that sideload right before the run
(or devices where the dev channel is reinstalled by the job). A host without a dev password counts as dead.

## Non-default ECP port

A Roku serves ECP on port 8060. To target a stub or fake on another port (for example a loopback fake on
`127.0.0.1`), pass `--ecp-port <n>` or set `ROKU_ECP_PORT` (the flag wins; default 8060). It is separate from
`--host`, whose `ip:pw` syntax is unchanged, and applies to every host in the run. The installer port is
not affected.

```bash
npx brighttest e2e run flows/ --host 127.0.0.1 --ecp-port 18060
ROKU_ECP_PORT=18060 npx brighttest e2e inspect --host 127.0.0.1
```

Screenshots and videos are written under a per-device subfolder (`<dir>/<host>/…`) so parallel devices
never clobber each other.

## Deep-link matrix

Run each flow once per content id — ideal for verifying a details/playback screen across many titles:

```bash
npx brighttest e2e run flows/details.e2e.yaml --host <ip> --password <pw> \
  --content-id abc123,def456,ghi789 --media-type movie
```

Each matrix entry launches with `{ contentId, mediaType }` (overriding the flow's own launch params; the runner presses Home first because params are set) and
is labelled by content id in the output and screenshot/video filenames. The matrix also shards across
devices when you pass multiple hosts.

## Continuous integration

On-device e2e needs a **real Roku on the runner's LAN**, so it can't run on GitHub-hosted runners. The
repo ships a ready-to-adapt workflow at
[`.github/workflows/e2e-device.yml`](https://github.com/Ramon-Lobo/brighttest/blob/main/.github/workflows/e2e-device.yml):
manual (`workflow_dispatch`), pinned to a **self-hosted runner** labelled `roku`, it runs `flows/` against
the device and uploads screenshots/video as an artifact.

One-time setup:

1. Register a self-hosted runner (Settings → Actions → Runners) on a machine near a Roku; label it `roku`.
2. Put the Roku in developer mode and set **Network access = Permissive**.
3. Add repo secrets `ROKU_HOST` (device IP, or a comma list) and `ROKU_PASSWORD`.
4. Put your flows under `flows/` and dispatch the workflow.

```yaml
# excerpt — see the file for the full, injection-safe version
jobs:
  e2e:
    runs-on: [self-hosted, roku]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: "22" }
      - run: npm ci
      - env: { ROKU_HOST: "${{ secrets.ROKU_HOST }}", ROKU_PASSWORD: "${{ secrets.ROKU_PASSWORD }}" }
        run: npx brighttest e2e run flows/ --screenshots e2e-artifacts --screenshots-mode failure
```

## Tree source fallback

The e2e lane reads the screen from `/query/sgnodes/all`. When that read fails 3 times in a row (a `FAILED`
body or a render-thread RPC timeout; `APP_UI_FALLBACK_AFTER` in `lib/e2e/sgnodes.js`), the tree is read
from `/query/app-ui` instead. Limited mode and "channel not running" never fall back. If `app-ui` fails too,
you get the original sgnodes error.

The tree result says which source it used: `source` is `sgnodes` or `app-ui`, and `parentLinks` is `true` or
`false`. An `app-ui` tree has **no parent links**: nodes carry no `parent` field, and anything that needs a
parent fails with the error code `TREE_NO_PARENT_LINKS` rather than matching nothing. Id, subtype, text and
other node selectors work the same on both sources.
