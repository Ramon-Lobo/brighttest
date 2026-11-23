# Device job on a self-hosted runner (opt-in)

A device job needs a real Roku on the runner's LAN, so it cannot run on GitHub-hosted runners. It is separate,
manual or scheduled, never required, and never part of the headless job. Ask the human first: it needs a
registered runner and two secrets only they can create. The repo's `.github/workflows/e2e-device.yml` is the
verified shape; copy its structure.

Lease rules (the queue, exit 77 lease lost, exit 78 lease directory unusable, never `--no-lease`, never `device unlock --force`): read
`using-a-roku-device-safely` and `docs/guide/device-lease.md`. They are not repeated here.

## One-time setup (human)

1. Register a self-hosted runner on a machine near the Roku and label it `roku`. The Roku needs developer mode
   and ECP network access set to Permissive (`npx brighttest doctor --host <device-ip>` checks it).
2. Add repository secrets `ROKU_HOST` and `ROKU_PASSWORD` in the repository settings. Never put them in a file.
3. Run the runner as the same OS user as any local developer or agent on that machine. The lease is a per-user
   directory and does not span users or machines (`docs/guide/ci.md`, `docs/guide/device-lease.md`).

## The job

```yaml
name: device
on:
  workflow_dispatch:
    inputs:
      flows:
        description: "Flow path (file or directory of *.e2e.yaml)"
        default: "flows/"

permissions:
  contents: read

concurrency:
  group: roku-device
  cancel-in-progress: false

jobs:
  e2e:
    runs-on: [self-hosted, roku]
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: "22"
      - run: npm ci
      - name: Run flows under the lease
        env:
          ROKU_HOST: ${{ secrets.ROKU_HOST }}
          ROKU_PASSWORD: ${{ secrets.ROKU_PASSWORD }}
          FLOWS: ${{ inputs.flows }}
          BRIGHTTEST_AGENT: ci:${{ github.run_id }}
          BRIGHTTEST_LEASE_WAIT: 30m
        run: |
          npx brighttest device status
          rc=0
          npx brighttest e2e run "$FLOWS" --screenshots e2e-artifacts --screenshots-mode failure || rc=$?
          if [ "$rc" -eq 75 ]; then
            echo "device busy: the lease wait timed out (exit 75); not retrying" >&2
          fi
          exit "$rc"
      - if: always()
        uses: actions/upload-artifact@v7
        with:
          name: e2e-screenshots
          path: e2e-artifacts
          if-no-files-found: ignore
```

- `e2e run` takes the lease itself, per device. Do not wrap it in `device with`. A step that is not a brighttest lane
  (a script, `curl`, `npx rooibos`) goes inside `npx brighttest device with -- <cmd>`.
- `BRIGHTTEST_AGENT` labels the holder in `device status` (`ci:run-123` is the help text's own example form).
  `BRIGHTTEST_LEASE_WAIT` is how long the job queues for the device; `docs/guide/ci.md` sets a longer value for CI. `--wait 0` fails at once if the device is busy.
- `concurrency: group: roku-device` makes workflow runs queue behind each other instead of cancelling. The host
  is a secret and cannot be in the group name, so the group is a fixed label (as `e2e-device.yml` explains).
- The `FLOWS` input goes through `env:` and is quoted, never interpolated into the shell line.
- `--cross-check` is the other device lane: `npx brighttest --cross-check --host "$ROKU_HOST" --password
  "$ROKU_PASSWORD"` (the form in `docs/guide/ci.md`; it puts the password on the command line, and whether
  `--cross-check` reads `ROKU_PASSWORD` alone is unverified).

## Exit codes in CI

| Code | Meaning | What the job does |
|---|---|---|
| 0 | flows passed | green |
| 75 | the device is busy or the wait timed out | the step fails with a clear line; do not loop, re-run the workflow later or ask the human for another device |
| 77 | the lease was lost or hit its `--max` cap | the run is void; fail the job, do not trust partial results |
| 78 | the lease directory is unusable | fail the job and report it; do not work around it |
| other | the flow run's own failure | fail the job; read the uploaded screenshots |

Whether to mark exit 75 (device busy) as neutral instead of failed is the human's decision; the default is failed and visible.
Do not hide it with `|| true`.

## What not to do

- No device step on a hosted runner, and no device job on `push` or `pull_request` (a fork's pull request would
  run on the human's network).
- Do not print `ROKU_HOST` or the password; the repo's workflow summary prints only the number of devices.
- Do not hold the lease across steps unless you need to; a long hold blocks every local agent on that device.
  A multi-step session lock needs one shell invocation with an `unlock` trap (see `using-a-roku-device-safely`).
- Not device-verified: this job has not run against a real device in this skill.
