# Does this need a device?

Evidence: the headless and device capability split is from `skills/writing-rooibos-tests/references/limitations.md`
and `npx brighttest --help`; the greenfield run of a reducer spec headless was run on a scratch copy of
`examples/greenfield-skeleton`. The device rows are not device-verified. `<device-ip>` is a placeholder.

## Default: headless

`npx brighttest --junit results.xml` runs pure specs and `@SGNode` suites with no device, including
`onChange` observer cascades. `--coverage` adds LCOV, still with no device. Start and finish most work here.

## Table

| The feature | Headless is enough? | Use a device for |
|---|---|---|
| Reducers, parsing, formatting, validation | yes | nothing |
| A node's field logic and observers | yes (node suite) | optional cross-check |
| HTTP shape of a request or response | yes, with mocked rules | real server and certificates |
| Screens, focus order, text on screen after keys | no | an e2e flow (`writing-e2e-flows`) |
| Real remote input, animation timing, wall-clock waits | no: simulated | a flow or `--device` run |
| Layout, pixels, video, audio, DRM | no | a human looking at the screen |
| "Works on device" as a claim in a report | no | a run on the device, with model and firmware |

`brighttest --cross-check --host <device-ip>` compares headless with the device when you need to know whether
the simulator is faithful (`debugging-failing-tests`).

## Device rules, in short

- Every device command takes the lease. Load `using-a-roku-device-safely` before the first one; it holds the
  protocol, the exit codes and the forbidden list. This file does not repeat them.
- Never use `--no-lease` or `device unlock --force`. Never press `PowerOff` or an input-switch key. Never run raw `curl` to a device, sudo, or change a firewall, pf or any device setting. Do not use `env`, `printenv` or `pgrep -f`.
- Run long device work in the background with a deadline, and report anything you did not run as "not run on a
  device" with the exact command for the human.
- The device password is set by the human in `ROKU_PASSWORD` or a gitignored `.env`. Run
  `git check-ignore -q .env || printf '.env\n' >> .gitignore` first (`init` does not do it). Never write,
  print or log the password, and never put it in a spec, flow, script or report. Use `<ROKU_PASSWORD>`.

## What to put in the hand-back

For each feature: `headless: pass (N tests)` or `device: not run`, and the command the human can run, for
example `npx brighttest e2e run flows/<name>.e2e.yaml --host <device-ip> --as "$BRIGHTTEST_AGENT" --purpose "<task>: <check>"`
(check the flags with `npx brighttest e2e --help`).
