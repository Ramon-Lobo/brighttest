# Sharing a device (device lease)

A Roku can only do one thing at a time. A second sideload replaces the dev channel under the first run,
two e2e runs press each other's keys, and the debug ports (8080, 8085) take one client each. Nothing on the
device reports these collisions: you just get wrong results.

brighttest therefore treats each device as a **leased, serialized resource**. Every brighttest command that
touches a device takes the lease for that device first, and waits its turn if someone else holds it.
That covers terminals, git worktrees, AI agents and CI jobs running on the **same machine as the same OS
user**.

| Takes the lease | When |
|---|---|
| `brighttest --device` | around the build + sideload + run |
| `brighttest --cross-check` | around the device phase only (the headless phase runs without it) |
| `brighttest e2e run` | per device, around all of that device's flows; presses Home ×2 first |
| `brighttest e2e inspect` / `e2e record` | for the whole command |
| `brighttest studio` | while you use it (see [Studio](#studio)) |
| `brighttest device with -- <cmd>` | around any other command (`curl`, `npx rooibos`, a script) |

Headless lanes never take a lease. Single reads that cannot disturb a run (`query/device-info`,
`query/active-app`, `query/apps`, and `brighttest devices` discovery) need none either.

## Who has the device?

```bash
npx brighttest device status          # every device: holder, purpose, since, deadline, queue
npx brighttest device status --json   # the same, for scripts and agents
npx brighttest device log --tail 20   # audit log: acquired / released / queued / timeout / reclaimed / forced …
```

A holder is described by its **agent** label, **purpose**, **worktree + branch**, cwd and PID. Set the
first two so others can read them:

```bash
export BRIGHTTEST_AGENT=dev#2                      # or --as dev#2
npx brighttest e2e run flows/ --purpose "LSE-T5 check"
```

While a command waits, it prints (on stderr, once and then every 30 s):

```
[brighttest lease] 192.168.1.50 is held by device-qa#1 — "e2e run flows/home.e2e.yaml"
  since 14:02:11 (4m12s, deadline 15:02:11), worktree …/roku-test-wt-a (feat/ecp-queue).
  You are #2 in queue.
  Waiting up to 25m48s more (BRIGHTTEST_LEASE_WAIT / --wait). Ctrl-C to leave the queue.
```

Waiters are served first come, first served. There is no priority and no preemption.

The lease events log (`events.log`) also records the host name, the mode and how many waiters were ahead on `acquired` and `queued` events, and the wrapped command's exit code on `released`. `device watch` shows the exit code in the run history; older log lines without these fields still display, with nothing in their place.

## A live board: `device watch`

```bash
npx brighttest device watch                 # interactive screen (needs a terminal)
npx brighttest device watch --once          # one static board, then exit
npx brighttest device watch --json          # the same board as JSON (schema brighttest-lease-board/v1)
npx brighttest device watch --plain         # one static board every interval, no screen control (for tee and logs)
npx brighttest device watch --host 192.168.1.50 --interval 5s --tail 20 --all
```

`watch` is read-only. It lists every known device with its state (held, free, stale), holder, how long, the
waiting line with estimates, and the recent runs with wait time, hold time and how each ended. It never takes,
changes or cleans a lease. Its one network call is a reachability probe: `GET /query/device-info` with a 1 second
bound, at most once per device every 30 seconds, never a lease or a `device` command (`--once` and `--json` run one
probe pass first). `--no-probe` makes no connection at all and the column reads "not probed".

The interactive screen keeps Studio's look (alternate screen, the Studio palette in truecolor with 256 and 16 color
fallbacks, `NO_COLOR` honoured). Keys: arrows or `j`/`k` move, `enter` or `tab` switch pane, `a` shows all keys,
`p` pauses, `r` refreshes, `?` lists the keys, `q`, `Esc` or Ctrl-C quits and restores your terminal.

The screen is drawn with [ink](https://github.com/vadimdemedes/ink), an **optional** dependency installed with
brighttest by default and loaded only when the interactive screen starts. If it is missing (for example after
`npm install --omit=optional`, or when the optional install failed), `device watch` prints one line to stderr and
shows the plain live view instead, with exit code 0. `--once`, `--json`, `--plain` and any run without a terminal
never load it. To add it later: `npm i ink react`.

## Wrapping anything else: `device with`

```bash
npx brighttest device with --as dev#2 --purpose "check Home" -- curl -d '' http://$ROKU_HOST:8060/keypress/Home
npx brighttest device with -- npx rooibos --host "$ROKU_HOST" --password "$ROKU_PASSWORD"
```

`device with` takes the lease, presses Home twice (skip with `--no-hygiene`), runs the command with
`ROKU_HOST`, `ROKU_PASSWORD` and `BRIGHTTEST_LEASE` in its environment, and releases when it exits. A
brighttest command started inside it re-uses the same lease instead of waiting for itself.

| Option | Meaning |
|---|---|
| `--host <ip[:pw]>` | Device (else `ROKU_HOST`, else the cached device) |
| `--as <agent>` / `--purpose <text>` | Holder label and purpose (`BRIGHTTEST_AGENT`, `BRIGHTTEST_PURPOSE`) |
| `--wait <dur>` | How long to queue (default 30m). `0` = fail at once if the device is busy or anyone is queued |
| `--max <dur>` | Hard cap on the hold (default 60m). 5 s before it, the command is stopped (exit 77). At most about 24.8 days |
| `--expect <dur>` | Expected hold time, shown to waiters as an estimate (see below) |
| `--no-hygiene` | Skip the Home ×2 press after acquiring |
| `--lease <token>` | Run under that session lease (see below) instead of queueing; same as `BRIGHTTEST_LEASE=<token>` |

**Estimated wait.** The waiting line and `device status` show "est. wait". It is the holder's remaining time
(its `--expect`, else the median of the last 10 holds in `events.log` with the same first two words of purpose,
for example `e2e run`) plus the expected hold of each ticket ahead. With no history it is left out. It is only
an estimate: it never makes a lane give up or skip the queue.

Durations are `90s`, `10m`, `1h` or plain milliseconds. The device lanes (`--device`, `--cross-check`,
`e2e`) accept `--wait`, `--as`, `--purpose` and `--no-lease`.

## Keeping the app alive on long runs: `--keepalive`

```bash
npx brighttest device with --keepalive -- <long command>        # one key every 240 s
npx brighttest device with --keepalive=120 -- <long command>
```

Opt-in, off by default. While the wrapped command runs, `device with` sends one ECP `Fwd` keypress from the
host every `<sec>` seconds (default 240, minimum 60, `0` = off); the first one is sent after one full interval.
Each send is logged to stderr. After 3 failures in a row it stops and logs a warning; the wrapped command is
not affected. It uses the lease `device with` already holds, never sends Home, Back, Select or any key that
moves focus, and stops when the command exits or on SIGINT/SIGTERM.

What was tested: `Fwd` every 240 s kept the sample app alive for 45 minutes with no stall at about 595 s. Other
keys and intervals have not been tested, so none are offered. It does not change the device screensaver or any
device setting, and it applies to `device with` only (not to `e2e run`).

## Resetting a stuck device: `device reset`

```bash
npx brighttest device reset --host 10.0.0.5:changeme
```

Takes the lease (no Home x2 press), sends the installer `Delete` (the dev password is required; this frees a
halted app or a stuck installer page, about 1.3 s on a device), presses Home, then polls `active-app` until a
Home screen shows (10 s limit). Exit 0 when Home is reached; exit 1 when the Delete fails, the password is
refused or Home never shows (the lease is released either way); 75/77/78 are the lease codes. The sideloaded
app is removed, so sideload again afterwards. For CI see `e2e run --reset-device` in [scaling](/e2e/scaling).

## Multi-step debugging: a session lock

`device with` holds the device for one command. For several steps in a row (an agent poking at a device while
it reads the output), take a **session** lease instead:

```bash
TOKEN=$(npx brighttest device lock --host 192.168.1.50 --as device-qa#1 --purpose "debug launch")
BRIGHTTEST_LEASE=$TOKEN npx brighttest device with -- curl -d '' http://192.168.1.50:8060/keypress/Home
npx brighttest device with --lease "$TOKEN" -- npx rooibos --host 192.168.1.50 --password "$ROKU_PASSWORD"
npx brighttest device renew --lease "$TOKEN"
npx brighttest device unlock --lease "$TOKEN"
```

- `device lock` takes the lease (queueing like any other command, `--wait`), presses Home twice (skip with
  `--no-hygiene`) and prints the token on stdout. `--json` prints `{leaseId, deadline, expiresAt}`.
- No process owns a session. It ends when you `device unlock`, after `--idle` (default 10 minutes) without use, or
  at `--max` (default 45 minutes), whichever comes first. Every use of the token renews the idle time (a
  `device with` that carries it, `device renew`, or a raw device command the hook allows because of it), but
  never past `--max`. Config: `sessionIdle`, `sessionMax`.
- A command that carries the token (`BRIGHTTEST_LEASE=<token>` or `device with --lease <token>`) runs under the
  session without queueing. If the session has expired or was unlocked, it exits 77 and does not run unlocked.
- `device unlock --lease <token>` releases a session (exit 0), or exits 77 if it is not held or already expired.
  `device renew --lease <token>` exits 77 in the same cases. Both read `BRIGHTTEST_LEASE` when `--lease` is
  absent. A token for a command lease is refused (exit 2): those end with their command.
- `device lock` on a device you already hold through `BRIGHTTEST_LEASE` exits 2 instead of queueing behind
  yourself. Unlock first.
- A command under the token does not press Home itself (only `device lock` did, once). `e2e run` is the exception
  when it starts the instrument hub (state or net steps, or a top-level `net` key in `brighttest.json`): it presses
  Home twice once at the start of the run, so an app left running by an earlier run restarts
  and says hello to the new hub. Without that, a plain launch is ignored by a running channel and state steps
  fail with `STATE_NOT_INSTRUMENTED`. `--no-hygiene` or `deviceLease.hygiene: "none"` skips it. This applies to any
  re-entrant lease: `device with -- brighttest e2e run` takes a command lease (the parent presses Home), and the
  child's run sees it as re-entrant and presses Home twice again. That is harmless and intended, since a wrapped
  script may have launched the app in between. Under a plain per-command lease taken by `e2e run` itself, the
  lease does the Home presses and `e2e run` adds none.
- Treat the token like a password: it lets anything that has it use the device. Do not write it to files or logs.

## Exit codes

| Code | Meaning |
|---|---|
| `0` (or the command's own code) | ok |
| `75` | the device is busy (`--wait 0`) or the wait timed out |
| `77` | the lease was lost, reached its `--max` deadline, or the `BRIGHTTEST_LEASE` token is no longer held |
| `78` | the lease directory is unusable (permissions, disk full, read-only) |
| `2` | usage error |

`device with` passes the wrapped command's exit code through. If that command itself exits 75 or 77, the
`[brighttest lease] …` line on stderr tells the two cases apart.

## Crashes and stuck holders

- A holder that crashes (even `kill -9`) frees the device within about a second, because waiters check
  its PID. If it started child processes (the Rooibos CLI, a `device with` command) that are still running,
  the device stays held until they exit: the device *is* still in use.
- A waiter that is killed (`kill -9`, or an agent's Bash tool timeout) keeps its place in the queue for 60
  seconds. A new waiter with the same `--as` and `--purpose` in that window adopts the ticket and keeps the
  place (the `events.log` gets an `adopted` entry); after 60 s the ticket is removed. Adoption never extends
  the 60 s.
- A holder that hangs is bounded by its deadline (`maxHold`, default 60 minutes).
- Laptop sleep is safe: the heartbeat is not used to decide liveness. A holder that sleeps past its deadline
  exits 77 when it wakes, and the run has to be redone.
- If you must free a device by hand (the holder is yours and stuck):

  ```bash
  npx brighttest device unlock --force --host 192.168.1.50 --reason "stuck after laptop sleep" [--kill]
  ```

  The old holder is told it lost the lease (it notices within a second and exits 77); it does not take the
  device back. Without `--kill` its process is left running, so stop it yourself if it is still touching
  the device.

  `--force` refuses a live holder without `--reason`; `--kill` also terminates the holder and its child
  processes. The action is recorded in the audit log. Never force-unlock someone else's lease without asking.

## Opting out

`--no-lease`, `BRIGHTTEST_NO_LEASE=1` or `"deviceLease": { "enabled": false }` run a lane without the lease.
Each prints a loud warning and records a `bypass` event. It is meant for a single user who knows nobody else
uses the device; agents must never use it.

## Foreground advisory

Right after a lease is acquired with no wait in the queue, brighttest asks the device in the background
(`GET /query/active-app`, 1 s timeout, response capped at 64 KB) what is in front. If the dev channel is up,
one warning line goes to stderr: a manual run or another tool may be using the device. It warns only when all of
these hold:

- the acquire did not queue behind another holder;
- nothing on that device was released, reclaimed, force-unlocked or lost in the last 10 minutes (normal leased use, such as a sideload, leaves the
  dev channel running on purpose);
- the foreground app has the id `dev` or the ui-location `dev`.

The check never delays or fails the acquire, and nothing is written to the lease record. An unreachable
device, an HTTP error or any other foreground app prints nothing. The pool gate does not run it; the chosen member does (one request and one warning per member pick). MCP tool
calls skip it. It is best effort: a fast-exiting command such as `device lock --no-hygiene` can exit before the
request is sent or answered, and releasing the lease cancels it. Set `BRIGHTTEST_LEASE_NO_FOREGROUND_CHECK=1` to turn it off.

## Configuration

All optional, in `brighttest.json`:

```jsonc
"deviceLease": {
  "enabled": true,       // false = --no-lease for this project
  "wait": "30m",         // default queue time (BRIGHTTEST_LEASE_WAIT and --wait win)
  "maxHold": "60m",      // hard cap on one hold
  "sessionIdle": "10m",  // session lock (device lock): idle expiry, renewed by every use of the token
  "sessionMax": "45m",   // session lock: hard cap
  "hygiene": "home",     // "home" | "none": Home ×2 after acquiring, for e2e run and device with
  "studioIdle": "5m",    // Studio releases after this long without user activity
  "studioYield": "60s",  // …or after this long when someone is queued
  "pool": ["192.168.1.10", "192.168.1.11"]  // devices for `--device any` (see below)
}
```

| Environment variable | Meaning |
|---|---|
| `BRIGHTTEST_AGENT` | Holder label shown in `status` (e.g. `dev#2`, `device-qa#1`, `ci:run-123`) |
| `BRIGHTTEST_PURPOSE` | Free-text purpose (default: the command line, with passwords removed) |
| `BRIGHTTEST_LEASE_WAIT` | Default wait (a duration); overrides the config |
| `BRIGHTTEST_LEASE_DIR` | Lease directory (default `~/.brighttest/leases`) |
| `BRIGHTTEST_LEASE` | A held lease token; set by `device with` for its command (nested calls re-use it), or by you for a session from `device lock` |
| `BRIGHTTEST_NO_LEASE=1` | Same as `--no-lease` |

Leases live in `~/.brighttest/leases/<key>/` (`holder.json`, a `queue/` of tickets, `events.log`). Passwords and
device serial numbers are never written there (only a hash). The directory must be on a **local** file system
(NFS is not supported).

**Keys.** A device lane (`device with|lock`, `e2e run`, `--device`, `--cross-check`) first reads the device's
serial number (or device-id) from its device-info page, waiting at most 1.5 s, and takes **two** leases under one
token: the identity key `id-<16 hex>` (a hash of the serial), then the address key (the host resolved to an IP,
plus `_p<port>` when the ECP port is not 8060). Two addresses, a host name and its IP, or two ECP ports that
reach the same device share the identity key, so they queue; two devices never share one. Everything that knows
only an address (Studio, the MCP server, `--device any` pool picks) takes the address key alone, so it still
collides with an identity-keyed lane that reached the device by the same address. `device status`, `log` and
`unlock --force` with `--host` look at both keys; `unlock --lease` and `renew` cover both. Under a held
`BRIGHTTEST_LEASE` the lane reuses the key it already holds and does not read the device again.

If the device-info read fails (unreachable, error, timeout, for example while the device reboots), the lane
prints `device identity not read (<reason>); leasing by address <host>` every time and writes the same line as a
`note` event to `events.log`. It then uses the identity key last remembered for that host (kept in
`identity-cache.json` in the lease directory, hashes only, mode 0600) in addition to the address key, so a lane
that holds the device by identity is still met; with nothing remembered it holds the address key only.

Status, `log` and `unlock --force` with `--host` use the remembered identity key only when its holder was reached
by that same host and ECP port (or both keys are one hold), so a stale cache entry after a host changed address never touches
another device's lane. A key that is not held prints `<key> was not held` and `unlock --force` still exits 0; an
unreadable lease directory is an error (exit 78). Two ECP ports of one fake device are two devices to this lookup:
`status --host` by the second port can under-report a holder, which fails closed (nothing is released). A lane that holds a lease for one device (under `BRIGHTTEST_LEASE`) and then locks a
second device queues for it while still holding the first; two lanes doing this in opposite order wait for each
other until `--wait` times out (exit 75). Lock one device at a time.

Known limits: the same device can still end up with two unrelated holders when an address-only holder (Studio,
MCP, a pool pick, a lane whose read failed with nothing remembered) uses a different address or port than an
identity-keyed lane; and a host name that does not resolve is leased by name (brighttest prints a warning).
Use the device IP and the default port. Both are recorded as `note` events in
`events.log`, as are Studio's profiling and Perfetto stops when it yields the device; `released` events carry the
reason (idle, yielded to another agent, released from the UI).

## A pool of devices: `--device any`

With two interchangeable devices, list them in `deviceLease.pool` and run `brighttest --device any`, or
`brighttest device with --device any -- <cmd>` (`-d any` works too). The run takes the **first free device** of
the pool, in list order, and prints which one it chose; `device with` sets `ROKU_HOST` for the command to that
device. If all are busy it queues, **first come, first served across the pool**: the oldest waiter gets the next
device that frees up, whichever one it is. An explicit `--host` always wins: the pool is then not used.

The pool is a list of IPv4 addresses or host names (no port, no password, no IPv6 address, no duplicates, not
empty). A bad value stops a `--device any` run with a message that names the entry number and the problem, never the value.
For `--device` and `--cross-check` every pool device needs a dev password (`--password`, `ROKU_PASSWORD`, or the
device cache), checked before any lease is taken (exit 2). `--wait`, `--as` and `--purpose` work as for a single
device. `--wait 0` scans the pool at once and fails with exit 75 only when every device is busy, or when other
runs are already queued for the pool (it does not barge past them); it never fails just because another run is
choosing at the same moment. `--device any` belongs to the lanes and to `device with` only (`device lock` and the
others reject it, exit 2), and `--device=any` works like `--device any`. A bad pool in `brighttest.json` is
reported (exit 2) only when `--device any` is used; headless runs ignore it. Brighttest does not check whether a
pool device is reachable.

Internally the choice is serialized by a short-lived lease named `pool-<id>` that you may see in `device status`
for a moment. It is held only while choosing, never while the device is in use. With `--cross-check` the pick
happens when the device phase starts, so no device is held during the headless leg.

## Studio

Studio takes the lease on its first device request from an open tab (or any action: a key press, a flow
run, a launch) without queueing. Background polling does not count as activity, so Studio releases the
device after `studioIdle` without user actions, or after `studioYield` when someone else is waiting. While
someone else holds the device, device requests answer `423 Locked` with the lease status, the UI shows who
has the device and pauses polling, and **Take over when free** queues Studio like anyone else. Studio never
preempts. A lease badge in the header is always visible: who holds the device (or free), how many are queued, and whether Studio is holding, queued or released; click it to see the waiters in queue order. With `deviceLease.pool` set and no `--host`, Studio takes one free pool member when it takes the lease (the same FIFO pick as `--device any`) and talks to that device until it releases; every pool member needs a password (`--password`, `ROKU_PASSWORD`, `.env` or the device cache), and the instrument hub is not started in pool mode (connecting to a device later does not start it either: restart Studio with `--host`). A flow running from Studio counts as activity and is never interrupted by the idle or yield
release, but if the lease is lost or you release it from the UI, the flow is aborted at once (the run stream
ends with an `aborted` event). A running profiling session does not count as activity and does not hold the
lease: when Studio releases the device the session is stopped, and its export ends with a marker saying why.
`GET /api/lease` returns the status; `POST /api/lease {"action":"acquire"|"release"}` queues or
releases.

### Perfetto tracing cannot be switched off

The Profile page can enable Perfetto tracing on the device, but brighttest cannot disable it: there is no known
(documented) disable call or state query. Stopping a trace in Studio only closes the stream. Tracing can stay on
after you stop the trace. On one Roku Ultra (firmware 16.0.4) a channel relaunch, and Home then launch, did not clear it: the
stream still delivered data with no new enable request. Whether a device restart clears it has not been
tested. brighttest cannot confirm the current state. Studio shows what it recorded instead: `enabled by
brighttest at <time>, device state not queryable` (with the date when the record is more than a day old), or
`no brighttest record; device state not queryable` when it has no record. It never shows the device as off.
Internally, enables older than six hours are re-sent, since the device may have restarted; that does not hide
the record from this line.

If port 8700 is taken (another worktree's Studio), `brighttest studio` uses the first free port of
8701-8709 and prints it. An explicit `--port` that is taken fails at once and names the process using it.

## CI and several users

- **CI on the same machine as the same user**: nothing to set up. Give runs a label and a longer wait:
  `BRIGHTTEST_AGENT=ci:<run id>` and `BRIGHTTEST_LEASE_WAIT=45m`, and add
  `npx brighttest device status` steps before and after the device steps (see [CI integration](./ci)).
- **CI as another OS user on the same machine** is not supported: the lease directory and its files are
  created private to one user (0700/0600). Run CI as the same user that runs the other device work.
- **Another machine** cannot see the lease. Dedicate the device to that machine while it runs.

## The Claude Code guard hook

`brighttest device hook` is a Claude Code `PreToolUse` hook for the Bash tool (`lib/device-hook.js`). Register it
in `.claude/settings.json` with `node bin/cli.js device hook` (this repo does, with a 5 s timeout).
In a project that depends on brighttest, `npx brighttest skills install --agent claude --with-hook` merges the entry for
you (see [Agent skills](./agent-skills.md#guard-hook-and-mcp-server-opt-in-claude-target)). That changes one user file,
`.claude/settings.json`, by appending to `hooks.PreToolUse`; it never overwrites, and `skills uninstall --agent claude`
or deleting that entry undoes it. The merged command is
`node "$CLAUDE_PROJECT_DIR/node_modules/brighttest/bin/cli.js" device hook`.
 It reads the
hook JSON on stdin and denies a raw device command (`curl`/`wget` to the device ports, `nc`, a bare `rooibos`
run) unless the command is wrapped by a lease-aware command (`device with`, an e2e or `--device` run) or carries a
live `BRIGHTTEST_LEASE` token from `device lock`. The deny message prints the `device with` command to use instead,
and `--no-lease` / `BRIGHTTEST_NO_LEASE` are always denied for agents. The rule is syntactic, so it cannot see
script files, URLs built from variables, `python`/`node` one-liners or MCP tools. If the hook itself fails (bad
input, timeout), it allows the command and logs to `events.log`, and it always exits 0.

## What the lease cannot stop

The lease only protects access that goes through brighttest (or `device with`). A script that opens its
own connection to the device, a URL built in code, another terminal or another machine can still interfere.
Wrap such commands in `brighttest device with -- …`.

The lease controls who can send commands to the device. It does not keep the app alive or restart it, and its
caps (`maxHold`, the session cap, the idle timeout) do not either. A long run can outlast the device's own
screensaver window, about 10 minutes after the last input, even while the lease is valid. See
[Long device runs stop after about 10 minutes](/guide/troubleshooting#long-device-runs-stop-after-about-10-minutes).
