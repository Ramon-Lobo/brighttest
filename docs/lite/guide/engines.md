# Engines and patches

::: info At a glance
**What it is for:** knowing which simulator and test framework build runs your headless suites.

**You will:**
- check your engine build
- see what changes on stock engines

**First command:** `npx brighttest doctor --engines`
:::

## What brighttest depends on

Exact pins of `@ramonlobo/brs-node` (simulator) and `@ramonlobo/rooibos-roku` (framework): an upstream release plus ordered patches, versioned `<upstream-version>-bt.<N>`. Stock `brs-node` and `rooibos-roku` also work: a feature missing its patch is detected at startup and falls back or is skipped with a message.

## Which engine am I on?

```sh
brighttest doctor --engines          # patch table, flavor (patched/stock), probe
brighttest doctor --engines --json
```

Each headless run prints one `engine:` line. Choose with the `engines` config block or `BRIGHTTEST_ENGINES` (`auto`, `patched`, `stock` or a package name; the variable wins). See [CLI reference](/guide/cli-reference), [Troubleshooting](/guide/troubleshooting#brighttest-doctor-engines-what-can-the-headless-engine-do).

## Patches stock rooibos lacks

On stock rooibos the run goes on with one stderr warning.

| Patch | Feature | On stock |
|---|---|---|
| `ROO-04` | `globalFields` seeding before each `@SGNode` suite | Ignored; one `lacks ROO-04 globalFields seeding` line per run (all lanes, device too). Seeded widgets read `invalid`. |
| `ROO-05` | Bare `@deviceOnly` = `@tags("deviceOnly")` | Suite runs headless; one warning per `file:line`. Use `@tags("deviceOnly")`. |

You only see these after pinning stock; `auto` resolves the patched build. See [Global context](/writing-tests/global-context), [Headless vs device](/writing-tests/headless-vs-device#device-only-tests-deviceonly).

## Non-device behavior

::: warning `Label.forceUpperCase` (patch `BRS-02`) does not exist on a real Roku
A spec relying on it passes headless and does not match the device. Use uppercase strings or your own conversion; confirm with `--cross-check` or the device lane.
:::

- `doctor --engines` marks the row `NON-DEVICE`; on stock the probe reads absent.
- Patched runs print one stderr line per use, e.g. `nondevice-field: Label.forceUpperCase used in source/tests/Title.spec.bs:12 (non-device behavior: ...)`.
- Package metadata lists it under `nonDevice`; fork-local, not for upstream.

## Engine flags (`device-data`)

brighttest reads `package.json#brighttest.flags` instead of guessing from versions.

| Flag | Effect | Without it |
|---|---|---|
| `device-data` (`brs-node`) | Scene lanes (`@SGNode`, `--coverage`) pass `--device-data`, carrying config `deviceInfo` (model, resolution, locale...) into the simulator. | Stock or older than `2.7.1-bt.1`: one-time warning; engine keeps its own identity. |
| `coverage-dir` (`rooibos-roku`) | Device lane copies that dir's `lcov.info` to `--lcov`: `FN`/`FNDA`, `BRDA` and line records (framework records dropped). | Missing/empty file or rooibos below 5.17.0: console LCOV, lines only. |

## Changing engine behavior

It lives in the forks, not this repo: see [delivery model](full:/maintainers#delivery-model).

## Related

- [Headless vs device](/writing-tests/headless-vs-device): lane differences

**Full guide:** [Engines and patches](full:/guide/engines) — the original wording.
