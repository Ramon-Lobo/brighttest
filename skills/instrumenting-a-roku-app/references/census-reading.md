# Reading the census

Evidence: output of `npx brighttest instrument census` on `examples/legacy-app` at this version, and
`lib/instrument/census.js`. Headless, not device-verified.

## Run it

```bash
npx brighttest instrument census                                  # markdown to stdout
npx brighttest instrument census --json --out .brighttest/census  # JSON to stdout; census.json and census.md in the dir
```

It is static: no device, no network, no build. Nothing is written unless you pass `--out`. Run it from the app
folder. Exit 0 means a report was produced; 2 means census failed (the message is on stderr).

Scope: it scans `source/` and `components/` under the `rootDir` from `brighttest.json`, else a bsconfig `rootDir`
(a census-only hint: build and instrument do not read `bsconfig.json`), else the current directory (test folders and
`*.spec.*` skipped). A `rootDir` outside the project root is ignored.

It reads `brighttest.json` from the current directory (or the file given with `--config <path>`) and honors
`instrument.exclude` and `instrument.net`. A `brighttest.json` or `--config` file that is not valid JSON, or a missing
`--config` file, fails census with exit 2 and a message on stderr; it is never treated as empty.

## Sections

| Section | What it tells you | What to do |
|---|---|---|
| Files, Network line | counts of BrightScript and XML files, components, tasks, `roUrlTransfer` literals, dynamic `CreateObject`, sync and async gets, certificate calls | sanity check against what you know of the app |
| Scenes (plan column) | per Scene: `bootstrap` (own or inherited init gets wrapped), `synthesize` (no init, one is generated), `excluded`, or `skipped:<kind>` | every `skipped:` row is a Scene the state agent will not start in |
| Tasks | Task components and their function | tasks run off the render thread |
| Global fields | `m.global.addFields` keys; `<dynamic>` means a non-literal | candidates for state assertions |
| Registry sections | `roRegistrySection` names; `<dynamic>` = not a literal | `init --brownfield` proposes these as `state.registrySections` |
| setUrl sites | receiver, thread, class (`confirmed` or `unknown`), covered yes or no | `no` = those requests will not be captured |
| CreateObject sites | class and covered | `<dynamic>` classes cannot be classified |
| Not covered | file, line and reason (for example `excluded`, `dynamic CreateObject`, `render-thread sync`, `content-node URL`) | informational: where network capture has no view |
| Could not instrument | entries that fail the build under `--strict` | show the human; fix or exclude with their OK |
| Informational | entries that never fail strict, for example `excluded-candidate` in a default-excluded path | nothing to do |
| Inline CDATA Scenes | Scenes whose init lives in a CDATA script in the XML; report-only, never rewritten | the state agent is unavailable for that Scene |

A parse error list may appear when a file or component XML did not parse; treat those files as unscanned.

## Turning it into a plan

1. Count the "Could not instrument" rows. Zero means `--strict` will pass (kinds: `references/errors-and-exit-codes.md`).
2. For each row decide: accept (leave strict off), exclude the file, or change the app (only with the human's OK).
3. Check "setUrl sites" with `Covered: no`. If those matter for the flows you plan, say so.
4. Write the result as a short note: counts, the rows you accept, the excludes you propose.

`excluded-candidate` rows say a file you excluded still contains URL call sites. That is expected for vendor code,
but an exclude you add yourself trips strict (default-excluded paths do not), so excludes added in step 2 of the flow
can make the strict build in step 4 exit 4.
