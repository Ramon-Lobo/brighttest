# Device Channel: the standing brighttest device fixture

A generic, self-contained Roku channel that covers what device test batches need from a real app, so
nobody has to build a throwaway one. No real services, no accounts, no secrets, no network unless a launch
argument names a URL. Every screen has stable node ids; every interesting event prints a `BTDEV:` marker on
the 8085 debug port.

> Invoke the repo CLI as `node ../../bin/cli.js` from this folder. In your own project it is `npx brighttest`.

## Build, run, sideload

```bash
make build                       # out/device-channel.zip, app only (tests excluded), built with brighterscript
node ../../bin/cli.js            # headless Rooibos suites (24 specs, 7 suites), no device
node ../../bin/cli.js --coverage # + LCOV

# device (always through the lease; ROKU_HOST / ROKU_PASSWORD come from your environment)
BRIGHTTEST_AGENT=you#1 node ../../bin/cli.js device with --purpose "device-channel sideload" -- make deploy
node ../../bin/cli.js e2e run flows --host "$ROKU_HOST"
make launch ARGS='crash=1'       # launch with args (query string), then `make home`
```

## Screens (one panel mounted at a time under `stage`)

| Screen id | Contents (stable ids) | Serves |
|---|---|---|
| `homeScreen` | `menuList` (LabelList, 8 entries), `homeRows` (RowList, 2 rows of tiles). Right/Left moves focus between them | readiness loop, nested focus (ROB-04/11/28), `navigate_to`, e2e |
| `gridScreen` | `catalogGrid` (MarkupGrid, 5x2 tiles) | focus paths, MarkupGrid selectors |
| `detailsScreen` | `detailsTitle`, `detailsMeta`, `detailsBody`, `playButton` | e2e Home -> Details -> Back |
| `settingsScreen` | `settingsButtons` (`toggleFlag`, `saveName`, `crashButton`), `nameBox` (TextEditBox), `nameKeyboard` (Keyboard), `flagLabel`, `nameEcho` | text entry, `m.global` change (`flag`), crash from a flow, registry write |
| `dialogsScreen` | `dialogButtons` (`openMessage`, `openConfirm`); opens a `Dialog` with id `deviceDialog`; result in `global.lastDialog` | modal focus, dialog selectors |
| `playerScreen` | stub player by default (`playerState`, `playerPosition`, Timer driven); a real `Video` (`videoNode`) only with `stream=<url>` | player flows without internet; `assertPlaying` with a stream you supply |
| `netScreen` | `netRun` button runs `NetTask`; `netStatus` | roUrlTransfer call sites for the instrument plugin and network hub |
| `tasksScreen` | `runTask` (Task + thread info), `callStore` (callFunc on a `Node`), `callLeaf` (callFunc through a 3-level chain `LeafWidget -> MidWidget -> BaseWidget`) | state-inspection targets, `BT_op` inheritance checks |
| `perfScreen` | `perf=<n>` Rectangles (+ a Label per 5), a looping `Animation`, a 100 ms Timer (`perfTick`), `perfInfo` | sgperf / chanperf / Perfetto / stress |
| `probeScreen` | `probeRun`, `probeSummary`, hidden `probeText` with every probe line; same lines on 8085 | BRS-06 / COV-23 platform facts |

`Back` returns Home. The app publishes `__bt_state` (`current`, all scalar `m.global` fields, `user`) so
`assertState` works with no instrumentation: e.g. `global.flag`, `global.lastverb`, `global.lastdialog`,
`global.titlecount`, `user.tier`. Global field names are lower case in the snapshot.

## Launch arguments

`POST http://<roku>:8060/launch/dev?key=value&...` (or `--launch` params in a flow). Unknown keys are logged and ignored.

| Arg | Effect |
|---|---|
| `scene=<Name>` | Create another root Scene (see Plugin-check scenes). Default `MainScene` |
| `crash=1` (or `error`) | Runtime error `crashdelay` ms (default 2500) after the scene shows (ROB-02b/13/15/29). `crash=task`: the error happens in a Task. `crash=exit`: clean exit with no result |
| `crashdelay=<ms>` | Delay for the crash modes (0-60000) |
| `slow=<ms>` | Sleep in `main` before creating the scene (0-30000): the app is active but nothing renders (readiness gate) |
| `perf=<n>` | Node count for `perfScreen` (1-3000, default 300) |
| `stream=<url>` | Make `playerScreen` use a real `Video` node with this URL |
| `net_url=<url>` | Let `NetTask` send real requests to this URL. Without it no request is sent |
| `bt_net=<profile>` | Logged and exposed as `global.btNet` (network-interception launch-arg channel) |
| `stress=<kb>`, `stressfields=<n>` | Publish a `global.stressBlob` string of that size / `n` extra `global.sf<i>` fields (state size and latency checks) |

## 8085 markers

One line each, `BTDEV:<event> <detail>`: `startup`, `args` (one per key), `slow`, `scene-ready`, `scene-init`,
`panel`, `key`, `settings`, `dialog`, `player`, `task`, `net`, `perf`, `probe`, `registry`, `stress`,
`crash-armed`, `crash`, `exit`, `input` (deep link while running). The crash marker is printed immediately before the
runtime error (`source/lib/Crash.brs`, first statement after the marker).

## Network call sites (`NetTask`, `source/lib/NetShapes.brs`, `components/widgets/NetTyped.bs`)

Every receiver shape the instrument plugin classifies (ADR 0019 Amendment A), on purpose:
confirmed (local, `m.` chain assigned in another function, one copy hop, `CreateObject(...)` as receiver),
likely (untyped parameter named `xfer`; a `.bs` parameter typed `roUrlTransfer`), unknown (call result,
untyped parameter with no name hint), excluded (AA with a `setUrl` member, `.bs` class with `setUrl`), and the
unrewritable candidates (indexed `o["setUrl"](...)`, bare `x.getUrl()` statement). Do not tidy these call sites.

## Plugin-check scenes (`scene=<Name>`, `components/scenes/`)

| Scene | First statement of `init` / shape | Serves |
|---|---|---|
| `InitIfBlockScene` | block `if` | INS-14 (g), INS-22 |
| `InitIfInlineScene` | single-line `if` | INS-14 (g), INS-22 |
| `InitLabelScene` | a label | INS-14 (g), INS-22 |
| `InitForScene` | `for` loop | INS-22 |
| `InitCommentScene` | a comment | INS-22 |
| `InitNoInitScene` | no `init` (plugin synthesizes one) | INS-19, INS-22 |
| `SharedScene` | `SharedInit.brs`, shared with the non-Scene `SharedGroup` child | INS-14 (c)(e), INS-20, INS-23 |
| `BaseScene` / `ChildScene` | a Scene extending a Scene (`initCount` shows how many inits ran) | INS-14 (h) |

Each prints `BTDEV:init <Name>` on 8085 and sets `initRan`.

## Probes (`probeScreen`, `source/lib/Probes.brs`)

Facts to record on a device, never assertions (the headless engine differs in places). Lines are
`<phase>|<key>=<value>` where phase is `init` (inside component init), `after-init`, `rerun` or `task`: detached
`findNode` matrix (BRS-06: render thread in `init` vs after vs in a Task), AA key order (literal, incremental,
`clippingRect`), `hasField` lists (ScrollingLabel, Button, Keyboard, TextEditBox, Video, `Label.forceUpperCase` for
BRS-02), `aa_from_array`/`array_from_aa` type mismatch, Scene child count and subtypes (implicit child), LayoutGroup
lazy layout (`layout.child2.x` / `layout.group.width` compared between phases).

## Rooibos suites (`source/tests/`, headless; also `--device` and `--cross-check`)

`Args`, `Catalog` (incl. an injectable-clock fake), `Net` (all shapes with no URL), `Probes`, `StoreNode` and
`LeafWidget` (`@SGNode`, callFunc incl. inheritance), and `Failing`: passes by default, fails with
`deliberate failure` when `bs_const=BT_DEVCH_FAIL=true` is set in the manifest (then run any lane; set it back after).

## e2e flows (`flows/`)

| Flow | Covers |
|---|---|
| `home-navigation` | stable ids, menu/rows focus, published state |
| `grid-details` | grid -> details -> back, `assertText`, state |
| `settings-state` | buttons, keyboard text entry, `m.global` change |
| `dialogs` | Dialog open/answer, recorded result |
| `launch-args-perf` | `slow` + `perf` launch args, perf node count |

Crash and exit flows are run by hand with `make launch ARGS='crash=1'` or a one-step flow `launch: { crash: 1 }`
followed by an `assertVisible` (expected to report an app crash).

## Notes

Everything here is written from scratch with generic names. The shape of the Scene/panel/Task layout follows the
public Roku unit-testing-framework samples; no files were copied.
