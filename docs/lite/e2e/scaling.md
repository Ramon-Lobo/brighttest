# Scaling & CI

::: info At a glance
**What it is for:** running e2e flows at scale.

**You will:**
- Set screenshots and session video
- Shard flows across devices and drop dead ones
- Run deep-link matrices and write JUnit
- Run on a self-hosted CI runner

**First command:** `npx brighttest e2e run flows/ --host <roku-ip> --password <dev-password>`
:::

## Screenshots

Every run captures screenshots. They need the dev `--password`.

| Option | Effect |
|---|---|
| `--screenshots-mode all` | One per step (default). |
| `--screenshots-mode failure` | Only when a step fails. |
| `--screenshots-mode off` | None. |
| `--screenshots <dir>` | Output dir (default `<stagingDir>/e2e/screenshots`). |

A `screenshot:` step always captures unless the mode is `off`.

## Session video

`--video` (mp4, or `--video gif`) assembles per-step screenshots into one slideshow per flow. It needs **ffmpeg** on `PATH`, else it is skipped with a note.

::: warning It's a step-by-step replay, not smooth motion
ECP has no video-out, and the screenshot endpoint tops out at ~1 fps. For frame-rate video, record an **HDMI capture device** with ffmpeg alongside the run. See [VIDEO-FINDINGS.md](https://github.com/Ramon-Lobo/brighttest/blob/main/experiments/VIDEO-FINDINGS.md).
:::

## Multiple devices

A comma list in `--host` (or `ROKU_HOST=a,b,c`) shards flows round-robin, in **parallel**, one device per host.

```bash
npx brighttest e2e run flows/ --host 192.0.2.5:<pw-a>,192.0.2.6 --password <dev-password>
```

- `ip:pw` gives a host its own password; others fall back to `--password` / `ROKU_PASSWORD`. ECP needs no auth, but screenshots do.
- One device streams live; several buffer per device and print in host order. The tally aggregates.
- Screenshots and videos go to `<dir>/<host>/…`, so devices never clobber each other.

### Shared devices

Each device is leased for its share of the run ([device lease](/guide/device-lease)). A busy device delays only its own flows, and no run holds one device while waiting for another, so no deadlock. No device within `--wait` (default 30m): exit **75**. `npx brighttest device status` shows holders.

### Resetting devices and dropping dead ones: `--reset-device`

1. Per host, in its own lease window: installer `Delete`, Home, wait for Home (see `device reset` in the [lease guide](/guide/device-lease)).
2. Launch the app (`--app`, default `dev`) and check it leaves Home.
3. **2 consecutive failures** mark the host dead: one line names it and the reason; its flows move to the other hosts.
4. All hosts dead: exit 1, no flows run.

::: warning Delete removes the sideloaded app
Use it where CI sideloads right before the run, or the job reinstalls the dev channel. A host without a dev password counts as dead.
:::

## Non-default ECP port

To target a stub or fake (for example on `127.0.0.1`), set `--ecp-port <n>` or `ROKU_ECP_PORT`. The flag wins; default 8060.

```bash
npx brighttest e2e run flows/ --host 127.0.0.1 --ecp-port 18060
```

It applies to every host, leaves `--host`'s `ip:pw` syntax unchanged and does not affect the installer port.

## Deep-link matrix

Run each flow once per content id:

```bash
npx brighttest e2e run flows/details.e2e.yaml --host <roku-ip> --content-id abc123,def456 --media-type movie
```

Each entry launches with `{ contentId, mediaType }` (overriding the flow's launch params; Home is pressed first), is labelled by content id in output and file names, and shards across hosts.

## JUnit output

`e2e run --junit <file>` writes JUnit XML beside the console output. Exit codes do not change.

| Result | XML |
|---|---|
| Flow file / each run | One `<testsuite>` (path under project root) / one `<testcase>`; matrix runs add the contentId. |
| Failed flow | `<failure message="step N (op): CODE: text" type="CODE">`, first failing step, typed code if any (`APP_CRASHED`, `KEY_NOT_ALLOWED`, `TIMEOUT`, `STATE_*`). |
| Skipped by `requires:` | `<skipped message="reason">`; `--fail-on-skip` still sets the exit code. |
| Never ran (parse error, unreachable, no lease) | A failure. |

Output is byte-stable (no timestamps, durations or ids). Parent dirs are created. A write error is reported without changing the exit code.

## Continuous integration

On-device e2e needs a **real Roku on the runner's LAN**, so not GitHub-hosted runners. [`.github/workflows/e2e-device.yml`](https://github.com/Ramon-Lobo/brighttest/blob/main/.github/workflows/e2e-device.yml) is manual (`workflow_dispatch`), runs on a **self-hosted runner** labelled `roku`, and uploads screenshots/video.

1. Register a self-hosted runner (Settings → Actions → Runners) near a Roku; label it `roku`.
2. Enable developer mode and **Network access = Permissive**.
3. Add secrets `ROKU_HOST` (IP or comma list) and `ROKU_PASSWORD`.
4. Put flows under `flows/` and dispatch.

```yaml
# excerpt — the file has the full, injection-safe version
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

The lane reads `/query/sgnodes/all`. After 3 failures in a row (`FAILED` body or render-thread RPC timeout; `APP_UI_FALLBACK_AFTER` in `lib/e2e/sgnodes.js`) it reads `/query/app-ui`.

- Limited mode and "channel not running" never fall back. If `app-ui` also fails, you get the sgnodes error.
- Launch readiness (`lib/e2e/ready.js`) counts the same way; a transport timeout (hung read aborted by the client) counts like a `FAILED` body.
- The result reports `source` (`sgnodes` or `app-ui`) and `parentLinks` (`true` or `false`).

::: warning No parent links on `app-ui`
Nodes have no `parent` field; anything needing one fails with `TREE_NO_PARENT_LINKS` instead of matching nothing. Other selectors work the same.
:::

## Related

- [Authoring flows](/e2e/authoring): inspect, record, stamp
- [Device lease](/guide/device-lease): sharing, exit 75, `device reset`

**Full guide:** [Scaling & CI](full:/e2e/scaling) — the original wording.
