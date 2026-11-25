# tree.json format (brighttest-feature-tree/v1)

Evidence: fields, enums, caps and exit codes are the ones in `skills/facts.json` (`featureTree` block, generated from
`lib/features/schema.js`), checked by `test/skills-mapping.test.js`, and the rules match `features check --help`.
Not device-verified.

## Shape

```json
{
  "schema": "brighttest-feature-tree/v1",
  "graph": { "hash": "<graph.hash>", "treeHash": "<graph.scan.treeHash>" },
  "provenance": { "author": "agent", "createdFrom": "graph.json" },
  "features": [
    {
      "id": "player",
      "name": "Video player",
      "kind": "screen",
      "summary": "Plays a selected title and resumes from the last position.",
      "members": ["comp:PlayerScreen", "file:components/player/PlayerScreen.xml"],
      "risk": "high",
      "testability": { "overrides": [
        { "node": "file:components/player/resume.brs", "class": "headless-unit",
          "reason": "resume math is plain functions", "evidence": "source/tests/Resume.spec.bs" } ] },
      "proposedTests": [
        { "target": "file:components/player/resume.brs", "lane": "headless-unit",
          "title": "resume position clamps to duration", "why": "pure arithmetic, characterization first" } ],
      "notes": "Trick-play keys need an e2e flow."
    }
  ],
  "ignored": [ { "members": ["file:source/roku_modules/x.brs"], "reason": "vendor" } ],
  "paths": { "recommended": "leaf-first", "reason": "shared parsers have no tests and screens depend on them" }
}
```

Copy `graph.hash` and `scan.treeHash` from `graph.json` exactly. Do not write `dependsOn`: it is computed.

## Enums

- `kind`: app-shell, screen, flow, service, widget, shared, platform, vendor.
- `risk`: low, medium, high.
- `lane` (overrides and proposed tests): headless-unit, headless-scene, headless-fixtures, device, e2e. There is
  no `unknown` lane.
- `needs` on a proposed test: net, state, store, media, registry.
- `paths.recommended`: leaf-first, base-first.

## Caps

At most 400 features; `name` 60 characters; `summary` 400; `why`, `reason` and `notes` 300 each (reasons on
overrides included); at most 20 proposed tests per feature; `id` matches `^[a-z0-9][a-z0-9-]{0,47}$` and is unique.

## Checks (features check)

| Rule | Error when |
|---|---|
| V1 | shape, types, enums or caps are wrong |
| V2 | `graph.hash` is not the graph's hash (stale graph) |
| V3 | a file is in no feature or in two (`--partial` allows "in none") |
| V4 | a member id is not in the graph, or a component and its XML are in different features |
| V5 | a feature id is not a slug or is repeated |
| V6 | an override names a missing node, or a cheaper-than-rule class has no evidence (a spec path in the graph, or `run:<junit file>`) |
| V7 | a proposed test has a missing target or a lane that cannot reach the node (for example `headless-unit` on inline-CDATA-only). A proposed test on an unclassified node is a warning |
| V8 | text holds a control character, absolute path, URL with credentials, `Bearer` literal or a 32+ character token-like run |
| V9 | `paths.recommended` or `paths.reason` is missing |

An override of a node no rule classified needs a reason only (nothing to undercut) and is reported as agent judgement.

## Exit codes

`features check`: 0 valid (warnings allowed), 1 internal error, 2 usage error or unreadable input, 3 invalid or
stale. `features render`: same, and it writes nothing on 3. `features graph`: 0 produced, 1 internal, 2 usage.
