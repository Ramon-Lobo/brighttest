# GitHub Actions recipes

Action versions below are the ones this repo's own workflows use (`.github/workflows/test.yml`). Newer major
versions may exist; unverified. Ask the human before adding a file. Each job is separate so one can be dropped.

## Headless gate (everyday, no Roku)

```yaml
name: brighttest
on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read

jobs:
  headless:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: "22"
          cache: npm
      - run: npm ci
      - run: npx brighttest --coverage --lcov coverage/lcov.info --junit reports/junit.xml
      - if: always()
        uses: actions/upload-artifact@v7
        with:
          name: reports
          path: |
            reports/junit.xml
            coverage/lcov.info
          if-no-files-found: ignore
```

- The step fails the job on any test failure (non-zero exit). Do not add `continue-on-error`.
- `--coverage` is the headless coverage run; `--lcov` and `--junit` set the report paths (`npx brighttest --help`).
- Faster per-push gate for pure logic: `npx brighttest --no-sgnode` skips `@SGNode` suites. Run the coverage job
  on another trigger if you use it.
- Feeding LCOV to a coverage service needs that service's action and its token as a secret reference; which one
  is the human's choice. `docs/guide/ci.md` shows one example.

## Strict debug build (optional)

```yaml
  debug-build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: "22"
          cache: npm
      - run: npm ci
      - run: npx brighttest instrument build --strict --out build/debug.zip
```

Exit 0: package written. Exit 1: broken build, nothing written. Exit 4: `--strict` found something it could not
instrument (a policy failure, the build itself is valid). Strict is off by default; turn it on in CI only after the
team has read the census (`instrumenting-a-roku-app`). The debug zip is never published; do not upload it as a
release asset.

## Release gate (release-only workflow)

Keep this out of the every-push workflow: it needs the store package, which only a release build produces. Put it in
its own file that runs on a release trigger or by hand, with the build first.

```yaml
name: release
on:
  workflow_dispatch: {}

permissions:
  contents: read

jobs:
  release-gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: "22"
          cache: npm
      - run: npm ci
      # Replace with the project's own store-package build (unverified here: brighttest does not build it).
      - run: ./scripts/build-store.sh   # must write build/store.zip
      - run: npx brighttest instrument verify build/store.zip
      # publish steps come after this one
```

`instrument verify <zip|dir>` exits 0 when clean, 3 when any instrumentation marker is found (markers print to
stderr), 2 on a missing or unreadable input, so it fails on a fresh checkout without the build. Never publish when
it exits non-zero. The script name above is a placeholder: take the real command from the project.

## Local check of the shell lines

The `run:` lines above are plain commands. To try one locally before committing, run it from the project root,
for example `npx brighttest instrument verify build/store.zip; echo "exit $?"` (same in bash and zsh).

## Drift check for the skills themselves (brighttest maintainers only)

`npx brighttest skills --check` exits 1 when `skills/manifest.json` no longer matches the `skills/` tree. It is for
the brighttest repo; a normal project does not need it.
