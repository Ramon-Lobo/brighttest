# Motivation and decisions

::: info At a glance
**What it is for:** why brighttest is built the way it is. This is an explanation page; you do not need it to use
the tool.

**You will:**
- See the problem it solves
- Read the four main decisions in one line each
- See what was rejected

**First page to open instead, if you want to use it:** [Quick start](/guide/getting-started)
:::

## The problem

Testing Roku apps traditionally meant the official `rokudev/unit-testing-framework`.

- **Device-only:** tests were sideloaded, launched over ECP and read back over telnet (port 8085). This was slow and
  awkward in CI.
- **No mocking and no coverage.**
- **Unmaintained** since 2019.

The goal was CI without devices, mocking and coverage, and a fast loop, all for plain `.brs` code that would not
be rewritten.

## The decisions
<!-- covers: Decision 1 — Don't build a new engine -->
<!-- covers: Decision 2 — BrighterScript as the base -->
<!-- covers: Decision 3 — Rooibos as the test framework -->
<!-- covers: Decision 4 — A headless lane for the fast loop -->

Each decision builds on the previous one.

| # | Decision | Why |
|---|---|---|
| 1 | Don't build a new engine | A BrightScript runner still needs a device, and a JS engine means re-implementing an interpreter |
| 2 | Use BrighterScript as the base | It compiles plain `.brs` unchanged and has a plugin API. It is not a runtime |
| 3 | Use Rooibos as the test framework | Mocks, coverage (LCOV), `@SGNode` tests and the describe/it style |
| 4 | Add a headless lane for the fast loop | A small driver runs Rooibos suites on the `brs-node` simulator, so one spec runs in both lanes |

## The boundary we accept

There is no desktop Roku emulator, but very little is device-only.

- Coverage runs headless (`--coverage`).
- `@SGNode` node tests and their observer cascades run headless.
- Only behaviour tied to real wall-clock timing (animations, Task I/O, live remote input) is device-only. Mark those
  tests `@deviceOnly`, and use `--cross-check` to prove the fast lane matches the device.

## What we evaluated and rejected

| Option | Verdict |
|---|---|
| New BrightScript engine | Rejected: it can't escape the device |
| New JavaScript engine | Rejected: `brs-node` already exists |
| Rooibos only (device for everything) | Rejected as the default: it loses the fast loop |
| `@rokucommunity/brs` as the interpreter | Rejected: its parser can't handle the Rooibos runtime |

## Outcome

The result is a thin tool over BrighterScript, Rooibos and brs-node. It was validated end to end on a large
production codebase, with both lanes green and fidelity confirmed with `--cross-check`.

## Related

- [Architecture](/architecture): how the parts fit
- [Headless vs device](/writing-tests/headless-vs-device): what runs where

**Full guide:** [Motivation and decisions](full:/motivation). The rationale for later decisions is in
[Design decisions](full:/decisions-summary).
