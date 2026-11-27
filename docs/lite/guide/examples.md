# Example apps

::: info At a glance
**What it is for:** choosing which example app in the repo's `examples/` folder to open.

**You will:**
- pick an example by task
- run read-only commands and headless suites on them

**First command:** `node bin/cli.js assess examples/greenfield-skeleton`
:::

## Which one to open

Generic, self-contained apps with invented content. Repo-only (not in npm): from a clone run `node ../../bin/cli.js` in the app folder (`npx brighttest` in your project). Each has a README.

| Folder | What it is | Use it for |
|---|---|---|
| `sample-app/` | Four screens; unit, `@SGNode`, coverage, device, e2e flows; `brighttest.instrument.json` | First tour of every lane; [instrument recipe](/guide/instrument#example-the-sample-app) |
| `streaming-app/` | HLS and MP4 (open sources), `Video` player, resume, search | Video flows, "reaches `play`" device checks |
| `device-channel/` | Stable node ids, `BTDEV:` markers on the 8085 console, launch args for crashes, slow starts, stress, network | Device batches (via the [lease](/guide/device-lease)), Studio, e2e |
| `greenfield-app/` | `id` on interactive nodes, one `BTStore` (slices `user`, `nav`), one networking Task, specs beside code, net and state flows | `init --greenfield` target; [state fixtures](/writing-tests/state-fixtures), network flows. Fake origin on `127.0.0.1:8787` by default |
| `greenfield-skeleton/` | Manifest, `main.brs`, one Scene; no brighttest files | `brighttest init --greenfield` from nothing |
| `legacy-app/` | Plain BrightScript: per-request and port-loop Tasks, varied `roUrlTransfer`, `m.global` bag, registry, deep trees, inline-CDATA Scene, vendored folder in `instrument.exclude`; `EXPECTED-CENSUS.json` | Brownfield: `instrument census`, `instrument build`, `init --brownfield`, census scaling |
| `bsconfig-plugin-app/` | `bsconfig.json` with `rootDir: "src"`, custom `files`, local bsc plugin, manifest `bs_const` | What `assess` reports as blockers |
| `store-fixtures-app/` | `roChannelStore` purchase flow on `csfake/*.xml` fixtures | [roChannelStore fixtures](/guide/store-fixtures); headless only |

## Try the read-only commands on them

`assess` and `instrument census` write nothing (unless `--out`), contact no device, need no network.

```bash
node bin/cli.js assess examples/greenfield-skeleton       # no blockers, recommends greenfield
node bin/cli.js assess examples/bsconfig-plugin-app       # blockers: bsconfig plugins, rootDir and files list
node bin/cli.js assess examples/legacy-app --json         # the brownfield report as JSON
cd examples/legacy-app && node ../../bin/cli.js instrument census
```

Expected lines are in the READMEs. `assess` never changes its exit code for findings ([Assess a project](/guide/assess)).

## Run the headless suites

```bash
cd examples/greenfield-app && node ../../bin/cli.js         # 15 specs pass headless
cd examples/store-fixtures-app && node ../../bin/cli.js     # 3 specs pass headless
```

::: warning Not run on a device
Both ran headless when the full page was written. The device and e2e parts (`sample-app`, `streaming-app`, `device-channel`, e2e flows elsewhere) need a Roku in developer mode and are not verified.
:::

## Related

- [Assess a project](/guide/assess): what `assess` reports

**Full guide:** [Example apps](full:/guide/examples) — the original wording.
