# Examples of mapping

brighttest was run read-only against four public, open-source Roku apps to see what it reports on code it has never seen. This page
lists what came out: counts, names and structure that brighttest derived, plus pictures of its own feature report. Nothing here is
source code or an asset from those apps.

These projects are analysed read-only as worked examples. This page contains only counts, names and structure derived by brighttest; it contains no source code or assets from these projects, which remain under their own licences and copyright. Silo is a trademark of Silo Media L.L.C.; Jellyfin is a trademark of its owners; YouTube and Roku are trademarks of their respective owners. brighttest is not affiliated with, endorsed by, or sponsored by any of them. Results are a snapshot at the stated commit and may contain errors.

## The four apps

- jellyrock (https://github.com/jellyrock/jellyrock), commit a24bcf9, licensed GPL-2.0.
- playlet (https://github.com/iBicha/playlet), commit 4bd5c11, licensed AGPL-3.0.
- silo-roku (https://github.com/Silo-Server/silo-roku), commit 6389fcc, licensed AGPL-3.0-or-later.
- jellyfin-roku (https://github.com/jellyfin/jellyfin-roku), commit ddcc2a0, licensed GPL-2.0.

Each app was fetched at the commit above, analysed with brighttest 0.7.0 and then deleted. The apps' own code was not run during the
census or the feature report (the one exception is described under [Headless spec run](#headless-spec-run)).

## Census and feature graph

`brighttest assess` and `brighttest features graph` ran on each app, with no crash and exit code 0 in every case.

| App | .bs / .brs / .xml files | Components | Tasks | Spec files | Graph nodes | Graph edges |
|---|---|---|---|---|---|---|
| jellyrock | 781 / 3 / 224 | 221 | 27 | 354 | 926 | 15311 |
| silo-roku | 632 / 0 / 182 | 124 | 13 | 205 | 660 | 22219 |
| jellyfin-roku | 236 / 0 / 187 | 187 | 31 | 0 | 667 | 12167 |
| playlet (`playlet-lib/src`) | 386 / 0 / 130 across the repo | 115 | 8 | 63 across the repo | 646 | 6118 |

Notes on reading the table:

- The playlet repository root is not itself a Roku app. brighttest reports `not-a-roku-app` there, and the real projects sit in
  sub-folders (`playlet-lib`, `playlet-app`, `playground`). The row shows `playlet-lib/src`, the largest one.
- File and spec counts matched a plain file count exactly. Component counts differ by a few for jellyrock and playlet and by 58
  for silo-roku: brighttest assumes the default `source/` and `components/` layout and does not honour a `bsconfig` `files` list.
- Call-site counts from a plain text search are higher than brighttest's resolved edges for jellyrock, silo-roku and playlet,
  because the graph counts only calls it can resolve. Treat edge counts as a lower bound.

## Feature reports

`brighttest features render` produced an HTML report for each app from a generated skeleton (no agent, so nodes are not yet
classified into named features). The pictures show the top of each report, which is brighttest's own interface.

| App | Features | Files | Components | Edges | Call sites resolved | Headless-testable nodes | Needs a device |
|---|---|---|---|---|---|---|---|
| jellyrock | 10 | 644 | 221 | 15311 | 95% | 588 | 1 |
| silo-roku | 75 | 472 | 124 | 22219 | 98% | 460 | 1 |
| jellyfin-roku | 6 | 424 | 187 | 12167 | 94% | 382 | 1 |
| playlet (`playlet-lib/src`) | 57 | 486 | 115 | 6118 | 91% | 325 | 0 |

![brighttest feature report summary for silo-roku at commit 6389fcc](/external-examples/silo-roku-report.png)

![brighttest feature report summary for playlet-lib at commit 4bd5c11](/external-examples/playlet-report.png)

![brighttest feature report summary for jellyfin-roku at commit ddcc2a0](/external-examples/jellyfin-roku-report.png)

No picture is shown for jellyrock: its summary lists many configuration plugin file names, which this page leaves out. The jellyrock
numbers above are in the table.

What the reports flag for these apps:

- `bsconfig` plugins and `files` lists are not honoured, so code changed by a plugin is not modelled. The report says so as an
  assessment blocker (jellyrock, silo-roku, jellyfin-roku).
- Playlet-lib has no scenes, so the report notes that the census found 0 scenes.
- Spec files that live outside `source/` and `components/` (jellyrock, silo-roku) produce no spec-to-code edges.

## Headless spec run

For silo-roku only, the project's own specs were run headless in an isolated, stripped environment (an owner-approved exception to
the read-only rule). 18 shards ran in 223 s; 17 passed with 2746 of 2746 tests passing, and one shard errored before producing
results, so its tests are not counted. jellyrock and playlet specs need a Roku device, and jellyfin-roku has no headless runner, so
those were not run.

## Terms of this page

- Only counts, short names and brighttest's own report are shown. No source excerpts, logos, wordmarks, posters, icons, banners or
  fonts from these projects are included.
- "Silo" is used only to refer to the project, never as a product name of brighttest's.
- These numbers are a snapshot. Run `brighttest assess` on your own app for current figures.
