# The two test paths

Evidence: ordering rules from `docs/guide/feature-tree.md` and the rendered report of `examples/feature-tree-app`.
The advice on choosing is guidance. Not device-verified.

| | Leaf-first (bottom-up) | Base-first (top-down) |
|---|---|---|
| Order | features nothing else depends on last; shared and leaf code first | app shell first, then features by distance from the entry |
| First tests | characterization specs on pure functions, then scene specs | a launch smoke: an e2e flow if a device is available, otherwise a headless scene spec of the root scene's `init` with `globalFields` seeded |
| Below the current step | already tested | stubbed with test doubles; network and store faked |
| Needs a device early | no | optional (the headless fallback is listed) |
| Best when | big untested shared core, planned refactors, no device | journey coverage wanted fast, device available, screen-heavy code |
| Risk | slow to show user-visible value | stubs can hide integration bugs until lower layers have tests |

Features in a dependency cycle are one step ("test together"). Nodes that are not classified are listed in their
step as "not classified: needs the agent or a human" and get no test until classified.

## Choosing

1. Ask the human: is a device available and may you use it? Is the app code editable? What matters first, user
   journeys or core logic?
2. No device: recommend leaf-first (every step is headless). Device available and journeys matter: base-first.
   Say why in `paths.reason`, in one sentence, and mention the other path's main risk.
3. Show both paths from the report. Do not pick for the human; ask, then start with step 1 of the chosen path.

When a step is done, a new spec must fail when the behaviour is broken, then pass (`writing-rooibos-tests`).
Record which step each new spec covers in your hand-back.
