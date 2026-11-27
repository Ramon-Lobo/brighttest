# Assess a project

::: info At a glance
**What it is for:** a read-only, offline readiness check of a Roku project, safe on any checkout.

**You will:**
- run `assess` and read blockers, secrets and risky patterns
- get a path: `brownfield`, `greenfield` or `not-a-roku-app`

**First command:** `npx brighttest assess .`
:::

It reports Node and engines, bsconfig and manifest facts, what the census would touch, CI and `.gitignore`.

## Run it

```sh
brighttest assess [<dir>] [--json] [--out <dir>] [-c <config>]
```

| Option | Meaning |
| --- | --- |
| `<dir>` | Project root (default: current directory). |
| `--json` | Print the `brighttest-assess/v1` JSON instead of the summary. |
| `--out <dir>` | Also write `assess.json`, `assess.md`, `census.json`, `census.md` (directory created). Refused inside `source/` or `components/`, or if the path is an existing file (exit 2, nothing written). |
| `-c <file>` | Config instead of `<dir>/brighttest.json`. |

Without `--out` nothing is written.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Report produced; findings never change it. A non-Roku dir is 0 with `recommendation.path: "not-a-roku-app"`. |
| 1 | Internal error. |
| 2 | Usage error, `<dir>` missing, unreadable or invalid `-c` config, or `--out` refused. |

## What it reads, and what it never does

No network, no device or lease, no subprocess; the census runs in process.

- **Reads:** `manifest`, `bsconfig*.json`, `package.json`, `package-lock.json`, `brighttest*.json`, root
  `.gitignore`, CI files (`.github/workflows/*.yml`, `Jenkinsfile`, `.gitlab-ci.yml`, `azure-pipelines.yml`,
  `bitbucket-pipelines.yml`), BrightScript, BrighterScript and XML sources, engine `package.json` under the
  project's `node_modules`.
- **Skips:** `node_modules/`, `.git/`, `out/`, `dist/`, `build/`, `.brighttest/`, `coverage/`, `reports/`.
- **Never opens:** `.env*`, `*.pem`, `*.p12`, `*.pkg`, `certs/`, `~/.brighttest/devices.json`. The `devices`
  section only checks the cache exists and whether `ROKU_HOST` is set, never values.
- **Caps:** stops at 20,000 files; ignores files over 2 MB. Both are reported as `truncated`.

Skipped files are named (first 10 in the summary; first 50 in `scan.skipped`, rest in `scan.skippedMore`) with a
reason (`sensitive` or `over-size-cap` plus size), next to `scan.maxBytes` and `scan.maxFiles`. Sensitive files show
the path only.

### Census guard

The census (`brighttest instrument census` code) opens every file under `source/` and `components/`, so assess lists
them by name and size first. A sensitive file (`.env*`, `*.pem`, `*.key`, `*.p12`, `*.pkg`, `id_rsa*`, anything in
`certs/`) or a file over 2 MB stops the census: those files are never opened, `census.error` gets the reason, and a
blocker is added. Move them out of the app folders to get a census.

Absolute paths in census errors (for example a require stack) are redacted everywhere: inside the root they stay
relative (`<path>/components/A.brs`); others (home directory, Windows network path) become `<path>/<file name>`.
The file name and message stay.

::: details Symlinks, special files and other safety edges
- Symlinks are skipped. The census opens files with `O_NOFOLLOW` after an `lstat` and refuses a file that changed
  between them.
- A symlinked `manifest` is not read (`manifest is a symlink and was not read`; no `bs_const` from it).
- A FIFO, socket or device is refused as "not a regular file".
- A `.env*` folder is skipped with its contents and blocks the census like `certs/`. Other secret names such as
  `build.pkg` apply to files only. `certs/` matches in any letter case.
- `-c <file>` must be a regular file (a symlink to one is followed); a special file or one over 2 MB is a usage
  error. The `node_modules/<engine>/package.json` read is equally safe.
- Only the root `.gitignore` is opened; nested ones are listed.
- `--out` is checked on real paths (symlinks resolved, case-insensitive on macOS and Windows).
- With `-c` outside the project, `brighttest.config.file` is `null`. Among several `brighttest*.json`,
  `brighttest.json` wins.
:::

## Report sections

Host, project, bsconfig, manifest, engines, census, CI, `.gitignore`, devices, recommendation. JSON
(`schema: "brighttest-assess/v1"`) top-level keys: `schema`, `cliVersion`, `root`, `host`, `project` (with
`bsconfig`, `manifestKeys`), `brighttest` (config, `engines`), `census`, `secrets`, `risky`, `scans`, `ci`,
`gitignore`, `devices`, `recommendation` (`path`, `editPermission`, `blockers`, `nextSteps`, `unknowns`), `scan`.

### Build step

`project.buildStep` (`scripts`, `placeholders`, `advise`) finds `package.json` scripts `build`, `package` or `bundle`
(with `pre`/`post` or `:suffix`) and `{{NAME}}` / `__NAME__` tokens in the manifest or tool config. With `advise`
true, a `build:` line recommends `instrument build --from <dir|zip>`
([own build step](/guide/instrument#apps-with-their-own-build-step-from)). Advisory; exit code unchanged.

### Recommendation

- `recommendation.path`: `not-a-roku-app` without a manifest; `greenfield` with a manifest, under 5 components and no
  specs; else `brownfield`. For `not-a-roku-app`, sub-folders with a `manifest` and `source/` or `src/` are named (up
  to 5) in a blocker and the first next step: run from one, or set `rootDir`.
- `recommendation.editPermission`: always `"unknown"`; only a person can say.
- `recommendation.blockers`, things brighttest does not honor:
  - bsconfig `plugins`; `manifest.bs_const`;
  - a custom `files` list (globs or `{ src, dest }`). Only roku-deploy defaults (`source/**/*.*`,
    `components/**/*.*`, `images/**/*.*`, `locale/**/*`, `manifest`; may vary by bsc version) adds an unknown,
    "confirm", not a blocker;
  - a bsconfig `rootDir` (e.g. `src`) not repeated in `brighttest.json`. The build reads `rootDir` only from
    `brighttest.json`; census uses the bsconfig one (direct or via `extends`) as a hint when `brighttest.json` sets
    none. Confirm with the human and set it; the blocker clears;
  - a manifest app with 0 scenes and no `rootDir`: `census found 0 scenes`.

::: details rootDir and extends edges
- An absolute `rootDir` or one with `..` is named as outside the root and never read.
- An inherited `rootDir` (via `extends`) raises the same blocker; manifest discovery, path and `dirs` follow the
  census's effective root, where the sensitive-file and size guard also runs.
- `extends` is followed only to a plain, non-secret-named `*.json` under 2 MB.
:::

### Scan and scans

- `scan`: `files`, `skippedSensitive`, `overCap`, `truncated`, `maxBytes`, `maxFiles`, `skipped`, `skippedMore`,
  and `scan.treeHash`, a stable hash of path, size and content hash to prove a run changed nothing.
- `scans`: `{ secrets: { ran, files, skippedLongLines }, risky: { ran, files, skippedLongLines } }`.
- The 20,000-file cap is reported once: `scan.truncated`, plus one `census skipped` message if `source/` and
  `components/` alone pass it.

### Secrets

`secrets` lists only `{ file, line, key, kind }`; values and line text are never read, so it is safe to paste.

| Kind | Matches |
| --- | --- |
| `assignment` | sensitive key (token, secret, password, api key) set to a literal; `${VAR}` and empty values ignored |
| `bearer-literal`, `private-key`, `url-credentials` | `key: null` |

- Keys match by word: `apiToken`, `authtoken`, `client_secret`, `passphrase`, `ROKU_PASSWORD` yes; `author`,
  `passThrough`, `authStatus`, bare `pass`/`auth` no.
- Values may contain spaces; an XML field with a secret-like `id` and a `value` (any order) counts.
- Lines over 4,000 characters are skipped, counted in `scans.secrets.skippedLongLines` / `scans.risky.skippedLongLines`.
- Covers BrightScript, BrighterScript, XML, `manifest`, `bsconfig*.json`, `brighttest*.json`.

### Risky patterns

`risky` lists `{ kind, file, line }`, ignoring comments and strings.

| Kind | Matches |
| --- | --- |
| `eval` | `Eval(` call |
| `roInput-unknown-keys` | `.getInfo()` in a file using `roInput` |
| `render-thread-sync-http` | `GetToString`, `GetToFile`, `PostFromString`, `PostFromFile` outside a Task |
| `task-infinite-loop` | `while true` / `while 1` in a Task with no `wait(` in the loop |
| `logs-deeplink-params` | `print`/`?` of `launchArgs`, `inputData`, `contentId`, `mediaType`, `deeplink*` |
| `large-global` | over 20 distinct `m.global` fields, reported once |

::: warning
An empty list is not proof of a clean project; the patterns are a short, fixed list.
:::

## Task counts

- `census.tasks`: every Task, including inherited (`extends="MyBaseTask"`); listed in `census.md`'s Tasks table.
- `census.directTasks`: only `extends="Task"`; `census.json` calls it `counts.tasks`.

The summary prints both, e.g. `96 tasks (19 extend Task directly)`.

## Next

Run `brighttest features graph` ([Map the app](/guide/feature-tree)); an agent can build a feature tree and test
plan with the `mapping-a-roku-app` skill ([Agent skills](/guide/agent-skills)).

## Related

- [Adopting brighttest](/guide/adopting): where assess fits

**Full guide:** [Assess a project](full:/guide/assess) — the original wording.
