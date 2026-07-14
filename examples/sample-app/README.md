# brighttest sample app

A tiny but complete Roku SceneGraph channel that exercises **every brighttest lane** — headless unit
tests, `@SGNode` node tests, coverage, on-device runs, and the on-device **E2E** lane (flows, focus
navigation, text entry, screenshots, video). It's intentionally small and meant to **grow**: add a
feature, add a spec and/or a flow beside it.

## The app

A four-screen channel, one panel mounted at a time:

- **Home** — a 2-row focus grid: a nav row (`searchButton`, `settingsButton`) and a content row
  (`tileNews`, `tileSports`, `tileMovies`). Selecting a tile opens Details; selecting a nav button
  opens that screen.
- **Details** — shows the chosen title; `Back` returns Home.
- **Search** — an on-screen `Keyboard`; typed text mirrors into `searchQuery`.
- **Settings** — a `captionsToggle` that flips `captionsState`.

`Back` always returns Home (and never exits), which makes E2E flows deterministic.

## Layout

```
manifest
source/
  main.brs              # app entry (excluded from the test build — see notes)
  lib/Format.brs        # pure helpers, covered by unit tests
  tests/
    Format.spec.bs      # unit suite (headless)
    Counter.spec.bs     # @SGNode node suite (onChange cascade)
components/
  Counter.xml/.brs      # a node with an onChange cascade (tested via @SGNode)
  HomeScene.xml/.brs    # mounts the active panel, routes navigation, handles Back
  panels/*.xml/.brs     # Home / Details / Search / Settings panels
flows/
  home-to-details.e2e.yaml
  search.e2e.yaml
  settings.e2e.yaml
brighttest.json
```

## Running the tests

> In this repo, invoke the local CLI with `node ../../bin/cli.js`. In your own project it's `npx brighttest`.

### Logic tests (no device)

```bash
node ../../bin/cli.js                    # headless — Format unit suite + Counter @SGNode suite
node ../../bin/cli.js --coverage --lcov coverage/lcov.info   # + LCOV coverage (still no device)
node ../../bin/cli.js --device --host <ip> --password <pw>   # the same suites on real hardware
```

### On-device E2E

E2E drives the **running app**, so first sideload the app build (tests excluded), then run the flows.

```bash
# 1. Build an app-only zip and sideload it (developer mode + Network access = Permissive)
zip -r app.zip manifest source components -x 'source/tests/*'
curl --digest -u "rokudev:<pw>" -F mysubmit=Install -F "archive=@app.zip" "http://<ip>/plugin_install"

# 2. Explore, then run the flows
node ../../bin/cli.js e2e inspect --host <ip> --app dev
node ../../bin/cli.js e2e run flows/ --host <ip> --password <pw>

# extras
node ../../bin/cli.js e2e run flows/ --host <ip> --password <pw> --video          # session replay
node ../../bin/cli.js e2e run flows/ --host <ip> --password <pw> --screenshots-mode all
```

All three flows pass end to end (focus path-finding across the Home grid, Select transitions, `Back`,
text entry on the keyboard, and text/visibility assertions).

## Notes (the non-obvious bits, learned the hard way)

- **`main.brs` is excluded from the test build** (`"!source/main.brs"` in `brighttest.json`). In a test
  build Rooibos provides the entry; the app's own `Main()` would boot the UI and the test runner would
  never start (the run hangs). The app still needs `main.brs` for the real/E2E build, so it stays in the
  source tree — just negated for the Rooibos lanes.
- **The E2E build is plain `.brs`/`.xml`.** E2E sideloads raw source, and Roku only runs `.brs`. Keep app
  code plain BrightScript; exclude `source/tests/**` (the `.bs` specs) from the app zip.
- **Render-thread components can't call `pkg:/source` globals.** `HomePanel` keeps its own local `clamp`
  even though the identical logic lives in `lib/Format.brs` for the unit tests. Share code with a
  component via an explicit `<script>` include, not a source global.
- **Flows normalize to Home.** Relaunching a running channel doesn't reset its scene, so each flow starts
  with `launch` → `back` (Back always returns Home here) → `assertVisible homeTitle`.
- **A `Keyboard` persists its text** across relaunches — the search flow clears with `Backspace` first.

## Extending this example

- **New logic?** Add a function to `lib/Format.brs` (or a new `lib/*.brs`) and a `*.spec.bs` under
  `source/tests/`. It runs headless — no device.
- **New component with state?** Model it like `Counter` and add an `@SGNode("YourComponent")` suite.
- **New screen/journey?** Add a panel + wire it in `HomeScene.brs`, then drop a `*.e2e.yaml` in `flows/`.
- Keep every new node **`id`-tagged** so flows can select it (or run `brighttest e2e stamp` to auto-inject
  ids). This example grows alongside the tool — new brighttest features should gain coverage here.
