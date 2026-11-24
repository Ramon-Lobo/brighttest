# cycles fixture (feature graph)

Tiny, never run on a device or headless. Input for the graph builder's SCC, ambiguity and uncertainty tests.
Everything is invented. See `EXPECTED.json` for the intended findings.

- `cycle-a` and `cycle-b` components: A creates B (`createChild`) and B imports back through `callFunc` on A.
  Component-level cycle `[comp:CycleA, comp:CycleB]`.
- `source/ping.brs`, `pong.brs`, `pang.brs`: a 3-file call cycle in the source scope.
- `Loop` component that extends itself: malformed `extends` loop.
- `Dup` functions: `Dup_name` is defined in `source/dup1.brs` and `source/dup2.brs` (ambiguous in the source scope)
  and in the `CycleB` scope only once (not ambiguous there).
- `Missing.brs` script uri that does not exist: `unresolved-script`.
- `source/broken.brs`: a parse error.
- `source/secret.key`: secret-named file that must never be opened. The symlink `source/link.brs` is created by the
  test, not committed (git handling of symlinks differs by platform).
