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
| Debug one live device once | not an adoption: `using-brighttest-mcp` |

When the answer is "no", write down why and offer the nearest thing brighttest can do.

## 2. Existing app or new app

- Code exists and ships: existing-app path. Start with `npx brighttest assess .` (read-only).
- Nothing exists yet, or only a template: new-app path: `npx brighttest init --greenfield`.
- A mix (a new feature module in an old app): treat the app as existing; add the new module's specs first.

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
