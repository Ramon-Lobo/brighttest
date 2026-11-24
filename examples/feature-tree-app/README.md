# feature-tree-app

A small invented Roku app ("Feature Probe") used as ground truth for the brownfield feature tree
(`brighttest-feature-graph/v1`). It is generic fixture content, about 30 files. It runs headless with `npx brighttest`
(one pure suite, one `@SGNode` suite, 3 tests).

- `EXPECTED-GRAPH.json`: the graph the builder must find, written by hand (nodes, edges with `conf` and `at`, uncertainty,
  suggested structure). Built-in call sites and built-in field accesses are deliberately not listed as edges.
- `EXPECTED-FEATURES.json`: the intended grouping (`brighttest-feature-tree/v1`), with `coreFiles` per feature. Every file
  node is in exactly one feature.

## Edge kinds covered

`extends`, `script`, `import` (`source/lib/Greeting.bs`), `child`, `creates` (literal and dynamic), `runs-task`,
`entry`, `global-read`, `global-write`, `registry`, `calls`, `callfunc` (ambiguous), `observes` (name, builtin and
unresolved), `spec-covers`.

## Deliberately absent

- `vendor` nodes and `roku_modules/` (no ropm), and `eval`.
- `global-*` and `registry` with a dynamic key (`m.global[k]`, a variable section name).
- `unresolved` script, import or call, and `parse-error`: these live in `test/fixtures/feature-graph/cycles`.
- Component cycles: none here, `suggested.cycles` is empty. The cycles fixture has them.
- `callfunc` with a single (name) candidate.

## Deliberate blind spots and traps

- `MainScene.brs:20` creates a screen from a variable name (`dynamic-createobject`). `DetailsScreen`, `SettingsScreen`
  and `PlayerScreen` are therefore unreached from the entry.
- `DetailsScreen.brs:10` calls `callFunc("refresh")` on its player child. Two components declare `refresh`
  (`DetailsScreen`, `SettingsScreen`), so the name-only match is ambiguous, although the real receiver has none.
- `m.api.observeField` is on a node made by `CreateObject`, so the receiver is unresolved. `m.home` and `m.tick` come
  from `findNode` and resolve.
- `LibLoader.xml` has a `ComponentLibrary` (`component-library`). `InlineBanner.xml` has an inline CDATA script
  (`inline-cdata`): its functions are invisible to the parser. `Logger.brs` has an `#if DEBUG` block
  (`bs-const-branch`, analyzed with `bs_const=DEBUG=false`).
- The spec for `StringUtils` covers `Str_trim` and `Str_title` by called name; `Badge` is covered by `@SGNode("Badge")`.

The `ApiTask` task and the Timer are only declared and wired. The headless run never instantiates `MainScene`.
