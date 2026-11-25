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

## Exit codes

`0` graph produced (findings never change it), `1` internal error, `2` usage error, missing `<dir>`, bad config or
refused `--out`.

## What the graph cannot see

Dynamic names (`CreateObject` with a variable, `callFunc` by a computed name), inline CDATA scripts, code behind
`bs_const` branches and anything outside `source/` and `components/` are reported as uncertainty, not resolved.
