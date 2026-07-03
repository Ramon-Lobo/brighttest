# Motivation & decisions

Why roku-test is shaped the way it is — the problem, the options we weighed, and the decisions we made.
If you just want to use it, jump to the [Quick start](/guide/getting-started).

## The problem

Testing a Roku channel traditionally means the official `rokudev/unit-testing-framework`:

- **Device-only.** Tests are packaged into the channel, sideloaded, launched over ECP, and results read
  back over telnet (port 8085). Slow, and awkward in CI.
- **No mocking, no coverage.** You assert against real Roku objects — integration-style, not isolated units.
- **Unmaintained.** Frozen since 2019.

We wanted three things — **CI without physical devices**, **mocking & code coverage**, and a **fast
feedback loop** — for a **plain BrightScript (`.brs`)** codebase we did not want to rewrite.

## Decision 1 — Don't build a new engine

A from-scratch engine is the obvious temptation and the wrong move:

- A **BrightScript-based** runner still executes on a Roku, so it can't remove the device dependency.
- A **JavaScript-based** engine means re-implementing a BrightScript interpreter — a huge, low-ROI effort.

Both roads reinvent mature, maintained tools. So we compose those instead.

## Decision 2 — BrighterScript as the base

[BrighterScript](https://github.com/rokucommunity/brighterscript) (`bsc`) is a compiler / transpiler /
plugin host that **works on plain `.brs` unchanged** (the language is a superset). It gives us static
validation, a build/deploy pipeline (`roku-deploy`), and — crucially — a **plugin API** other tools build
on. It is **not** a runtime; it does not execute code.

## Decision 3 — Rooibos as the test framework

[Rooibos](https://github.com/rokucommunity/rooibos) is a maintained rewrite of the official framework,
shipped as a BrighterScript plugin. It provides mocking/stubbing/spies, **code coverage (LCOV)**,
`@SGNode` node-test scaffolding, and a `describe/it` authoring style. We standardize on **Rooibos syntax**
as the single way to write tests.

## Decision 4 — A headless lane for the fast loop

Rooibos's own runner is **SceneGraph-scene based**, so out of the box it only runs on a device (its CLI
requires `--host`/`--password`). To get device-free runs we add a small **headless driver** that reuses
Rooibos's *own* compiled assertions but replaces the scene runner, executing suites on the
[`brs-node`](https://github.com/lvcabral/brs-engine) BrightScript simulator. Result: **one spec file runs
both lanes.** (See [Architecture](/architecture).)

## The boundary we accept

There is **no desktop Roku emulator** — Roku testing runs on real hardware or a simulator. Two limits
follow, and they are inherent to the platform, not to roku-test:

- **Code coverage requires a real device.** Coverage is tallied at runtime by an on-device SceneGraph
  collector; the simulator can't run it. (roku-test still writes the LCOV file *from* the device run.)
- **SceneGraph-bound tests (`@SGNode`, node observers) are device-only.** Keep business logic in pure
  functions and it stays in the fast headless lane.

## What we evaluated and rejected

| Option | Verdict |
|---|---|
| New BrightScript engine | Rejected — can't escape the device; Rooibos already is the maintained rewrite. |
| New JavaScript engine | Rejected — re-implements an interpreter that already exists (`brs-node`). |
| Rooibos-only (device for everything) | Rejected as default — loses the fast, device-free loop. |
| `@rokucommunity/brs` as the headless interpreter | Rejected — its parser can't handle the Rooibos runtime. See [Troubleshooting](/guide/troubleshooting). |

## Outcome

A thin tool over a mature stack: **BrighterScript + Rooibos + brs-node**, with a headless driver that
unifies authoring. It was validated end-to-end against a real production BrightScript codebase — both
lanes green on the same specs, coverage + LCOV produced on real hardware.
