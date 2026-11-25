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

`resolution.sites` counts, per kind (`calls`, `callfunc`, `observes`), how many call sites the graph saw and how many
it resolved or left unresolved. A site is resolved when every outcome at it is `exact`, `name` or `builtin`. The tally is
derived from the edges, so it is not part of the graph hash. `features graph` prints it as an `unresolved:` line (callFunc
and observeField sites), and the HTML report shows it as the "Unresolved sites" row. Several callFunc or observeField
sites on one line are counted separately (each edge then carries a `col`). Plain `calls` sites on one line are not told
apart: they are counted once per line in `resolution.sites.calls`.

## Mapping with an agent

The deterministic commands need no agent. To have an agent group the graph into named features, install the skills
(`npx brighttest skills install`) and ask it to map the app: the `mapping-a-roku-app` skill runs `features graph`,
reads the graph in slices, writes `tree.json` next to `graph.json`, runs `features check` (at most three fix rounds),
runs `features render`, then presents both test paths and asks which to take before any spec is written. The
`adoption-assessor` agent may write `tree.json` and the report in the features folder and nothing else in the
project; `test-author` takes its next target from the path you chose. The agent never edits the app and never uses a
device; every class in the report is a prediction until a run proves it.

## Where specs are found

Specs inside `source/` and `components/` are found as before. Specs outside them (so `spec-covers` edges exist) are
read from these top-level folders, matched ignoring case, with the folder's real name in the node ids:

- `test`, `tests`, `spec` and `specs`;
- the static leading folders of `testsFilePattern`, for example `qa/unit` for `qa/unit/**/*.spec.bs`.

Every `.brs` and `.bs` file under such a folder counts as a spec. `node_modules`, `roku_modules`, vendor and
`instrument.exclude` paths are skipped (a folder named after rooibos is skipped, but a spec file named after rooibos is
kept), symlinks are never followed, and a folder that is a symlink to the project root, to `source/` or `components/`,
to somewhere outside the project, or into `node_modules` or an excluded folder is ignored. At most 5000 `.brs`/`.bs`
files are read (data files do not count); beyond that the graph reports a `truncated` item.

Limits: a pattern that starts with a wildcard, brace, `..` or an absolute path (for example `**/qa/*.bs`) names no
folder, so such specs are only found under the four conventional folders. Folders that `sourceGlobs` maps from
elsewhere into the package (its `src`/`dest` form) are not read.

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

## Render the report

```bash
npx brighttest features render                 # <stagingDir>/features/tree.json -> report.html beside it
npx brighttest features render --auto          # no agent: render the generated skeleton tree
npx brighttest features render tree.json --graph graph.json --out reports/features.html
```

`render` runs the same checks as `check` and refuses an invalid or stale tree (exit `3`, nothing written, an existing
report is left as it was). Run it from the project root: the CI checklist reads the project's CI files, and a banner
in the header says when the code changed since the graph was written. `--out` is refused inside `source/` or
`components/` (of the current project, and of the project that holds the tree or graph), when it would overwrite an
input file, a symbolic link, or a file that is not an HTML report. The file is written atomically. With `--auto` the
report is built from the graph alone, so it works with no agent at all. The skeleton tree is generated in memory from
`graph.json`; `features graph` does not write a `tree.skeleton.json` file yet, and `--auto` does not read one.
From a folder that is not a Roku project the CI checklist and the staleness banner are skipped (the rest of the
report is unchanged). A tree at an app root with no `--out` is refused, because the default output folder (beside the tree) holds `source/`. Without `--out`, the report goes beside the tree; only the staging folder
(`.brighttest/features/`) gets a self-ignoring `.gitignore`, a tree's own folder is never touched.

The output is one HTML file you can open offline or attach to a ticket:

- **Self-contained and locked down.** Inline CSS and one inline script, with a Content-Security-Policy that carries
  their hashes (`default-src 'none'`), so nothing is fetched. Every string from the project or the tree is escaped.
  The same graph and tree always give the same bytes.
- **Complete without JavaScript.** The script only adds a filter box, expand and collapse all, path tabs and a theme
  toggle. Both test paths are shown in sequence when it is off.
- **Accessible.** Landmarks, a skip link, ordered headings, labelled tables, native `details` for the tree, badges
  with text (never colour alone), reduced-motion and print styles. Light and dark themes follow the system setting;
  `report.html#theme=dark` or `#theme=light` forces one. Both meet WCAG AA contrast.
- **Sections.** Header (versions, hashes, warnings), summary, feature tree, a panel per feature (members with rule
  and evidence, dependencies with edge kind, confidence and `file:line`, specs, proposed tests, CI jobs), the
  leaf-first and base-first test paths, a headless versus device matrix, a numbered CI checklist, uncertainty with
  what only a device can confirm, and method and provenance.
- **Nodes that no rule classified** show a "not classified" badge in their own last column, are never counted as
  headless or device, get no CI job ("classify first") and are summarised as "N nodes not classified".
- **Size.** Member and dependency tables stop at 500 rows with "N more in graph.json". `render` warns when the file is
  over 8 MB and still writes it.

The checklist cites `docs/guide/ci.md` by path and section and does not generate workflow files.

### Run evidence from JUnit and LCOV

```bash
npx brighttest --coverage --lcov coverage/lcov.info --junit reports/junit.xml
npx brighttest features render --auto --junit reports/junit.xml --lcov coverage/lcov.info
```

`--junit <file>` and `--lcov <file>` (both repeatable) overlay what actually ran onto the report.

- The JUnit file has to come from brighttest, or carry `file` attributes. brighttest's headless JUnit names each case by
  its Rooibos `@suite("...")` title and has no file attribute, so the graph records each spec file's suite titles and a
  case maps to the one spec that has that title. A title used by more than one spec is reported as not mapped (the
  warning gives a count). A `file` attribute, or a classname that is a spec path, is matched by whole trailing path
  segments; a bare name maps only when exactly one spec has it.
- A spec whose mapped cases all pass marks itself and the nodes it covers `ran-headless`. A failing or skipped-only spec
  marks nothing.
- `ran-device` comes only from a JUnit marked `brighttest.lane=device` (a `<property>` inside the `<testsuite>`, or at
  the file level) or from the e2e suite name. The device Rooibos lane (`--device --junit`) writes that marker, and e2e flows are not graph
  spec nodes. The marker applies to its own suite, so a
  merged file can hold a headless and a device suite.
- LCOV carries no lane, so it never adds a level. A node whose lines executed shows `executed (lcov N% of M lines)`;
  `--lcov` output from a device run is not told apart from a headless one. Paths are matched after removing `pkg:/` and
  the project root; a bare file name with more than one match, and paths that climb out of the project, are ignored.


## Exit codes

`features graph`: `0` graph produced (findings never change it), `1` internal error, `2` usage error, missing
`<dir>`, bad config or refused `--out`.
`features check`: `0` valid, `1` internal error, `2` usage error or unreadable input, `3` tree invalid or stale.
`features render`: `0` report written, `1` internal error, `2` usage error, unreadable input or refused `--out`, `3` tree invalid or stale (nothing written).

## What the graph cannot see

Dynamic names (`CreateObject` with a variable, `callFunc` by a computed name), inline CDATA scripts, code behind
`bs_const` branches and anything outside `source/` and `components/` are reported as uncertainty, not resolved.

`bsconfig.json` plugins and a custom `files` list are reported as uncertainty (`bsconfig-plugins`, `bsconfig-files`);
`extends` is followed for both (json files inside the project root, no symlinks, five levels). A `bsconfig.json` that
cannot be read or parsed, or an `extends` target that cannot be followed, is reported as `bsconfig-not-read`. Known
limitation: a `files` list that is only a subset of the default entries is not flagged, since it matches the walked layout
for the entries it keeps.
