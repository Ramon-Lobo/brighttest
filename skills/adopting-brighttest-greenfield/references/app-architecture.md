# App architecture and seams

Evidence: file layout and `init --greenfield` output checked on a scratch copy of `examples/greenfield-skeleton`;
store and HTTP behavior read from `lib/instrument/greenfield/BTStore.brs` and `BTHttp.brs`. The shape of
`examples/greenfield-app` (one store node, one networking Task, ids on nodes) is the reference for the
"convention" lines. Not device-verified. Where the templates were not run, it says "unverified".

## Layout after `init --greenfield`

```
manifest                      bs_const=BT_AGENT=false added
brighttest.json
source/main.brs               yours
source/brighttest/BTStore.brs copied template
source/brighttest/BTHttp.brs  copied template
source/tests/*.spec.bs        specs live under source/ and end in .spec.bs
components/                   yours: Scenes, Tasks
```

`brighttest.json` defaults (`sourceGlobs`, `testsFilePattern`) already cover this layout. Specs outside `source/`
are not compiled (see `writing-rooibos-tests`).

## The seams

A seam is a place where a test can put its own input or read an output without a device. Build three:

| Seam | Shape | Test it with |
|---|---|---|
| Logic | plain functions in `source/`, no `m.top`, no node access | a Rooibos spec, headless |
| State | reducers `fn(state, action) as object` held by a store | `BTStore_create(reducers, initial)`, `store.dispatch`, `store.state` (verified: 3 passed) |
| Network | every request goes through one helper | `BTHttp_transfer` / `BTHttp_getJson` in Tasks; mocks with `--net-unmatched` (see `docs/guide/network-recipe.md`) |

## BTStore: what exists

- Pure mode, usable in any spec: `BTStore_create(reducers, initial)` returns an object with `dispatch(action)`
  and `state`. Verified headless.
- Scene mode, in a Scene component: `BTStore_init(reducers, initial)`, `BTStore_dispatch`, `BTStore_getState`,
  `BTStore_select("a.b")`, `BTStore_subscribe(slice, callbackName)`, `BTStore_snapshot`, `BTStore_restore`,
  `BTStore_replay`. State lives in `m.global.btState_<slice>`. Unverified in a running scene by this skill.
- Task thread: `BTStore_dispatch` does not reduce there and returns `{}`. Set `m.global.btAction` to an action
  AA (it needs a `type` field); the render thread reduces it.

Not there, do not assume: `#if BT_AGENT` branches, `state.action` events, `hashBefore`/`hashAfter`, `dispatch`
and `restore` ops from the agent, effect replay, `m.global.btEffect`. `BT_AGENT=false` in `manifest` is set but
the templates do not read it yet. So `testing-app-state` features that need those ops are not available from
the templates alone. Say so rather than claiming time-travel.

## BTHttp: what exists

- `BTHttp_url(url)` returns `url` unchanged: nothing is rerouted yet.
- `BTHttp_transfer(url, opts)` makes a `roUrlTransfer` with certificates set; `opts.headers`, `opts.port`.
- `BTHttp_getJson(url, opts)` is synchronous, for Tasks: returns `{ ok, status, json, error }`, `opts.timeoutMs`
  default 8000. Unverified on a device.

## Tasks

Convention (not enforced by any tool): a Task does one request or one write and returns through fields. It has
no layout, no navigation, no business rules. Put the rule in a plain function and call it from the Task; the
spec tests the function. A Task that decides things can only be tested with a node suite or a device.

## What the skeleton shows

`examples/greenfield-skeleton` is only `manifest`, `source/main.brs` and one Scene with one Label that has no
`id`. It demonstrates the start state, not the architecture. For a fuller shape read `examples/greenfield-app`
(read-only reference; do not copy client or real content into a new app).
