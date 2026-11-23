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

Symlinks are skipped, not followed. Only the root `.gitignore` is read, not nested ones. `--out` is checked on real paths
(symlinks resolved, case-insensitive on macOS and Windows), so it cannot point into `source/` or `components/` by an
alias. When `-c` points outside the project, `brighttest.config.file` is `null`, never an absolute path. When several
`brighttest*.json` files exist, `brighttest.json` wins.

## Report sections

Host, project, bsconfig, manifest, engines, census, CI, `.gitignore`, devices, recommendation. In the JSON
(`schema: "brighttest-assess/v1"`) these are `host`, `project` (including `bsconfig` and `manifestKeys`),
`brighttest` (config and `engines`), `census`, `ci`, `gitignore`, `devices` and `recommendation`.

- `recommendation.path`: `not-a-roku-app` without a manifest; `greenfield` with a manifest, fewer than 5 components and
  no spec files; otherwise `brownfield`.
- `recommendation.editPermission` is always `"unknown"`: only a person can say whether app code may be edited.
- `recommendation.blockers` names things brighttest does not honor, such as bsconfig `plugins`.
- `scan.treeHash` is a stable hash of the scanned file list (path, size and content hash), so you can check that a run
  changed nothing.
- `scan` holds the file counts (`files`, `skippedSensitive`, `overCap`, `truncated`) and the `treeHash`; `scans` says which
  scans did not run.
- `secrets` and `risky` are always empty in this version and `scans` says `not-run`: the secret and risky-pattern scans
  arrive in a later release. An empty list here does not mean the project is clean.
