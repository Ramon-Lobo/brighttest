# feature-tree-app

A small invented Roku app ("Feature Probe") used as ground truth for the brownfield feature tree
(`brighttest-feature-graph/v1`). It is generic fixture content, about 35 files. It runs headless with `npx brighttest`
(one pure suite, one `@SGNode` suite, 3 tests).

- `EXPECTED-GRAPH.json`: the graph the builder must find, written by hand (nodes, edges with `conf` and `at`, uncertainty,
  suggested structure). Built-in call sites and built-in field accesses are deliberately not listed as edges.
- `EXPECTED-FEATURES.json`: the intended grouping (`brighttest-feature-tree/v1`), with `coreFiles` per feature. Every file
  node is in exactly one feature.

## Edge kinds covered

`extends`, `script`, `import` (`source/lib/Greeting.bs`), `child`, `creates` (literal and dynamic), `runs-task`,
`entry`, `global-read`, `global-write`, `registry`, `calls`, `callfunc` (ambiguous), `observes` (name, builtin and
unresolved), `spec-covers`.

## Conventions in `EXPECTED-GRAPH.json`

- `conf: builtin` is used for edges whose target is a built-in node (`extends Group`, a `Label` child) and for an
  `observes` whose receiver is a built-in node (the `Timer` in `MainScene.brs:9`).
- `runs-task` has its own edge. Its `at` is the line of `control = "RUN"` (`MainScene.brs:5`); the `creates` edge for the
  same task is at the `CreateObject` line (`:3`).
- `facts.platformObjects` lists the platform objects and nodes a file uses that cannot be exercised without a device or
  a fixture (`Video`, `roUrlTransfer`, `roChannelStore`). Other built-in calls are not listed.
- The specs under `source/tests` produce `spec-covers` edges only. They do call `Str_trim` and `Str_title`, but the builder
  must not emit `calls` edges from spec files (they would make the helpers look used by test code).

## Deliberately absent

- `vendor` nodes and `roku_modules/` (no ropm), and `eval`.
- `global-*` and `registry` with a dynamic key (`m.global[k]`, a variable section name): `dynamic-global` is in
  `test/fixtures/feature-graph/cycles`.
- `unresolved` script, import and call, `dynamic-callfunc`, an `unresolved` callfunc, `truncated` and `parse-error`:
  all in `test/fixtures/feature-graph/cycles` (`truncated` is left to the scale run).
- Component cycles: none here, `suggested.cycles` is empty. The cycles fixture has them, with the diamond and the
  shared-utility case.
- `callfunc` with a single (name) candidate.
- Search (keyboard and results), a RowList grid and a nav controller: the other screens already cover screens, focus and
  `onKeyEvent` (Home, Player), and these would only add files. The keyboard and the grid are runtime-only behavior that
  the static graph cannot tell apart from a plain `Group`.

Added to cover the design's inventory: `EntitlementGate` (`roChannelStore`, testability rule F4) and the pure
`ContentParser` used by `ApiTask`.

## Deliberate blind spots and traps

- `MainScene.brs:20` creates a screen from a variable name (`dynamic-createobject`). `DetailsScreen`, `SettingsScreen`,
  `PlayerScreen` and `EntitlementGate` are therefore unreached from the entry.
- `DetailsScreen.brs:10` calls `callFunc("refresh")` on its player child. Two components declare `refresh`
  (`DetailsScreen`, `SettingsScreen`), so the name-only match is ambiguous, although the real receiver has none.
- `m.api.observeField` is on a node made by `CreateObject`, so the receiver is unresolved. `m.home` and `m.tick` come
  from `findNode` and resolve.
- `LibLoader.xml` has a `ComponentLibrary` (`component-library`). `InlineBanner.xml` has an inline CDATA script
  (`inline-cdata`): its functions are invisible to the parser. `Logger.brs` has an `#if DEBUG` block
  (`bs-const-branch`, analyzed with `bs_const=DEBUG=false`).
- The spec for `StringUtils` covers `Str_trim` and `Str_title` by called name; `Badge` is covered by `@SGNode("Badge")`.

The `ApiTask` task and the Timer are only declared and wired. The headless run never instantiates `MainScene`.
