# Map the app

`brighttest features graph` reads a Roku project and writes a dependency graph of its files, components, calls, global
fields and registry sections. It is the first step of planning tests for an app you did not write. Like
[assess](/guide/assess), it is read-only and offline: no network, no device, no subprocess.

```bash
npx brighttest features graph            # current directory
npx brighttest features graph ./my-app --out ./out
npx brighttest features graph --json     # print the graph instead of the summary
```

## What it writes

| File | Content |
|---|---|
| `graph.json` | the `brighttest-feature-graph/v1` document: nodes, edges, resolution counts, uncertainty and blind spots |
| `.gitignore` | `*`, so generated files are not committed (see below) |

The graph is a pure function of the project tree: running it twice on the same tree gives the same bytes (apart from the
display-only `app` field). Edges carry a confidence (`exact`, `name`, `ambiguous`, `dynamic`, `unresolved`, `builtin`),
and everything the analysis cannot resolve is listed under `uncertainty` rather than guessed.

## Where files go

Without `--out`, output goes to `<stagingDir>/features/`, which is `.brighttest/features/` unless `brighttest.json`
sets `stagingDir`. The folder writes its own `.gitignore` containing `*`, unless the project's `.gitignore` already
ignores `.brighttest/` and the output is under it. The project's own `.gitignore` is never edited. An output folder
outside the project gets no `.gitignore`.

`--out` is refused (exit 2, nothing written) inside `source/` or `components/`, or when the path is an existing file.

## Check a feature tree

`brighttest features check [<tree.json>] [--graph <graph.json>] [--json] [--partial]` validates a
`brighttest-feature-tree/v1` document that groups the graph's files into named features. Errors (exit `3`) block
rendering: wrong shape or caps (V1), a graph the tree was not written for (V2), a file in no feature or in two (V3),
an unknown member or a component split from its XML file (V4), a bad or repeated feature id (V5), a testability
override without evidence (V6), an invalid proposed test (V7), unsafe text such as an absolute path, a URL with
credentials or a token-like string (V8), and a missing recommended path (V9). A proposed test on a node that no rule
classified is a warning. A proposed test whose target is not a file or component of the graph, or whose lane cannot
reach the node (for example `headless-unit` on a component with only inline CDATA script), is an error. Each finding
carries a JSON pointer, so it can be fixed and re-run. `--json` prints `schema`, `ok`, `errors`, `warnings`,
`findings` and `agentJudgement` (the nodes whose override had no rule class to undercut).

## Exit codes

`features graph`: `0` graph produced (findings never change it), `1` internal error, `2` usage error, missing
`<dir>`, bad config or refused `--out`.
`features check`: `0` valid, `1` internal error, `2` usage error or unreadable input, `3` tree invalid or stale.

## What the graph cannot see

Dynamic names (`CreateObject` with a variable, `callFunc` by a computed name), inline CDATA scripts, code behind
`bs_const` branches and anything outside `source/` and `components/` are reported as uncertainty, not resolved.
