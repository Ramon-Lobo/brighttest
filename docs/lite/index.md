# brighttest

::: info At a glance
**What it is for:** brighttest tests plain BrightScript Roku projects. You write a test once in Rooibos syntax, and
run it headless (fast, in CI, with coverage and even SceneGraph nodes, no device) or on a real Roku to confirm
fidelity.

**You will:**
- Install it and run your first headless test
- Choose between logic tests and UI journeys
- Find the guide for your situation: a new app, an existing app, CI, or AI agents

**First command:** `npm i -D brighttest`
:::

## What is brighttest?

It is a thin, config-driven CLI over **BrighterScript + Rooibos + brs-node**.

::: code-group
```sh [Headless (default)]
npm i -D brighttest
npx brighttest                                        # no device
```
```sh [Headless + coverage]
npx brighttest --coverage --lcov coverage/lcov.info   # no device
```
```sh [On a real Roku]
npx brighttest --device --host <roku-ip> --password <dev-pw>
```
:::

## What you get

Each feature in one line, with where to read more.

| Feature | What it gives you | Read |
|---|---|---|
| CI without devices | The default lane runs specs on a BrightScript simulator in Node | [Quick start](/guide/getting-started) |
| Mocking and coverage | Full Rooibos assertions and mocks, plus real coverage and LCOV, headless | [Writing tests](/writing-tests/) |
| Fast feedback | Sub-second local runs (`--no-sgnode`), with no package, sideload, ECP or telnet cycle | [Headless vs device](/writing-tests/headless-vs-device) |
| One spec, every lane | The same `.spec.bs` runs headless and on the device, including `@SGNode` suites | [Headless vs device](/writing-tests/headless-vs-device) |
| On-device E2E | YAML flows that launch, drive the D-pad, type and assert on the live SceneGraph, with focus path-finding, screenshots and video | [E2E](/e2e/) |
| Studio | A local web app for a device: live SceneGraph, remote, flow authoring with a step trace, app state and profiling | [Studio](/guide/studio) |
| Instrumented builds | A debug-only package built without editing your source, for app-state flows and network fixtures, with a release gate | [Instrumented builds](/guide/instrument) |
| Shared devices | A per-device lease, so terminals, worktrees, agents and CI jobs queue for a Roku instead of colliding | [Sharing a device](/guide/device-lease) |
| Built for AI agents | An assessment command, agent skills with safety rules, and an MCP server | [Agent skills](/guide/agent-skills), [MCP](/guide/mcp) |

## Where to start

Pick the row that matches you.

| You are | Start with |
|---|---|
| New to testing on Roku | [Writing tests guide](/writing-tests/). It assumes no prior experience. |
| Adding brighttest to an existing app, or starting a new one | [Adopting brighttest](/guide/adopting) |
| Using AI coding agents | [Agent skills](/guide/agent-skills) and the [MCP server](/guide/mcp) |
| Curious why it exists | [Motivation](/motivation) |

## Two kinds of testing

You will usually do both, in this proportion.

1. **Logic:** Rooibos unit and integration specs, run headless (fast CI, coverage) or on a device. Most of your tests
   are these. Start at the [Writing tests guide](/writing-tests/).
2. **UI journeys:** the [on-device E2E lane](/e2e/) drives a real Roku like a user and asserts on the live screen.
   It is additive, for the critical flows only a real device can prove.

```sh
npx brighttest e2e inspect --host <roku-ip> --app dev                 # see the live screen
npx brighttest e2e run flows/ --host <roku-ip> --password <dev-pw>    # run YAML flows
```

## Related

- [Command cheat sheet](/cheat-sheet)
- [CLI reference](/guide/cli-reference)
- The source is on GitHub: [Ramon-Lobo/brighttest](https://github.com/Ramon-Lobo/brighttest)

**Full guide:** [Overview](full:/)
