# Sharing a device (device lease)

::: info At a glance
**What it is for:** one command, person, agent or CI job on a Roku at a time.

**You will:**
- see who holds a device and who waits
- wrap any command in the lease, or hold a session
- free a stuck device, use a device pool, tune the lease

**First command:** `npx brighttest device status`
:::

## Why there is a lease

A Roku does one thing at a time and never reports collisions: you just get wrong results.

A second sideload replaces the dev channel, two e2e runs press each other's keys, debug ports (8080, 8085) take one
client each. So each device is a **leased, serialized resource**: brighttest device commands take the lease and wait
their turn, across terminals, worktrees, agents and CI jobs on the **same machine as the same OS user**.

| Takes the lease | When |
|---|---|
| `brighttest --device` | build + sideload + run |
| `brighttest --cross-check` | device phase only |
| `brighttest e2e run` | per device, around its flows; presses Home ×2 first |
| `brighttest e2e inspect` / `e2e record` | whole command |
| `brighttest studio` | while you use it ([Studio](#studio)) |
| `brighttest device with -- <cmd>` | any other command (`curl`, `npx rooibos`, a script) |

No lease: headless lanes, and reads that cannot disturb a run (`query/device-info`, `query/active-app`, `query/apps`,
`brighttest devices` discovery).

## Who has the device?

```bash
npx brighttest device status          # holder, purpose, since, deadline, queue
npx brighttest device status --json
npx brighttest device log --tail 20   # acquired / released / queued / timeout / reclaimed / forced …
export BRIGHTTEST_AGENT=dev#2         # or --as dev#2
npx brighttest e2e run flows/ --purpose "LSE-T5 check"
```

- A holder shows its **agent**, **purpose**, **worktree + branch**, cwd and PID. Set the first two.
- Holder text is shown with control characters and terminal escapes removed (status, log, waiting line, lock/unlock
  notices). `--json` keeps the raw value, control bytes as `\u` escapes.

While waiting, a command prints to stderr once, then every 30 s:

```
[brighttest lease] 192.0.2.50 is held by device-qa#1 — "e2e run flows/home.e2e.yaml"
  since 14:02:11 (4m12s, deadline 15:02:11), worktree …/roku-test-wt-a (feat/ecp-queue).
  You are #2 in queue.
  Waiting up to 25m48s more (BRIGHTTEST_LEASE_WAIT / --wait). Ctrl-C to leave the queue.
```

Waiters are first come, first served: no priority, no preemption.

`events.log` also records the host name, mode and waiters ahead (`acquired`, `queued`), and the wrapped command's exit
code (`released`). For `e2e run` that code is 1 if any unit failed on this device (per host; fail-on-skip not counted),
absent if the run did not finish. `device watch` shows it; older lines without these fields still display.

## A live board: `device watch`

A read-only board of devices, queues and recent runs.

```bash
npx brighttest device watch          # interactive (needs a terminal)
npx brighttest device watch --once   # or --json (schema brighttest-lease-board/v1)
npx brighttest device watch --plain --for 10m   # a board every interval, no screen control
npx brighttest device watch --host 192.0.2.50 --interval 5s --tail 20 --all
```

- Shows state (held, free, stale), holder, duration, waiters with estimates, runs with wait, hold, outcome. Never
  touches a lease. Without a terminal or `--for`, `--plain` stops after 10 minutes.
- **Probe:** its one network call is `GET /query/device-info` (1 second bound, at most once per device every 30
  seconds; `--once`/`--json` probe once first). Only held, queued, configured (`devices.json`, `deviceLease.pool`,
  `ROKU_HOST`, `--host`) or recently held (24 hours) devices are probed; others read "idle, not probed". `--no-probe`
  connects to nothing ("not probed").
- **Screen:** Studio's look (truecolor, 256 and 16 color fallbacks, `NO_COLOR` honoured). Keys: arrows or `j`/`k`
  move, `enter`/`tab` pane, `a` all keys, `p` pause, `r` refresh, `?` help, `q`/`Esc`/Ctrl-C quit.

::: details The screen needs `ink` (optional)
[ink](https://github.com/vadimdemedes/ink) is an **optional** dependency, installed by default, loaded only for the
interactive screen. If missing (`npm install --omit=optional`, failed install), `watch` prints one stderr line and
shows the plain live view (exit code 0). `--once`, `--json`, `--plain` and non-terminal runs never load it. Add it:
`npm i ink react`.
:::

| Exit | `watch` (same for `status`, `log`) |
|---|---|
| 0 | quit, `--once`, `--json`; a missing lease directory (empty board) |
| 2 | unknown flag; bad `--interval`; `--tail` outside 1 to 200 (`device log --tail` up to 10000) |
| 78 | lease directory unreadable or not a directory |

## Wrapping anything else: `device with`

Holds the lease around any non-brighttest command.

```bash
npx brighttest device with --as dev#2 --purpose "check Home" -- curl -d '' http://$ROKU_HOST:8060/keypress/Home
npx brighttest device with -- npx rooibos --host "$ROKU_HOST" --password "$ROKU_PASSWORD"
```

It takes the lease, presses Home twice (`--no-hygiene` skips), runs the command with `ROKU_HOST`, `ROKU_PASSWORD` and
`BRIGHTTEST_LEASE` set, and releases on exit. A nested brighttest command re-uses the lease.

| Option | Meaning |
|---|---|
| `--host <ip[:pw]>` | device (else `ROKU_HOST`, else cached device) |
| `--as` / `--purpose` | label and purpose (`BRIGHTTEST_AGENT`, `BRIGHTTEST_PURPOSE`) |
| `--wait <dur>` | queue time (default 30m); `0` = fail if busy or anyone queued |
| `--max <dur>` | hold cap (default 60m, at most about 24.8 days); stopped 5 s before (exit 77) |
| `--expect <dur>` | expected hold, shown to waiters |
| `--no-hygiene` | no Home ×2 |
| `--lease <token>` | run under a session, no queueing (= `BRIGHTTEST_LEASE=<token>`) |

Durations: `90s`, `10m`, `1h` or milliseconds. `--device`, `--cross-check` and `e2e` accept `--wait`, `--as`,
`--purpose`, `--no-lease`.

**Estimated wait** ("est. wait" in the waiting line and `device status`) = holder's remaining time + expected hold of
each ticket ahead. Expected hold is `--expect`, else the median of the last 10 holds with the same verb (e.g. `e2e`;
no verb = `other`). Overdue: `past expected hold by <duration>; ETA unknown`; no data: `ETA unknown (no --expect)`.
Never invented, never makes a lane give up or skip the queue.

## Keeping the app alive on long runs: `--keepalive`

Opt-in: `device with` sends an ECP `Fwd` keypress from the host on a timer.

```bash
npx brighttest device with --keepalive -- <long command>        # every 240 s
npx brighttest device with --keepalive=120 -- <long command>
```

Interval default 240, minimum 60, `0` = off; first send after one interval; each send logged to stderr. After 3
failures in a row it stops with a warning (command unaffected). Uses the held lease; never Home, Back, Select or any
focus key; stops on command exit or SIGINT/SIGTERM.

::: warning Tested one way only
`Fwd` every 240 s kept the sample app alive 45 minutes, no stall at about 595 s. Other keys and intervals are
untested, so not offered. No screensaver or device setting changes. `device with` only, not `e2e run`.
:::

## Resetting a stuck device: `device reset`

Frees a halted app or stuck installer page.

```bash
npx brighttest device reset --host 192.0.2.5:<dev-password>
```

1. Lease (no Home ×2).
2. Installer `Delete` (dev password required; about 1.3 s).
3. Home, then poll `active-app` for a Home screen (10 s limit).

Exit 0 = Home reached; 1 = Delete failed, password refused or no Home (lease released either way); 75/77/78 = lease
codes. The app is removed: sideload again. For CI: `e2e run --reset-device` ([scaling](/e2e/scaling)).

## Multi-step debugging: a session lock

For several steps in a row, take a **session** lease instead of `device with`.

```bash
TOKEN=$(npx brighttest device lock --host 192.0.2.50 --as device-qa#1 --purpose "debug launch")
BRIGHTTEST_LEASE=$TOKEN npx brighttest device with -- curl -d '' http://192.0.2.50:8060/keypress/Home
npx brighttest device with --lease "$TOKEN" -- npx rooibos --host 192.0.2.50 --password "$ROKU_PASSWORD"
npx brighttest device renew --lease "$TOKEN"
npx brighttest device unlock --lease "$TOKEN"
```

- `device lock` queues (`--wait`), presses Home twice (`--no-hygiene`), prints the token; `--json` prints
  `{leaseId, deadline, expiresAt}`.
- No process owns it. Ends at `device unlock`, after `--idle` (default 10 minutes) unused, or at `--max` (default 45
  minutes). Each token use renews idle (`device with`, `device renew`, a raw command the hook allows), never past
  `--max`. Config: `sessionIdle`, `sessionMax`.
- A command with the token runs without queueing; if expired or unlocked it exits 77, never runs unlocked.
- `unlock` exits 0, or 77 if not held/expired; `renew` likewise. Both read `BRIGHTTEST_LEASE` without `--lease`. A
  command-lease token is refused (exit 2).
- `device lock` on a device you hold via `BRIGHTTEST_LEASE` exits 2. Unlock first.
- **Token = password:** never write it to files or logs.

**Home presses.** Under a token, commands do not press Home, except:

- `e2e run` presses Home twice at start when it starts the instrument hub (state/net steps, or top-level `net` in
  `brighttest.json`), so a running app restarts and greets the new hub; else state steps fail with
  `STATE_NOT_INSTRUMENTED`. Skip: `--no-hygiene` or `deviceLease.hygiene: "none"`.
- This holds for any re-entrant lease: in `device with -- brighttest e2e run` both parent and child press Home
  (intended: the script may have launched the app). A plain `e2e run` lease adds none.

::: tip Order of operations
`device lock` closes a running app. Lock, install (`instrument build --sideload` or `builds install --latest`),
launch, work; or `device lock --no-hygiene`. `e2e run` launches but never installs.
:::

## Exit codes

| Code | Meaning |
|---|---|
| `0` (or the command's own code) | ok |
| `75` | busy (`--wait 0`) or wait timed out |
| `77` | lease lost, `--max` reached, or `BRIGHTTEST_LEASE` no longer held |
| `78` | lease directory unusable (permissions, disk full, read-only) |
| `2` | usage error |

`device with` passes the command's code through; if it is 75 or 77, the `[brighttest lease] …` stderr line tells which.

## Crashes and stuck holders

- **Holder crash** (even `kill -9`): freed within about a second (PID check), unless its children (Rooibos CLI,
  `device with` command) still run: then the device *is* in use.
- **Killed waiter** (`kill -9`, Bash tool timeout): place kept 60 seconds; a waiter with the same `--as` and
  `--purpose` adopts it (`adopted` in `events.log`). Adoption never extends the 60 s.
- **Hang:** bounded by `maxHold` (default 60 minutes).
- **Laptop sleep:** safe (heartbeat does not decide liveness); past the deadline it exits 77 on wake; redo the run.

Free your own stuck holder:

```bash
npx brighttest device unlock --force --host 192.0.2.50 --reason "stuck after laptop sleep" [--kill]
```

The old holder notices within a second and exits 77. `--force` needs `--reason` for a live holder; `--kill` also ends
it and its children (otherwise stop it yourself). Audited. **Never force-unlock someone else's lease without asking.**

## Opting out

`--no-lease`, `BRIGHTTEST_NO_LEASE=1` or `"deviceLease": { "enabled": false }` skip the lease with a loud warning and a
`bypass` event. Only for a single user who knows nobody else uses the device; **agents must never use it**.

## Foreground advisory

After an acquire that did not queue, a background `GET /query/active-app` (1 s timeout, 64 KB cap) warns once on
stderr if the dev channel is in front (a manual run or another tool may be using it).

It warns only when nothing on the device was released, reclaimed, force-unlocked or lost in the last 10 minutes (a
sideload leaves the channel running on purpose) and the foreground id or ui-location is `dev`.

::: details Limits
Never delays or fails the acquire; writes nothing. Unreachable device, HTTP error or other app: silent. The pool gate
skips it; the chosen member runs it (one per pick). MCP calls skip it. Best effort: a fast exit (`device lock
--no-hygiene`) or a release can cancel it. Off: `BRIGHTTEST_LEASE_NO_FOREGROUND_CHECK=1`.
:::

## Configuration

All optional, in `brighttest.json`.

```jsonc
"deviceLease": {
  "enabled": true,       // false = --no-lease
  "wait": "30m",         // BRIGHTTEST_LEASE_WAIT and --wait win
  "maxHold": "60m",      // cap on one hold
  "sessionIdle": "10m",  // session idle expiry
  "sessionMax": "45m",   // session cap
  "hygiene": "home",     // "home" | "none": Home ×2 for e2e run and device with
  "studioIdle": "5m",    // Studio releases when idle this long
  "studioYield": "60s",  // …or this long when someone is queued
  "pool": ["192.0.2.10", "192.0.2.11"]  // for --device any
}
```

| Env var | Meaning |
|---|---|
| `BRIGHTTEST_AGENT` | holder label (`dev#2`, `device-qa#1`, `ci:run-123`) |
| `BRIGHTTEST_PURPOSE` | purpose (default: command line, passwords removed) |
| `BRIGHTTEST_LEASE_WAIT` | default wait; overrides config |
| `BRIGHTTEST_LEASE_DIR` | lease dir (default `~/.brighttest/leases`) |
| `BRIGHTTEST_LEASE` | held token; set by `device with` (nested calls re-use it) or by you from `device lock` |
| `BRIGHTTEST_NO_LEASE=1` | = `--no-lease` |

Files: `~/.brighttest/leases/<key>/` holds `holder.json`, `queue/` and `events.log`. No passwords or serials (hash
only). Must be a **local** file system (no NFS).

### Lease keys
<!-- covers: Keys -->

Device lanes (`device with|lock`, `e2e run`, `--device`, `--cross-check`) take **two** leases under one token.

- Read the serial (or device-id) from device-info (at most 1.5 s); take identity key `id-<16 hex>` (serial hash) and
  address key (resolved IP, plus `_p<port>` when ECP is not 8060).
- Addresses or ports of one device share the identity key and queue; two devices never share one.
- Address-only users (Studio, MCP server, `--device any` picks) take the address key alone, colliding by address.
- `status`, `log`, `unlock --force` with `--host` check both; `unlock --lease` and `renew` cover both. Under
  `BRIGHTTEST_LEASE` the held key is reused.

On a failed read (e.g. reboot) the lane prints and logs (`note` event) `device identity not read (<reason>); leasing by
address <host>`, and adds the remembered identity key from `identity-cache.json` (hashes only, mode 0600); with none
remembered, address key only.

::: details Edge cases and known limits
- `--host` lookups use the remembered key only if its holder used the same host and port, so a stale entry never
  touches another device.
- Unheld key: `<key> was not held`; `unlock --force` still exits 0. Unreadable lease dir: exit 78.
- Two ports of one fake device count as two: `status --host` may under-report (fails closed).
- Holding one device and locking a second queues while holding; two lanes in opposite order deadlock until `--wait`
  (exit 75). Lock one at a time.
- An address-only holder on a different address or port than an identity lane can double-hold a device; an unresolved
  host name is leased by name (warning). Use the IP and default port. Both are `note` events, as are Studio's
  profiling and Perfetto stops on yield; `released` carries the reason (idle, yielded, released from the UI).
:::

## A pool of devices: `--device any`

List devices in `deviceLease.pool`; `brighttest --device any` or `device with --device any -- <cmd>` (`-d any`,
`--device=any`) takes the **first free one** in list order and prints it.

`device with` sets `ROKU_HOST` to it. All busy: queue **FIFO across the pool**. `--host` always wins.

- Entries: IPv4 or host names; no port, password, IPv6, duplicates; not empty. Errors name the entry number, never the
  value; reported (exit 2) only with `--device any` (headless ignores it).
- `--device`/`--cross-check` need a password for every member (`--password`, `ROKU_PASSWORD`, cache), checked before
  leasing (exit 2).
- `--wait 0` exits 75 only if all are busy or others already queue; never because another run is choosing.
- Lanes and `device with` only; `device lock` etc. reject it (exit 2). Reachability is not checked.
- A brief `pool-<id>` lease serializes the choice (may show in `device status`). `--cross-check` picks at the device
  phase, so nothing is held during the headless leg.

## Studio

Studio holds the lease only while you use it.

- Takes it without queueing on the first device request or action (key, flow, launch). Polling is not activity.
  Releases after `studioIdle`, or `studioYield` when someone waits.
- Busy device: requests answer `423 Locked`, the UI shows the holder and pauses polling. **Take over when free**
  queues like anyone; Studio never preempts.
- Header badge: holder (or free), queue size, Studio's state; click for the queue.
- A Studio flow counts as activity and is never cut by idle/yield, but aborts at once if the lease is lost or released
  from the UI (`aborted` event). Profiling is not activity: on release it stops, its export says why.
- Pool mode (`deviceLease.pool`, no `--host`): takes one free member (FIFO) until release. Every member needs a password
  (`--password`, `ROKU_PASSWORD`, `.env`, cache). No instrument hub, even if a device connects later: restart with
  `--host`.
- API: `GET /api/lease`; `POST /api/lease {"action":"acquire"|"release"}`.
- Port 8700 taken: first free of 8701-8709 (printed). A taken explicit `--port` fails and names the process.

### Perfetto tracing cannot be switched off

brighttest can enable Perfetto tracing but has no known (documented) disable call or state query.

Stopping a trace only closes the stream. Studio shows `enabled by brighttest at <time>, device state not queryable`
(with the date if over a day old) or `no brighttest record; device state not queryable`, never "off". Enables older
than six hours are re-sent internally; the line still shows.

::: warning Seen on one device
On one Roku Ultra (firmware 16.0.4), a relaunch and Home-then-launch did not clear tracing. Whether a restart clears
it is untested.
:::

## CI and several users

The lease works within one machine and one OS user.

- **CI, same machine and user:** nothing to set up. Use `BRIGHTTEST_AGENT=ci:<run id>`, `BRIGHTTEST_LEASE_WAIT=45m`,
  and add `npx brighttest device status` steps before and after the device steps ([CI integration](./ci)).
- **CI as another OS user:** not supported (files are 0700/0600). Use the same user.
- **Another machine:** cannot see the lease; dedicate the device to it while it runs.

::: warning Disagreement with the CI pages
[CI integration](/guide/ci) says `device status` lists device addresses, "so keep it out of CI logs; run it from your
own shell"; [Device shelf](/guide/ci-device-shelf) agrees. Both kept as written.
:::

## The Claude Code guard hook

`brighttest device hook`: a Claude Code `PreToolUse` hook for Bash (`lib/device-hook.js`) that denies raw device
commands.

- Register `node bin/cli.js device hook` in `.claude/settings.json` (this repo does, 5 s timeout), or run
  `npx brighttest skills install --agent claude --with-hook` ([Agent skills](/guide/agent-skills#guard-hook-and-mcp-server-opt-in-claude-target)).
  It appends to `hooks.PreToolUse` (never overwrites) the command
  `node "$CLAUDE_PROJECT_DIR/node_modules/brighttest/bin/cli.js" device hook`; undo with
  `skills uninstall --agent claude` or by deleting it.
- Reads hook JSON on stdin. Denies `curl`/`wget` to device ports, `nc`, bare `rooibos`, unless wrapped (`device with`,
  e2e, `--device`) or carrying a live `BRIGHTTEST_LEASE`. The message prints the `device with` alternative.
  `--no-lease` / `BRIGHTTEST_NO_LEASE` are always denied for agents.
- An env-var host (`http://$ROKU_HOST/keypress/Home`, `${ROKU_HOST}:8060`, `${ROKU_HOST:-x}`) is a Roku endpoint on
  port 8060 or a mutating path (`/keypress`, `/keydown`, `/keyup`, `/launch`, `/install`, `/input`, `/search`,
  `/exit-app`, `/plugin_*`). Checks `sh -c`, `$(...)`, backticks. `/query/device-info`, `/query/active-app`,
  `/query/apps` stay allowed.

::: warning Syntactic only
It cannot see script files, URLs built in code (`python`/`node`), a variable holding the whole URL, or MCP tools. If
the hook fails (bad input, timeout) it allows and logs to `events.log`; it always exits 0.
:::

## What the lease cannot stop

Only access through brighttest (or `device with`) is protected.

Own connections, URLs built in code, other terminals or machines can interfere: wrap them in
`brighttest device with -- …`. Neither the lease nor `maxHold`, session cap or idle timeout keeps the app alive; a long
run can outlast the screensaver (about 10 minutes after the last input). See
[Long device runs stop after about 10 minutes](/guide/troubleshooting#long-device-runs-stop-after-about-10-minutes).

## Related

- [Several agents on one device](/guide/multi-agent-device): etiquette
- [CI integration](/guide/ci), [Device shelf](/guide/ci-device-shelf): the lease in CI

**Full guide:** [Sharing a device (device lease)](full:/guide/device-lease) — the original wording.
