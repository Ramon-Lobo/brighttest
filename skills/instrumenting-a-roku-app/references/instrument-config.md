# The instrument config

Evidence: `docs/guide/instrument.md` (Configuration), `lib/config.js` (`mergedInstrumentExclude`, `INSTRUMENT_DEFAULTS`),
`lib/instrument/plugin.js` (`DEFAULT_EXCLUDE`) and `node bin/cli.js instrument --help`. Not device-verified.

## Where it lives

`brighttest.json` in the app folder (build accepts `--config <path>`; census does not apply it, see `references/census-reading.md`). All keys are optional. Adding or
changing this file is an edit to the repo: ask the human if it does not exist yet. `npx brighttest init --brownfield`
writes the block for you (`strict: false`, proposed `state.registrySections`) and adds `.brighttest/` and
`*.bt-instrumented.zip` to `.gitignore`; it adds no spec. An existing `instrument` block is kept unless `--force`.

```json
{
  "instrument": {
    "strict": false,
    "exclude": ["source/vendor/**"]
  }
}
```

Other keys in the block exist (`net`, `scene`, `op`, `hub`, `state`); their meaning is in
`docs/guide/instrument.md` and the `testing-app-state` skill. Do not set them from guesses.

## `instrument.exclude`

A list of globs for files the plugin must not rewrite. Excluded files are still scanned by the census and still
shipped in the package; they only get no probes. This is the canonical key.

Always excluded without any config (`DEFAULT_EXCLUDE` in `lib/instrument/plugin.js`): `source/vendor/**`,
`source/rooibos/**`, `roku_modules/**`, `components/bt/**`, `source/bt/**`, `**/*rooibos*` (the list continues in the
source; read it there). Add to it, do not repeat it.

Good candidates: generated code, large third-party code outside those folders, a file the build reports as
`BT9003 staged-output-invalid` after the human agreed to skip it.

The census and the build read the same merged list, so an exclude shows up in both.

## The deprecated alias

An older top-level key, the same word as `instrument.exclude` written as one camel-cased name, is a deprecated alias.
The config loader merges it into `instrument.exclude` (deduplicated). Skills and new configs use only
`instrument.exclude`. If you meet the alias in an existing config, leave it and tell the human; do not rewrite their
config unasked. (This text avoids writing the alias literally because the facts gate bans it in skills.)

## Strict

`"strict": false` is the default. `--strict` or `--no-strict` override it for one run. With strict on, the build
exits 4 when a report entry counts as "could not instrument". Which kinds count: `references/errors-and-exit-codes.md`.
Ramp: run `instrument census`, read "Could not instrument", clear or accept those rows, then try one `--strict`
build. Turn it on in config or CI only with the human's OK.

## Config recipe: check what you will exclude before building

```bash
npx brighttest instrument census --json | grep -c '"excludedBy"'
```

The count is how many report entries cite an excluded file (zero is fine; grep itself then exits 1, which is not an
error). Run it from the folder holding `brighttest.json`. It changes nothing on disk.
