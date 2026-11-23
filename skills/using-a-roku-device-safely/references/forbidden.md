# What an agent must never do

Each item has a reason. If a task seems to need one of these, stop and ask the human.

| Never | Why | Do instead |
|---|---|---|
| Never use `--no-lease`, `BRIGHTTEST_NO_LEASE`, or `deviceLease.enabled: false` | It removes the only protection against two users on one device | `device with`, or a lane |
| Run `device unlock --force` (with or without `--kill`) | It takes the device from a live holder who may be mid-run | Wait, check `device status`, ask the owner |
| Kill another holder's process | Same as above | Wait for its deadline |
| Send raw `curl`, `wget`, `nc` or a bare `rooibos` run to the device | Not leased, so it collides | Wrap in `device with --` |
| Use sudo or change a firewall | Out of scope and not reversible by you | Report the blocker |
| Change device settings (screensaver, network access, developer mode) | Shared device, owner decides | Report what doctor says |
| Write the dev password to any file, log or report | Secrets leak | See `secrets.md` |
| Write a lease token to a file or log | It lets anything use the device | Shell variable only |
| Press `PowerOff` or input-switch keys | The device would leave the app | None; they are refused |
| Loop on exit 75 or hold a lock while idle | Starves others | Wait once, or release |
| Leave a session lock held at the end | Blocks others until idle expiry | `device unlock` |

## The guard hook and its gaps

`brighttest device hook` is a Claude Code `PreToolUse` hook for Bash. It denies raw `curl` or `wget` to the
device ports, `nc`, and a bare `rooibos` run unless the command is wrapped by a lease-aware command or carries
a live token. It always denies the lease bypass flags for agents.

The rule is syntactic. It cannot see script files, URLs built from variables, `python` or `node` one-liners,
or MCP tools. A passing hook does not make a command safe: you still wrap those in `device with`. If the hook
itself fails it allows the command, so it is a backstop, not a gate.

## What the lease cannot stop

A script with its own connection, another terminal, or another machine can still interfere. The lease also
does not keep the app alive; see the stall in `device-quirks.md`.

## Reporting

When no device was reachable or leased, say "NOT VERIFIED on a device" and give the exact command the human
should run. Do not claim a pass from a headless run.
