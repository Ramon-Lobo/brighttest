# Open Cinema — brighttest streaming sample

A real streaming channel that puts **video** through the full brighttest pipeline. Where
[`../sample-app`](../sample-app) covers the mechanics (focus grids, text entry, navigation), this one
adds the part that actually breaks on hardware: an HLS/MP4 player, resume-from-position, and asserting
that a stream **reaches `play`** on a real device.

Everything streams from open, freely licensed sources (Blender open movies + public HLS test streams),
so it runs anywhere with no accounts or keys.

## The app

One panel mounted at a time in a single `stage`, so `assertVisible`/`assertGone` are always exact:

- **Home** (`homeScreen`) — poster rows built from the feed, plus a **Continue Watching** row that
  appears once you've started something, and a **Search** button reached by pressing `Up` from the top
  row.
- **Details** (`detailsScreen`) — title, metadata, description, and a `playButton`.
- **Player** (`playerScreen`) — a `Video` node playing HLS or MP4. Resumes from the last saved position
  and persists progress to the registry as you watch.
- **Search** (`searchScreen`) — an on-screen `Keyboard`; typing narrows the poster results live
  (`result-<id>` tiles) using the same `Search_filter` the unit specs cover.

`Back` always returns Home, which keeps the flows deterministic.

## Layout

```
manifest
data/feed.json           # "Open Cinema": 2 categories, HLS + MP4 titles, bundled posters
images/*.jpg             # Creative Commons posters (committed)
source/
  main.brs               # app entry (excluded from the test build)
  lib/
    Feed.brs             # parse/normalize the feed        ┐
    Format.brs           # duration / progress formatting  │ pure logic,
    Search.brs           # case-insensitive title filter    │ covered headless
    Watchlist.brs        # continue-watching list (cap 10)  ┘
  tests/*.spec.bs        # 20 headless unit tests over the lib/ helpers
components/
  MainScene.xml/.brs     # mounts the active panel, routes verb:id actions, owns the registry
  panels/*.xml/.brs      # Home / Details / Player / Search
flows/
  play-a-title.e2e.yaml  # Home → Details → play → assert playback → Back → Home
  search.e2e.yaml        # Home → Search → type → assert results narrow → Back → Home
brighttest.json
```

## Running the tests

> In this repo, invoke the local CLI with `node ../../bin/cli.js`. In your own project it's `npx brighttest`.

### Logic tests (no device)

```bash
node ../../bin/cli.js                # headless — 20 unit tests over Feed/Format/Search/Watchlist
```

### On-device E2E

E2E drives the **running app**, so sideload first, then run the flows. The `Makefile` wraps both:

```bash
make deploy ROKU=<ip> PASSWORD=<devpw>     # zip (app only) + sideload
make launch ROKU=<ip>                      # start the channel

node ../../bin/cli.js e2e run flows/ --host <ip> --password <devpw>
```

Put `ROKU`/`PASSWORD` in a `.env` next to the `Makefile` (auto-loaded, gitignored) to skip the flags.

Both flows pass end to end: focus navigation across the poster grid, Select transitions, live playback,
keyboard search, and Back-to-Home.

## Notes (the video-specific bits, learned the hard way)

- **Assert playback over ECP, not the SceneGraph tree.** A fullscreen `Video` saturates the render
  thread, so `/query/sgnodes` stalls while it decodes. `assertPlaying` (and `assertMedia`) read
  `/query/media-player` instead, which stays responsive and reports the real transport state
  (`buffer` → `play` → `finished`). Use it for anything that happens *during* playback.
- **Removing a panel does not stop its `Video`.** `MainScene.showPanel` explicitly sets the player's
  `control = "stop"` before tearing the panel down — otherwise audio keeps playing after you navigate
  away.
- **A render-thread crash looks like a frozen app, not an error.** An unhandled error in a field-observer
  callback (here, progress reporting) kills the render thread: the video keeps playing but the app stops
  responding to `Back` and `sgnodes` goes dark. Keep observer callbacks defensive — e.g. use `Int(Val(s))`
  and `StrI(n).Trim()` for numeric conversions rather than methods that throw on the wrong boxed type.
- **`main.brs` is excluded from the test build** (`"!source/main.brs"` in `brighttest.json`): Rooibos
  provides the entry for the headless lane; the app's own `Main()` would boot the UI and the runner would
  never start.
- **Streams and posters are open/free.** Blender open movies (Big Buck Bunny, Sintel, Tears of Steel,
  Elephants Dream) plus public HLS test streams. Swap in your own by editing `data/feed.json`.

## Extending this example

- **New logic?** Add to `lib/*.brs` + a `*.spec.bs` under `source/tests/`. Runs headless.
- **New title?** Add an entry to `data/feed.json` (drop a poster in `images/`).
- **New journey?** Add a panel, wire the `verb:id` action in `MainScene.brs`, and drop a `*.e2e.yaml` in
  `flows/`. Keep every node `id`-tagged so flows can select it.
