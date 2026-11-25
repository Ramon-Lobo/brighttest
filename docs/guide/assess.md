# Assess a project

`brighttest assess` looks at a Roku project and tells you how ready it is for brighttest: Node and engines, bsconfig
and manifest facts, what the instrumentation census would touch, CI, `.gitignore`, and a recommended path
(`brownfield`, `greenfield` or `not-a-roku-app`). It is read-only and offline, so it is safe to run on any checkout.

```sh
brighttest assess [<dir>] [--json] [--out <dir>] [-c <config>]
```

| Option | Meaning |
| --- | --- |
| `<dir>` | Project root (default: the current directory). |
| `--json` | Print the `brighttest-assess/v1` JSON document instead of the human summary. |
| `--out <dir>` | Also write `assess.json`, `assess.md`, `census.json` and `census.md` there. The directory is created. It is refused inside `source/` or `components/`. |
| `-c <file>` | Use this brighttest config instead of `<dir>/brighttest.json`. |

Without `--out` the command writes nothing.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | A report was produced. Findings never change the code. A directory that is not a Roku app is exit 0 with `recommendation.path: "not-a-roku-app"`. |
| 1 | Internal error. |
| 2 | Usage error, `<dir>` missing, unreadable or invalid `-c` config, or `--out` refused. |

## What it reads, and what it never does

It reads only: `manifest`, `bsconfig*.json`, `package.json`, `package-lock.json`, `brighttest*.json`, the root
`.gitignore`, CI files (`.github/workflows/*.yml`, `Jenkinsfile`, `.gitlab-ci.yml`, `azure-pipelines.yml`,
`bitbucket-pipelines.yml`), BrightScript, BrighterScript and XML sources, and the engine `package.json` files under the
project's own `node_modules`.

It skips `node_modules/`, `.git/`, `out/`, `dist/`, `build/`, `.brighttest/`, `coverage/` and `reports/`. It stops at 20,000
files and ignores any file over 2 MB; both are counted and reported as `truncated`.

It never opens `.env*`, `*.pem`, `*.p12`, `*.pkg`, `certs/` or `~/.brighttest/devices.json` (the `devices` section only
checks that the cache file exists and whether `ROKU_HOST` is set, never their values). It makes no network call, touches
no device or lease, and starts no subprocess. The census runs in process.

The census uses the existing `brighttest instrument census` code, which opens every file under `source/` and
`components/`. So assess first lists those two folders by name and size only. If it finds a sensitive file (`.env*`,
`*.pem`, `*.key`, `*.p12`, `*.pkg`, `id_rsa*`, anything under a `certs/` folder) or a file over 2 MB, it does not run the
census, never opens those files, sets `census.error` with the reason and adds a blocker. Move such files out of the app
folders to get a census.

Census errors can carry absolute paths, for example a missing-module require stack. Assess redacts them in the blocker,
the Markdown and text reports and the JSON. A path inside the project root keeps its folders relative to the root
(`<path>/components/A.brs`); any other absolute path, including anything under your home directory or a Windows
network path, becomes `<path>/<file name>`. The file name and the error message stay.

Symlinks are skipped, not followed: the file scan skips them, and the census opens files with `O_NOFOLLOW` after an `lstat`, refusing a file that changed between the two. A symlinked `manifest` inside the project root is not read (census lists it as `manifest is a symlink and was not read`, and `bs_const` is not taken from it). A FIFO, socket or device in a path census or assess would read is refused as "not a regular file", never opened. A folder named `.env*` is skipped with everything under it, in the file scan and in the census (other secret-style names such as `build.pkg` apply to files only), and assess's folder guard lists it like a `certs/` folder, so it blocks the census with a reason. `-c <file>` must be a regular file (a symlink to one is followed); a FIFO or other special file, or a file over 2 MB, gives a usage error instead of a read. The `node_modules/<engine>/package.json` read for the engine section goes through the same safe read. Only the root `.gitignore` is opened; nested ones are listed but never read. `certs/` folders are skipped in any letter case. `--out` is checked on real paths
(symlinks resolved, case-insensitive on macOS and Windows), so it cannot point into `source/` or `components/` by an
alias. When `-c` points outside the project, `brighttest.config.file` is `null`, never an absolute path. When several
`brighttest*.json` files exist, `brighttest.json` wins.

## Report sections

Host, project, bsconfig, manifest, engines, census, CI, `.gitignore`, devices, recommendation. In the JSON
(`schema: "brighttest-assess/v1"`) the top-level keys are `schema`, `cliVersion`, `root`, `host`, `project` (including
`bsconfig` and `manifestKeys`), `brighttest` (config and `engines`), `census`, `secrets`, `risky`, `scans`, `ci`,
`gitignore`, `devices`, `recommendation` (`path`, `editPermission`, `blockers`, `nextSteps`, `unknowns`) and `scan`.

- `recommendation.path`: `not-a-roku-app` without a manifest (when folders below the root hold a `manifest` plus a `source/` or
  `src/` tree, a blocker and the first next step name up to 5 of them: run assess from one, or set `rootDir`); `greenfield` with a manifest, fewer than 5 components and
  no spec files; otherwise `brownfield`.
- `recommendation.editPermission` is always `"unknown"`: only a person can say whether app code may be edited.
- `recommendation.blockers` names things brighttest does not honor: bsconfig `plugins`, `manifest.bs_const`, a bsconfig
  `rootDir` that `brighttest.json` does not repeat, and a custom `files` list (string globs or `{ src, dest }` entries).
  Census follows a bsconfig `rootDir` (direct or through `extends`) only as a hint, and only when `brighttest.json` sets
  no `rootDir`; the build uses `rootDir` from `brighttest.json` and does not read `bsconfig.json`. So a bsconfig `rootDir`
  such as `src` is a blocker to confirm with the human (set the same `rootDir` in `brighttest.json`); it clears when
  `brighttest.json` has the same `rootDir`. A `rootDir` that is absolute or contains `..` is named as outside the project
  root and never read. A `files` list that only has entries from the roku-deploy defaults (`source/**/*.*`, `components/**/*.*`, `images/**/*.*`, `locale/**/*`, `manifest`; may vary by bsc version) is not a
  blocker; it adds an unknown, "confirm". A manifest app with 0 scenes and no `rootDir` gets a `census found 0 scenes`
  blocker. A `rootDir` inherited through bsconfig `extends` raises the same blocker, and manifest discovery, the recommended path and the `dirs` follow the census's effective root. `extends` is followed only to a plain `*.json` file that is not secret-named and is under 2 MB. The sensitive-file and size guard runs on the census's effective root, and census itself never opens secret-named files, `certs/` folders or files over 2 MB.
- `scan.treeHash` is a stable hash of the scanned file list (path, size and content hash), so you can check that a run
  changed nothing.
- `scan` holds the file counts (`files`, `skippedSensitive`, `overCap`, `truncated`) and the `treeHash`. `scans` says
  whether each scan ran and how many files it looked at: `{ secrets: { ran, files, skippedLongLines }, risky: { ran, files, skippedLongLines } }`.
- `secrets` lists `{ file, line, key, kind }` and nothing else. Kinds: `assignment` (a sensitive key name such as
  token, secret, password or api key set to a literal string; placeholders like `${VAR}` and empty values are ignored),
  `bearer-literal`, `private-key` and `url-credentials` (these three have `key: null`). The value and the line text are
  never read into the report, so the JSON and Markdown are safe to paste into an issue. Key names are matched by word
  (`apiToken`, `authtoken`, `client_secret`, `passphrase`, `ROKU_PASSWORD`; not `author`, `passThrough` or `authStatus`, and a bare `pass` or `auth` is not flagged), values may contain spaces, and an XML
  field with a secret-looking `id` and a `value` (either attribute order) counts. Lines over 4,000 characters are not scanned and are counted in
  `scans.secrets.skippedLongLines` (and `scans.risky.skippedLongLines`). The scan covers BrightScript,
  BrighterScript, XML, `manifest`, `bsconfig*.json` and `brighttest*.json`.
- `risky` lists `{ kind, file, line }` for these kinds: `eval` (an `Eval(` call), `roInput-unknown-keys` (`.getInfo()` in a
  file that uses `roInput`), `render-thread-sync-http` (`GetToString`, `GetToFile`, `PostFromString` or `PostFromFile`
  outside a Task script), `task-infinite-loop` (`while true` or `while 1` in a Task script with no `wait(` call in the loop body), `logs-deeplink-params`
  (`print` or `?` of `launchArgs`, `inputData`, `contentId`, `mediaType` or a `deeplink*` name) and `large-global` (more than 20
  distinct `m.global` fields, reported once at the first). Comments and string contents are ignored. An empty list is not
  proof that the project is clean; the patterns are a short, fixed list.
- `--out <dir>` writes `assess.json`, `assess.md`, `census.json` and `census.md`. If the path is an existing file the
  command exits 2 and writes nothing. Without `--out` nothing is written.
- The 20,000-file cap is reported once: `scan.truncated` for the scan, and a single `census skipped` message when
  `source/` and `components/` alone pass the cap.

## Next

To see how the app's files, components and calls connect, run `brighttest features graph`;
see [Map the app](/guide/feature-tree). An agent can turn that graph into a feature tree and test plan with the
`mapping-a-roku-app` skill (see [Agent skills](/guide/agent-skills)).
