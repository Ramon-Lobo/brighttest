# Device shelf: a self-hosted runner with Rokus attached

::: info At a glance
**What it is for:** one machine on the LAN with Rokus, registered as a self-hosted CI runner for on-device e2e runs.

**You will:**
- set up the runner, devices and secrets
- share the shelf (lease + `concurrency`)
- copy and check the sample workflow

**First file:** your `e2e-device.yml` workflow
:::

This is the setup for the existing `e2e-device.yml` pattern (see [CI](/guide/ci) and
[E2E, Scaling & CI](/e2e/scaling)). GitHub-hosted runners cannot reach a device, so the shelf is the only place these
runs can happen.

## Shelf setup

1. Register the machine as a self-hosted runner with a label such as `roku`.
2. On each Roku: enable developer mode, set the developer password, set Network access to Permissive.
3. Give each Roku a fixed address (a DHCP reservation) so the runner secret stays valid.
4. Install Node on the runner, as in the workflow.

## Secrets: addresses and password stay out of the repo

Hosts and the password come from the runner's secret store (repository or environment secrets, or the runner's own
environment), never from the repo, the workflow file or the docs.

| Variable | Source | Meaning |
|---|---|---|
| `ROKU_HOST` | secret | One address, or a comma list for several devices (flows shard across them) |
| `ROKU_PASSWORD` | secret | Developer password; screenshots need it |

Pass them through the workflow's `env:` block and never echo them. A step summary may print the number of devices, not
the addresses.

## The lease: sharing the shelf with people and agents

Every brighttest device command takes the [device lease](/guide/device-lease), so CI and developers queue behind each
other on the same Roku.

| Variable | Meaning |
|---|---|
| `BRIGHTTEST_AGENT` | Holder label in `brighttest device status`, e.g. `ci:<run id>` |
| `BRIGHTTEST_LEASE_WAIT` | How long the run queues for a busy device (e.g. `45m`); a timeout exits 75 |

::: warning Same OS user
Leases across OS users are not supported (the lease directory is private to its user). Run the runner as the same OS
user as the people sharing the shelf.
:::

## Serializing runs: the `concurrency` group

The lease serializes device access; a `concurrency` group stops GitHub from starting a second shelf job meanwhile.

The host is a secret and cannot go in the group name, so use one fixed group per shelf (a different name per shelf)
and do not cancel queued runs:

```yaml
concurrency:
  group: roku-device
  cancel-in-progress: false
```

## JUnit and artifacts

Pass `--junit <file>` to `e2e run` and upload it so a CI test tab can read it
([JUnit output](/e2e/scaling#junit-output)). Upload with `if: always()` so a failed run still publishes its report.

## Sample workflow (text only)

A sketch to copy into your repo. Addresses are documentation-range placeholders; real values stay in secrets.

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

Pass inputs through `env:` and quote them in the shell, rather than interpolating `${{ }}` into the script.

## Checks before relying on it

1. From your own shell on the runner, `npx brighttest device status` lists each device and who holds it. It prints
   device addresses, so do not add it to the workflow or run it in CI logs.
2. Run the workflow once by hand with a single passing flow; the JUnit file should show one passing test case.
3. Know the exit codes:

| Exit | Meaning |
|---|---|
| 0 | passed |
| 1 | a flow failed, `--fail-on-skip` hit a skip, or no flow ran |
| 2 | usage or device-setup error |
| 75 | the lease wait timed out |

::: warning The lease page says otherwise
[Sharing a device](/guide/device-lease#ci-and-several-users) says to add `device status` steps before and after the
device steps in CI. Both statements are kept as written.
:::

## Related

- [CI integration](/guide/ci), [E2E scaling](/e2e/scaling), [device lease](/guide/device-lease)

**Full guide:** [Device shelf](full:/guide/ci-device-shelf) — the original wording.
