# cycles fixture (feature graph)

Tiny, never run on a device or headless. Input for the graph builder's SCC, ambiguity and uncertainty tests.
Everything is invented. See `EXPECTED.json` for the intended findings (every case has an `at` or a file name).

- `CycleA` and `CycleB` components: A creates B (`createChild`) and B creates A back; each also calls the other with
  `callFunc` (a name-only edge, not an import). Component-level cycle `[comp:CycleA, comp:CycleB]`.
- `source/ping.brs`, `pong.brs`, `pang.brs`: a 3-file call cycle in the source scope.
- `Loop` component that extends itself: malformed `extends` loop.
- `Dup_name` is defined in `source/dup1.brs` and `source/dup2.brs`. The call in `source/main.brs:3` is ambiguous in the
  source scope (both files are in it). The calls in `CycleA` (sees dup1 only) and `CycleB` (dup2 only) are not.
- `Missing.brs` script uri that does not exist: `unresolved-script`.
- `source/imports.bs`: an `import` of a file that does not exist (`unresolved-import`), a call to an undefined
  function (`unresolved-call`), a `callFunc` with a variable name (`dynamic-callfunc`), a `callFunc` of a name no
  component declares (a `callfunc` edge with conf `unresolved`) and `m.global[key]` (`dynamic-global`).
- `components/diamond/`: `DiamondTop` has children `DiamondLeft` and `DiamondRight`, which both have child
  `DiamondBottom` (a diamond, no cycle). All four script `source/util.brs` and share `Diamond.brs`, which calls
  `Util_fmt`: one utility used by 4 components (shared-utility detection).
- `components/hostile/Fish&Chips.xml` and `.brs`: an ampersand in the component and file name, and quotes, angle
  brackets and a `</script>` in XML attribute values, an interface function name, a field id and a comment. For the
  report's escaping test. `"` and `<` are not allowed in file names on every OS, so they are only in attribute values.
- `source/broken.brs`: a parse error.
- `source/secret.key`: secret-named file that must never be opened. The symlink `source/link.brs` -> `secret.key` is
  not committed (git handling of symlinks differs by platform). `test/features-fixtures.test.js` creates it in a
  temp copy, and the graph builder's integration test (to be written with the builder) must create it the same way
  to check the `not-read` finding.

Not covered here: `truncated` (needs the file cap, left to the scale run) and `eval`.
