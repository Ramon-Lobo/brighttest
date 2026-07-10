# Contributing

Thanks for your interest in improving brighttest! This is a community tool for testing BrightScript / Roku
apps, and contributions of all kinds are welcome — bug reports, documentation fixes, and pull requests.

- **Repository:** <https://github.com/Ramon-Lobo/brighttest>
- **Issues:** <https://github.com/Ramon-Lobo/brighttest/issues>
- **Discussions:** <https://github.com/Ramon-Lobo/brighttest/discussions>

The canonical, always-current version of this guide lives in
[`CONTRIBUTING.md`](https://github.com/Ramon-Lobo/brighttest/blob/main/CONTRIBUTING.md) at the repo root
(that's the copy GitHub surfaces when you open an issue or PR).

## Ways to contribute

- **Report a bug** — open an [issue](https://github.com/Ramon-Lobo/brighttest/issues/new/choose) with a
  minimal repro (the smallest `.spec.bs` and `brighttest.json` that shows the problem), the command you
  ran, the full output, your OS, and `node --version`.
- **Suggest a feature** — start a [discussion](https://github.com/Ramon-Lobo/brighttest/discussions) or
  open an issue describing the use case before writing code.
- **Improve the docs** — everything under `docs/` is fair game. Every page also has an
  **Edit this page on GitHub** link at the bottom.
- **Fix a bug or build a feature** — see the workflow below.

## Development setup

You need **Node.js 18+** and **git**.

```bash
# 1. Fork the repo on GitHub, then clone your fork
git clone https://github.com/<your-username>/brighttest.git
cd brighttest

# 2. Install dependencies
npm install

# 3. Link the CLI globally so `brighttest` runs your working copy
npm link
```

After `npm link`, running `brighttest` anywhere uses your local checkout, so you can test changes against a
real Roku project. Run `npm unlink -g brighttest` when you're done.

### Project layout

| Path | What lives here |
|---|---|
| `bin/cli.js` | CLI entry point — argument parsing and command dispatch |
| `lib/` | The runner: `headless.js`, `device.js`, `cross-check.js`, coverage, `reporter.js`, `config.js` |
| `skills/` | Bundled agent skills (see [Agent skills](/guide/agent-skills)) |
| `scripts/` | Repo tooling, e.g. `gen-skills-manifest.js` |
| `docs/` | This VitePress documentation site |
| `patches/` | Patches to upstream deps for faithful headless SceneGraph testing (see [Maintainers](/maintainers)) |

## Making changes

1. **Branch off `main`:** `git checkout -b fix/short-description`
2. **Match the surrounding style** — plain Node.js (CommonJS), no build step, no linter; keep it simple.
3. **Run the unit suite** ([Vitest](https://vitest.dev), covers config, LCOV parsing, the reporter, and
   CLI args). CI runs it on Node 18, 20, and 22:
   ```bash
   npm test           # run once
   npm run test:watch # while developing
   ```
   Add or update tests under `test/` for behaviour you change.
4. **Also verify end to end** by running the CLI against a real or sample Roku project and note what you
   ran in your PR:
   ```bash
   brighttest                 # headless (default)
   brighttest --coverage      # headless + coverage + LCOV
   ```
5. **If you touched `skills/`,** run `npm run skills:manifest`.
6. **If you touched docs,** run `npm run docs:dev` to preview and `npm run docs:build` to confirm the build.

## Commit & PR conventions

- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/):
  `type(scope): summary`, e.g. `feat(cli): add --watch flag`, `fix(headless): …`, `docs: …`.
- Keep PRs focused — one logical change each — and open them against `main`.
- Update the docs in the same PR when you change behaviour, flags, or config.

See the full [PR checklist](https://github.com/Ramon-Lobo/brighttest/blob/main/CONTRIBUTING.md#pr-checklist)
in the root guide.

## License

By contributing, you agree that your contributions will be licensed under the project's
[MIT License](https://github.com/Ramon-Lobo/brighttest/blob/main/LICENSE).
