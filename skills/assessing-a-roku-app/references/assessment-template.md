# Assessment template

Evidence: fields come from the `brighttest-assess/v1` document (`lib/assess.js`, `docs/guide/assess.md`). Placeholders
only. Keep it to one page. Not device-verified.

Fill every line. Write "not checked" or "unknown" instead of guessing. Do not paste secret values, source lines
that hold secrets, serials, LAN addresses or passwords.

```
# Assessment: <project folder name>

Run: `npx brighttest assess . --out <dir>`  exit <0|1|2>  brighttest <cliVersion>  scan.treeHash <first 12>
Same tree before and after (git status): <yes|no>

## Verdict
Path: <brownfield|greenfield|not-a-roku-app> (recommendation.path)
Edit permission: unknown -> asked the human: <answer or "not asked yet">

## The app
Language: <language>  Files: <brs> brs, <bs> bs, <xml> xml  Scan truncated: <yes|no>
Census: <components> components, <scenes> scenes, <tasks> tasks, setUrl <covered>/<sites> covered
Census error: <none|text, with absolute or home paths, username and host replaced by <path>>
Specs: <specFiles> (Rooibos present: <yes|no>)
bsconfig: <none|file>; rootDir <value|none>; plugins <list|none>
Manifest keys set: <bs_const|rsg_version|...|none>

## Blockers (each one from recommendation.blockers, with absolute or home paths, username and host replaced by <path>)
- <blocker text> -> what it means: <one line> -> needs human OK to change: <yes|n/a>

## Unknowns (recommendation.unknowns)
- <text>

## Secrets (key names and file:line only)
- <file>:<line> <key or kind>        (or: none found)
Rotate/remove needed: <for the human to decide>

## Risky patterns
- <kind> <file>:<line> -> <one-line meaning from risky-patterns.md>   (or: none found)

## Environment
Node <host.node> (required <host.nodeRequired>, ok <yes|no>)  CI: <systems|none>, runs brighttest <yes|no>
.gitignore: brighttest dir <yes|no>, .env <yes|no>, coverage <yes|no>
Engines: brs-node <version|not installed>, rooibos <version|not installed>

## Not checked
- Anything on a real device (not device-verified).
- Code paths the census cannot see (see blockers).
- <anything else you did not look at>

## Proposed next steps (none done yet; each needs the human's OK if it edits the app)
1. <step>
```

## Short example (placeholders)

```
Verdict: brownfield, edit permission unknown (asked: not yet)
Census: 14 components, 3 scenes, 4 tasks, setUrl 5/6 covered
Blockers:
- bsconfig plugins are not honored by brighttest: <plugin> -> brighttest builds without it; results may differ
  from the app's own build -> changing the build needs human OK
Secrets: components/Api.brs:12 apiToken (assignment) -> human to decide rotation
Risky: render-thread-sync-http components/Home.brs:88 -> synchronous request on the render thread
Not checked: everything on a device
Next: setting-up-brighttest, then one headless run (needs human OK before any app edit)
```
