# Contributing to brighttest

Thanks for your interest in improving brighttest! This project is a community tool for testing
BrightScript / Roku apps, and contributions of all kinds are welcome — bug reports, documentation
fixes, and pull requests.

- **Repository:** <https://github.com/Ramon-Lobo/brighttest>
- **Issues:** <https://github.com/Ramon-Lobo/brighttest/issues>
- **Discussions:** <https://github.com/Ramon-Lobo/brighttest/discussions>
- **Docs:** <https://ramon-lobo.github.io/brighttest/>

By participating, you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md).

## Ways to contribute

- **Report a bug** — open an [issue](https://github.com/Ramon-Lobo/brighttest/issues/new/choose) with a
  minimal repro (the smallest `.spec.bs` and `brighttest.json` that shows the problem), the command you
  ran, the full output, your OS, and `node --version`.
- **Suggest a feature** — start a [discussion](https://github.com/Ramon-Lobo/brighttest/discussions) or
  open an issue describing the use case before writing code, so we can agree on the approach.
- **Improve the docs** — everything under `docs/` is fair game; small fixes can go straight to a PR.
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

After `npm link`, running `brighttest` (or `npx brighttest`) anywhere on your machine uses your local
checkout, so you can test changes against a real Roku project. Run `npm unlink -g brighttest` when done.

### Project layout

| Path | What lives here |
|---|---|
| `bin/cli.js` | CLI entry point — argument parsing and command dispatch |
| `lib/` | The runner: `headless.js`, `device.js`, `cross-check.js`, coverage, `reporter.js`, `config.js` |
| `skills/` | Bundled agent skills (see `docs/guide/agent-skills.md`) |
| `scripts/` | Repo tooling, e.g. `gen-skills-manifest.js` |
| `docs/` | VitePress documentation site |
| `patches/` | Patches to upstream deps that make headless SceneGraph testing faithful (see `docs/maintainers.md`) |

## Making changes

1. **Create a branch** off `main`:
   ```bash
   git checkout -b fix/short-description
   ```
2. **Make your change.** Match the style of the surrounding code — this repo is plain Node.js (CommonJS),
   no build step, no linter config; keep it simple and readable.
3. **Test it manually.** There is no self-test suite (brighttest tests *other* projects), so verify your
   change by running the CLI against a real or sample Roku project:
   ```bash
   brighttest                 # headless (default)
   brighttest --coverage      # headless + coverage + LCOV
   brighttest --cross-check --host <ip> --password <pw>   # if you have a device
   ```
   Describe in your PR exactly what you ran and what you observed.
4. **If you touched `skills/`,** regenerate the manifest:
   ```bash
   npm run skills:manifest
   ```
5. **If you touched docs,** preview them locally:
   ```bash
   npm run docs:dev      # local preview at http://localhost:5173
   npm run docs:build    # confirm the static build succeeds
   ```

## Commit & PR conventions

- **Commit messages** follow [Conventional Commits](https://www.conventionalcommits.org/):
  `type(scope): summary`, e.g. `feat(cli): add --watch flag`, `fix(headless): …`, `docs: …`,
  `coverage: …`. Keep the subject in the imperative mood and under ~72 characters.
- **Keep PRs focused** — one logical change per PR. Unrelated cleanups belong in their own PR.
- **Open against `main`** and fill in the PR description: what changed, why, and how you verified it.
- **Update the docs** in the same PR when you change behaviour, flags, or config.

### PR checklist

- [ ] Change is scoped to one thing and the branch is up to date with `main`.
- [ ] Ran the CLI against a real/sample project and confirmed the expected behaviour.
- [ ] Regenerated the skills manifest if `skills/` changed (`npm run skills:manifest`).
- [ ] `npm run docs:build` succeeds if docs changed.
- [ ] Commit messages follow Conventional Commits.
- [ ] Updated relevant docs (`README.md`, `docs/…`).

## Releasing (maintainers)

Releases are cut by maintainers: bump the version in `package.json` (semver), tag the commit, and publish
to npm. See [`docs/maintainers.md`](docs/maintainers.md) for the internals and the dependency patches.

## Questions

Not sure where to start? Open a [discussion](https://github.com/Ramon-Lobo/brighttest/discussions) — happy
to help you find a good first issue.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE) that
covers this project.
