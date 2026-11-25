# Testability classes

Evidence: classes and rule ids follow the graph's `testability` objects and `docs/guide/feature-tree.md`; the plain
wording is guidance. Not device-verified. Every class is a prediction until a run proves it.

| Class | Meaning | Command |
|---|---|---|
| `headless-unit` | plain functions, no scene | `npx brighttest --no-sgnode` |
| `headless-scene` | a component booted headless, fields and `onChange` | `npx brighttest` |
| `headless-fixtures` | logic that talks to network, store, globals, media or registry, against fakes (`needs`) | `npx brighttest` plus fixtures |
| `device` | firmware behaviour, timing, real I/O | `--device` or `--cross-check`, leased |
| `e2e` | journeys, focus and keys, launch and deep links | `npx brighttest e2e run`, leased |
| `unknown` | no rule fired: not classified | none, and no CI job |

`unknown` is not a lane. It is never counted as headless-testable and never scheduled. A node with an `unknown`
class stays out of both paths' first tests until someone classifies it.

## Rules in plain terms

- U1/U2: a pure function (no `m.`, no `GetGlobalAA`, only safe built-ins, pure callees) is headless-unit.
- S1/S0/S2: a component with an interface or `onChange`, or one that hosts a scene, is headless-scene; reading
  `m.global` in `init` adds the `state` need.
- F1: a covered `roUrlTransfer.setUrl` site needs `net` fixtures. F4: `roChannelStore` needs `store`. F5: `Video` or
  `Audio` needs `media`. F6: `roRegistrySection` needs `registry`.
- F2, D1-D5: real network, wall-clock timing, TLS, platform values, inline CDATA, a component library: also needs
  a device (or is reported as uncertainty).
- T1: a Task; test request building and response parsing as plain functions, real timing needs a device.
- E1-E3: key and focus handling, the entry point and launch or deep-link parameters: also need an e2e flow.
- X1: an unresolved base type or child: uncertainty, never cheaper than headless-scene.

## Overrides

You may override a node's class only with a `reason`. Moving it to a cheaper lane than the rule gave also needs
`evidence`: a spec path that exists in the graph, or `run:<junit file>`. Label it "agent judgement" in the hand-back.
Never override to a device or e2e claim you did not observe: write "not device-verified".

## What only a device can confirm

Wall-clock timing and animation, real playback, DRM and video quality, focus and key routing end to end, layout and
pixels, real network and certificates, firmware strictness, platform values, Task thread scheduling, performance
and memory. The report lists these verbatim; repeat them in the hand-back.
