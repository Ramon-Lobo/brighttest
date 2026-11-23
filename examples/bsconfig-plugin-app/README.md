# bsconfig-plugin-app

Brownfield trap fixture: a plain app whose build is driven by `bsconfig.json`.

- `rootDir: "src"`: the app lives under `src/`, not at the project root.
- a custom `files` list (`manifest`, `source/**/*.brs`, `components/**/*.xml`).
- a local no-op bsc plugin, `plugins/noop-plugin.js` (zero dependencies, no network).
- a `manifest` `bs_const` override (`DEMO_FLAG=true`).

## Expected `brighttest assess` blockers

Brighttest does not run bsc plugins and reads `rootDir` from bsconfig.json as a census hint only (the build uses `rootDir` from `brighttest.json`) and does not honor a custom `files` list, so assess reports all three.
The census finds the scene under `src/` through the bsconfig hint; the build still needs `rootDir` in `brighttest.json`.

Real output (`node bin/cli.js assess examples/bsconfig-plugin-app`), key lines:

```
bsconfig:  bsconfig.json, unsupported: plugins
census:    1 scenes, 0 tasks, setUrl 0/0 covered, 0 could not instrument
recommend: greenfield; edit permission unknown
  blocker: bsconfig plugins are not honored by brighttest: ./plugins/noop-plugin.js
  blocker: bsconfig rootDir is read by the census as a hint only; the brighttest build uses rootDir from brighttest.json and does not read bsconfig.json (set the same rootDir in brighttest.json, and confirm with the human): "src"
  blocker: bsconfig files list is not honored by brighttest (the default source/, components/ layout is assumed): 3 entries
```
