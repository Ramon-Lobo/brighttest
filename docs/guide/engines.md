# Engines and patches

brighttest runs headless suites on a simulator (`brs-node`) and a test framework (`rooibos-roku`). It depends on two
published, scoped builds of them: `@ramonlobo/brs-node` and `@ramonlobo/rooibos-roku`. Each is an exact upstream
release plus a short, ordered list of patches, published as `<upstream-version>-bt.<N>` and pinned to an exact version
in brighttest's `package.json`. brighttest also runs on the stock `brs-node` and `rooibos-roku`; a feature that needs a
missing patch is detected at startup and falls back or is skipped with a message.

## Which engine am I on?

```sh
brighttest doctor --engines          # patch table, engine flavor (patched or stock), probe result
brighttest doctor --engines --json   # the same as JSON
```

Every headless run also prints one `engine:` line with the package, version and flavor. Choose the build with the
`engines` config block or `BRIGHTTEST_ENGINES` (`auto`, `patched`, `stock` or a package name; the variable wins). See
the [CLI reference](/guide/cli-reference) and [Troubleshooting](/guide/troubleshooting#brighttest-doctor-engines-what-can-the-headless-engine-do).

## Patches stock rooibos lacks

Two features of the patched `rooibos-roku` have no stock equivalent. On a stock `rooibos-roku` brighttest does not
block the run; it warns once on stderr and carries on.

| Patch | Feature | On stock rooibos |
|---|---|---|
| `ROO-04` | `globalFields` seeding of the test scene before each `@SGNode` suite | Ignored. brighttest prints one `lacks ROO-04 globalFields seeding` line per run (all lanes, device included). A seeded widget reads `invalid`. |
| `ROO-05` | Bare `@deviceOnly` as sugar for `@tags("deviceOnly")` | Not an annotation, so the suite runs headless. On headless lanes brighttest prints one warning per `file:line`. Use `@tags("deviceOnly")` instead. |

The default install and `auto` mode resolve the patched build, so neither warning appears unless you pin stock with
`engines` or `BRIGHTTEST_ENGINES=stock`. See [Global context](/writing-tests/global-context) and
[Headless vs device](/writing-tests/headless-vs-device#device-only-tests-deviceonly).

## Non-device behavior

::: warning The `Label.forceUpperCase` patch is non-device
Patch `BRS-02` adds a `forceUpperCase` field to `Label` in the headless engine. **A real Roku has no such field.**
A spec that relies on it passes headless and does not match the device.
:::

- `doctor --engines` always marks the row `NON-DEVICE`; on a stock engine the probe column reads absent.
- Each headless run on an engine that has the patch prints one stderr line per use it finds in your sources, for
  example `nondevice-field: Label.forceUpperCase used in source/tests/Title.spec.bs:12 (non-device behavior: ...)`.
- The engine's package metadata lists the patch under `nonDevice`. The patch is local to the fork and is not meant
  for upstream.
- Do not use the field in code that also ships to a device. Use uppercase strings, or an uppercase conversion in your
  own code, so the headless and device lanes agree. `--cross-check` and the device lane are the way to confirm.

## Engine flags (`device-data`)

The patched `brs-node` stamps the CLI flags it supports in `package.json#brighttest.flags`. brighttest reads that list
instead of guessing from the version. The flag that matters today is `device-data`: it means the engine accepts
`--device-data`, which carries the `deviceInfo` block from your config (model, resolution, locale and so on) into the
simulator. Scene lanes (`@SGNode` specs and `--coverage`) pass it when the flag is listed. On an engine without it
(stock, or a patched build older than `2.7.1-bt.1`) brighttest prints a one-time warning and the scene lanes keep the
engine's own identity. See [Headless vs device](/writing-tests/headless-vs-device).

The `rooibos-roku` stamp lists `coverage-dir`. On the device lane, when the engine supports `coverage-dir`,
brighttest writes that directory's `lcov.info` to the `--lcov` path, so it carries function (`FN`/`FNDA`) and branch
(`BRDA`) records as well as lines (framework records are dropped). When the file is missing or empty, or the engine
has no `coverage-dir` (rooibos below 5.17.0), it falls back to the console LCOV, which has line records only.

## Changing engine behavior

Engine and framework behavior lives in the forks, not in this repository. See
[Maintainer internals: delivery model](/maintainers#delivery-model).
