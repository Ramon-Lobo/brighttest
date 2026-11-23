# Testability rules

Evidence: rules marked "enforced" were checked in `node bin/cli.js` on a scratch copy of
`examples/greenfield-skeleton`; rules marked "convention" are advice from `docs/e2e/authoring.md` and
`examples/greenfield-app`, with no tool that checks them. Not device-verified.

| # | Rule | Why | Status |
|---|---|---|---|
| 1 | Put logic in plain functions under `source/`, not in node handlers | a plain function runs headless in milliseconds; a handler needs a node suite or a device | convention |
| 2 | Specs live under `source/` and end in `.spec.bs` | `testsFilePattern` is `**/*.spec.bs` and only compiled paths run | enforced: pattern from `init`'s `brighttest.json` |
| 3 | Reducers return a new state and take `(state, action)` | `BTStore_create` calls every reducer with every action, and stores the return value | enforced by the template code |
| 4 | Every node a flow touches has an `id` | the only stable selector is the node `id` (flows use `id`, not `testId`); without it you fall back to `text` or `subtype`, which break on copy changes | convention; `e2e lint` does not check ids against your XML, and exits 0 on warnings (read the count) |
| 5 | Give ids by hand to what you assert; `e2e stamp` is for apps you cannot edit | hand-picked ids win and survive refactors | convention (`docs/e2e/authoring.md`) |
| 6 | Keep Tasks thin: one request or write, result through fields | the rule is in a function the spec tests | convention |
| 7 | Tasks that change store state set `m.global.btAction` | `BTStore_dispatch` from a Task thread returns `{}` | enforced by the template code (header comment) |
| 8 | Send requests through `BTHttp_transfer` or `BTHttp_getJson` | one place to add routing or mocking later | convention; the template does not reroute today |
| 9 | Do not put secrets, real tokens or real hosts in source or fixtures | specs and flows are committed | convention, plus the hard rules in `adopting-brighttest` |
| 10 | Seed state in the spec (`initial`), do not read it from the registry | a spec must not depend on a previous run | convention |
| 11 | Compare numbers with matching types in `assertEqual` (`1.5` vs `3.0`) | it is type-strict on numbers | enforced: see the second test in `Example.spec.bs` |

## Order of work for each feature

1. Failing spec for the logic (headless): `npx brighttest --junit results.xml`.
2. Make it pass. Read the pass count.
3. Add the node, its `id`, the observer, the thin Task.
4. If a screen behavior matters, one flow, then `npx brighttest e2e lint <flow>`.
5. Run the flow only through the device lease (`references/needs-a-device.md`).

## What not to do without the human's OK

- Do not change the manifest beyond what `init --greenfield` does, rename the app, or add a dependency.
- Do not edit someone else's existing app to make it fit these rules: use the existing-app path.
