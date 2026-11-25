# Mapping results

This page shows what the mapping step produces on the example apps that ship in this repository, so you can see a real
report before you run it on your own project. Each report is a single static file. Click "See results" to open it in a new
tab.

Every report below is the automatic skeleton: `brighttest features graph` followed by `brighttest features render --auto`.
No agent was involved, so features are grouped by simple structural rules and have generic names. A curated tree, where an agent
or a person names the features and proposes tests, reads the same way but with meaningful names. See
[Map the app](/guide/feature-tree) for how to produce one. None of the reports here is a curated tree.

The files are exactly what the CLI wrote from the committed example apps. Regenerate them with `npm run docs:mapping-results`.
The report ships with a strict content security policy (`default-src 'none'`): it loads nothing from the network and runs only
its own inline script.

## How to read a report

- **Summary** counts features, files, components and edges, and shows how many call sites brighttest could resolve.
- **Feature tree** and **Feature details** list each feature once, with the files it owns and the features it depends on.
- **Test paths** orders the features two ways: leaf-first (shared code first) and base-first (the screens first). Each feature
  is marked as testable headless or as needing a device.
- **Uncertainty** lists what the analysis could not resolve, such as a `callFunc` whose target is ambiguous or an
  `observeField` with a dynamic callback. These are the places to check by hand.

## Feature Probe (`examples/feature-tree-app`)

A small invented channel of about 35 files, built to cover every kind of link the graph knows: components, tasks, global fields,
the registry, `callFunc` and observers. Its one `callFunc` is ambiguous on purpose, so it is a good place to see the
Uncertainty section filled in. Result: an automatic skeleton with 5 features.

[See results](../mapping-results/feature-tree-app/index.html){target="_blank" rel="noopener"}

![Feature tree section of the report for the feature-tree-app example: named features with kind, risk and test classes, expanded to show what each depends on](/images/mapping-results/feature-tree-app.png)

## Greenfield Sample (`examples/greenfield-app`)

A small channel written the way brighttest recommends: an `id` on every interactive node, one store, one networking task and
specs beside the code. Check the class mix in the summary: most nodes are testable headless, and one needs a device. Result:
an automatic skeleton with 6 features.

[See results](../mapping-results/greenfield-app/index.html){target="_blank" rel="noopener"}

![Feature tree section of the report for the greenfield-app example: named features with kind, risk and test classes, expanded to show what each depends on](/images/mapping-results/greenfield-app.png)

## Open Cinema (`examples/streaming-app`)

A streaming channel that plays open-licence HLS and MP4 video, with resume-from-position. The video player needs a real device, so
look at how the report separates what can run headless from what needs a device. Result: an automatic skeleton with 3 features.

[See results](../mapping-results/streaming-app/index.html){target="_blank" rel="noopener"}

![Feature tree section of the report for the streaming-app example: named features with kind, risk and test classes, expanded to show what each depends on](/images/mapping-results/streaming-app.png)

## Maps of real projects

For reports on public open-source apps, see [Examples of mapping](/guide/external-examples).
