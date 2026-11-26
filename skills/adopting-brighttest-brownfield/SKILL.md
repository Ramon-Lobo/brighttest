---
name: adopting-brighttest-brownfield
description: Use when adding brighttest to an existing, long-lived Roku app, with or without permission to edit its code — mapping bsconfig.json into brighttest.json, the first green headless run, characterization tests, seam extraction, the no-edit path (copy, stamp, patches for a human), exclusions and the strict ramp. Starts by asking the human whether app code may be edited and whether a device is available.
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
npx brighttest instrument census --json --out "$TMPDIR/bt-census"
```

Install the package with `setting-up-brighttest`. `doctor --engines` exits 0 when the engine probe passes, 1 when
it fails or disagrees with package metadata, 2 when no engine is installed. `census` writes `census.json` and
`census.md` into that folder, which sits outside the app, so `git status` stays unchanged. List `could not instrument` entries and `Not covered` reasons as known gaps. Do not enable strict yet.

Engine smoke step: on the legacy-app copy, with the engine `-bt.1` pins from main at 7332b12, two bounded default
runs (which include the `@SGNode` suites) finished green in about 5 s (17 passed, 0 failed, 7 suites, exit 0), and
`--no-sgnode` finished green in about 1 s (8 passed, 4 `@SGNode` suites skipped). An earlier engine version printed
nothing after "building the test bundle" for over 100 s on the same copy. So do the default run bounded, with a hard
timeout, and report it as green, failed or hung; add `--timeout <sec>` when you try `@SGNode`. `--no-sgnode` stays
available as a fallback. Do not claim it always works: the `@SGNode` result does not block the first green run.

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
Before handing off, work through its "Before you hand off, all of these" checklist: the `.env` ignore check, the
engine smoke step with one bounded default run, and at least 3 new specs even when the app already ships specs.

## Step 5: characterization tests first, then seams

Order: when a feature tree exists (`mapping-a-roku-app`, `tree.json`), take the order from the path the human chose
(`paths.recommended`, leaf-first or base-first) and do one step at a time. Without a tree, start with the pure
functions below.

Pin what the code does today before changing it: formatters, parsers, URL builders, reducers. For code that cannot
be called from a test (logic inside `init`, observers, Tasks), extract a pure function as a proposal. With edit
permission, make it a separate small change. Without it, write the proposal as a patch for a human to review: you
never apply it. See `references/seams-cookbook.md`. Do not test Task nodes through `@SGNode`: test request
building and response parsing.

## Step 6: e2e and instrumentation without editing the app (no-edit path, in this order)

1. Copy the app outside its repository (`references/no-edit-path.md`, section 1). Never work in the original.
2. Always run `npx brighttest init --brownfield` in the copy, before any build, even when `brighttest.json` already
   exists: it merges into the existing file (valid keys kept, missing ones added, wrong-typed ones fixed, a valid file
   left untouched; `--dry-run` previews). It also appends `.brighttest/` and `*.bt-instrumented.zip` to `.gitignore`.
   Nothing else: no spec, no npm script. Read its report and tell the human either `brighttest.json: unchanged (valid)`
   or each `added`/`changed` line. Never skip this step because the file is there.
3. Check the instrument-build rule below, then `npx brighttest instrument build --out app-debug.bt-instrumented.zip`.
4. Prove it cannot ship: `npx brighttest instrument verify app-debug.bt-instrumented.zip` exits 3 (markers found),
   and `npx brighttest instrument verify <plain package or folder>` exits 0. A missing path exits 2.

`e2e stamp <src> -o <dir>` copies the project and adds ids to nodes that lack one; build and run from the copy.
`instrument build` never modifies the source tree. Anything that touches a device is optional here, needs the human's
OK from Step 0, and goes through `using-a-roku-device-safely`.

Instrument-build rule: read the app's `brighttest.json` `sourceGlobs`, `instrument.include` and `instrument.exclude`
first. They are often written for test lanes (they leave out `source/main.brs`, or include `certs/**`), which does not
suit an instrument build. Say so plainly in your reply. Do not edit the app's file: write a separate config next to
the copy and pass it, for example `npx brighttest instrument build --config bt-instrument.json --out app-debug.bt-instrumented.zip`.

## Step 7: exclusions and the strict ramp

Exclude vendored code with `instrument.exclude`. Strict (`--strict`, exit 4 when something could not be
instrumented) is off by default. Say so in the report-back, in two or three sentences: strict makes the build fail
with exit 4 and write no package when any entry counts as "could not instrument"; it stays off for the first run so a
first build always produces a package and lists every entry; turn it on later, in CI, with `--strict` or
`"strict": true` under `instrument`, only once the build with `--strict` exits 0. See `references/no-edit-path.md`.

## Final reply

List every command you ran with its exit code (init, build, verify on the debug zip, verify on the plain package),
the strict explanation above, any test-lane glob finding, and the files you wrote (copy only).

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
