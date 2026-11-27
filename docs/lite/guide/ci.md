# CI integration

::: info At a glance
**What it is for:** a headless gate on every push, plus an occasional device fidelity check.

**You will:**
- add a headless job with coverage and JUnit
- add an optional device `--cross-check` job
- share the runner's Roku with local agents

**First command:** `npx brighttest --coverage`
:::

## The pipeline

Run the **headless lane on every push**: a fast, hardware-free gate that also gives **code coverage** (`--coverage`).
Run the **device lane** occasionally (nightly / pre-release) as a **fidelity check** with `--cross-check`.

1. Push / PR runs the headless job (`npx brighttest --coverage`) and uploads coverage.
2. Fail blocks the PR; pass allows merge to main.
3. Nightly, a device job runs `npx brighttest --cross-check` and confirms 0 divergent.

## Exit codes & reports

All flags and exit codes are in the [CLI reference](/guide/cli-reference). Fail the job on any non-zero exit.

| Exit | Meaning |
|---|---|
| `1` | a test failed |
| `2` | usage or config error |
| `75`, `77`, `78` | [device lease](/guide/device-lease#exit-codes) problems |

A device run that prints no result line, or goes silent past `--idle-timeout`, is a failure.

| Flag | Output |
|---|---|
| `--junit <path>` | JUnit XML for test-result UIs |
| `--lcov [path]` | LCOV for Coveralls/Codecov or `genhtml`; works on the **headless `--coverage` lane** (no device) and the device lane |

## GitHub Actions — headless gate (with coverage)

The everyday gate: standard GitHub-hosted Linux runners, **no Roku required**, uploads coverage.

```yaml
name: tests
on: [push, pull_request]

jobs:
  headless:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      - run: npm ci
      - run: npx brighttest --coverage --lcov coverage/lcov.info --junit reports/junit.xml
      - if: always()
        uses: actions/upload-artifact@v4
        with:
          name: junit
          path: reports/junit.xml
      - uses: coverallsapp/github-action@v2
        with:
          path-to-lcov: coverage/lcov.info
```

::: tip Fastest pure-logic gate
`npx brighttest --no-sgnode` skips `@SGNode` suites. Put the `--coverage` job on a separate trigger to keep the
per-push gate sub-second.
:::

## Device lane — fidelity check (optional)

A nightly job on a **self-hosted runner** on the same network as a dev device.

- Not needed for coverage. `--cross-check` confirms headless still matches real firmware; fails on any divergence.
- `brighttest setup` is for workstations (writes a project `.env` and a local default). CI sets `ROKU_HOST` and
  `ROKU_PASSWORD` from secrets in the job environment (the shell variable wins over any `.env`).

```yaml
  cross-check:
    runs-on: [self-hosted, roku]          # a runner that can reach the device
    needs: headless
    if: github.ref == 'refs/heads/main'   # e.g. only on main / nightly
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      - run: npm ci
      - name: Confirm headless matches the device
        env:
          ROKU_HOST: ${{ secrets.ROKU_HOST }}
          ROKU_PASSWORD: ${{ secrets.ROKU_PASSWORD }}
        run: npx brighttest --cross-check --host "$ROKU_HOST" --password "$ROKU_PASSWORD"
```

::: warning Never hard-code device credentials
Keep the device IP and password in CI **secrets** (`ROKU_HOST`, `ROKU_PASSWORD`), passed via `env:`. Never inline or
commit them.
:::

### Sharing the device with local agents

When the runner shares a Roku with people or agents on the same machine, the [device lease](/guide/device-lease)
serializes them. Label the CI holder and give it a longer wait:

```yaml
    env:
      BRIGHTTEST_AGENT: ci:${{ github.run_id }}
      BRIGHTTEST_LEASE_WAIT: 45m
    steps:
      - run: npx brighttest --cross-check --host "$ROKU_HOST" --password "$ROKU_PASSWORD"
```

- `npx brighttest device status` lists device addresses from the lease directory, so keep it out of CI logs; run it
  from your own shell.
- For CI runs against each other, add `concurrency: { group: roku-device, cancel-in-progress: false }`.
- Leases across different OS users are not supported: run CI as the same OS user.
- A wait that times out exits **75**.

::: warning The lease page says otherwise
[Sharing a device](/guide/device-lease#ci-and-several-users) says to "add `npx brighttest device status` steps before
and after the device steps" in CI. Both statements are kept as written.
:::

## Recommended split

| Trigger | Lane | Why |
|---|---|---|
| Every push / PR | Headless `--coverage` | Fast, hardware-free gate; blocks broken logic at once and produces coverage |
| Nightly / pre-release | Device `--cross-check` | Needs hardware; confirms the fast lane is still a faithful proxy for real firmware |
| Manual / pre-release | [`e2e run`](/e2e/scaling) | UI journeys on a real device; self-hosted runner near a Roku, can't run on GitHub-hosted runners |

::: tip On-device E2E in CI
The e2e lane needs a real Roku on the runner's LAN, so it runs only on a **self-hosted** runner. The repo ships
`.github/workflows/e2e-device.yml`; see [E2E → Scaling & CI](/e2e/scaling).
:::

## Engine flavors in this repo's own CI

brighttest's repo tests several engines so pin or upstream changes surface early.

| Workflow | Legs | When |
|---|---|---|
| `engines-matrix` | `patched-pinned`, `stock-latest` | PRs touching `lib/`, `brs/` or `package.json`, and nightly |
| `engines-matrix` | `patched-candidate` | manual dispatch |
| `upstream-canary` | upstream `master`, built from a read-only clone, same suites | manual only |

Each leg runs `doctor --engines` (the capability probe; fails when it contradicts the engine's metadata), the unit and
integration suites, the example apps, and the RSG coverage probes against a committed baseline. When you bump the pin,
see [Refresh the probe baseline](full:/maintainers#refresh-probe-baseline).

## Debug builds (instrument)

`npx brighttest instrument build --strict` produces an instrumented debug package in CI.

| Exit | Meaning |
|---|---|
| **0** | package written |
| **1** | broken build (nothing written) |
| **4** | strict-mode failure (policy) |
| **3** | the release gate, `instrument verify` |

See [Instrumented builds](/guide/instrument).

## Coverage services

`coverage/lcov.info` is standard LCOV: it feeds Coveralls, Codecov or a local HTML report.

```bash
genhtml coverage/lcov.info --output-directory coverage/html
```

brighttest filters framework-internal records out of the LCOV automatically, so coverage reflects *your* code.

## Related

- [Device shelf](/guide/ci-device-shelf): a self-hosted runner with Rokus
- [Sharing a device](/guide/device-lease): the lease

**Full guide:** [CI integration](full:/guide/ci) — the original wording.
