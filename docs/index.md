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

features:
  - title: CI without devices
    details: The default lane runs your specs headlessly on a BrightScript simulator in Node — no Roku hardware required.
  - title: Mocking & coverage
    details: Full Rooibos assertions and mocks headless; real code coverage + LCOV headless too, no device.
  - title: Fast feedback
    details: Sub-second local runs (--no-sgnode). No more package → sideload → ECP → telnet cycle.
  - title: One spec, every lane
    details: The exact same .spec.bs runs headless and on-device — including @SGNode node suites headless.
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
