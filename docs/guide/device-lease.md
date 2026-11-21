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
| `--expect <dur>` | Expected hold time, shown to waiters as an estimate |
| `--no-hygiene` | Skip the Home ×2 press after acquiring |

Durations are `90s`, `10m`, `1h` or plain milliseconds. The device lanes (`--device`, `--cross-check`,
`e2e`) accept `--wait`, `--as`, `--purpose` and `--no-lease`.

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
- A waiter that is killed (`kill -9`) loses its place in the queue after 5 seconds. (The design allows 60 s so a
  restarted waiter could take its place back; that arrives with ticket adoption, LSE-T11.)
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

## Configuration

All optional, in `brighttest.json`:

```jsonc
"deviceLease": {
  "enabled": true,       // false = --no-lease for this project
  "wait": "30m",         // default queue time (BRIGHTTEST_LEASE_WAIT and --wait win)
  "maxHold": "60m",      // hard cap on one hold
  "hygiene": "home",     // "home" | "none": Home ×2 after acquiring, for e2e run and device with
  "studioIdle": "5m",    // Studio releases after this long without user activity
  "studioYield": "60s"   // …or after this long when someone is queued
}
```

| Environment variable | Meaning |
|---|---|
| `BRIGHTTEST_AGENT` | Holder label shown in `status` (e.g. `dev#2`, `device-qa#1`, `ci:run-123`) |
| `BRIGHTTEST_PURPOSE` | Free-text purpose (default: the command line, with passwords removed) |
| `BRIGHTTEST_LEASE_WAIT` | Default wait (a duration); overrides the config |
| `BRIGHTTEST_LEASE_DIR` | Lease directory (default `~/.brighttest/leases`) |
| `BRIGHTTEST_LEASE` | A held lease token; set by `device with` for its command (nested calls re-use it) |
| `BRIGHTTEST_NO_LEASE=1` | Same as `--no-lease` |

Leases live in `~/.brighttest/leases/<device>/` (`holder.json`, a `queue/` of tickets, `events.log`). The key
is the device address (plus the ECP port when it is not 8060). Passwords and device serial numbers are never
written there. The directory must be on a **local** file system (NFS is not supported).

The same device can end up with two keys, and then two holders at once: a host name that does not resolve
is leased by name (brighttest prints a warning), while a process that resolves it, or uses the IP, leases by
IP; and a lane run with a different `ROKU_ECP_PORT` than another lane gets a different key (the port is part of
the key unless it is 8060). Always use the device IP and the default port for real devices. Both cases are also recorded as `note` events in
`events.log`, as are Studio's profiling and Perfetto stops when it yields the device; `released` events carry the
reason (idle, yielded to another agent, released from the UI).

## Studio

Studio takes the lease on its first device request from an open tab (or any action: a key press, a flow
run, a launch) without queueing. Background polling does not count as activity, so Studio releases the
device after `studioIdle` without user actions, or after `studioYield` when someone else is waiting. While
someone else holds the device, device requests answer `423 Locked` with the lease status, the UI shows who
has the device and pauses polling, and **Take over when free** queues Studio like anyone else. Studio never
preempts. A flow running from Studio counts as activity and is never interrupted by the idle or yield
release, but if the lease is lost or you release it from the UI, the flow is aborted at once (the run stream
ends with an `aborted` event). A running profiling session does not count as activity and does not hold the
lease: when Studio releases the device the session is stopped, and its export ends with a marker saying why.
`GET /api/lease` returns the status; `POST /api/lease {"action":"acquire"|"release"}` queues or
releases.

If port 8700 is taken (another worktree's Studio), `brighttest studio` uses the first free port of
8701-8709 and prints it. An explicit `--port` that is taken fails at once and names the process using it.

## CI and several users

- **CI on the same machine as the same user**: nothing to set up. Give runs a label and a longer wait:
  `BRIGHTTEST_AGENT=ci:<run id>` and `BRIGHTTEST_LEASE_WAIT=45m`, and add
  `npx brighttest device status` steps before and after the device steps (see [CI integration](./ci)).
- **CI as another OS user on the same machine** is not supported: the lease directory and its files are
  created private to one user (0700/0600). Run CI as the same user that runs the other device work.
- **Another machine** cannot see the lease. Dedicate the device to that machine while it runs.

## What the lease cannot stop

The lease only protects access that goes through brighttest (or `device with`). A script that opens its
own connection to the device, a URL built in code, another terminal or another machine can still interfere.
Wrap such commands in `brighttest device with -- …`.
