# Reading the assess output (`brighttest-assess/v1`)

Evidence: sections, field names, blocker texts and exit codes are from `lib/assess.js`, `node bin/cli.js assess
--help` and `docs/guide/assess.md` on this version. Not device-verified. The census behavior is "until ADOPT-27
merges".

Three forms: the terminal summary (default), `--json` (the document), and `assess.md` / `assess.json` written by
`--out <dir>`, plus `census.md` / `census.json` only when the census ran. They hold the same facts.

## Sections of the JSON

| Field | What to read |
|---|---|
| `schema`, `cliVersion`, `root` | Schema id, tool version, `root` is always `.`. |
| `host` | `node`, `nodeRequired`, `nodeOk`, `platform`. |
| `project` | `isRokuApp`, `manifest`, `dirs`, `language`, `bsconfig` (`present`, `file`, `rootDir`, `files`, `plugins`, `bsConstOverride`, `unsupported`), `ropm`, `packageManagerDeps`, `rooibos` (`present`, `specFiles`, `specsOutsideSource`, `brsAnnotated`), `manifestKeys`, `files` (counts, `truncated`). |
| `brighttest` | `installed`, `config` (`present`, `file`, `keys`, `deprecatedKeys`), `engines` (brs-node and rooibos versions, `warnings`). |
| `census` | `components`, `scenes`, `tasks`, `setUrlSites`, `setUrlCovered`, `notCovered` (reason and count), `couldNotInstrument`, `inlineCdataScenes`, `registrySections`, `globalFields`, `error`. |
| `secrets` | `{ file, line, key, kind }`. Kinds: `assignment`, `bearer-literal`, `private-key`, `url-credentials` (the last three have `key: null`). No value, no line text. |
| `risky` | `{ kind, file, line }` (see `risky-patterns.md`). |
| `scans` | `secrets` and `risky`, each `{ ran, files, skippedLongLines }`. Check `ran` is true. |
| `ci`, `gitignore`, `devices` | CI systems and Node versions, whether `.gitignore` covers the brighttest dir, `.env` and coverage, and `ROKU_HOST` set or not plus whether a device cache exists (never their values). |
| `recommendation` | `path`, `editPermission`, `blockers`, `nextSteps`, `unknowns`. |
| `scan` | `files`, `skippedSensitive`, `overCap`, `truncated`, `treeHash`. |

## The recommendation

- `path`: `not-a-roku-app` (no manifest), `greenfield` (a manifest, fewer than 5 components, no spec files),
  otherwise `brownfield`. Count of components is the census one.
- `editPermission`: always `unknown`. Ask the human.
- `nextSteps`: the tool's suggestion, for example `npx brighttest doctor --engines`, `npx brighttest init`.
  They are suggestions; `init` writes files, so ask first if the human has not said to go ahead.
- `unknowns`: always includes `device availability`; also `whether the team will edit app code`, and a
  "bsconfig files list matches the bsc defaults: confirm it has no other entries" line when that applies.

## Blockers (exact starts of the text, from `lib/assess.js`)

| Blocker starts with | Meaning | Do not |
|---|---|---|
| `bsconfig plugins are not honored by brighttest:` | A bsconfig plugin is listed; brighttest does not run it. | Remove the plugin. |
| `bsconfig manifest.bs_const overrides are not honored by brighttest` | A build constant set in bsconfig is ignored. | Move it into the manifest without OK. |
| `bsconfig rootDir is not honored by brighttest (census reads source/ and components/ under the project root only):` | `rootDir` is set and the manifest is not in that folder. The value is shown JSON-quoted, or "points outside the project root, not read" for an absolute or `..` path. | Move folders. |
| `bsconfig files list is not honored by brighttest (the default source/, components/ layout is assumed):` | A custom `files` list (not only the roku-deploy defaults); the count of entries follows. | Edit the list. |
| `census found 0 scenes: check the app keeps components/ at the project root ...` | A manifest app whose census found no scene and no `rootDir` is set. | Treat 0 as "no scenes exist". |
| `census skipped: ...` | Sensitive or oversized files under `source/` or `components/` (not opened), or over 20,000 files there. `census.error` holds the same text. | Open or print the named files. |
| `census could not parse the project: ...` | The census failed on the project. | Guess the counts. |
| `Node <v> does not satisfy <range>` | The host Node is too old for this brighttest. | Change Node without telling the human (use a version manager only with OK). |

Every blocker is a limit of what brighttest sees. List it in the report with the "needs human OK" note whenever
clearing it would mean editing bsconfig, the manifest or the folder layout.

## Census, until ADOPT-27 merges

The census reads `source/` and `components/` in the folder with the manifest: the project root, or
`<rootDir>/manifest` when bsconfig `rootDir` is set and there is no manifest at the root (then no `rootDir`
blocker). Other `rootDir` values are blockers. `rootDir` through `extends`, or in a bsconfig that does not parse,
is not detected. Do not describe any broader behavior as current. `census.setUrlCovered` of `setUrlSites` tells
how many HTTP-call sites the census can instrument; `notCovered` gives the reasons.

## Limits to state in every report

- Nothing is known about a real device (`devices` shows only whether a host variable or cache exists).
- Only the root `.gitignore` is read. Nested ones are listed, not opened.
- Symlinks are skipped. `node_modules/`, `.git/`, `out/`, `dist/`, `build/`, `.brighttest/`, `coverage/`,
  `reports/` and `certs/` are skipped. More than 20,000 files, or a file over 2 MB, is cut and counted
  (`scan.truncated`, `scan.overCap`).
- Secret key names are matched by word, so a bare `pass` or `auth` is not flagged, and placeholders such as `${VAR}`
  and empty values are ignored. A clean `secrets` list is not proof there are none.
