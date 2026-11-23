# Exit criteria: what "adopted" means

Evidence: this checklist is this skill's own definition of "adopted", built on the CLI behavior in
`references/command-cheatsheet.md`. No command enforces it. Not device-verified.

## The checklist

Mark each line done, not done, or not applicable, with the command you ran.

1. Tool runs: `npx brighttest --version` prints a version.
2. Config committed: `brighttest.json` exists and names the real sources and test pattern.
3. Ignore entries: `.brighttest/` and `*.bt-instrumented.zip` are in `.gitignore`; `git check-ignore .env`
   prints `.env` before any password is written; no password or token in any tracked file (`git status` and
   `git diff` show none).
4. Green headless run: `npx brighttest --junit results.xml` exits 0, and you read the summary, not only the code.
   A zero-test run is not green: confirm the test count is above zero.
5. A real guard: at least one spec or flow covers logic the app depends on (not only the scaffolded example).
6. CI gate: a CI job runs the headless command and publishes the JUnit file (wording for CI is in
   `setting-up-brighttest`).
7. Existing app, no-edit path: the app's own source is unchanged (`git status` shows only brighttest files).
8. Device work, if any: ran through a lane or `device with`, lease released, result labeled with model and
   firmware when known.
9. Honest report: lists what was not run on a device and what was not run at all.

## The report an agent hands back

Keep it short:

- Path chosen (existing or new, edit or no-edit) and why.
- Commands run and their results, pasted exactly for failures.
- Files added or changed.
- "Not verified": every device step, with the exact command a human can run, for example
  `npx brighttest device with --as "<role>#<n>" --purpose "<task>: <check>" -- <command>`.
- Follow-ups: skills not installed that would help, and open questions for the human.

## Not adopted yet when

- The only green run is the scaffolded example spec.
- Tests pass because they were skipped or excluded without a note.
- A device result is claimed from a headless run.
