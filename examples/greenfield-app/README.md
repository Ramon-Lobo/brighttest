# greenfield-app

A small, generic Roku channel written the way brighttest recommends: an `id` on every interactive or
asserted node, one store node, one networking Task, specs beside the code. Invented content only. It is the
fixture for network, state, robustness, MCP and engine checks.

## App

- `MainScene` hosts one screen at a time: `HomeScreen` (tiles `tile1..3`, `searchButton`, `signInButton`,
  `focusDemoButton`, `heroTitle`, `tierLabel`, three solid-colour posters), `DetailsScreen` (`detailsTitle`,
  `trackingStatus`), `SearchScreen` (`searchKeyboard`, `searchQuery`, `runSearch`, `searchError`),
  `FocusScreen` (focus chain `outerGroup > innerGroup > leafButton`; `plainTarget` is a plain `Group`).
- `HttpTask`: modes `get` (sync), `getAsync`, `post` (JSON body), `download` (to `tmp:/`); `lastUrl` is the
  `getUrl()` read-back. Base URL comes from launch parameter `BT_BASE_URL` (default `http://127.0.0.1:8787`).
- `AppStore`: a `BTStore` (`source/brighttest/BTStore.brs`) with slices `user` and `nav`, and `dispatch(action)`,
  which routes to `BTStore_dispatch`. `EffectsTask` persists one preference to registry section `greenfield`.
- Periodic mode: launch with `periodic=true` to GET `/home` every 10 s.
- Net-secrets probe (opt-in): launch with `netsecrets=1` (off by default; without it every request is unchanged).
  After the hero `GET /home`, `HttpTask` sends one extra `GET <base>/echo?token=abc&access_token=def&sig=ghi` with header
  `Authorization: Bearer test-not-secret`. Header and query only, no JSON body key. All values are dummies, not real
  credentials; they exist so a redaction check can grep captures for `test-not-secret`, `abc`, `def` and `ghi`.
- Input-order probe (opt-in): launch with `inputprobe=1` (off by default; without it `m.global` gains nothing).
  `MainScene` then adds string fields `m.global.inputProbe` (written by the commands under test) and
  `m.global.inputProbeLog` (written only by the fixture). It observes `inputProbe` and appends each event's own value,
  comma-separated, via `InputProbe_append` (`source/lib/InputProbe.brs`). The log stops at 1,800 chars and ends with
  `|full` (under the 2,048-char serializer cap). Ids: `a01..a22` (220 ms), `b01..b22` (100 ms), `c01..c22` (50 ms),
  no reset between rates. Used by TP-STA-25 step 2.
- `Badge` sets `Label.forceUpperCase` (non-device behaviour).

## Run

```
cd examples/greenfield-app
brighttest                 # headless: pure + @SGNode suites
brighttest --coverage
```

## State layer

`AppStore` calls `BTStore_init` with one reducer per slice (`Reducer_user`, `Reducer_nav`, built on `Reducer_apply`).
The slices live in `m.global.btState_user` and `m.global.btState_nav` (BrightScript field names are
case-insensitive, so specs and flows read them as `btstate_user` and `btstate_nav`). There is no `state` field on
`AppStore` any more: read a slice from `m.global`, change it through `dispatch` (or `m.global.btAction` from a Task).
`MainScene` observes `btState_user` and sets `tierLabel` from `tier`.

`brighttest.json` sets `instrument.state.dispatch` to `["dispatch"]`, so an instrument build wraps `dispatch` and the
action log in Studio (and time travel) work without further config.

| Path | Value |
| --- | --- |
| `btstate_user.tier` | `free` (default), `premium` after `user/signIn` |
| `btstate_user.signedIn` | boolean |
| `btstate_nav.screen`, `btstate_nav.detailsId` | current screen name and item id |

In a flow, `setState: { layer: global, path: btstate_user.tier, value: premium }` writes the slice and
`assertState: { path: global.btstate_user.tier, equals: premium }` reads it (see `flows/state.e2e.yaml`).

## Specs (`source/tests`)

| Suite | Kind |
| --- | --- |
| `Format.spec.bs` | pure functions (Format, Http, Config, Reducer) |
| `AppStore.spec.bs` | `@SGNode("AppStore")`, reads the `btstate_*` slices |
| `Badge.spec.bs` | `@SGNode`, `@tags("bt-nondevice")` (forceUpperCase) |
| `BTNetIdentity/Faults/Record.spec.bs` | `@tags("needs-n1")`, `@ignore`d sketches of the `BTNet_*` spec API |
| `FailOnPurpose.spec.bs` | `@tags("fail-on-purpose")`, `@ignore`d (remove it to see a failing run) |

## Flows (`flows/`) and fixtures

| File | Used by |
| --- | --- |
| `home-to-details.e2e.yaml` (passes) | robustness and MCP checks |
| `missing-id.e2e.yaml` (fails on purpose) | failure-bundle cases |
| `network.e2e.yaml` + `fixtures/net/*` | network checks |
| `state.e2e.yaml` + `fixtures/state/premium.json` | state checks |

`fixtures/net/home.rules.json` is live: `network.e2e.yaml` loads it and it must stay correct. The
`fixtures/state/premium.json` has the layered shape Studio saves (`{v, name, layers: {global, scene}}`), so a
headless spec can load it with `BTState_load` and seed it with `BTState_seedGlobals(snap.layers.global)`
(see `docs/writing-tests/state-fixtures.md`). Pair with `test/fixtures/fake-origin` for a live origin.

`network.e2e.yaml` is a net-mock flow. It needs a build made with `instrument build --net`, the same
`BRIGHTTEST_HUB_TOKEN` value set at build time and at run time, and the instrument hub running (`e2e run`
starts it). See the token section in `docs/guide/instrument.md`.
