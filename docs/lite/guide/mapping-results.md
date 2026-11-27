# Mapping results

::: info At a glance
**What it is for:** seeing a real feature report from the example apps before running one on your project.

**You will:**
- learn how to read a report
- open the reports for three example apps (on the full site)

**First command:** `npx brighttest features render --auto`
:::

## About these reports

Each one is the automatic skeleton, not a curated tree.

- Made with `brighttest features graph` then `brighttest features render --auto`. No agent: features are grouped by
  structural rules with generic names. A curated tree reads the same with meaningful names ([Map the app](/guide/feature-tree)).
- Exactly what the CLI wrote from the committed example apps. Regenerate with `npm run docs:mapping-results`.
- Each is one static file with a strict CSP (`default-src 'none'`): nothing loaded from the network, only its own
  inline script.

## How to read a report

| Section | Shows |
|---|---|
| **Summary** | features, files, components, edges, and how many call sites were resolved |
| **Feature tree** / **Feature details** | each feature once, its files and the features it depends on |
| **Test paths** | leaf-first (shared code first) and base-first (screens first); each feature marked headless or needs a device |
| **Uncertainty** | what was not resolved, e.g. an ambiguous `callFunc` target or a dynamic `observeField` callback; check these by hand |

## Feature Probe (`examples/feature-tree-app`)

About 35 invented files covering every link kind: components, tasks, global fields, the registry, `callFunc` and
observers. Its one `callFunc` is ambiguous on purpose, to fill the Uncertainty section. Result: 5 features.

[See results](full:/mapping-results/feature-tree-app/index.html) (opens on the full site). Screenshot: see the full guide.

## Greenfield Sample (`examples/greenfield-app`)

Written the recommended way: an `id` on every interactive node, one store, one networking task, specs beside the
code. Most nodes are headless-testable and one needs a device. Result: 6 features.

[See results](full:/mapping-results/greenfield-app/index.html) (opens on the full site). Screenshot: see the full guide.

## Open Cinema (`examples/streaming-app`)

Plays open-licence HLS and MP4 video with resume-from-position. The player needs a real device, so it shows the
headless/device split. Result: 3 features.

[See results](full:/mapping-results/streaming-app/index.html) (opens on the full site). Screenshot: see the full guide.

## Maps of real projects

Reports on public open-source apps: [Examples of mapping](/guide/external-examples).

## Related

- [Map the app](/guide/feature-tree): produce your own report

**Full guide:** [Mapping results](full:/guide/mapping-results) — the original wording.
