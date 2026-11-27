# Map the app

::: info At a glance
**What it is for:** a dependency graph of an app you did not write, as the first step of planning its tests.

**You will:**
- write `graph.json` with `features graph`
- validate an agent-written `tree.json` with `features check`
- render one offline HTML report with `features render`, optionally with run evidence

**First command:** `npx brighttest features graph`
:::

The graph covers files, components, calls, global fields and registry sections. Like [assess](/guide/assess) it is
read-only and offline: no network, no device, no subprocess.

```bash
npx brighttest features graph            # current directory
npx brighttest features graph ./my-app --out ./out
npx brighttest features graph --json     # print the graph instead of the summary
```

Usage: `brighttest features graph [<dir>] [--out <dir>] [--json] [-c <config>]` (`-c` picks a config instead of
`<dir>/brighttest.json`). Rendered examples: [Mapping results](/guide/mapping-results).

## What it writes

| File | Content |
|---|---|
| `graph.json` | `brighttest-feature-graph/v1`: nodes, edges, resolution counts, uncertainty, blind spots |
| `.gitignore` | `*`, so generated files are not committed |

- **Deterministic:** the same tree gives the same bytes (except the display-only `app` field).
- **Edge confidence:** `exact`, `name`, `ambiguous`, `dynamic`, `unresolved`, `builtin`. Anything unresolved goes
  under `uncertainty`, never guessed.
- **`resolution.sites`:** per kind (`calls`, `callfunc`, `observes`), sites seen, resolved and unresolved. Resolved
  means every outcome is `exact`, `name` or `builtin`. Derived from edges, so not part of the graph hash. Shown as
  an `unresolved:` line (callFunc and observeField) and the report's "Unresolved sites" row.

::: details Counting sites on one line
Several callFunc or observeField sites on one line count separately (each edge carries a `col`). Plain `calls`
sites on one line are counted once per line in `resolution.sites.calls`.
:::

## Mapping with an agent

The commands need no agent. To get named features, run `npx brighttest skills install` and ask the agent to map
the app. The `mapping-a-roku-app` skill:

1. runs `features graph` and reads the graph in slices;
2. writes `tree.json` next to `graph.json`;
3. runs `features check` (at most three fix rounds), then `features render`;
4. shows both test paths and asks which to take before any spec is written.

The `adoption-assessor` agent may write only `graph.json`, `tree.json`, `report.html` and that folder's
`.gitignore` in the features folder. `test-author` takes its next target from your chosen path.

::: warning
The agent never edits the app or uses a device. Every class in the report is a prediction until a run proves it.
:::

## Where specs are found

Specs in `source/` and `components/` are found as before. Specs elsewhere (giving `spec-covers` edges) come from
top-level folders, matched ignoring case, keeping the real name in node ids:

- `test`, `tests`, `spec`, `specs`;
- the static leading folders of `testsFilePattern` (e.g. `qa/unit` for `qa/unit/**/*.spec.bs`).

Every `.brs`/`.bs` file there is a spec. At most 5000 `.brs`/`.bs` files are read (data files do not count);
beyond that the graph reports `truncated`.

::: details Skipped folders and limits
- Skipped: `node_modules`, `roku_modules`, vendor and `instrument.exclude` paths. A folder named after rooibos is
  skipped; a spec file named after rooibos is kept.
- Symlinks are never followed. A folder symlinked to the root, `source/`, `components/`, outside the project,
  `node_modules` or an excluded folder is ignored.
- A pattern starting with a wildcard, brace, `..` or absolute path (e.g. `**/qa/*.bs`) names no folder; its specs
  are found only in the four conventional folders.
- Folders `sourceGlobs` maps in from elsewhere (`src`/`dest` form) are not read.
:::

## Where files go

Default output: `<stagingDir>/features/`, i.e. `.brighttest/features/` unless `brighttest.json` sets `stagingDir`.

- The folder gets a `.gitignore` of `*`, unless the project's `.gitignore` already ignores `.brighttest/` and the
  output is under it. An output folder outside the project gets none.
- The project's own `.gitignore` is never edited.
- `--out` is refused (exit 2, nothing written) inside `source/` or `components/`, or if the path is an existing file.

## Check a feature tree

`brighttest features check [<tree.json>] [--graph <graph.json>] [--json] [--partial]` validates a
`brighttest-feature-tree/v1` document grouping the graph's files into named features.

| Option | Meaning |
|---|---|
| `<tree.json>` | default `<stagingDir>/features/tree.json` |
| `--graph` | the graph it was written for (default: `graph.json` beside the tree) |
| `--json` | print `schema`, `ok`, `errors`, `warnings`, `findings`, `agentJudgement` (nodes whose override had no rule class to undercut) |
| `--partial` | allow files in no feature yet (incremental mapping) |

Errors (exit `3`) block rendering. Each finding has a JSON pointer, so you can fix and re-run.

| Rule | Error |
|---|---|
| V1 | wrong shape or caps |
| V2 | graph the tree was not written for |
| V3 | file in no feature, or in two |
| V4 | unknown member, or component split from its XML |
| V5 | bad or repeated feature id |
| V6 | testability override without evidence |
| V7 | invalid proposed test |
| V8 | unsafe text: absolute path, URL with credentials, token-like string |
| V9 | missing recommended path |

A proposed test on a node no rule classified is a warning. A target that is not a graph file or component, or a lane
that cannot reach the node (e.g. `headless-unit` on a component with only inline CDATA script), is an error.

## Render the report

```bash
npx brighttest features render                 # <stagingDir>/features/tree.json -> report.html beside it
npx brighttest features render --auto          # no agent: render the generated skeleton tree
npx brighttest features render tree.json --graph graph.json --out reports/features.html
```

`render` runs the `check` rules and refuses an invalid or stale tree (exit `3`, nothing written, old report kept).
Run it from the project root: the CI checklist reads the CI files, and a banner says when code changed since the
graph. From a non-Roku folder those two are skipped; the rest is unchanged.

- **`--auto`:** builds the skeleton tree from `graph.json` in memory, no agent needed. `features graph` does not
  write a `tree.skeleton.json` yet, and `--auto` does not read one.
- **Default output:** beside the tree. A tree at an app root with no `--out` is refused (that folder holds
  `source/`). Only the staging folder (`.brighttest/features/`) gets a self-ignoring `.gitignore`.
- **`--out` refused:** inside `source/` or `components/` (of the current project, or of the project holding the tree
  or graph), or when it would overwrite an input, a symbolic link, or a non-HTML-report file. Writes are atomic.

### What the report contains

One HTML file to open offline or attach to a ticket.

| Property | Detail |
|---|---|
| Locked down | inline CSS and one inline script, CSP with their hashes (`default-src 'none'`); nothing fetched; all strings escaped; same inputs give same bytes |
| No JavaScript needed | script only adds filter, expand/collapse all, path tabs, theme toggle; without it both paths show in sequence |
| Accessible | landmarks, skip link, ordered headings, labelled tables, native `details`, text badges (never colour alone), reduced-motion and print styles; WCAG AA in light and dark; `report.html#theme=dark` or `#theme=light` forces a theme |
| Size | member and dependency tables stop at 500 rows ("N more in graph.json"); warns over 8 MB but still writes |

Sections: header (versions, hashes, warnings), summary, feature tree, a panel per feature (members with rule and
evidence; dependencies with edge kind, confidence, `file:line`; specs; proposed tests; CI jobs), leaf-first and
base-first test paths, headless versus device matrix, numbered CI checklist, uncertainty (what only a device can
confirm), method and provenance.

- Unclassified nodes get a "not classified" badge in their last column, never count as headless or device, get no CI
  job ("classify first"), and are summarised as "N nodes not classified".
- The checklist cites `docs/guide/ci.md` by path and section; it does not generate workflow files.

### Run evidence from JUnit and LCOV

`--junit <file>` and `--lcov <file>` (both repeatable) overlay what actually ran.

```bash
npx brighttest --coverage --lcov coverage/lcov.info --junit reports/junit.xml
npx brighttest features render --auto --junit reports/junit.xml --lcov coverage/lcov.info
```

| Evidence | Rule |
|---|---|
| JUnit source | must come from brighttest or carry `file` attributes |
| Case mapping | headless JUnit names cases by Rooibos `@suite("...")` title, no file attribute; a case maps to the one spec with that title. A title in several specs is not mapped (warning with count). A `file` attribute or spec-path classname matches by trailing path segments; a bare name only if unique |
| `ran-headless` | a spec whose mapped cases all pass marks itself and its covered nodes; failing or skipped-only marks nothing |
| `ran-device` | only from JUnit marked `brighttest.lane=device` (a `<property>` in the `<testsuite>` or file level) or the e2e suite name. `--device --junit` writes the marker; e2e flows are not graph spec nodes. Marker applies per suite, so one merged file can hold both lanes |
| LCOV | no lane, never adds a level; shows `executed (lcov N% of M lines)`; device and headless LCOV look alike. Paths matched after removing `pkg:/` and the root; ambiguous bare names and paths climbing out of the project are ignored |

## Exit codes

| Code | `features graph` | `features check` | `features render` |
|---|---|---|---|
| `0` | graph produced (findings never change it) | valid (warnings allowed) | report written |
| `1` | internal error | internal error | internal error |
| `2` | usage error, missing `<dir>`, bad config, refused `--out` | usage error, unreadable input | usage error, unreadable input, refused `--out` |
| `3` | — | tree invalid or stale | tree invalid or stale (nothing written) |

## What the graph cannot see

These are reported as uncertainty, not resolved:

- dynamic names (`CreateObject` with a variable, `callFunc` by computed name), inline CDATA scripts, code behind
  `bs_const` branches, anything outside `source/` and `components/`;
- bsconfig plugins (`bsconfig-plugins`) and a custom `files` list (`bsconfig-files`); `extends` is followed for both
  (json in the root, no symlinks, five levels);
- an unreadable `bsconfig.json` or unfollowable `extends`: `bsconfig-not-read`.

::: warning Known limitation
A `files` list that is only a subset of the defaults is not flagged, since it matches the walked layout for the
entries it keeps.
:::

## Related

- [Agent skills](/guide/agent-skills): the `mapping-a-roku-app` skill
- [CI](/guide/ci): what the checklist cites

**Full guide:** [Map the app](full:/guide/feature-tree) — the original wording.
