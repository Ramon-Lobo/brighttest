# Architecture

brighttest is a thin orchestration layer over three mature tools. You write Rooibos specs once; the tool
runs them headless (no device) or on a real Roku — and can diff the two to prove the fast lane is faithful.

```mermaid
flowchart TD
  spec["Your .spec.bs<br/>(Rooibos syntax)"] --> bsc["BrighterScript (bsc)<br/>+ rooibos-roku plugin<br/>transpile · inject runtime · instrument"]
  bsc -->|default<br/>SceneGraph off| hl["lightweight driver<br/>on brs-node simulator"]
  bsc -->|--coverage<br/>SceneGraph on| cov["stock Rooibos scene runner<br/>on brs-node simulator"]
  bsc -->|--device| dev["stock Rooibos CLI<br/>deploy → run on real Roku"]
  hl --> hlout["PASS/FAIL · JUnit · exit code<br/>(no device)"]
  cov --> covout["+ @SGNode suites · LCOV coverage<br/>(no device)"]
  dev --> devout["results + coverage + LCOV<br/>(real hardware · fidelity reference)"]

  classDef lane fill:#eef,stroke:#88a;
  class hl,cov,dev lane;
```

`--cross-check` runs the headless and device lanes and diffs every test, so the fast lane can be trusted.

## Components

| Component | Role | Runtime? |
|---|---|---|
| **BrighterScript (`bsc`)** | Compiles/transpiles plain `.brs` + `.bs`; hosts the Rooibos plugin; builds/deploys. | No (compiler) |
| **rooibos-roku** (bsc plugin) | Turns `@suite/@it/@params` specs into runnable suites; injects the runtime + coverage instrumentation. | No (build-time) |
| **brs-node** (`brs-cli`) | BrightScript **and SceneGraph** simulator that runs `.brs` headlessly in Node. Broad component set incl. crypto, and a SceneGraph engine so `@SGNode` suites run without a device. | Yes (headless) |
| **brighttest** | The CLI/orchestrator: generates configs, builds, runs the right lane, parses results, writes JUnit/LCOV. | — |

## The lanes

### Headless — default (fast loop)

```mermaid
sequenceDiagram
  participant U as npx brighttest
  participant B as bsc + rooibos plugin
  participant D as headless_runner.brs
  participant S as brs-node simulator
  U->>B: build (SceneGraph off)
  B-->>U: compiled suites + Rooibos runtime
  U->>S: run source/*.brs + driver (brs-cli -n)
  S->>D: execute driver Main
  D->>D: for each suite → group → test: run, read m.currentResult
  D-->>U: PASS/FAIL lines + __RESULT__
  U-->>U: parse → JUnit + exit code
```

1. `bsc` builds with the Rooibos plugin, **SceneGraph off** — the fastest configuration.
2. A bundled driver (`brs/headless_runner.brs`) asks Rooibos's generated `RuntimeConfig` for the suite
   map, instantiates each suite, walks its `groupsData → testCases`, invokes each test method (handling
   `@params`), and reads the pass/fail state — reusing **Rooibos's own assertions**.
3. Runs on **brs-node** (`brs-cli -n`). brighttest parses `PASS`/`FAIL`/`__RESULT__` lines, writes optional
   JUnit, and sets a CI exit code. With a project that has `@SGNode` specs, the default lane boots a scene
   to run them too (pass `--no-sgnode` to skip that and stay on the pure SceneGraph-off driver).

### Headless coverage — `--coverage` (no device)

1. `bsc` builds with the Rooibos plugin and **coverage instrumentation + SceneGraph on**.
2. brighttest runs the **stock Rooibos scene runner on the brs-node simulator**. Because the simulator has
   a SceneGraph engine, this runs `@SGNode` node suites and their `onChange` observer cascades in full,
   and the coverage collector's field observers work — yielding **real LCOV with no device**.
3. brighttest scrapes the printed coverage blocks (ANSI-stripped) and writes `lcov.info`.

### Device — `--device` (the reference)

1. `bsc` builds with the Rooibos plugin and coverage on.
2. brighttest hands off to the **stock Rooibos CLI**, which deploys to the Roku and runs the scene-based
   runner on hardware. Results + coverage come back over the network; `--lcov` writes `lcov.info` locally.
3. The device lane is the fidelity reference — it runs everything, including behavior tied to real
   wall-clock timing that the simulator only approximates.

### Cross-check — `--cross-check`

Builds once, runs both the headless and device lanes, matches tests by name, and reports `agree` /
`device-only` / `DIVERGENT`. A run fails on any divergence, so the headless lane stays a trustworthy proxy.

## Why one spec works in every lane

A Rooibos suite compiles to a plain object: test methods plus a metadata structure
(`testGroups → testCases`, each with `funcName`, `name`, `rawParams`). Assertions set
`m.currentResult.isFail`. The scene-based runner is just *one* way to drive that object; the headless
driver is another. Same compiled suite, same assertions — only the driver and the run target differ.

## What runs where

```mermaid
flowchart LR
  t{"What does the test touch?"}
  t -->|Pure logic / strings / arrays / math| both["Headless ✅ and Device ✅"]
  t -->|Common components<br/>roByteArray, base64, roRegex, dates| both
  t -->|Crypto<br/>roEVPDigest, roHMAC| both
  t -->|Code coverage / LCOV| both
  t -->|SceneGraph nodes<br/>@SGNode, fields, onChange| both
  t -->|Real wall-clock timing<br/>animations, Task I/O, live input| dev["Device only<br/>(mark @deviceOnly)"]
```

Design guideline: keep business logic in pure functions so most tests are trivially headless; the few
tests that genuinely need real hardware timing get marked `@deviceOnly` and skipped on the fast lanes.
More in [Headless vs device](/writing-tests/headless-vs-device).

## Beyond the test lanes: instrument, hub and assess

Three parts sit beside the test lanes. They read the same `brighttest.json`; instrument and the hub also use the bsc build and the device lease.

- **Instrument** (`brighttest instrument build|verify|census`, `lib/instrument/`). A bsc plugin rewrites a **staged copy** of
  the app (Scene `init` bootstrap, `setUrl` / `getUrl` routing, an optional state agent) and the build writes a
  debug-only package. `instrument verify` is the release gate that finds the markers; `census` is a static scan that
  changes nothing. See [Instrumented builds](/guide/instrument).
- **Hub and proxy** (`lib/instrument/hub.js`, `net-proxy.js`). On the headless lanes an in-process proxy answers the app's
  `roUrlTransfer` traffic from mock rules and fixtures (`BTNet_*`, `instrument.net.fixtures`, `--net-record`,
  `--net-unmatched`) and injects faults ([fault model](/guide/net-faults)). For a real device the same proxy sits behind a LAN
  hub that `e2e run` (and the MCP net tools) start only while the device lease is held; it answers only the leased device and
  needs the build's hub token. `brighttest doctor` can prove the device reaches it.
- **Assess and init** (`lib/assess.js`, `lib/init.js`). `brighttest assess` is a read-only, offline report that picks a path
  (`brownfield`, `greenfield` or `not-a-roku-app`); `init --brownfield` and `init --greenfield` set the project up for it. See
  [Assess a project](/guide/assess).

None of these are needed for the default `brighttest` run, which is unchanged unless you opt in.
