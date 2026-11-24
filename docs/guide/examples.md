# Example apps

The repository's `examples/` folder holds generic, self-contained Roku apps with invented content. They are repo-only (not in the
npm package), so run them from a clone with `node ../../bin/cli.js` from the app folder; in your own project the command is
`npx brighttest`. Each folder has a README with the full detail; this page says which one to open for what.

| Folder | What it is | Use it for |
|---|---|---|
| `sample-app/` | A four-screen channel with unit, `@SGNode`, coverage, device and e2e flows. Ships `brighttest.instrument.json` for an instrument build. | The first end-to-end tour of every lane; the [instrument recipe](./instrument#example-the-sample-app). |
| `streaming-app/` | A streaming channel (HLS and MP4 from open sources) with a `Video` player, resume position and search. | Video flows and "reaches `play`" checks on a device. |
| `device-channel/` | A standing device fixture: stable node ids on every screen, `BTDEV:` markers on the 8085 console, launch arguments for crashes, slow starts, stress and network calls. | Device test batches (always through the [device lease](./device-lease)), Studio and e2e work. |
| `greenfield-app/` | A small app written the way brighttest recommends: an `id` on each interactive node, one `BTStore` store node (slices `user` and `nav`), one networking Task, specs beside the code, net and state flows with fixtures. | What `init --greenfield` aims for; [state fixtures](/writing-tests/state-fixtures) and network flows. Expects the fake origin on `127.0.0.1:8787` by default. |
| `greenfield-skeleton/` | The smallest valid app (a manifest, `main.brs` and one Scene) with no brighttest files. | Trying `brighttest init --greenfield` from nothing. |
| `legacy-app/` | A conventional plain-BrightScript channel with no brighttest conventions: per-request and port-loop Tasks, `roUrlTransfer` in several shapes, `m.global` as a bag, registry sections, deep trees, an inline-CDATA Scene, a vendored folder listed in `instrument.exclude`. `EXPECTED-CENSUS.json` holds the census counts. | The brownfield path: `instrument census`, `instrument build`, `init --brownfield`, scaling the census. |
| `bsconfig-plugin-app/` | A brownfield trap: `bsconfig.json` with `rootDir: "src"`, a custom `files` list, a local bsc plugin and a manifest `bs_const`. | What `assess` reports as blockers (see below). |
| `store-fixtures-app/` | An `roChannelStore` purchase flow tested against the engine's `csfake/*.xml` fixtures. | The [roChannelStore fixtures](./store-fixtures) guide. Headless only. |

## Try the read-only commands on them

`assess` and `instrument census` write nothing (unless you pass `--out`), contact no device and need no network:

```bash
node bin/cli.js assess examples/greenfield-skeleton       # no blockers, recommends greenfield
node bin/cli.js assess examples/bsconfig-plugin-app       # blockers: bsconfig plugins, rootDir and files list
node bin/cli.js assess examples/legacy-app --json         # the brownfield report as JSON
cd examples/legacy-app && node ../../bin/cli.js instrument census
```

The expected key lines for the skeleton and the bsconfig app are in their READMEs. `assess` never changes its exit code for
findings; see [Assess a project](./assess).

## Run the headless suites

```bash
cd examples/greenfield-app && node ../../bin/cli.js         # 15 specs pass headless
cd examples/store-fixtures-app && node ../../bin/cli.js     # 3 specs pass headless
```

Both were run headless when this page was written. Nothing on this page was run on a device: the device and e2e parts of the
examples (`sample-app`, `streaming-app`, `device-channel`, the e2e flows elsewhere) need a Roku in developer mode and are not
verified here.
