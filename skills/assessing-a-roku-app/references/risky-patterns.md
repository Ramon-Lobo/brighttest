# Risky patterns

Evidence: the six kinds, their trigger rules and the "comments and strings are ignored" rule are from `lib/assess.js`
and `docs/guide/assess.md` (`risky` section). The "what it means" column is guidance, not something the tool
checks, and is not device-verified. Never quote a source line into a report if you are unsure what it holds.

Output shape: `risky` is a list of `{ kind, file, line }`. The scan has no values to leak. An empty list is not
proof of a clean project. Lines over 4,000 characters are not scanned (`scans.risky.skippedLongLines`).

| kind | Tool trigger | What it means (guidance) | What to tell the human |
|---|---|---|---|
| `eval` | an `Eval(` call | Code built and run at runtime. Static reading (including the census) cannot see what runs, so tests may not cover it. | Name the site. Whether it is safe is a human call. |
| `roInput-unknown-keys` | `.getInfo()` in a file that uses `roInput` | Input or deep-link data read as a bag of keys. The set of keys can vary by launch source, so code must not assume any key. | Specs for deep-link handling should cover missing and extra keys. |
| `render-thread-sync-http` | `GetToString`, `GetToFile`, `PostFromString` or `PostFromFile` outside a Task script | A synchronous request on the render thread can freeze the UI while it waits, and is hard to mock like a Task request. | Moving it into a Task is an app edit: needs the human's OK. |
| `task-infinite-loop` | `while true` or `while 1` in a Task script with no `wait(` in the loop body | A loop with no wait can spin and starve other work, and can hang a test run that waits for the Task. | Report the site. Adding a wait is an app edit: needs the human's OK. |
| `logs-deeplink-params` | `print` or `?` of `launchArgs`, `inputData`, `contentId`, `mediaType` or a `deeplink*` name | Launch parameters may reach logs, including logs a test run saves. | Do not paste such logs into reports. The human decides whether to change the logging. |
| `large-global` | more than 20 distinct `m.global` fields, reported once at the first | Many global fields make app state hard to seed and reason about in tests. | Plan to seed state with care (`testing-app-state`, `debugging-failing-tests` on `globalFields`). |

## Reporting rules

- One line per finding in the template: kind, `file:line`, the meaning column. Do not rank them as bugs: a pattern
  is a place to look, not proof of a defect.
- Do not open or edit the cited code to "fix" a finding. The assessment is read-only.
- A finding does not block adoption. It tells the human where headless tests may behave differently from the
  device, so add "not device-verified" to anything built on those paths.
