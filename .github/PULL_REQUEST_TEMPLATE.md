<!--
Title: conventional and lowercase, `type(scope): short description`, e.g. `fix(headless): report a native crash as a failed run`.
Fill in each section. Delete "Behavior" or "Known differences" only when they truly do not apply.
-->

## Summary

<!-- What changed, then the before-state and what it caused in practice. Plain prose, no code walk-through.
     Link related issues: "Closes #123". -->

## Behavior

<!-- A table of the cases that change (or stay the same on purpose). Delete this section for pure refactors, docs and CI. -->

| Case | Before | Now |
| --- | --- | --- |
|  |  |  |

## Changes

<!-- Short bullets: what was done and why it matters. The reviewer can read the diff. -->

-

## Known differences

<!-- Honest limits: what still differs, what is not covered, what you chose not to do. Start each item with a bold lead-in. Delete if none. -->

-

## Test plan

<!-- Check what you ran, with exact counts and commands. Say what you did not run. -->

- [ ] New or changed tests under `test/`: <names and count>
- [ ] `npm test` passes: <files / tests>
- [ ] Ran the CLI against a real or sample project and confirmed the expected behavior: <command and result>
- [ ] `npm run skills:manifest` if `skills/`, the version, a dependency range, a CLI flag, subcommand or help text, or a lease/instrument default changed
- [ ] `npm run docs:build` succeeds, and the docs are updated if behavior, flags or config changed
- [ ] Branch is up to date with `main`, the change is one logical thing, and commits follow Conventional Commits
