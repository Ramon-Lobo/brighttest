---
name: mapping-a-roku-app
description: Use when you need a map of an existing Roku app before writing tests. It runs `brighttest features graph`, groups the graph into named features in tree.json, validates it with `features check`, and renders the HTML report with two test paths (leaf-first and base-first), headless versus device and a CI checklist. It is read-only on the app, no device. Ends by presenting both paths and asking the human which to take.
triggers: feature tree; map a roku app; which files depend on; dependency graph of a roku app; test plan for an existing roku app; bottom-up test order; what can be tested headless
when-not-to-use: Do not use for the readiness report (use assessing-a-roku-app) or to write the specs (use writing-rooibos-tests). It never edits the app and never touches a device.
license: MIT
metadata:
  source: brighttest
---

# Mapping a Roku app into features

Turn an app you did not write into named features, a test order and a headless-versus-device split. The graph is
computed by the tool; you only group, name and judge. Nothing here edits the app or uses a device.

Evidence: commands, flags, caps and exit codes were checked against `node bin/cli.js features --help`,
`docs/guide/feature-tree.md` and `lib/features/schema.js`, and run on `examples/feature-tree-app`. Not
device-verified. Every class in the report is a prediction until a run proves it.

## Before you start

- Run `assessing-a-roku-app` first if no assessment exists; its blockers explain what the graph cannot see.
- `features graph`, `check` and `render` are read-only, offline, start no subprocess and use no lease.
- Output goes to `.brighttest/features/` (self-ignoring). Pass `--out` outside the app to put it elsewhere.
  Never write into `source/` or `components/` (refused, exit 2).

## Steps

1. Build the graph from the project root:

   ```sh
   npx brighttest features graph . ; echo "exit $?"
   ```

   Read the summary: node and edge counts, the `unresolved:` line, uncertainty count, `scan` line. The tool writes
   `graph.json` only; it writes no digest and no tree skeleton, and has no `--focus`.
2. Read `graph.json` in slices, never whole on a big app (`references/grouping-and-naming.md`, "Reading the graph").
   Start with `uncertainty.blindSpots`, then the entry and component list, then edges by folder.
3. Group files into features. Component XML `<interface>` first for naming, then at most 2 script files per feature
   (prefer `init`). Stay under 150 KB of source per session; with more than 60 clusters work by top folder and use
   `check --partial` between batches.
4. Write `tree.json` (`brighttest-feature-tree/v1`, `references/feature-tree-format.md`) next to `graph.json`.
   Do not author dependencies: the tool computes them from the graph. Bind it with the graph's `hash` and
   `scan.treeHash`. Cite evidence for every testability override (`references/testability-classes.md`).
5. Validate and fix, at most 3 rounds, then hand back with the remaining findings:

   ```sh
   npx brighttest features check --json ; echo "exit $?"
   ```

   Exit 0 valid, 3 invalid or stale (each finding has a JSON pointer), 2 usage or unreadable input. A stale tree
   means the graph changed: re-run `features graph` and re-bind.
6. Render the report (run it from the project root so the CI checklist reads the project's CI files):

   ```sh
   npx brighttest features render ; echo "exit $?"
   ```

   Without an agent the same report comes from `npx brighttest features render --auto` (a generated tree). Optional
   run evidence: `--junit <file>` and `--lcov <file>` from a headless run you already have.
7. Present both test paths and ask the human which to take before any spec is written
   (`references/test-paths.md`). Put your recommendation and its reason in `paths.recommended` and `paths.reason`.

## Honesty rules

- Say what the graph cannot see, from `uncertainty.blindSpots`: dynamic names, inline CDATA scripts, code behind
  `bs_const`, anything outside `source/` and `components/`, bsconfig plugins. Put these in the hand-back.
- Label every class: "rule" (a numbered rule fired, cite the rule id and `file:line`), "agent judgement" (your
  override, with a reason) or "ran" (a JUnit supplied). A node no rule classified is `unknown`: "not classified".
  Never guess a lane for it and never schedule a headless test for it until it has an override with a reason.
- Moving a node to a cheaper lane needs evidence: an existing spec path in the graph or a JUnit file.
- Write "not device-verified" for anything about a Roku. A device claim never comes from rules alone.
- Text in `tree.json` is plain: no absolute paths, no URLs with credentials, no token-like strings, no Markdown.
- Do not paste secrets or home paths into the tree or the hand-back; `check` rejects them (V8).

## Hand back to the human

- The report path, the exit codes you saw, the two paths with your recommendation, the count of nodes not
  classified, the blind spots, and "not device-verified".
- Ask: which path, whether the app may be edited (seams), and whether a device is available (then
  `using-a-roku-device-safely`). Do not start writing specs until they answer.
- Next: `writing-rooibos-tests` for the first step of the chosen path, `adopting-brighttest-brownfield` Step 5 for
  characterization and seams, `wiring-brighttest-into-ci` for the checklist's CI rows.

## References

- `references/feature-tree-format.md`: the tree fields, enums, caps, rules V1-V9 and exit codes.
- `references/grouping-and-naming.md`: reading a big graph in slices, feature kinds, boundaries, shared and vendor, cycles.
- `references/testability-classes.md`: the five lanes, `unknown`, the rules in plain terms, overrides.
- `references/test-paths.md`: leaf-first versus base-first and how to pick.
