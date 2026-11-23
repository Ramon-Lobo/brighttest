---
name: adopting-brighttest-brownfield
description: Use when adding brighttest to an existing, long-lived Roku app, with or without permission to edit its code: mapping bsconfig.json into brighttest.json, the first green headless run, characterization tests, seam extraction, the no-edit path (copy, stamp, patches for a human), exclusions and the strict ramp. Starts by asking the human whether app code may be edited and whether a device is available.
triggers: brownfield roku app; legacy roku app; existing app without tests; map bsconfig to brighttest.json; characterization tests; app i cannot edit; first green headless run; seam extraction
when-not-to-use: Do not use for a new app (use adopting-brighttest-greenfield), for the read-only report (use assessing-a-roku-app), or for spec and flow syntax (use writing-rooibos-tests, writing-e2e-flows). It does not teach the device lease (use using-a-roku-device-safely).
license: MIT
metadata:
  source: brighttest
---

# Adding brighttest to an existing Roku app

Load `adopting-brighttest` first if you have not (it picks the path and holds the hard rules), and run
`assessing-a-roku-app` before this skill: its report names the blockers this skill works around. This skill is the
order of steps for an app that already has code and few or no tests.

Evidence: commands, flags, exit codes and blocker texts were checked against `lib/*.js` and the `*_HELP` text in
`bin/cli.js`, and run on copies of `examples/legacy-app` and `examples/bsconfig-plugin-app` in a scratch folder
(assess, `init --brownfield`, `instrument build`, `--strict`, `instrument verify`, `e2e stamp`, a headless run with
`--no-sgnode`). Recipes checked in bash and zsh. Not device-verified. Anything marked "unverified" was not run.

## Step 0: ask the human two questions first

Before you plan any step that changes the app or needs a device, ask, and wait for the answer:

1. May I edit the app's code (source, components, manifest, bsconfig)? Adding only `brighttest.json`, spec files
   under `source/tests/` and `.gitignore` lines is still a write into the app folder: ask about that too.
2. Is a Roku device available for this work, and may I use it through the lease? If yes, who owns it?

`assess` always answers `editPermission: unknown` and lists `device availability` as unknown: it never knows.
Record both answers in your plan. No edit permission means the no-edit path (`references/no-edit-path.md`): the
app folder stays byte-identical and you work on a copy. No device means every step below stays headless.

## Step 1: install, engine check, census (no device, read-only)

```bash
npx brighttest doctor --engines
npx brighttest instrument census --json --out .brighttest/census
```

Install the package with `setting-up-brighttest`. `doctor --engines` exits 0 when the engine probe passes, 1 when
it fails or disagrees with package metadata, 2 when no engine is installed. `census` writes `census.json` and
`census.md` into the folder and does not edit the app; `.brighttest/` is the staging folder, so it must be ignored
by git. List `could not instrument` entries and `Not covered` reasons as known gaps. Do not enable strict yet.

Engine smoke step: on the legacy-app copy a default run (which includes the `@SGNode` suite) printed nothing
after "building the test bundle" for over 100 s and was killed; with `--no-sgnode` the same project ran. So
run `npx brighttest --no-sgnode` for the first green run and add `--timeout <sec>` when you do try `@SGNode`.
Recorded here as an outcome, not a fix: the `@SGNode` result is non-gating while ENG-PUB is held.

## Step 2: map bsconfig.json into brighttest.json

brighttest does not read `bsconfig.json` to build. Map by hand: `rootDir` to `rootDir`, `files` to `sourceGlobs`.
Plugins, `manifest.bs_const` overrides, ropm copy steps and a custom `files` mapping are not honored: an app that
needs a bsc plugin to compile is blocked until that is solved, so say so and stop. Details and examples are in
`references/bsconfig-mapping.md`. `npx brighttest assess . --json` prints `project.bsconfig.mapping` (the
suggested `rootDir` and `sourceGlobs`).

## Step 3: configure with the smallest working file

- Tests wanted and the human allowed writes: `npx brighttest init` (existing files are kept).
- No edits to the app: `npx brighttest init --brownfield`, or write `brighttest.json` yourself on the copy.
- Then set `sourceGlobs`, `diagnosticFilters` for noisy codes, `globalFields` for widgets that read globals, and
  `instrument.exclude` for vendored code. `init` does not add `.env` to `.gitignore`: with the human's OK, add it before any password exists.

## Step 4: first green headless run

Follow `references/first-green-run.md`: write 3 meaningful specs for pure functions, run `npx brighttest
--no-sgnode`, read the pass count (zero tests is not green), flip one expectation to see a failure, restore it.

## Step 5: characterization tests first, then seams

Pin what the code does today before changing it: formatters, parsers, URL builders, reducers. For code that cannot
be called from a test (logic inside `init`, observers, Tasks), extract a pure function as a proposal. With edit
permission, make it a separate small change. Without it, write the proposal as a patch for a human to review: you
never apply it. See `references/seams-cookbook.md`. Do not test Task nodes through `@SGNode`: test request
building and response parsing.

## Step 6: e2e and instrumentation without editing the app

`e2e stamp <src> -o <dir>` copies the project and adds ids to nodes that lack one; build and run from the copy.
`instrument build` never modifies the source tree. The debug package must never ship: `instrument verify` exits 3
when instrumentation markers are found and 0 when clean. See `references/no-edit-path.md`. Anything that touches
a device is optional here, needs the human's OK from Step 0, and goes through `using-a-roku-device-safely`.

## Step 7: exclusions and the strict ramp

Exclude vendored code with `instrument.exclude`. Strict (`--strict`, exit 4 when something could not be
instrumented) is off by default: explain it, enable it in CI only after the census is clean. See
`references/no-edit-path.md`.

## Hard rules

- No edit to app code, manifest or bsconfig without the human's OK. Proposals are patches; the human applies them.
- Never print or write a device password, token or serial. The dev password lives in `ROKU_PASSWORD` or a
  gitignored `.env`; run `git check-ignore .env` first.
- Device access only through a brighttest lane or `npx brighttest device with --as "$BRIGHTTEST_AGENT" --purpose
  "<task>" -- <cmd>`. Never `--no-lease`, never `device unlock --force`, never raw `curl` to a device.
- Never publish or hand over an instrumented package. Gate every release with `instrument verify`.

## References

- `references/bsconfig-mapping.md`: bsconfig keys to brighttest.json keys, and the current limits.
- `references/seams-cookbook.md`: before and after BrightScript for extracting testable seams.
- `references/no-edit-path.md`: copy, stamp, instrument, patches for review, exclusions, strict ramp, release gate.
- `references/first-green-run.md`: the first headless run, expected failures and their routes.
