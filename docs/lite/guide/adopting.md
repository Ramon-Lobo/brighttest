# Adopting brighttest

::: info At a glance
**What it is for:** going from "we have a Roku app" to "tests run green on every pull request".

**You will:**
- assess the app and pick a path
- install brighttest and get one green headless run
- add CI gates

**First command:** `npx brighttest assess .`
:::

Works for an app you may not edit (`examples/legacy-app`) and a new one (`examples/greenfield-app`), by hand or
with the [agent skills](/guide/agent-skills).

## 1. Assess

Start read-only: [`brighttest assess`](/guide/assess) writes nothing unless you pass `--out`.

```sh
npx brighttest assess .
npx brighttest assess . --out ./assessment
```

1. Read the blockers, instrumentation census, secrets and risky patterns.
2. Note the path: `brownfield` (existing app) or `greenfield` (new).
3. Decide: may app code be edited, and is a device available? Neither is required.

::: tip Map an existing app first
`brighttest features graph` builds the dependency graph; an agent with the `mapping-a-roku-app` skill groups it
into a `tree.json`; `brighttest features render` writes an HTML report with leaf-first and base-first test order,
headless versus device, and a CI checklist. No edits, no device. See [Map the app](/guide/feature-tree).
:::

## 2. Install

```sh
npm install --save-dev brighttest
npx brighttest init                 # existing app: brighttest.json, a first spec, git-ignore entries
npx brighttest init --brownfield    # existing app you will not edit: runs the census, writes the instrument block
npx brighttest init --greenfield    # new app: also copies the BTStore and BTHttp templates
```

- `--brownfield` and `--greenfield` cannot be combined. See `brighttest init --help` and [Instrumented builds](/guide/instrument).
- Check `brighttest.json` matches your `bsconfig.json` ([Quick start](/guide/getting-started)).
- With an AI agent, run `npx brighttest skills install`. It writes the skills (`adopting-brighttest`, the router to
  load first, plus `adopting-brighttest-brownfield` or `-greenfield`), always-on safety rules, and for Claude Code
  four subagents: `adoption-assessor`, `test-author`, `ci-integrator`, `device-debugger`. Optional `--with-hook` and
  `--with-mcp`: see [Agent skills](/guide/agent-skills).

## 3. Instrument (when you need app state or flows)

Builds a debug-only package with test hooks, without editing source. Run the census, exclude files you do not want
touched, gate releases with `instrument verify`. Skip it for headless-only specs. See
[Instrumented builds](/guide/instrument).

## 4. First green run

Get one passing headless run first: `npx brighttest`.

1. Add characterization tests that pin today's behavior (legacy-app: a pure function; greenfield-app: a reducer,
   written before its screen).
2. Prove each test can fail before trusting it.
3. Put focus, playback and real network in on-device flows ([On-device E2E](/e2e/),
   [Sharing a device](/guide/device-lease)).

## 5. CI

Add the headless gate with JUnit and coverage, then the `instrument verify` release gate. Device jobs are opt-in, on
a self-hosted runner under the device lease. See [CI](/guide/ci), [Device shelf (CI)](/guide/ci-device-shelf).

## What "adopted" means

- `brighttest assess` shows no unaccepted blockers.
- Headless passes locally and in CI.
- One characterization (or spec-first) test has been shown to fail when behavior breaks.
- Release builds pass `instrument verify`.
- Device-only behavior is labeled, not claimed from a headless run.

## Rules that always apply

::: warning
Never print or commit a device password or token. Use the device lease for every command on a shared Roku. Report
what you did not verify.
:::

## Related

- [Troubleshooting](/guide/troubleshooting): when something goes wrong

**Full guide:** [Adopting brighttest](full:/guide/adopting) — the original wording.
