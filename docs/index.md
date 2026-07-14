---
layout: home

hero:
  name: brighttest
  text: Unified BrightScript testing
  tagline: Write a test once in Rooibos syntax. Run it headless — fast CI, coverage, even SceneGraph nodes, no device — or on a real Roku to confirm fidelity.
  actions:
    - theme: brand
      text: Quick start
      link: /guide/getting-started
    - theme: alt
      text: Writing tests guide
      link: /writing-tests/
    - theme: alt
      text: Why it exists
      link: /motivation
    - theme: alt
      text: View on GitHub
      link: https://github.com/Ramon-Lobo/brighttest

features:
  - title: CI without devices
    details: The default lane runs your specs headlessly on a BrightScript simulator in Node — no Roku hardware required.
  - title: Mocking & coverage
    details: Full Rooibos assertions and mocks headless; real code coverage + LCOV headless too, no device.
  - title: Fast feedback
    details: Sub-second local runs (--no-sgnode). No more package → sideload → ECP → telnet cycle.
  - title: One spec, every lane
    details: The exact same .spec.bs runs headless and on-device — including @SGNode node suites headless.
  - title: On-device E2E
    details: Deterministic UI tests on a real Roku — launch, drive the D-pad, type, and assert on the live SceneGraph. YAML flows, focus path-finding, screenshots &amp; video.
---

## What is brighttest?

A thin, config-driven CLI over a mature stack — **BrighterScript + Rooibos + brs-node** — for testing
**plain BrightScript** Roku projects. You write tests once in [Rooibos](https://github.com/rokucommunity/rooibos)
syntax; brighttest runs them in whichever lane you need.

```bash
npm i -D brighttest
npx brighttest                                              # headless (no device) — default
npx brighttest --coverage --lcov coverage/lcov.info        # headless + coverage (no device)
npx brighttest --device --host <roku-ip> --password <dev-pw>          # on real hardware (fidelity)
```

New to testing on Roku? Start with the **[Writing tests guide](/writing-tests/)** — it assumes no prior
experience with any of these tools.

## Two kinds of testing

- **Logic** — Rooibos unit/integration specs, run headless (fast CI, coverage) or on device. This is the
  bulk of your tests. Start at the [Writing tests guide](/writing-tests/).
- **UI journeys** — the [on-device E2E lane](/e2e/) drives a real Roku like a user (launch, D-pad, text)
  and asserts on the live screen. Additive — for the critical flows only a real device can prove.

```bash
npx brighttest e2e inspect --host <roku-ip> --app dev     # see the live screen
npx brighttest e2e run flows/ --host <roku-ip> --password <dev-pw>   # run YAML flows
```
