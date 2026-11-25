# Grouping and naming features

Evidence: node and edge fields were read from a graph of `examples/feature-tree-app`; the guidance is advice, not
something the tool checks. Not device-verified.

## Reading the graph

`graph.json` has `nodes`, `edges`, `resolution`, `uncertainty`, `specSuites`, `scan` and `hash`. Do not open it
whole on a big app. Print slices with `node -e`, from the project root:

```sh
node -e 'const g=require(require('path').resolve(process.argv[1]));console.log(g.nodes.length,"nodes",g.edges.length,"edges");console.log(JSON.stringify(g.uncertainty.blindSpots,null,1).slice(0,3000))' .brighttest/features/graph.json
node -e 'const g=require(require('path').resolve(process.argv[1]));for(const n of g.nodes.filter(n=>n.kind==="component"))console.log(n.id,n.extends,n.file,n.testability&&n.testability.primary.class)' .brighttest/features/graph.json
```

Then edges for one folder (filter on `from` starting with `file:components/home`). Keep each print short. A
component node has `file`, `extends`, `interface`, `children` and `testability`; an edge has `from`, `to`, `kind`,
`conf` and `at` (`file:line`). Confidence values: exact, name, ambiguous, dynamic, unresolved, builtin. Treat
`ambiguous`, `dynamic` and `unresolved` edges as "may depend on", and say so.

## Kinds

- `app-shell`: manifest, `main.brs`, the root scene, loaders. One per app.
- `screen`: a full-screen component and the pieces only it uses. `flow`: a multi-screen journey (sign-in, checkout).
- `service`: tasks, API clients, storage, entitlement. `widget`: a reusable UI piece used by several screens.
- `shared`: utilities many features call. `platform`: wrappers around device APIs. `vendor`: third-party code.

## Good boundaries

- A component and its XML always go together (V4). Put a feature's `<interface>` consumers with it.
- Prefer folder boundaries when the folders already name a feature. Split a folder only when two groups share no
  edges. Name a feature for what the user sees ("Settings"), not for a file ("SettingsScreen2").
- Shared code used by three or more features is its own `shared` feature; test it first on the leaf-first path.
- Third-party folders (`roku_modules`, vendor, excluded paths) go under `ignored` with the reason, or a `vendor`
  feature when the app calls them heavily. Do not propose tests for them.
- A cycle between features is one unit of work: say "test together" in `notes` and suggest the seam (an
  extracted pure function, or a field instead of a direct call) as a proposal. Never apply it without edit permission.
- Every file is in exactly one feature or `ignored`. Specs that already exist are members of the feature they cover.
