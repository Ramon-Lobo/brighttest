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
- Fix every blocker (bsconfig plugins, bs_const overrides, census errors, Node too old) before the first run.
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
