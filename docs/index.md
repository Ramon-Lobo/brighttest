---
layout: home

hero:
  name: roku-test
  text: Unified BrightScript testing
  tagline: Write a test once in Rooibos syntax. Run it headless for fast CI, or on a real Roku for coverage.
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
    details: Full Rooibos assertions and mocks headless; real code coverage (and LCOV) when you run on a device.
  - title: Fast feedback
    details: Sub-second local runs. No more package → sideload → ECP → telnet cycle.
  - title: One spec, two lanes
    details: The exact same .spec.bs runs headless and on-device. Only SceneGraph node tests are device-only.
---

## What is roku-test?

A thin, config-driven CLI over a mature stack — **BrighterScript + Rooibos + brs-node** — for testing
**plain BrightScript** Roku projects. You write tests once in [Rooibos](https://github.com/rokucommunity/rooibos)
syntax; roku-test runs them in whichever lane you need.

```bash
npm i -D roku-test
npx roku-test                                              # headless (no device) — default
npx roku-test --device --host <roku-ip> --password <dev-pw> --lcov   # on-device + coverage
```

New to testing on Roku? Start with the **[Writing tests guide](/writing-tests/)** — it assumes no prior
experience with any of these tools.
