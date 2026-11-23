# csfake (roChannelStore) and BTMedia (Video and Audio) fixtures

Sources: `docs/guide/store-fixtures.md`, `docs/writing-tests/media-state.md`, `lib/spec-api/BTMedia.brs`. Both run
headless only and are not device-verified.

## csfake: purchase flows without a store

- Put XML in `csfake/` at the project root, include `csfake/**/*` in `sourceGlobs`, and call
  `store.FakeServer(true)` in the code under test (the spec or a test seam; ask the human before adding it to
  production code). Without it the fixtures are ignored.
- Files read by the engine: `GetCatalog.xml`, `GetPurchases.xml`, `CheckOrder.xml`, `PlaceOrder.xml`. See the guide for
  the shape of each.
- Rules of the engine: an ordered `code` must exist in `GetCatalog.xml` with a positive `qty` or the event reports
  `-3`; the `<id>` in `PlaceOrder.xml` must equal the one in `CheckOrder.xml`. A missing or unparsable file gives an
  empty response, not an error.
- The data is static per run. Test failure paths by using different fixtures per suite, not at runtime.
- Not modelled: receipts, dunning, region data, attestation, a real credential store. The coverage is `Partial`.
- Start from `examples/store-fixtures-app/` (run at this version: 3 passed).

## BTMedia: drive playback states

- `import "pkg:/source/bt/BTMedia.brs"` at the top of the spec. brighttest stages it when a spec mentions
  `BTMedia_`. Do not define your own function with the `BTMedia_` prefix (duplicate-name build error).
- Functions (node first): `BTMedia_load`, `BTMedia_play`, `BTMedia_tick`, `BTMedia_pause`, `BTMedia_resume`,
  `BTMedia_stop`, `BTMedia_finish`, `BTMedia_fail`, `BTMedia_next`, `BTMedia_sync`. They throw a string when misused.
- Nothing plays. The helper writes fields one step at a time, with no timers. On brs-node a `Video` node otherwise
  stays at `state = "none"`.
- Observers run synchronously, so no wait is needed after a call. A plain suite cannot use a function-name
  `observeField` on a `createObject` Video node (use the port form or an `@SGNode` suite).
- Compare `position` and `duration` with a tolerance, not `assertEqual`.
- Not usable on `--no-sgnode` (no `roSGNode`): run on the default lane or `--coverage`.
- Not covered: real decoding, buffering time, DRM, ads, real error codes, `roVideoPlayer`, `roAudioPlayer`,
  `SoundEffect`. The engine's `Audio` node differs from the Roku docs for `error` and `stopped`, so an `Audio` spec
  can see a state the engine would not produce itself.
- Start from `test/fixtures/media-driver/` (run at this version: 10 passed, 2 suites).
