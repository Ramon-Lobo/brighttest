---
name: assessing-a-roku-app
description: Use when you must look at an existing Roku/BrightScript app before adding brighttest, and report how ready it is. It runs the read-only `brighttest assess`, reads the brighttest-assess/v1 output (recommended path, blockers, census, secrets, risky patterns), fills a short assessment template for the human, and lists what the assessment must never do (edit the app, print secrets, touch a device).
triggers: assess a roku app; brighttest assess; is this app ready for brighttest; assessment report for a roku project; what do the assess blockers mean; risky patterns in brightscript code; brownfield assessment
when-not-to-use: Do not use to install brighttest or write brighttest.json (use setting-up-brighttest), to choose the overall path first (use adopting-brighttest), or to fix what the assessment finds. The assessment changes nothing in the app.
license: MIT
metadata:
  source: brighttest
---

# Assessing a Roku app (read-only)

Run `brighttest assess`, read the result, and hand the human a short, honest report. The assessment never
changes the app. Any step that would change it needs the human's OK first.

Evidence: every command, flag, JSON field, blocker text and exit code here was checked against `lib/assess.js`,
`node bin/cli.js assess --help` and `docs/guide/assess.md` on this version. The shell recipes were run in bash
and zsh against `examples/legacy-app/`. Not device-verified: assess uses no device. Claims marked "(guidance)"
are advice, not something the tool checks.

## What assess does and does not do

- Read-only, offline, in process: no network, no device, no lease, no subprocess. Without `--out` it writes
  nothing. `npx brighttest assess --help` lists the options.
- It never opens `.env*`, `*.pem`, `*.p12`, `*.pkg`, key files, `certs/` or the device cache.
- Findings never change the exit code. Exit 0 means a report was produced (a folder without a manifest is exit 0
  with path `not-a-roku-app`). Exit 1 is an internal error. Exit 2 is a usage error: missing `<dir>`, bad `-c`
  config, or `--out` refused (inside `source/` or `components/`, or an existing file).
- It is a snapshot with a short, fixed set of checks. "None found" is not proof the app is clean.

## Steps

1. Confirm the folder is the project root (the one with `manifest`). From a repo you were given, run
   `git status --short` first and leave existing changes alone.
2. Run the assessment. Pick an output folder outside the app and outside any repo you would commit, or ask the
   human where to write it:

   ```sh
   OUT="$(mktemp -d)/assess-out"
   npx brighttest assess . --out "$OUT"; echo "exit $?"
   ```

   The summary prints to the terminal. `$OUT` gets `assess.json` and `assess.md`, plus `census.json` and `census.md` when the census ran.
   Use `--json` to print the JSON instead of the summary. Use `-c <file>` only when the config is not
   `<dir>/brighttest.json`.
3. Read the headline fields (guide: `references/reading-assess-output.md`):

   ```sh
   node -e 'const r=require(process.argv[1]);const c=r.recommendation;console.log(c.path,"|",c.editPermission,"|",c.blockers.length,"blockers |",r.secrets.length,"secrets |",r.risky.length,"risky")' "$OUT/assess.json"
   ```

4. Read every entry of `recommendation.blockers` and `recommendation.unknowns`. A blocker means brighttest
   cannot see, or does not honor, part of the app. Say so in the report; do not clear it by editing bsconfig,
   moving folders or changing source unless the human says yes.
5. Look at `secrets` (file, line and key name only) and `risky` (kind, file, line). Open the cited line only
   when the human asked you to explain it, and never print or quote a secret value (see below). Meanings:
   `references/risky-patterns.md`.
6. Check the run changed nothing: `git status --short` shows what it showed in step 1, and `scan.treeHash` is the
   same on a second run (same `--json` field, optional).
7. Fill `references/assessment-template.md` and give it to the human. Include the exit code you saw. Ask the
   human about edit permission; `recommendation.editPermission` is always `unknown`.

## Rules

- Read-only: the assessment edits no app file, `bsconfig*.json`, manifest or `.gitignore`. Put `--out` outside
  `source/` and `components/` (the command refuses those). Do not commit assessment output without the human's OK
  (guidance: it names file paths and key names).
- Secrets: the scan reports key names and `file:line` only, never values. Never print, quote, paste or re-derive a
  value. Do not run `cat`, `grep` or `env` on `.env` or key files to "confirm". Key names and file:line are safe to paste;
  the source line is not. `assess` already redacts absolute paths in census-error text (the blocker, the reports and
  the JSON): a path inside the project root becomes `<path>/<folders from the root>`, any other path (home directory
  included) becomes `<path>/<file name>`; do not redo that by hand. Text that did not come from `assess` (your own
  command output, logs, other tool errors) can still show home or absolute paths, a username or a host: do not paste
  those into shared text; replace them with `<path>` first. If a finding looks real, tell the human to rotate it (guidance).
- `.env` safety: before any file with a password is ever written, `git check-ignore .env` must print `.env`.
  Assessment itself writes none.
- No device: assess needs none. If the human then wants device work, load `using-a-roku-device-safely`. Never
  `--no-lease`, never `device unlock --force`, never sudo, never change a firewall or device setting, never press
  `PowerOff` or an input-switch key.
- Do not use `env`, `printenv` or `pgrep -f` while assessing (they can expose secrets or match other processes).
- Honest labels: write "not device-verified" for anything about running on a Roku; write "not checked" for what
  assess does not look at (see the limits in `references/reading-assess-output.md`).

## Census and rootDir

The census follows a bsconfig `rootDir` (direct or through `extends`) only as a hint, and only when `brighttest.json`
sets no `rootDir`. The build uses `rootDir` from `brighttest.json` and does not read `bsconfig.json`. A `rootDir`
blocker therefore means: the census saw the app, but the build would not. Report it and confirm with the human; the
fix is the same `rootDir` in `brighttest.json`. A `files` blocker still means brighttest does not honor the list.

## After the report

Do not start fixing. Suggest the next skill from the table, one at a time:

| Result | Next |
|---|---|
| path `brownfield`, blockers understood | `setting-up-brighttest`, then `adopting-brighttest` for the order of work |
| path `greenfield` | `adopting-brighttest` (an existing app still starts with `npx brighttest init`) |
| path `not-a-roku-app` | ask the human for the folder with the manifest, and run assess there |
| failing existing specs | `debugging-failing-tests` |

## References

- `references/assessment-template.md`: the report to fill in, with an example.
- `references/risky-patterns.md`: the six risky kinds and what each means.
- `references/reading-assess-output.md`: every section of `brighttest-assess/v1`, the blockers, and the limits.
