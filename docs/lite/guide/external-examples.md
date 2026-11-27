# Examples of mapping

::: info At a glance
**What it is for:** what brighttest reported, read-only, on four public open-source Roku apps it had never seen.

**You will:**
- compare census and graph counts across real apps
- see what the feature reports flagged
- see one headless spec run

**First command:** `npx brighttest assess .` on your own app
:::

Only counts, names and structure that brighttest derived, plus its own report. For the small bundled example apps,
see [Mapping results](/guide/mapping-results).

::: details Legal notice
These projects are analysed read-only as worked examples. This page contains only counts, names and structure
derived by brighttest; no source code or assets from these projects, which remain under their own licences and
copyright.

Silo is a trademark of Silo Media L.L.C.; Jellyfin is a trademark of its owners; YouTube and Roku are
trademarks of their respective owners. brighttest is not affiliated with, endorsed by, or sponsored by any of them.
Results are a snapshot at the stated commit and may contain errors.
:::

## The four apps

| App | Commit | Licence |
|---|---|---|
| [jellyrock](https://github.com/jellyrock/jellyrock) | a24bcf9 | GPL-2.0 |
| [playlet](https://github.com/iBicha/playlet) | 4bd5c11 | AGPL-3.0 |
| [silo-roku](https://github.com/Silo-Server/silo-roku) | 6389fcc | AGPL-3.0-or-later |
| [jellyfin-roku](https://github.com/jellyfin/jellyfin-roku) | ddcc2a0 | GPL-2.0 |

Each was fetched at that commit, analysed with brighttest 0.7.0, then deleted. App code was not run for the census or
report (one exception: [Headless spec run](#headless-spec-run)).

## Census and feature graph

`brighttest assess` and `brighttest features graph` ran on each app: no crash, exit code 0 every time.

| App | .bs / .brs / .xml files | Components | Tasks | Spec files | Graph nodes | Graph edges |
|---|---|---|---|---|---|---|
| jellyrock | 781 / 3 / 224 | 221 | 27 | 354 | 926 | 15311 |
| silo-roku | 632 / 0 / 182 | 124 | 13 | 205 | 660 | 22219 |
| jellyfin-roku | 236 / 0 / 187 | 187 | 31 | 0 | 667 | 12167 |
| playlet (`playlet-lib/src`) | 386 / 0 / 130 across the repo | 115 | 8 | 63 across the repo | 646 | 6118 |

- **playlet:** the repo root is not a Roku app (`not-a-roku-app`); the projects are in `playlet-lib`, `playlet-app`
  and `playground`. The row shows `playlet-lib/src`, the largest.
- **Counts:** file and spec counts matched a plain file count exactly. Components differ by a few for jellyrock and
  playlet and by 58 for silo-roku: brighttest assumes the default `source/` and `components/` layout and ignores a
  `bsconfig` `files` list.
- **Edges are a lower bound:** a text search finds more call sites for jellyrock, silo-roku and playlet, because the
  graph counts only calls it can resolve.

## Feature reports

`brighttest features render` built each report from a generated skeleton (no agent, so no named features yet).

| App | Features | Files | Components | Edges | Call sites resolved | Headless-testable nodes | Needs a device |
|---|---|---|---|---|---|---|---|
| jellyrock | 10 | 644 | 221 | 15311 | 95% | 588 | 1 |
| silo-roku | 75 | 472 | 124 | 22219 | 98% | 460 | 1 |
| jellyfin-roku | 6 | 424 | 187 | 12167 | 94% | 382 | 1 |
| playlet (`playlet-lib/src`) | 57 | 486 | 115 | 6118 | 91% | 325 | 0 |

Screenshots of the silo-roku, playlet-lib and jellyfin-roku report summaries: see the full guide (images at
[silo-roku](full:/external-examples/silo-roku-report.png), [playlet](full:/external-examples/playlet-report.png),
[jellyfin-roku](full:/external-examples/jellyfin-roku-report.png)). None for jellyrock: its summary lists many
configuration plugin file names, which are left out.

What the reports flag:

- `bsconfig` plugins and `files` lists are not honoured, so plugin-changed code is not modelled; reported as an
  assessment blocker (jellyrock, silo-roku, jellyfin-roku).
- Playlet-lib has no scenes: the census found 0 scenes.
- Specs outside `source/` and `components/` (jellyrock, silo-roku) give no spec-to-code edges.

## Headless spec run

Only silo-roku's own specs were run headless, in an isolated, stripped environment (a deliberate exception to
read-only).

| Result | Value |
|---|---|
| Shards | 18, in 223 s |
| Passed | 17 shards, 2746 of 2746 tests |
| Errored | 1 shard, before producing results (its tests not counted) |

Not run: jellyrock and playlet specs need a Roku device; jellyfin-roku has no headless runner.

## Terms of this page

- Only counts, short names and brighttest's own report. No source excerpts, logos, wordmarks, posters, icons,
  banners or fonts from these projects.
- "Silo" refers only to the project, never a brighttest product name.
- The numbers are a snapshot. Run `brighttest assess` on your own app for current figures.

## Related

- [Map the app](/guide/feature-tree): how the graph and report work

**Full guide:** [Examples of mapping](full:/guide/external-examples) — the original wording.
