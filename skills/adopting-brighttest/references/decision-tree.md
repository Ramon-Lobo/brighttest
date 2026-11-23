# Decision tree

Evidence: derived from `docs/guide/` and the CLI help. These are judgement rules for an agent, not CLI
behavior. Not device-verified.

## 1. Is brighttest the right tool?

| The ask | Answer |
|---|---|
| Unit-test BrightScript functions, components, Tasks | yes: Rooibos specs, headless (`writing-rooibos-tests`) |
| Check a screen's nodes, focus, text after key presses | yes, on a device: e2e flows (`writing-e2e-flows`) |
| Check app state (registry, `m.global`) during a flow | yes: `testing-app-state` |
| Mock HTTP in a spec | yes, headless: `--net-record`, `--net-unmatched` (see `brighttest --help`) |
| Pixel, layout or video-quality checks | no: nothing here compares pixels; ask a human to look |
| DRM, real CDN or real network performance | no: headless simulates; a device only shows one device |
| Load or soak testing across many devices | no: the lease serves one run per device |
| Certify a store submission | no: `instrument verify` only checks for instrumentation markers |
| Sideload a build once | not an adoption: `instrument build --sideload`, `using-a-roku-device-safely` |
| Screenshot or read the live tree once | not an adoption: `using-brighttest-mcp` |

When the answer is "no", write down why and offer the nearest thing brighttest can do.

## 2. Existing app or new app

Run `npx brighttest assess . --json` and read `recommendation.path`, `blockers` and `editPermission`
(`lib/assess.js`).

- `brownfield`: existing-app path. Start from the assess report.
- `greenfield`: a manifest with fewer than 5 components and no specs. For an existing app the next step is
  `npx brighttest init`; do not run `init --greenfield`, which edits the manifest and writes into `source/`.
  Use `init --greenfield` only for an app with nothing written yet.
- `not-a-roku-app`: stop and ask the human; assess must run from the folder with the manifest.
- `editPermission` is always `unknown`: ask the human (section 3).
- A blocker means brighttest cannot see, or does not honor, part of the app. Every blocker `assess` can emit
  (`lib/assess.js`, `docs/guide/assess.md`), and what to do:
  - `bsconfig plugins are not honored`: unsupported (a bscPlugins passthrough is not shipped). Report it.
  - `bsconfig manifest.bs_const overrides are not honored`: report it; results may differ from the real build.
  - `bsconfig rootDir is not honored`, `bsconfig files list is not honored`, `census found 0 scenes`: brighttest
    reads `source/` and `components/` at the project root only. Do NOT change bsconfig or move folders without the
    human's OK. Report the blocker and record it under "Not verified".
  - `census skipped ...` (a sensitive or over-2 MB file under `source/` or `components/`): with the human's OK,
    move those files out of the app folders (`docs/guide/assess.md`), then run assess again.
  - `census could not parse the project`: report the error text; do not guess a fix.
  - `Node <v> does not satisfy ...`: install Node 22 or newer, or ask the human.
  On the no-edit path none of these may be cleared by editing the app.
- A mix (a new module in an old app): treat the app as existing; add the new module's specs first.

## 3. May you edit the app?

- Yes: add specs next to the code, extract small seams if needed.
- No (vendor code, frozen branch, no permission): do not edit source. Use `init --brownfield`, which writes
  only `brighttest.json` and `.gitignore` entries, plus `instrument build` and e2e flows against the built
  package. Keep every file you add inside the brighttest config, `flows/` or test folders.
- Unsure: ask the human once, and write the answer in the report.

## 4. Do you need a device?

- Specs and coverage: no. Run headless.
- Flows (`e2e run`, `e2e inspect`, `e2e record`), `--device`, `--cross-check`, `instrument build --sideload`: yes.
- No device reachable, or `npx brighttest device status` shows it held: do the headless work, list the device work
  under "Not verified", and give the exact command for a human. Exit 75 means busy: stop, do not loop.
