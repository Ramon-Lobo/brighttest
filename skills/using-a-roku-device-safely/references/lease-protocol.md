# Lease protocol

One lease per device, first come, first served, no priority and no preemption. It covers terminals,
worktrees, agents and CI jobs on the same machine as the same OS user. Another machine cannot see it.

## Look first

```bash
npx brighttest device status           # holder, purpose, since, deadline, queue, est. wait
npx brighttest device status --json
npx brighttest device log --tail 20    # audit log: acquired, released, queued, timeout, reclaimed
```

A holder is described by its agent label, purpose, worktree and branch, cwd and PID. Set `BRIGHTTEST_AGENT`
and `--purpose` so the next reader can tell whose it is.

## One command: `device with`

```bash
npx brighttest device with --as "$BRIGHTTEST_AGENT" --purpose "<task>: <check>" -- <command>
```

It takes the lease, presses Home twice (skip with `--no-hygiene`), runs the command with `ROKU_HOST`,
`ROKU_PASSWORD` and `BRIGHTTEST_LEASE` in its environment, and releases on exit. A brighttest command started
inside it re-uses the lease instead of waiting for itself.

| Option | Meaning |
|---|---|
| `--host <device-ip>` | Device (else `ROKU_HOST`, else the cached device) |
| `--wait <dur>` | How long to queue (default 30m); `0` fails at once if busy |
| `--max <dur>` | Hard cap on the hold (default 60m); the command is stopped before it, exit 77 (lease lost at the deadline) |
| `--expect <dur>` | Expected hold, shown to waiters |
| `--keepalive[=<sec>]` | Send one ECP key every `<sec>` seconds while the command runs |

Durations are `90s`, `10m`, `1h` or plain milliseconds.

## Several steps: a session lock

Agent Bash tools usually reset shell state between calls, so a token kept in a variable is lost and the lock
stays held until idle expiry. Do lock, steps and unlock in ONE shell invocation, with the unlock in a trap:

```bash
TOKEN=$(npx brighttest device lock --host <device-ip> --as "$BRIGHTTEST_AGENT" --purpose "<task>") || exit $?
trap 'npx brighttest device unlock --lease "$TOKEN"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
npx brighttest device with --lease "$TOKEN" -- <command-1> \
  && npx brighttest device with --lease "$TOKEN" -- <command-2>
```

Chain the steps with `&&` so the first failure stops the rest and sets the exit status of the whole
invocation. The EXIT trap unlocks exactly once, on success, failure or a signal (INT and TERM exit, which
fires the EXIT trap). Checked with a stub in bash and zsh. Do not use `set -e` with this in zsh: the EXIT
trap did not fire there. Read that exit status before reporting success.

If the steps need separate calls, prefer `device with` per step instead of a session lock.

- `device lock` queues like any command, presses Home twice, and prints the token on stdout.
- No process owns a session. It ends on `device unlock`, after `--idle` (default 10 minutes) without use, or
  at `--max` (default 45 minutes). Each use of the token renews the idle time, never past `--max`.
- A command carrying an expired or unlocked token exits 77 and does not run unlocked.
- `device lock` on a device you already hold exits 2. Unlock first.
- Keep the token in a variable inside that one invocation. Never write it to a file or a log.

## Exit codes

| Code | Meaning |
|---|---|
| 75 | the device is busy (`--wait 0`) or the wait timed out |
| 77 | the lease was lost, reached its `--max` deadline, or the token is no longer held |
| 78 | the lease directory is unusable (permissions, disk full, read-only) |
| 2 | usage error |

## Crashes and stuck holders

- A holder that crashes frees the device within about a second. Child processes it started keep it held
  until they exit.
- A waiter that is killed keeps its place for 60 seconds; a new waiter with the same `--as` and `--purpose`
  adopts it.
- A hung holder is bounded by its hold cap. Laptop sleep past the deadline means exit 77 (lease lost) on wake: redo the run.
- Freeing a device by hand is the owner's decision, never the agent's (see `forbidden.md`).

## Pools and CI

`--device any` takes the first free device of `deviceLease.pool`. In CI give runs a label
(`BRIGHTTEST_AGENT=ci:<run id>`) and a longer wait, and add `device status` steps before and after.
