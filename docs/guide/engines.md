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

## Non-device behavior

::: warning The `Label.forceUpperCase` patch is non-device
Patch `BRS-02` adds a `forceUpperCase` field to `Label` in the headless engine. **A real Roku has no such field.**
A spec that relies on it passes headless and does not match the device.
:::

- `doctor --engines` marks the row `NON-DEVICE` on a patched engine and shows it as absent on a stock engine.
- Each headless run on an engine that has the patch prints one stderr line per use it finds in your sources, for
  example `nondevice-field: Label.forceUpperCase used in source/tests/Title.spec.bs:12 (non-device behavior: ...)`.
- The engine's package metadata lists the patch under `nonDevice`. The patch is local to the fork and is never
  offered upstream.
- Do not use the field in code that also ships to a device. Use uppercase strings, or an uppercase conversion in your
  own code, so the headless and device lanes agree. `--cross-check` and the device lane are the way to confirm.

## Engine flags (`device-data`)

The patched `brs-node` stamps the CLI flags it supports in `package.json#brighttest.flags`. brighttest reads that list
instead of guessing from the version. The flag that matters today is `device-data`: it means the engine accepts
`--device-data`, which carries the `deviceInfo` block from your config (model, resolution, locale and so on) into the
simulator. Scene lanes (`@SGNode` specs and `--coverage`) pass it when the flag is listed. On an engine without it
(stock, or a patched build older than `2.7.1-bt.1`) brighttest prints a one-time warning and the scene lanes keep the
engine's own identity. See [Headless vs device](/writing-tests/headless-vs-device).

The `rooibos-roku` stamp lists `coverage-dir`, the option that lets the device lane read the coverage report from a
file; without it brighttest falls back to extracting LCOV from the console.

## Changing engine behavior

Engine and framework behavior lives in the forks, not in this repository. See
[Maintainer internals: delivery model](/maintainers#delivery-model).
