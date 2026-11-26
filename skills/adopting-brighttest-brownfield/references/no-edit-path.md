# The no-edit path

Evidence: run on a copy of `examples/legacy-app` in a scratch folder with `node bin/cli.js` at this version:
`init --brownfield`, `instrument build` (exit 0), `instrument build --strict` (exit 4, nothing written),
`instrument verify` on the debug zip (exit 3) and on a plain folder (exit 0), on a missing path (exit 2), and
`e2e stamp`. Flags checked against `INSTRUMENT_HELP`, `E2E_HELP` and `INIT_HELP` in `bin/cli.js`. Not
device-verified: every device step below is optional and unrun.

## When it applies

The human said app code may not be edited (Step 0 of `SKILL.md`), or has not answered. The app folder stays
byte-identical. Run `git status --short` in it before and after your work: it must show the same lines.
Everything brighttest writes goes to a copy or to ignored folders such as `.brighttest/`.

## 1. Work on a copy

```bash
cp -R app app-work
rm -rf app-work/.git
```

Put the copy outside the app's repository. Write `brighttest.json` and specs in the copy. When the human later
allows it, they move the specs over, or you propose the files as a patch (`seams-cookbook.md`).

## 2. Configure without writing into the app

```bash
cd app-work
npx brighttest init --brownfield
```

`init --brownfield` runs the census, writes the `instrument` block into `brighttest.json` (with
`state.registrySections` proposed from the registry sections found), adds `.brighttest/` and
`*.bt-instrumented.zip` to `.gitignore`, and writes no example spec and no npm script. Run it even when `brighttest.json`
already exists: it merges (valid keys kept, missing keys added, wrong-typed values fixed, unknown keys kept) and prints
`brighttest.json: unchanged (valid)` or one `added`/`changed <key>: <old> -> <new>` line per change; a valid file is not
rewritten. `--dry-run` prints the plan only. Report the result to the human. `--force` replaces the `instrument` block. Excerpt of the result on the legacy-app copy:

```json
{
  "rootDir": ".",
  "sourceGlobs": ["manifest", "source/**/*", "components/**/*"],
  "instrument": {
    "strict": false,
    "state": { "registrySections": ["legacy_prefs", "legacy_session"] }
  }
}
```

Review the proposed registry sections with the human: they decide what state tests may read.

## 2b. Check the app's globs before building

Read `sourceGlobs`, `instrument.include` and `instrument.exclude` in the app's `brighttest.json`. If they were written
for test lanes (for example they exclude `source/main.brs` or include `certs/**`), say so plainly: they do not suit an
instrument build. Do not edit the app's file. Write a second file in the copy and pass it:

```bash
npx brighttest instrument build --config bt-instrument.json --out app-debug.bt-instrumented.zip
```

## 3. Exclusions

Vendored and generated code goes into `instrument.exclude`, a list of globs relative to `rootDir`:

```json
{ "instrument": { "exclude": ["source/vendor/**"] } }
```

`instrument.exclude` is the one documented spelling. An old top-level alias still works (the config loader merges
it into `instrument.exclude`, so the build and the census see one list), but do not write it in new files.
An excluded file that contains network call sites is reported as `excluded-candidate`; with strict on, that entry
fails the build when you excluded the file yourself (`docs/guide/instrument.md`, "What counts for strict").

## 4. Ids for e2e without editing the app

```bash
npx brighttest e2e stamp app-work -o app-stamped
```

`e2e stamp <src> -o <dir>` copies the project (it skips only `node_modules`, `.git`, `.brighttest` and `out`) and
injects an id onto every node inside a component's `<children>` that lacks one. Nodes that already have an id are
left alone. On the legacy-app copy it printed `injected 0 id(s)` because every node already had one.
It copies everything else too: certificates, `.env`, zips. Keep the output outside any repository, never commit it,
and never ship from it. Run `e2e lint <flow>` on flows written for it. Selecting by `text` or `subtype` needs no
ids at all (`writing-e2e-flows`).

## 5. Build the instrumented debug package

```bash
npx brighttest instrument build --out app-debug.bt-instrumented.zip
```

This builds from a staged copy and never modifies the source tree. The zip is written only after every check
passed. Exit codes: 0 ok, 1 build failure, 2 usage, 4 strict-mode failure (see below). On the legacy-app copy:
exit 0 and `2 report entries (1 informational, 1 would trip strict)`.

Sideloading it is a device step: it needs the human's OK and a lease (`--sideload --host <ip>` with `--as` and
`--purpose`, `ROKU_PASSWORD` in the environment). Load `using-a-roku-device-safely` first. Not needed to build.

## 6. Prove it cannot ship

```bash
npx brighttest instrument verify app-debug.bt-instrumented.zip
npx brighttest instrument verify path/to/store-package.zip
```

`instrument verify <zip|dir>` exits 3 when it finds instrumentation markers (the debug zip printed 14 markers,
among them the runtime files and `BT_AGENT=true` in the manifest) and 0 when clean. A missing path exits 2. Wire
the second form into the release job as a gate (`wiring-brighttest-into-ci`). Never hand the debug zip to anyone
who might publish it.

## The strict ramp: explained, not enabled

`instrument.strict` defaults to `false`. With `--strict` (or `"strict": true`) a report entry that counts as
"could not instrument" fails the build with exit 4 and writes no package. On the legacy-app copy the entry was
`inline-cdata-scene` (a Scene whose `init` sits in an inline CDATA script, so it is not bootstrapped). Ramp:
1. Run the build with strict off and list every entry with `--verbose`.
2. Fix or exclude each entry that matters, with the human's OK for any code change.
3. Turn strict on in CI only when the build with `--strict` exits 0. Do not turn it on in the config you hand over
   before then: the human's builds would start failing.

## What stays out of reach

- A bsc plugin or `bs_const` override in `bsconfig.json`: not honored (`bsconfig-mapping.md`).
- Specs inside the app folder when writes are not allowed: keep them in the copy and hand over a patch.
- `@SGNode` and Task suites: the default run may hang on some engine versions; the outcome does not block the first
  green run on the current engine. Use `--no-sgnode`.
