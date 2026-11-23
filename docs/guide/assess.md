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

Symlinks are skipped, not followed. Only the root `.gitignore` is opened; nested ones are listed but never read. `certs/` folders are skipped in any letter case. `--out` is checked on real paths
(symlinks resolved, case-insensitive on macOS and Windows), so it cannot point into `source/` or `components/` by an
alias. When `-c` points outside the project, `brighttest.config.file` is `null`, never an absolute path. When several
`brighttest*.json` files exist, `brighttest.json` wins.

## Report sections

Host, project, bsconfig, manifest, engines, census, CI, `.gitignore`, devices, recommendation. In the JSON
(`schema: "brighttest-assess/v1"`) these are `host`, `project` (including `bsconfig` and `manifestKeys`),
`brighttest` (config and `engines`), `census`, `ci`, `gitignore`, `devices`, `secrets`, `risky` and `recommendation`.

- `recommendation.path`: `not-a-roku-app` without a manifest; `greenfield` with a manifest, fewer than 5 components and
  no spec files; otherwise `brownfield`.
- `recommendation.editPermission` is always `"unknown"`: only a person can say whether app code may be edited.
- `recommendation.blockers` names things brighttest does not honor: bsconfig `plugins`, `manifest.bs_const`, a `rootDir`
  that is not used to find the manifest, and a custom `files` list (string globs or `{ src, dest }` entries). Census reads
  `source/` and `components/` in the manifest's folder. When there is no manifest at the root but `<rootDir>/manifest`
  exists, census reads there and there is no `rootDir` blocker. Otherwise a `rootDir` such as `src` is a blocker instead
  of a silent `0 scenes`. A `rootDir` that is absolute or contains `..` is named as outside the project root and never
  read. A `files` list that only has the bsc defaults (`manifest`, `source/**`, `components/**`, `images/**`) is not a
  blocker; it adds an unknown, "confirm". A manifest app with 0 scenes and no `rootDir` gets a `census found 0 scenes`
  blocker. A `rootDir` set through bsconfig `extends`, or in a bsconfig that does not parse, is not detected.
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
