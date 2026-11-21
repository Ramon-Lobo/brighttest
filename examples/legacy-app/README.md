# legacy-app (FX-LEGACY)

A deliberately conventional, plain-BrightScript channel with no brighttest conventions, written from scratch
to stress instrumentation the way long-lived apps do. Invented content only. Fixture for hand-off packs
(TP-INS, TP-STA, TP-NET, TP-ROB).

## What it contains

- Networking: `roUrlTransfer` per request in a short-lived Task (`PerRequestTask`), in a long-lived port-loop
  worker (`WorkerTask`, `CreateObject(cls)` with a variable), once on the render thread
  (`LegacyScene.renderThreadProbe`, gated by `config.renderThreadSync`, press Rewind); URLs built by string
  concatenation (`Util_buildUrl`); `SetCertificatesFile` with the system bundle and `pkg:/certs/custom-ca.pem`;
  `GetToString` and `AsyncGetToString`; a `Poster.uri` and a `Video` content url (media, not covered).
  `source/vendor/**` also uses `roUrlTransfer`; `brighttest.json` lists it under `instrumentExclude`.
- State: `m.global` as a bag (`addFields` in `main.brs`, later `setField` and in-place AA replacement on Play),
  dummy secrets (`authToken`, `sessionId`, `password`), a 60-item array, a 2 KB+ string, a node ref, an
  `roDateTime`, an integer `launchCount`; registry sections `legacy_prefs`, `legacy_session` (read at startup,
  written on exit); `LegacyStore` with `handleAction`, `dispatchAction`, `resetHome` and field observers.
  `tierLabel` follows `m.global.user.tier`.
- Structure: 9-level `DeepTree`; `ViewBase > ViewA > ViewB > ViewC` inheritance (init only in `ViewC`, inline
  CDATA script); 40 widgets (relative and `pkg:/` script includes); scenes `LegacyScene` (default), `BaseScene`
  and `DerivedScene` (both with `init`), `BareScene` (no init, no script), `InlineCdataScene` (init as inline CDATA, no .brs), `OverhangFixtureScene`
  (extends `OverhangPanelSetScene`; census fixture, not launched by default). Select with launch param `scene=<Name>`.
- Markers: `print "BTFIX:<event>"` on startup, scene init, keys, tasks, exit.
- Failure paths: keys Up Up Down Down crash (dot on invalid); Left Right Left Right run `END`.
- Net diagnostics: launch `netdiag=<url>`; Label `netDiag` shows `code=<n> reason=<s> event=<yes|no>` and
  the same text is printed as `NETDIAG ...`.
- Stress mode: launch param `stress=1` or `bs_const STRESS=true`: 500 global fields / 256 KB, plus trees of
  1,500 and 6,000 nodes.
- No-`roInput` mode: launch param `noinput=1`. Build variant without `supports_input_launch`: `manifest.noinput`.
- Specs (`source/tests`): `AgentCount`, `AgentSerializer`, `AgentWrite` (`@SGNode`). `InducedCrash` is
  `@ignore`d; unignored it crashes at `source/Config.brs:67` (`Legacy_explode`) called from
  `source/tests/InducedCrash.spec.bs:13` (call spans lines 13-16).
- Flows: `state-read`, `state-write`, `network-legacy` (`flows/*.e2e.yaml`).

## Census ground truth and scaling

`EXPECTED-CENSUS.json` holds the counts over `source/` (minus tests) and `components/`; regenerate or check
with `node tools/scale.js --census`.

```
node tools/scale.js --copies 12 --out /some/scratch/dir    # ~1,000 files; nothing committed
```

Copy 0 is the app; copies 1..N-1 repeat `components/` under `components/cK/` with `_cK` component names.

## Plain sideload (no brighttest)

The app is plain BrightScript, so it can be sideloaded as is. Enable developer mode on the device first.
Specs (`*.bs`, `source/tests/`) are left out of the package.

```
cd examples/legacy-app
zip -r /some/scratch/legacy-app.zip manifest source components certs -x '*.bs' -x 'source/tests/*'
curl --digest -u "rokudev:$ROKU_PASSWORD" --connect-timeout 5 --max-time 60 \
  -F mysubmit=Install -F "archive=@/some/scratch/legacy-app.zip" "http://<host>/plugin_install"
```

Or use the helper (host explicit, password from the environment only, never printed):

```
ROKU_PASSWORD=... sh tools/sideload.sh --host <ip>
```

## Run

```
cd examples/legacy-app && brighttest
```
