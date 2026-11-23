# bsconfig-plugin-app

Brownfield trap fixture: a plain app whose build is driven by `bsconfig.json`.

- `rootDir: "src"`: the app lives under `src/`, not at the project root.
- a custom `files` list (`manifest`, `source/**/*.brs`, `components/**/*.xml`).
- a local no-op bsc plugin, `plugins/noop-plugin.js` (zero dependencies, no network).
- a `manifest` `bs_const` override (`DEMO_FLAG=true`).

## Expected `brighttest assess` blockers

Stated expectation: the bsconfig plugin caveat (brighttest does not run bsc plugins), plus
the `rootDir` and custom `files` list as things to confirm.

Real output (`node bin/cli.js assess examples/bsconfig-plugin-app`), key lines:

```
bsconfig:  bsconfig.json, unsupported: plugins
census:    0 scenes, 0 tasks, setUrl 0/0 covered, 0 could not instrument
recommend: greenfield; edit permission unknown
  blocker: bsconfig plugins are not honored by brighttest: ./plugins/noop-plugin.js
```

Only the plugin caveat is a reported blocker today. `rootDir` and the `files` list are not
reported as blockers, and the census shows 0 scenes (the Scene sits under `src/`), so the
`rootDir` case is not surfaced by assess yet.
