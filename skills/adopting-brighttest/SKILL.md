---
name: adopting-brighttest
description: Use first when asked to add brighttest or automated tests to a Roku/BrightScript app, or to start a new Roku app with tests, and you need to know where to begin. It picks the existing-app or new-app path, gives the order of steps, names the sibling skill to load at each step, lists the hard rules (device lease, secrets, honest claims), says when brighttest is the wrong tool, and defines what "adopted" means.
triggers: adopt brighttest; add tests to a roku app; where do i start with brighttest; start a new roku app with tests; brighttest adoption plan; is brighttest the right tool
when-not-to-use: Do not use to install the package or edit brighttest.json (use setting-up-brighttest), or to write specs or flows once you know the path (use writing-rooibos-tests or writing-e2e-flows). It teaches no command in depth.
license: MIT
metadata:
  source: brighttest
---

# Adopting brighttest: where to start

This skill is a router. It decides the path, gives the order of steps and points to the skill that holds the
detail. Load it first, then load one sibling at a time.

Evidence: commands checked against `node bin/cli.js --help`, `init --help`, `assess --help`, `instrument --help`
and `device --help` at this version. Not device-verified. The path rules come from `docs/guide/` (listed in
`references/command-cheatsheet.md`).

## Step 0: is brighttest the right tool?

brighttest tests BrightScript and SceneGraph code headless, and drives a real Roku for UI flows. It is the wrong
tool for some jobs. Say so to the human instead of forcing it:

- Visual or pixel checks, video quality, DRM playback, real network performance: headless is a simulator and
  there is no pixel diff. Only a human on a real device can judge these.
- An app whose logic cannot be reached without a device you do not have: you can still write headless specs, but
  report every device claim as "not device-verified".
- A task that only needs a sideload: use `instrument build --sideload` and `using-a-roku-device-safely`. A one-off
  screenshot or live tree read: use `using-brighttest-mcp`. Neither is an adoption.
- You have no permission to change the repo: you can still assess (read-only) and write a plan.

See `references/decision-tree.md` for the full table.

## Step 1: pick the path

| Situation | Path | Load first |
|---|---|---|
| Existing app, any size, tests absent or thin | existing app | `setting-up-brighttest` now; `assessing-a-roku-app` and `adopting-brighttest-brownfield` when installed |
| New app, nothing written yet | new app | `setting-up-brighttest` now; `adopting-brighttest-greenfield` when installed |
| You may not edit the app's code | existing app, no-edit | the same as existing, then `instrument` (see `references/command-cheatsheet.md`) |
| App already has Rooibos specs that fail | not adoption | `debugging-failing-tests` |

## Step 2: the order of work

1. Install and check the tool: `npm i -D brighttest`, then `npx brighttest --version`. Needs Node 22 or newer.
2. Existing app: assess first, read-only, nothing written without `--out`:
   `npx brighttest assess . --json`. Read `recommendation.path`, `recommendation.blockers` and
   `recommendation.editPermission` (always `unknown`: ask the human). Then:
   - `brownfield`: existing-app path.
   - `greenfield`: the app has a manifest, fewer than 5 components and no specs. Even for an existing app the
     next step is `npx brighttest init`, not `init --greenfield` (that edits the manifest and writes into `source/`).
   - `not-a-roku-app`: stop and ask the human; run assess from the folder with the manifest.
   New app with nothing written yet: `npx brighttest init --greenfield`.
   Read every entry in `recommendation.blockers` before step 3 (what each one means and does:
   `references/decision-tree.md`). A blocker means brighttest cannot see, or does not honor, part of the app.
   Do not edit bsconfig or move folders to clear one without the human's OK.
3. Get one headless run green: `npx brighttest --junit results.xml`. Fix the config before writing tests.
4. Add specs for the logic that matters (`writing-rooibos-tests`). Add flows only for what needs a screen
   (`writing-e2e-flows`). State inside a running app is `testing-app-state`.
5. Gate it in CI with the headless command (see `references/command-cheatsheet.md`).
6. Only then touch a device, through the lease (`using-a-roku-device-safely`).

## Hard rules for every step

- Every device access goes through a brighttest lane or `npx brighttest device with --as "$BRIGHTTEST_AGENT"
  --purpose "<task>" -- <cmd>`. Never `--no-lease`, never `device unlock --force`, never raw `curl` to a device.
  Load `using-a-roku-device-safely` before the first device command.
- Never run sudo or change a firewall, pf or any device setting. Never press `PowerOff` or an input-switch key
  (MCP refuses them; flows and raw ECP do not).
- The dev password lives in `ROKU_PASSWORD` or a gitignored `.env`. Run `git check-ignore .env` first and add it to
  `.gitignore` before any password is written. Never print it, commit it or put it in a report.
- Headless is not a device. Write "not device-verified" when you did not run on a Roku.
- An instrumented package (`*.bt-instrumented.zip`) is debug-only. `instrument verify` on the store zip must
  exit 0 before any publish.
- Do not edit the app's own source to make a test pass unless the human allowed it. Say what you changed.

## What "adopted" means

Adopted is a checklist, not a feeling. See `references/exit-criteria.md`. In short: a headless run is green and
writes JUnit, the config and ignore entries are committed, at least one real spec or flow guards real logic, CI
runs the headless gate, and the report names what was not run on a device.

## Coming skills (planned, not installed yet)

`assessing-a-roku-app`, `adopting-brighttest-brownfield`, `adopting-brighttest-greenfield`,
`instrumenting-a-roku-app`, `wiring-brighttest-into-ci`, `mocking-network-and-store`. Until a sibling is
installed, use the existing skill named in the table, and read `references/command-cheatsheet.md`. Run
`npx brighttest skills list` to see the skills bundled with this version and the agents it detects.

## References

- `references/decision-tree.md`: tool fit, path choice, edit rights, device or not.
- `references/command-cheatsheet.md`: the verified commands by step, with flags and exit codes.
- `references/exit-criteria.md`: the "adopted" checklist and the report an agent hands back.
