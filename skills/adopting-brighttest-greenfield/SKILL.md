---
name: adopting-brighttest-greenfield
description: Use when starting a new Roku channel that should be testable from day one. Covers `init --greenfield` and exactly what it writes, the BTStore and BTHttp templates and their current limits, ids on nodes, thin Tasks, the spec-first loop (a reducer spec in the headless lane first, then a flow), and when a feature needs a real device and the lease.
triggers: new roku app; greenfield roku app; init --greenfield; testable app architecture; btstore; bthttp; start a roku channel with tests
when-not-to-use: Do not use for an app that already has code and no tests (use adopting-brighttest, then init without --greenfield), for installing the package (use setting-up-brighttest), or for the syntax of specs and flows (use writing-rooibos-tests, writing-e2e-flows). It does not teach the device lease (use using-a-roku-device-safely).
license: MIT
metadata:
  source: brighttest
---

# Starting a new Roku app with brighttest

Load `adopting-brighttest` first if you have not: it decides the path and holds the hard rules. This skill is the
new-app path: what to run, what the tool writes, the app shape that keeps tests cheap, and the first test.

Evidence: every command and file below was run on a copy of `examples/greenfield-skeleton` in a scratch folder
with `node bin/cli.js` at this version: `init --greenfield`, a reducer spec through `BTStore_create` (3 passed,
headless), `e2e lint` (exit 0 on a valid flow, exit 1 on a bad one). Recipes checked in bash and zsh. Not
device-verified. Anything marked "unverified" was not run.

## Step 0: confirm it is a new app

Greenfield means a manifest and next to no code, or no manifest yet. If the folder has an existing app, stop:
`init --greenfield` edits `manifest` and writes into `source/`. Ask the human, or use the existing-app path
(`npx brighttest init`). Do not edit an existing app's files without the human's OK.

A new app needs only a `manifest`, `source/main.brs` and one Scene (see `examples/greenfield-skeleton`).
Check with `npx brighttest assess . --json` (read-only): `recommendation.path` is `greenfield`.

## Step 1: scaffold

```bash
npx brighttest init --greenfield
git check-ignore -q .env || printf '.env\n' >> .gitignore
```

What `init --greenfield` writes (checked on the skeleton): `brighttest.json`, `source/tests/Example.spec.bs`,
`.gitignore` (+`.brighttest/`, `coverage/`, `reports/`), `source/brighttest/BTStore.brs`,
`source/brighttest/BTHttp.brs`, and `bs_const=BT_AGENT=false` in `manifest`. It adds an npm `test` script only if
a `package.json` exists. It never adds `.env` to `.gitignore`: the second line does, before any password exists.
Re-running keeps existing files; `--force` refreshes only the two templates. After it, `assess` reports
`brownfield` (a spec exists now): that is expected, not an error.

It does not add the script tags. Add them to each Scene or Task component that uses the templates:
`<script type="text/brightscript" uri="pkg:/source/brighttest/BTStore.brs" />` (and `BTHttp.brs` the same way).

## Step 2: first green run before any feature

```bash
npx brighttest --junit results.xml
```

Expect `3` or fewer passes from `Example.spec.bs` and exit 0. Read the count: zero tests is not green.

## Step 3: the first feature, spec first

1. Write the logic as a plain function in `source/` (a reducer is the model: `fn(state, action) as object`).
2. Write the spec in `source/tests/*.spec.bs` and watch it run headless (`writing-rooibos-tests`). A spec can
   call `BTStore_create(reducers, initial)`, then `store.dispatch({ type: "..." })` and read `store.state`.
3. Only then build the screen: set an `id` on every node a flow will assert or focus, keep Tasks thin.
4. Write one flow for what needs a screen (`writing-e2e-flows`), then `npx brighttest e2e lint <flow>`.
   Lint checks selector syntax only; it does not check that the id exists in your XML.

## The templates, honestly

BTStore and BTHttp are small starting conventions, not a framework. Their current limits are in the header of
each file and in `docs/guide/instrument.md`: no state-action events, no `dispatch` or `restore` ops, no
time-travel or replay of effects, `BTStore_dispatch` from a Task thread returns `{}` (Tasks set
`m.global.btAction`), and `BTHttp_url` returns its input unchanged. Do not promise any of those to the human.
See `references/app-architecture.md`.

## When a feature needs a device

Headless covers logic and `@SGNode` observers. A real Roku is for flows, focus on the real remote, timing,
and anything you must claim "works on device". See `references/needs-a-device.md`. Before any device command
load `using-a-roku-device-safely`. Never write a device password into a file, command or report.

## References

- `references/app-architecture.md`: layout, store, HTTP, Tasks, seams, what the skeleton shows.
- `references/testability-rules.md`: the rules, why each one, and which are convention vs enforced.
- `references/needs-a-device.md`: headless or device, per feature kind, and the lease pointer.
