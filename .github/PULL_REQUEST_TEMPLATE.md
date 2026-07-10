<!-- Thanks for contributing to brighttest! Please fill in the sections below. -->

## What & why

<!-- What does this PR change, and why? Link any related issue: e.g. "Closes #123". -->

## How was it verified?

<!-- Run `npm test`, and for behaviour changes also run the CLI against a real/sample project. -->

```
# e.g. npm test (all green) + brighttest --coverage against <project>, output below
```

## Checklist

- [ ] Change is scoped to one logical thing; branch is up to date with `main`.
- [ ] `npm test` passes, and new/changed behaviour has test coverage under `test/`.
- [ ] Ran the CLI against a real/sample project and confirmed the expected behaviour.
- [ ] Regenerated the skills manifest if `skills/` changed (`npm run skills:manifest`).
- [ ] `npm run docs:build` succeeds if docs changed.
- [ ] Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/).
- [ ] Updated relevant docs (`README.md`, `docs/…`).
