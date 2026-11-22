# Device shelf: a self-hosted runner with Rokus attached

A "device shelf" is one machine on the same LAN as one or more Roku devices, registered as a self-hosted CI runner. Pipelines send on-device e2e runs to it. This page describes the setup for the existing `e2e-device.yml` pattern (see [CI](/guide/ci) and [E2E, Scaling & CI](/e2e/scaling)). GitHub-hosted runners cannot reach a device, so the shelf is the only place these runs can happen.

## Shelf setup

1. Register the machine as a self-hosted runner with a label such as `roku`.
2. On each Roku: enable developer mode, set the developer password, and set Network access to Permissive.
3. Give each Roku a fixed address (a DHCP reservation) so the runner secret stays valid.
4. Install Node on the runner, as in the workflow.

## Secrets: addresses and password stay out of the repo

Device host addresses and the developer password come from the runner's secret store (repository or environment secrets, or the runner's own environment). They are never written in the repository, the workflow file or the docs.

| Variable | Where it comes from | Meaning |
|---|---|---|
| `ROKU_HOST` | secret | One address, or a comma list for several devices (flows shard across them) |
| `ROKU_PASSWORD` | secret | Developer password; screenshots need it |

Use the workflow's `env:` block to pass them, and never echo them. A step summary may print the number of devices, not the addresses.

## The lease: sharing the shelf with people and agents

Every brighttest device command takes the [device lease](/guide/device-lease) itself, so a CI run queues behind a developer using the same Roku and the other way round. Two environment variables set how CI behaves in that queue:

| Variable | Meaning |
|---|---|
| `BRIGHTTEST_AGENT` | Holder label shown in `brighttest device status`, for example `ci:<run id>` |
| `BRIGHTTEST_LEASE_WAIT` | How long the run queues for a busy device (for example `45m`). A wait that times out exits 75 |

If the runner is a different OS user from the people sharing the shelf, point `BRIGHTTEST_LEASE_DIR` at one shared, group-writable directory on both sides so they see the same leases.

## Serializing runs: the `concurrency` group

The lease serializes access to a device. A `concurrency` group on the workflow keeps GitHub from starting a second job on the shelf while the first is still running. The host is a secret and cannot be used in the group name, so use one fixed group per shelf and do not cancel queued runs:

```yaml
concurrency:
  group: roku-device
  cancel-in-progress: false
```

With several shelves, use a different group name per shelf.

## JUnit and artifacts

Pass `--junit <file>` to `e2e run` and upload the file, so a CI test tab can read it ([JUnit output](/e2e/scaling#junit-output)). Upload with `if: always()` so a failed run still publishes its report.

## Sample workflow (text only)

This is a sketch to copy into your own repository. Addresses below are placeholders from the documentation range; the real values stay in secrets.

```yaml
name: E2E (device shelf)
on:
  workflow_dispatch:
    inputs:
      flows:
        description: "Flow path (file or directory of *.e2e.yaml)"
        default: "flows/"

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
      - name: Run on-device flows
        env:
          ROKU_HOST: ${{ secrets.ROKU_HOST }}          # for example 192.0.2.10,192.0.2.11 (placeholder values)
          ROKU_PASSWORD: ${{ secrets.ROKU_PASSWORD }}
          FLOWS: ${{ inputs.flows }}
          BRIGHTTEST_AGENT: ci:${{ github.run_id }}
          BRIGHTTEST_LEASE_WAIT: 45m
        run: |
          npx brighttest device status
          npx brighttest e2e run "$FLOWS" \
            --screenshots e2e-artifacts --screenshots-mode failure \
            --junit e2e-artifacts/junit.xml
      - name: Upload report and screenshots
        if: always()
        uses: actions/upload-artifact@v7
        with:
          name: e2e-report
          path: e2e-artifacts
          if-no-files-found: ignore
```

Pass workflow inputs through `env:` and quote them in the shell, as above, rather than interpolating `${{ }}` into the script.

## Checks before relying on it

- `npx brighttest device status` on the runner lists each device and who holds it.
- Run the workflow once by hand with a single passing flow and confirm the JUnit file shows one passing test case.
- Exit codes: 0 passed, 1 a flow failed (or `--fail-on-skip` hit a skip, or no flow ran), 2 a usage or device-setup error, 75 the lease wait timed out.
