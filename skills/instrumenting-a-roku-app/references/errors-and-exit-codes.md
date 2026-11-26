# Errors and exit codes

Evidence: `node bin/cli.js instrument --help`, `lib/instrument/{build,verify,sideload,plugin}.js`, `docs/guide/instrument.md`,
and runs on `examples/legacy-app` (build 0, strict 4, verify 3 on the debug zip, 0 on a plain package, 2 on a missing
zip and on an unknown option). Not device-verified.

## Exit codes

| Command | Code | Meaning | Next step |
|---|---|---|---|
| `instrument build` | 0 | package written | `instrument verify` on it must exit 3 |
| `instrument build` | 1 | build failure: bsc or plugin error, `BT9003 staged-output-invalid`; with `--sideload` also auth, port 80 closed, installer failure; or `--net` with `BRIGHTTEST_HUB_TOKEN` unset or not 32 hex | read stderr, one line per blocking item |
| any `instrument` action | 2 | usage error: unknown action or option, `verify` without a path or with a missing or unreadable one, a census failure | fix the command |
| `instrument verify` | 3 | instrumentation markers found: do not release this package | rebuild the store package without `instrument build` |
| `instrument build` | 4 | strict mode: valid build, but something could not be instrumented | read the `strict:` lines |
| `instrument verify` | 0 | clean | proceed to the size check |
| `--sideload` | 75 | lease busy or wait timeout | wait or ask who holds it (`using-a-roku-device-safely`) |
| `--sideload` | 77 | lease lost | stop; re-acquire |
| `--sideload` | 78 | lease directory unusable | report to the human |

A failed build writes nothing new at `--out`; an older file there is kept, so check the exit code, not the file.
`--sideload` needs `--host <device-ip>` (never guessed) and `ROKU_PASSWORD`; without them it exits 2.

## Build errors (BT9001 to BT9005)

| Code | Message name | Fix |
|---|---|---|
| `BT9001` | a function uses a name reserved for the injected runtime (the runtime names are listed in `lib/instrument/plugin.js`, for example `BT_op`) | rename the function or exclude the file; either edits the app or its config, so ask the human |
| `BT9002` | plugin order is wrong: the Rooibos plugin must come before the instrument plugin | the help says `instrument build` builds the app only (no Rooibos), so you should not meet it; if you do, report it (not reproduced here) |
| `BT9003` | `staged-output-invalid <file>:<line> (bsc <code>, <kind>)`: a rewritten file no longer parses; also used for an unsupported brighterscript version | exclude that file (with the human's OK) and report the file, line and bsc code upstream |
| `BT9004` | plugin reused for a second Program | a plugin bug or custom wiring: one build needs one fresh Program. Report it |
| `BT9005` | `net-config-invalid`: bad `instrument.net` value | fix the `instrument.net` block in `brighttest.json` (see `docs/guide/instrument.md`) |

Stderr ends with `instrument build failed: N error(s), no package written`. Plain bsc errors are the app's own
compile errors: they exit 1 too. Report them; do not fix app code without the human's OK.

## Strict failures (exit 4)

stderr lines look like `strict: <kind> <file>:<line> <reason>`. Kinds that fail strict (from `docs/guide/instrument.md`):
`excluded-candidate` in a file the user excluded, `empty-init`, `inline-cdata-scene`, `unknown-scene-subtype`,
`init-in-excluded-file`, `init-shared-with-excluded-scene`, `indexed-seturl`, `indexed-geturl`, `bare-geturl`,
`xml-parse-failed`, `net-receiver-unknown`, `wrap-target-unknown`, and any kind not listed (fail closed).
Informational (never fail strict): `rewritten-shared-with-excluded`, `net-receiver-excluded`, `callfunc-seturl`,
`net-render-thread` (a hand-written `BT_url(` call on the render thread: identity on device, URL unchanged; wrap it in a Task),
and `excluded-candidate` in a default-excluded path. `--verbose` lists the informational entries of a successful build.

## Verify markers

`verify` prints `INSTRUMENTED: N marker(s)` and one line per marker: `runtime-file`, `string`, `component-xml`,
`bs-const` (`BT_AGENT=true`), `manifest-key` (`bt_instrumented`). `BT_AGENT=false` and the greenfield libraries are
not markers (`docs/guide/instrument.md`). Any marker means exit 3.
