# Adopting brighttest

This is the path from "we have a Roku app" to "tests run green on every pull request". It works for a long-lived
app you may not be allowed to edit (the `examples/legacy-app` shape) and for a new channel built with testing in
mind (the `examples/greenfield-app` shape). A person can follow it by hand, and the
[agent skills](./agent-skills.md) walk an AI coding agent through the same steps.

## 1. Assess

Start read-only. [`brighttest assess`](./assess.md) looks at the checkout, writes nothing unless you pass `--out`,
and recommends a path: `brownfield` for an existing app, `greenfield` for a new one.

```sh
npx brighttest assess .
npx brighttest assess . --out ./assessment
```

Read the blockers, the instrumentation census, and any secrets or risky patterns it reports. Decide two things
before going on: may app code be edited, and is a real device available. Neither is required. Headless runs need
no device, and instrumentation works without editing the app.

## 2. Install

```sh
npm install --save-dev brighttest
npx brighttest init                 # existing app: brighttest.json, a first spec, git-ignore entries
npx brighttest init --greenfield    # new app: also copies the BTStore and BTHttp templates
```

`init` creates `brighttest.json`; check that it matches your `bsconfig.json`. See [Quick start](./getting-started.md) for the details.

If your team uses an AI agent, install the skills too:

```sh
npx brighttest skills install
```

This detects the agents in your project, writes the skills and the always-on safety rules, and, for Claude Code,
the four subagent definitions. The optional `--with-hook` and `--with-mcp` flags are described in
[Agent skills](./agent-skills.md).

## 3. Instrument (when you need app state or flows)

Instrumentation builds a debug-only package with test hooks added, without editing your source. Run the census
first, exclude files you do not want touched, and gate releases with `instrument verify`. See
[Instrumented builds](./instrument.md). Skip this step if you only want headless unit specs at first.

## 4. First green run

Get one passing headless run before adding anything else.

```sh
npx brighttest
```

Then add characterization tests: specs that pin what the app does today, so later changes are safe. Prove each
new test can fail before you trust it. In `examples/legacy-app` the first spec targets a pure function. In
`examples/greenfield-app` the first spec is a reducer, written before the screen that uses it. Device-only
behavior (focus, playback, real network) belongs in on-device flows; see [On-device E2E](../e2e/index.md) and
[Sharing a device](./device-lease.md).

## 5. CI

Add the headless gate to your pipeline with JUnit and coverage output, then the `instrument verify` release gate.
Device jobs are opt-in and run on a self-hosted runner under the device lease. See [CI](./ci.md) and
[Device shelf (CI)](./ci-device-shelf.md).

## What "adopted" means

- `brighttest assess` reports no blockers you have not accepted.
- A headless run passes locally and in CI.
- At least one characterization test (or, for a new app, one spec-first test) has been shown to fail when the
  behavior breaks.
- Release builds pass `instrument verify`.
- Anything that needs a real device is labeled as such, not claimed from a headless run.

## Rules that always apply

- Never print or commit a device password or token.
- Go through the device lease for every command that touches a shared Roku.
- Report what you did not verify.

If something goes wrong, see [Troubleshooting](./troubleshooting.md).
