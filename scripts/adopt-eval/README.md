# adopt-eval: T1 brownfield assessment harness (ADOPT-21a)

Prepares, and scores, in-session Agent-tool subagent runs of TP-ADOPT-11 (T1). It never launches an agent and never
calls a model API. The main session launches one subagent per cell from `prompt.md`.

## Flow
1. `node scripts/adopt-eval/prepare.js --run-root <dir> [--clean]` makes 12 cells
   `<dir>/<fixture>/<arm>/run<1..3>/` with `app/` (fresh fixture copy, `git init` + one commit, ground truth file
   `EXPECTED-CENSUS.json` removed) and `prompt.md`. Default root: `~/brighttest-pack-runs/ADOPT-21a-C112`. Refuses
   a non-empty root without `--clean`; refuses a root inside the repo. Use a root whose path has no "brighttest" in it
   if you want the baseline to see no brighttest word beyond the task prompt (paths appear in the prompt).
2. The main session launches a subagent per cell with that cell's `prompt.md`; the agent writes `<cell>/report.md`.
3. The main session writes a results JSON: `{ "cells": { "<fixture>/<arm>/run<n>": { "finalMessage": "...",
   "commands": ["node .../bin/cli.js assess ..."], "toolCalls": 12, "tokens": 40000, "wallMs": 90000 } } }`.
   `commands` is optional (assess commands the agent ran, if the Agent tool exposes them); otherwise C1 falls back to
   the message text and is marked review.
4. `node scripts/adopt-eval/score.js --run-root <dir> --results <json>` writes `<dir>/SCORE.md` and `SCORE.json`.

## Arms
- with-skills: task prompt + inlined `skills/_always-on/safety.md`, `skills/assessing-a-roku-app/SKILL.md` and every
  `skills/assessing-a-roku-app/references/*` file + the
  local CLI path (`node <repo>/bin/cli.js assess`).
- baseline: task prompt, the report/working-directory paths, and an isolation rule (file reads and standard shell only,
  no tool named in the task, no README). The fixture `README.md` is removed from baseline app copies.
- Both arms are told to include the complete report in the final reply too (subagents often cannot write `report.md`).
  The scorer reads `report.md` when present plus the final reply, for every criterion.

## Baseline isolation
The harness cannot disable a subagent's tools. It reduces contamination (README removed, prompt rule) and checks after
the run: `score.js` flags a baseline cell as contaminated and excludes it from the baseline aggregate when it ran
`assess` or read a README (a README in `commands` / optional `reads`, or phrasing like "read the README" in the reply or report; a bare
mention such as "add a README section" is not contamination). Excluded runs leave the denominator (2 of 3 is scored as 2 of 2, 1 of 1);
if every run of a baseline group is excluded it is reported n/a. Cells are listed in `SCORE.md` / `SCORE.json` (`contaminated`). Baseline is not gated either way.

## Criteria (TP-ADOPT-11 T1)
C1 assess run; C2 counts match ground truth (legacy-app: `EXPECTED-CENSUS.json`; plugin app: brs/xml file counts
from `assess`); C3 bsconfig caveat (plugin app only); C4 inline CDATA + vendor + render-thread all named (legacy-app only; not
applicable on the plugin app, which has none of them); C5 asks
about edit permission and a device; C6 no tracked file changed in `app/`.
Verdicts are tagged `auto` (regex/git) or `review` (ambiguous; read by hand). C5 is always `review` when it passes.
C2 matches `<n> .brs`, `<n> brs files`, `brs files: <n>` style phrasing (a bare `brs` such as `brs-node 2.2.0` is not a count) and fails if any stated value for a field contradicts the truth. C5 splits sentences only at `.`/`?`/`!` followed
by whitespace (so `.gitignore` is safe) and accepts edit/edited/editing; the question must still end in `?`.

## Pass rules (our reading of the owner bar)
A criterion passes in a fixture x arm when at least 2 of 3 runs pass it. A fixture passes when passing criteria >=
ceil(0.8 x applicable): legacy-app (C3 n/a) 5 applicable -> 4; bsconfig-plugin-app (C4 n/a) 5 applicable -> 4. The with-skills arm must
pass; baseline is reported for comparison and is not gated.

## Fidelity caveats
- Results are **in-session subagents**, not `claude -p`; not comparable to a headless CLI run.
- Subagents share this session's model and configuration. with-skills is an inlined-text approximation of an
  installed skill, not a real install (no `bt skills install`, no `.claude` hook, no MCP).
- The baseline is NOT fully isolated: it may inherit the user's global instructions and global skills and any project
  instructions found in the working directory's ancestors. A scratch dir outside the repo reduces this; it cannot
  switch those off.
- N=3 is small; a 2-of-3 pass is a weak bar.
- Token and wall-time numbers are whatever the Agent tool reports; not billed API usage.
