# greenfield-app (FX-GREEN)

A small, generic Roku channel written the way brighttest recommends: an `id` on every interactive or
asserted node, one store node, one networking Task, specs beside the code. Invented content only. It is the
fixture for hand-off test packs (TP-NET, TP-STA, TP-ROB, TP-MCP, TP-ENG).

## App

- `MainScene` hosts one screen at a time: `HomeScreen` (tiles `tile1..3`, `searchButton`, `signInButton`,
  `focusDemoButton`, `heroTitle`, `tierLabel`, three solid-colour posters), `DetailsScreen` (`detailsTitle`,
  `trackingStatus`), `SearchScreen` (`searchKeyboard`, `searchQuery`, `runSearch`, `searchError`),
  `FocusScreen` (focus chain `outerGroup > innerGroup > leafButton`; `plainTarget` is a plain `Group`).
- `HttpTask`: modes `get` (sync), `getAsync`, `post` (JSON body), `download` (to `tmp:/`); `lastUrl` is the
  `getUrl()` read-back. Base URL comes from launch parameter `BT_BASE_URL` (default `http://127.0.0.1:8787`).
- `AppStore`: `state` assocarray (`user`, `nav` slices) and `dispatch(action)`; `EffectsTask` persists one
  preference to registry section `greenfield`.
- Periodic mode: launch with `periodic=true` to GET `/home` every 10 s.
- `Badge` sets `Label.forceUpperCase` (non-device behaviour).

## Run

```
cd examples/greenfield-app
brighttest                 # headless: pure + @SGNode suites
brighttest --coverage
```

## Specs (`source/tests`)

| Suite | Kind |
| --- | --- |
| `Format.spec.bs` | pure functions (Format, Http, Config, Reducer) |
| `AppStore.spec.bs` | `@SGNode("AppStore")` |
| `Badge.spec.bs` | `@SGNode`, `@tags("bt-nondevice")` (forceUpperCase) |
| `BTNetIdentity/Faults/Record.spec.bs` | `@tags("needs-n1")`, `@ignore`d until `BTNet_*` exists |
| `FailOnPurpose.spec.bs` | `@tags("fail-on-purpose")`, `@ignore`d (remove it to see a failing run) |

## Flows (`flows/`) and fixtures

| File | Used by |
| --- | --- |
| `home-to-details.e2e.yaml` (passes) | TP-ROB, TP-MCP |
| `missing-id.e2e.yaml` (fails on purpose) | failure-bundle cases |
| `network.e2e.yaml` + `fixtures/net/*` | TP-NET |
| `state.e2e.yaml` + `fixtures/state/premium.json` | TP-STA |

The `fixtures/net/*` and `fixtures/state/*` files are shape placeholders for features that do not exist
yet; adjust them when those features land. Pair with `test/fixtures/fake-origin` for a live origin.
