---
name: using-a-roku-device-safely
description: Use before any command that touches a real Roku. Covers the device lease (`device status`, `device with`, `device lock`), the lease exit codes 75, 77 and 78, `brighttest doctor`, ECP Permissive mode, the ports 8060, 80, 8085 and 8080, `--keepalive` and the stall at about 10 minutes, firmware quirks, how to handle the dev password, and what an agent must never do on a shared device.
triggers: roku device lease; device with; device lock; device status; exit 75; ecp limited mode; keepalive; touch a real roku; device busy; device password
when-not-to-use: Do not use for headless runs that never reach a device (use writing-rooibos-tests), or for the MCP tool list (use using-brighttest-mcp). It does not teach flow syntax (use writing-e2e-flows). For where to start or whether brighttest fits at all, use adopting-brighttest.
license: MIT
metadata:
  source: brighttest
---

# Using a Roku device safely

A Roku does one thing at a time. A second sideload replaces the dev channel under a running test, two runs
press each other's keys, and the debug ports take one client each. Nothing on the device reports the clash:
you only get wrong results. brighttest therefore leases each device. Every command that touches a device
takes the lease first and waits its turn.

Evidence: documented in `docs/guide/device-lease.md` and `docs/guide/troubleshooting.md`, and checked against
`lib/device-hook.js` and the facts gate. Not device-verified by this skill. The 10-minute stall and the 240 s
`Fwd` keepalive are a single-device observation, not verified across devices or firmware.

## Before you touch a device

1. Name yourself: `export BRIGHTTEST_AGENT=<role>#<n>` (or pass `--as`). Give each command a `--purpose`.
2. Check health, no lease needed: `npx brighttest doctor --host <device-ip>`. Fix Limited ECP or disabled
   developer mode first (see `references/device-quirks.md`).
3. See who has the device: `npx brighttest device status` (add `--json` for scripts).
4. Run the work through a lane or the wrapper. Never send raw `curl` or `nc` to the device.

```bash
npx brighttest device with --as "$BRIGHTTEST_AGENT" --purpose "<task>: <check>" -- <command>
```

Run anything that can take minutes in the background with a deadline, and poll with a bounded loop.

## Which tool takes the lease

- Lanes (`--device`, `--cross-check`, `e2e run`, `e2e inspect`, `e2e record`), `studio`, `instrument build --sideload` and the MCP device tools take it themselves. Do not wrap `studio` in `device with`.
- Any other command (a script, `curl`, a runner) goes inside `device with --`.
- Several steps in a row: `device lock` prints a token; run each step with `device with --lease <token>`;
  end with `device unlock --lease <token>`. The token expires on idle, so renew it with `device renew`.
- Reads that cannot disturb a run (`doctor`, `devices`, `query/device-info`) need no lease.

## Lease exit codes

| Code | Meaning |
|---|---|
| 75 | the device is busy (`--wait 0`) or the wait timed out |
| 77 | the lease was lost, reached its `--max` deadline, or the token is no longer held |
| 78 | the lease directory is unusable (permissions, disk full, read-only) |

On 75, wait and retry later or choose another device; never loop on it. On 77, the run is void: redo it under
a fresh lease. On 78, report it to the human; do not work around it. `device with` passes the wrapped
command's own exit code through, so read the `[brighttest lease]` line on stderr to tell the cases apart.

## Never do this

- Never use `--no-lease` or `BRIGHTTEST_NO_LEASE`; agents must not bypass the lease.
- Never run `device unlock --force`, and never kill another holder.
- Never use sudo, change a firewall, or change a device setting such as the screensaver.
- Never write the dev password or a lease token to a file, a log, a commit or a report.
- Never press `PowerOff` or an input-switch key (MCP refuses them; flows and raw ECP do not).

Details: `references/forbidden.md` and `references/secrets.md`.

## When it goes wrong

- A run stops at about 10 minutes with no keys: the device screensaver window. Use
  `device with --keepalive -- <long command>` (see `references/device-quirks.md`).
- Console capture fails with "already in use": another client holds port 8085. Close it.
- A halted or stuck app: `device reset` (needs the dev password, set out of band).
- Say "NOT VERIFIED on a device" in your report whenever no device was reachable or leased.

## References

- `references/lease-protocol.md`: status, with, lock, renew, queue, waits and caps, crashes.
- `references/device-quirks.md`: ECP mode, ports, keepalive and the stall, firmware notes, doctor.
- `references/forbidden.md`: the full never-list, the guard hook and its gaps.
- `references/secrets.md`: the dev password and tokens, and how to pass them.

See also `using-brighttest-mcp` (leased tool calls) and `debugging-failing-tests` (symptom lookup).
