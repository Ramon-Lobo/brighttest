# Several agents on one device

Several people or AI agents often work on the same app from different git worktrees and share one Roku. This
page is the short etiquette. The mechanism (queue, deadlines, exit codes) is in
[Sharing a device (lease)](/guide/device-lease).

Apps replacing each other on the device is normal here. Each lane that sideloads takes the lease first, so
installs never overlap; the next lane simply installs its own package over the last one.

## See who has the device and what is on it

```bash
npx brighttest device status          # holder, purpose, queue, and an "installed:" line per device
npx brighttest device watch --once    # one board, then exit
npx brighttest device log --tail 20
```

Always give `device watch` `--once` (or `--plain`) when you run it from a tool call: without a terminal it
has no one to quit it.

`device status` and the `device watch` board show an installed-build line read from the lease directory (no
device call). It looks like this:

```
installed: <title> <version> · sha 1a2b3c4d · by dev#2 (roku-test-wt-a @abc1234, dirty) · 12m ago
```

It names the package, the first 8 characters of its sha256, who installed it (agent, worktree, commit, and
`dirty` when the working tree had uncommitted changes) and how long ago. It reads `unknown` when brighttest
has no record for that device (the record is written only by brighttest installs made after this feature).

Read it before you trust a failing flow. If the build on screen is another worktree's, your flow is testing
the wrong app.

## Re-sideload or rebuild?

Rebuild only after your own code changes. If your code has not changed since your last build, put that same
package back instead of building again.

- Keep your package: build to a path you control, for example
  `npx brighttest instrument build --out .brighttest/mine.zip`.
- Compare the installed line with your last install (sha and commit). If it is already your build, you need
  no install at all.
- A sideload of a package that is already installed relaunches the dev channel and prints
  `identical package already installed; relaunched the dev channel`. That is a success, not a crash.

## Studio next to agents

Studio holds the device lease only while you use it. It yields to a waiting session after 60 seconds idle and
releases after 5 minutes idle. A `423` response from Studio means another agent holds the device. "Take over"
in Studio is the explicit override: it queues Studio like any other lane and never preempts the holder. After
Studio yields, the app on screen may be another agent's build, so check the installed line.

## Choosing the device

With several devices cached, `device with`, `device lock` and `device reset` stop with
`multiple devices are cached and no host was given: pass --host <ip> (or set ROKU_HOST) to choose one`.
When the host does come from the cache, the lane prints `using the cached device <host> (last used <age>);
pass --host to choose another`. Pass `--host` (or `ROKU_HOST`) in scripts and agent briefs; a stale cache
entry otherwise points a run at a device that is not yours.

## Habits that avoid trouble

- Label every lane: `--as <agent>` (or `BRIGHTTEST_AGENT`) and `--purpose "<task>: <what>"`.
- Give `--expect <dur>` so waiters get an estimate. `e2e run` takes `--expect` and `--max` like the other
  lanes. An estimate is only a guess: when the holder runs past it, the wait has no known end.
- Wrap long background commands in `timeout` and clean them up; never leave a watcher or a poll loop running.
- `device unlock --force` is for humans. If a holder looks stuck, read `device status` and `device log` first.
