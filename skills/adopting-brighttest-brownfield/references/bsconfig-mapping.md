# Mapping bsconfig.json into brighttest.json

Evidence: read from `lib/config.js` (`loadConfig`, `writeBsConfig`, `writeInstrumentBsConfig`),
`lib/instrument/census.js` (`effectiveBase`) and `lib/assess.js` (`bsconfigSection`), and run on a copy of
`examples/bsconfig-plugin-app` (assess, then census with a `rootDir` set). Not device-verified.

## The rule

brighttest never passes the project's `bsconfig.json` to bsc. Each lane writes its own generated bsconfig from
`brighttest.json` (`rootDir`, `sourceGlobs`, `diagnosticFilters`, ...) into `<stagingDir>/<lane>/`. So a setting
in `bsconfig.json` has an effect only if you repeat it in `brighttest.json`, and only the keys below can be repeated.

| bsconfig key | brighttest.json key | Status |
|---|---|---|
| `rootDir` | `rootDir` | Supported by repeating it. Resolved against the project root (the folder of `brighttest.json`): run commands from the app folder. |
| `files` | `sourceGlobs` | Supported by repeating it. The default is `["manifest","source/**/*","components/**/*"]`. Entries are passed on to bsc as they are; only string globs (with a `!` prefix to exclude) were checked. |
| `diagnosticFilters` | `diagnosticFilters` | Supported: a list of codes, merged with 1107 (always silenced). |
| `plugins` | none | Not honored. brighttest runs the Rooibos plugin (and the instrument plugin for its builds) and nothing else. |
| `manifest.bs_const` | none | Not honored. Constants in the app's own `manifest` file (`bs_const=A=true;B=false`) are read by bsc as usual. |
| `extends`, `stagingDir`, `sourceMap`, `autoImportComponentScript`, ... | none | Not read. `stagingDir` is a brighttest.json key with its own default (`.brighttest`); the generated bsconfig sets `autoImportComponentScript: true` for the test lanes only. |
| ropm copy steps, custom roku-deploy `files` mappings | none | Not run. Dependencies under `roku_modules/` must already be in the tree. |

An app that needs a custom bsc plugin or a `bs_const` override to compile cannot be built by brighttest today.
Report it as a blocker. Do not remove the plugin, and do not move the constant into the manifest, without the human's OK.

## Worked example (the rootDir app)

`examples/bsconfig-plugin-app` has `"rootDir": "src"`, a 3-entry `files` list and one local plugin. `assess`
printed three blockers on this version: the plugin, `bsconfig rootDir is read by the census as a hint only; the
brighttest build uses rootDir from brighttest.json and does not read bsconfig.json (...)`, and the `files` list.
The matching `brighttest.json`:

```json
{
  "rootDir": "src",
  "sourceGlobs": ["manifest", "source/**/*.brs", "components/**/*.xml"],
  "stagingDir": ".brighttest"
}
```

`sourceGlobs` entries are relative to `rootDir`. In that fixture the `manifest` file sits at the project root, not
under `src/`: where bsc looks for it under a `rootDir` was not checked, so verify with a build before you rely on it.
Do not trust a green census alone: the census and the build are separate code paths.

## What the census does with rootDir

The census scan base is, in order: `rootDir` from `brighttest.json`; else the `rootDir` found in `bsconfig.json`
(own, or through `extends` chains of `.json` files, at most 10 deep); else the project root. It is used only when
it is a directory inside the project root and no folder on the way is secret-named or `certs/`. Otherwise the census
falls back to the project root and the census records a note. With only the bsconfig hint, `assess` still
raises the `rootDir` blocker, because the build does not follow the hint. Verified by running assess and census on
a copy of the fixture: with `{"rootDir":"src"}` in `brighttest.json` the census found the scene under `src/` and
the `rootDir` blocker was gone, while the plugin and `files` blockers remained.

## How to get the values

`npx brighttest assess . --json` carries `project.bsconfig`: `rootDir`, `files`, `plugins`, `bsConstOverride`,
`unsupported` and `mapping` (`{ rootDir, sourceGlobs }`, the values to copy). A `files` list equal to the roku-deploy
defaults is not flagged. Read `assess` output with `assessing-a-roku-app` (`references/reading-assess-output.md`).
Show the human the proposed `brighttest.json` before you write it into their repository.

## The instrument config is a second file

An instrument build wants `main.brs` and no specs; the unit lanes want specs. `examples/sample-app` ships a second
config for this and `instrument build` takes it with `--config`:

```json
{
  "rootDir": ".",
  "sourceGlobs": ["manifest", "source/**/*", "!source/tests/**", "components/**/*"],
  "stagingDir": ".brighttest"
}
```

Save it as `brighttest.instrument.json` and run `npx brighttest instrument build --config brighttest.instrument.json`.
The `instrument` block (`exclude`, `strict`, `state`) belongs in whichever file you pass with `--config`.
