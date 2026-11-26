# fake-roku

Zero-dependency scripted stub Roku for device-free tests. Placeholder identifiers only (serial
`FAKE-SERIAL-0001`, IP `192.0.2.10`, dev password `rokudev-test`). Loopback by default.

```sh
node test/fixtures/fake-roku/server.js --scenario healthy --log fake.jsonl
node test/fixtures/fake-roku/server.js --list
```

The ready line is `fake-roku scenario=<name> {...ports...}`. Module API: `createFakeRoku({ scenario, ...overrides })`
(`start()` returns ports, `stop()`, `log`, `keypresses`, `setFault`, `setActiveApp`, `setAgentText`, `emitDebug`,
`emitDebugRaw`).

## Ports

ECP 8060 (`--ecp-port`; point brighttest at it with `--ecp-port` / `ROKU_ECP_PORT`), installer 8090
(`--installer-port`; a real device uses 80), console 8080 (`--console-port`), log/debug 8085 (`--debug-port`).
Port 0 picks a free port.

## CLI flags

`--scenario --host --log --list`, the four port flags, plus:
`--software-version --software-build --model` (device-info and console banner), `--console-latency-ms`,
`--installer-mode ok|compile-failure|transient-once|tcp80-closed|page|http-500`, `--delete-fails`,
`--screenshot-not-ok`, `--screenshot-format png|jpg`, `--banner-split`, `--rooibos pass|fail`,
`--perf ok|no-channel|no-dev-mode --perf-bitmaps N --perf-bitmap-name <text> --fps ok|failed` (see Perf endpoints),
`--fault-path <path> [--fault-status N]` (default 500; `/keyup/*` is a prefix glob), `--agent-text <file>`.

`--hub http://127.0.0.1:<port>` (module option `hub`; module option `env` overrides the environment for tests):
Fetch through the hub. On start, on `launch/dev` and on `keypress/Info` the stub does one GET of
`/bt/<token>/net/;http://fixture.invalid/fixture/netbody` against the hub, the token read from the
`BRIGHTTEST_HUB_TOKEN` environment variable (name from `HUB_TOKEN_ENV`). The body, cut to 200 characters, is
`Label netBody` in the tree (placeholder `netbody: pending` before the first answer). Any hub error, a missing
token or a non-200 shows `netbody: error`; the stub keeps running. The token is never printed or logged. The label
exists only when `--hub` is set.

## Perf endpoints (read-only ECP)

`GET /query/chanperf`, `/query/r2d2-bitmaps`, `/query/graphics-frame-rate`, generic bodies (placeholder numbers; the
firmware's `sytem-memory` spelling is kept). `chanperf` counters grow by a little on every call, so sample deltas are
non-zero. Module options (also CLI flags above):

| Option | Values | Effect |
|---|---|---|
| `perf` | `ok` (default) | all three answer data |
| | `no-channel` | all three answer a `FAILED` body (`Channel not running`) |
| | `no-dev-mode` | chanperf ok, r2d2-bitmaps answers 404 (and `fps: 'failed'` is separate) |
| `perfBitmaps` | count, default 3 | number of `<bitmap>` entries; bitmap 0 is the largest, sizes shrink |
| `perfBitmapName` | string | name of bitmap 0, XML-escaped; URL with query string, control and bidi characters pass through raw |
| `fps` | `ok` (default), `failed` | `failed` makes graphics-frame-rate answer a `FAILED` body |

Under `ecpMode: limited` they answer 403 like every non-basic query. Requests show in the log as usual.

## Request log (`--log`, JSONL)

HTTP lines (ECP and installer): `service`, `method`, `endpoint`, `url`, `status`, `start`/`end`, `startMs`/`endMs`,
`attempt`, `inFlight`. Keypresses appear as `endpoint` `/keypress/<Key>`, `/keydown/<Key>`, `/keyup/<Key>`.
TCP lines for ports 8080 and 8085: `service` `console` | `debug`, `event` `connect` | `close`, `time`.

## Tree contract

`tree: small` (default): `MainScene` (focused) -> `Rectangle bg`, `Label __bt_agent` (scripted agent text),
`Group home` -> `Label title` ("Home"), `Poster hero`. Selectors match `name=` as `id`.
`tree: grid` (scenario `focus-grid`): `MarkupGrid grid` with `Poster item1`..`item6` (3 columns x 2 rows);
`focused="true"` is on one item and moves on Up/Down/Left/Right (clamped, no wrap); starts on `item1`.
`late-node`: node `lateNode` appears 1500 ms after launch.
Active app is `dev`; `keypress/Home` switches to Roku, `launch/dev` switches back.

## Scenarios

Run `--list`. Also: `console-slow` (700 ms per console write), `keypress-home-500` (only
`keypress/Home` -> 500), `keyup-fails` (`keyup/*` -> 503), `rooibos-pass` / `rooibos-fail` (Rooibos transcript on
8085 after a successful install, replayed to later connections), `focus-grid`, `installer-500`, `late-node`.
`sgnodes-fails`: every `/query/sgnodes/*` answers a `FAILED` body; `/query/app-ui` still serves the scenario tree
(no parent links), so the app-ui fallback source can be exercised.
`sgnodes-hangs`: every `/query/sgnodes/*` request is accepted and never answered (the client timeout fires);
`/query/app-ui` still serves the tree.

## Flows (`flows/`)

```sh
node bin/cli.js e2e run test/fixtures/fake-roku/flows/fake-smoke.e2e.yaml --host 127.0.0.1 \
  --ecp-port 8060 --password rokudev-test --screenshots-mode off
```

- `fake-smoke.e2e.yaml`: passes on `healthy` (4 keypresses); on `crash-mid-flow` the fake crashes after the 3rd.
- `fake-wait-missing.e2e.yaml`: second step waits for a node that never exists (fails after the 3 s timeout).

Tests: `test/fake-roku.test.js`.
