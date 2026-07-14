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

Screenshots and videos are written under a per-device subfolder (`<dir>/<host>/…`) so parallel devices
never clobber each other.

## Deep-link matrix

Run each flow once per content id — ideal for verifying a details/playback screen across many titles:

```bash
npx brighttest e2e run flows/details.e2e.yaml --host <ip> --password <pw> \
  --content-id abc123,def456,ghi789 --media-type movie
```

Each matrix entry launches with `{ contentId, mediaType }` (overriding the flow's own launch params) and
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
