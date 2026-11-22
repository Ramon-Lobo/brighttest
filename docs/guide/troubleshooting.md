# Troubleshooting & how it works

The sharp edges we hit building and validating brighttest, each with its root cause. Most are already
handled by the tool — this page explains *why*, so surprises make sense. For mistakes specific to
*writing tests*, see [Common mistakes](/writing-tests/mistakes).

## "Cannot find name 'rooibos'" / duplicate `_` errors at build

**Cause:** the `rooibos-roku` bsc plugin didn't load, so `@suite`/`@it` annotations were never processed
and the classes look like plain (duplicate) functions.

**Fix (already in brighttest):** the generated bsconfig references the plugin by **absolute path**, so
`bsc` finds it regardless of npm hoisting. If you write your own bsconfig, ensure `rooibos-roku` is
resolvable from the project root.

## "Use of uninitialized variable" pointing at a suite class

**Cause:** the spec lives outside a compiled path (e.g. top-level `tests/`). Roku only compiles `source/`
and `components/`, so the suite class is never defined even though the runtime references it.

**Fix:** put specs under `source/` (e.g. `source/tests/*.spec.bs`).

## Headless run produces no results (0 passed / 0 failed)

Several distinct causes, all handled by the tool now:

- **Interpreter can't parse the Rooibos runtime.** The lightweight `@rokucommunity/brs` interpreter errors
  with `Expected property name after '.'` on Rooibos's own `.brs`. brighttest uses **`brs-node`**, whose
  parser handles it.
- **Default lane builds coverage off (for speed).** The everyday `brighttest` lane skips coverage
  instrumentation. Coverage runs headless via **`--coverage`**, which boots the scene-based Rooibos runner
  on the simulator so the collector's field observers work — no device, real LCOV.
- **Component scripts collide.** Loading `components/**` `.brs` flat causes duplicate `Init`. The headless
  driver loads **only `source/**`** (plus itself).
- **Line endings.** brs-node separates lines with `\r`; the result parser splits on `\r\n|\r|\n`.

## `assertEqual` fails on equal-looking numbers

`expected "2147483647 (Float)" to equal "2147483647 (Double)"` — Rooibos's `assertEqual` is
**type-strict** across numeric subtypes. Compare by value with a coercing `=`:
`m.assertTrue(x = 2147483647)`. (More in [Assertions](/writing-tests/assertions).)

## `--printLcov` produced no file (and how LCOV actually works)

`printLcov` is a **bsconfig `rooibos` option**, not just a CLI flag — and even then Rooibos **prints** the
LCOV to the run's console; it never writes a file. brighttest's `--lcov`:

1. sets `rooibos.printLcov: true` on the coverage build (headless `--coverage` or device),
2. captures the run output,
3. scrapes the `TN:/SF:/DA:/LF:/LH:/end_of_record` blocks,
4. drops framework-internal (`…/rooibos/…`) records,
5. writes a clean `lcov.info`.

If `--lcov` is requested but no coverage comes back, the run fails on purpose (so CI can't silently lose coverage).

## Interpreter notes

- **`@rokucommunity/brs`** — lightweight, fast; good for pure logic. **Does not** implement crypto and
  **cannot parse the Rooibos runtime**. Not used by brighttest's Rooibos lane.
- **`brs-node`** (`brs-cli`) — fuller component set incl. crypto and a **SceneGraph engine**; parses the
  Rooibos runtime. This is the headless interpreter brighttest uses (shipped as `@ramonlobo/brs-node`). The
  **default** lane uses a lightweight SceneGraph-off driver for speed; the **`--coverage`** lane runs the
  full scene-based Rooibos runner on brs-node's SceneGraph engine, so `@SGNode` suites and coverage run
  headless.

## `@SGNode` node tests hang forever (device lane)

**Symptom:** the device run reaches a node (`@SGNode`) suite and never returns; eventually
`did not indicate test completion`.

**Root cause:** Rooibos generates a `<Node>_component.xml` (extending the component under test) and a
same-named `.brs` containing the node's `init()` (which registers the `rooibosRunSuite` observer) and the
`rooibosRunSuite()` handler. BrighterScript only auto-links a component's same-named script when the
**`autoImportComponentScript`** compiler option is enabled. Without it, the generated XML never `<script>`s
its own `.brs`, so the component falls back to the *base* component's `init`, the observer is never
registered, `rooibosRunSuite` does nothing, and the main-thread runner waits forever on `rooibosTestResult`
(its `while` loop has no timeout).

**Fix (already in brighttest):** the generated device bsconfig sets `"autoImportComponentScript": true`. If
you run Rooibos yourself, set it in your bsconfig — this is a hard requirement for `@SGNode` tests
(RokuCommunity Rooibos issue #203). It's *not* a coverage problem: node tests work with coverage on once
the script is linked.

## Device run aborted: "no device output for Ns (idle watchdog)"

**Symptom:** a `--device` run stops with `run aborted: no device output for Ns (idle watchdog)`, or with
`[roku-test] no device output for Ns` from the Rooibos CLI.

**Cause:** the device printed nothing for too long. Two watchdogs exist. The Rooibos CLI exits on its own after
90 s of silence. The brighttest device lane has its own backstop at 120 s (`DEFAULT_IDLE_S` in `lib/device.js`),
so the CLI's line normally wins and the lane's fires only when the CLI itself wedges. Set the lane value with
`--idle-timeout <sec>` or the `deviceIdleTimeout` config key (`0` disables; the flag wins). `--timeout <sec>` (default 900) is the separate overall limit.

**Known limit:** with stock Rooibos, an `@async` test that never calls done prints `[Rooibos Result]: PASS`
after about 5 s, so the run looks like a pass and the watchdog never fires (the device is not silent). Keep
async tests calling done, and cross-check suspicious passes on the headless lane.

## E2E run fails with `APP_CRASHED`

**Symptom:** a `brighttest e2e run` wait fails fast with `APP_CRASHED: app <id> is no longer in front (active: ...); it exited or crashed`, instead of timing out on a selector.

**Cause:** after a missed poll, the wait asked the device which app is active and it was not the app under test, so the app exited or crashed. The error is non-retryable (`retryable: false`).

**Fix:** check that the app launched and was not halted (for example by a crash, a back-out to Home, or another app taking over), then re-run.

## Coverage % looks low

Coverage reflects only the lines your tests exercised. A big utility file with a few tested functions will
show a low percentage — that's accurate, not a bug. It climbs as you add tests.

## The old `brs` package errors on Node 22

The original `brs` (sjbarag) `0.45.x` throws `Cannot read properties of undefined (reading 'toLowerCase')`
even on hello-world under Node 22. It's unmaintained — use `brs-node` (what brighttest depends on).

## `brighttest doctor`: is the device ready?

```sh
brighttest doctor --host <ip>            # firmware, ECP mode, developer mode, with the exact fix for anything wrong
brighttest doctor --host <ip> --json     # the same as JSON: model, softwareVersion, build, ecpSettingMode, developerEnabled, videoMode, deviceClass, checks[] (id, ok, fix); no serial
```

It reads `query/device-info` only: no password, no lease, no keypresses. Exit 0 when every check passes, 1
when a check fails or the device does not answer. The serial number is hidden unless you pass `--show-serial`. Some firmware (16.0.4, for one) reports no `video-mode`, so doctor falls back to `ui-resolution` and prints `video mode: <value> (ui-resolution; no video-mode)`; JSON output carries `videoModeSource`.
The two fixable states are **Limited** ECP (Settings → System → Advanced system settings → Control by mobile
apps → Network access → Permissive) and **developer mode disabled** (enable it with the remote sequence the
fix text prints).

`brighttest e2e run` runs the same check first. On a Limited or developer-disabled device it stops before the
device lease, any launch or any keypress, and prints the same fix text.

## `brighttest doctor --engines`: what can the headless engine do?

```sh
brighttest doctor --engines          # capability table, engine flavor (patched or stock), probe result
brighttest doctor --engines --json   # the same as JSON
```

Runs a tiny probe app (`brs/probes/engine-caps/`) with the resolved `brs-node` and compares what the engine
does with what its `package.json#brighttest` metadata claims. No device is contacted. Exit 0 when they agree,
1 when the probe fails or disagrees (a patch was lost or added without updating the stamp; the message names
the patch and both values), 2 when no engine is installed. An engine without a stamp has no metadata to
compare, so its probe column is shown as the evidence only.

`BRS-02` (`Label.forceUpperCase`) is a **non-device** capability: a headless convenience that a real Roku
does not have. The table marks it NON-DEVICE, and any headless run on an engine that has it prints a warning
on stderr for each use in your sources, for example
`nondevice-field: Label.forceUpperCase used in source/tests/Title.spec.bs:12 (non-device behavior: ...)`.
Specs that rely on it will not match the device.

## "Waiting for the device lease" / exit 75, 77 or 78

Device commands queue for the device ([device lease](./device-lease)). Run `npx brighttest device status`
to see who holds it (agent, purpose, worktree, since when) and who is queued.

- **75**: the device was busy (`--wait 0`) or the wait timed out. Wait longer (`--wait 1h` or
  `BRIGHTTEST_LEASE_WAIT`), or ask the holder. This is "device in use", not "device unreachable": an
  unreachable device fails with a network error instead.
- **77**: the lease was lost (someone force-unlocked it), the hold reached its `--max` deadline, or the
  `BRIGHTTEST_LEASE` token in your environment is no longer held. Re-run the command.
- **78**: the lease directory (`~/.brighttest/leases` or `BRIGHTTEST_LEASE_DIR`) is not writable or the disk
  is full. The message names the path.
- **A lease that never frees**: a crashed holder frees within about a second unless a child process it
  started is still running (`device status` shows the PID). If the holder is yours and stuck:
  `npx brighttest device unlock --force --host <ip> --reason "…" [--kill]`.

## Console command says the target is "listed but not running" (or returns nothing)

**Symptom:** a Studio console command (`sgperf`, `textures`, `chanperf`) returns an empty result, or fails with
`target "<name>" is listed but not running (stub command set); bring the channel to the foreground and retry`,
or `console target not found for channel "<name>" (targets: ...)`.

**Cause:** these commands act on the console's *execution target*, which defaults to `main` (the system UI),
where they return nothing useful. The channel's own target has to be selected first with `target <n>`; Studio
does this for you (`target list`, then `target <n>`). A channel that is listed but not in the foreground answers
with a stub command set, where every targeted command is "Command not recognized", and Studio reports that as the
error above instead of an empty result. Global commands (`free`, `plugins`, `fps_display`) need no target.

**Fix:** bring the channel to the foreground (launch it) and retry. If the target is not found, check the channel
name against the listed targets in the message.

## `sgperf` report is empty

**Symptom:** `sgperf` start, then report, returns an empty report (parsed as not ok) even though a target is selected.

**Cause:** the report lists per-thread node activity between start and report. An idle app that creates no nodes
and runs no node operations in that window has nothing to report. This is not a Studio defect.

**Fix:** exercise the app between start and report (navigate, scroll, open a screen), then report again. The
distinction from a missing target: a missing or stub target is an explicit error; an idle app is just empty.

## `assertLog` sees nothing, or old lines from a previous run

**Symptom:** `assertLog` times out, or the run fails with `Console connection is already in use` /
`log capture unavailable: ...`.

**Cause:** log capture reads the device's BrightScript console on port 8085, and the device allows exactly one
client. A telnet session or another tool holding the port blocks capture. On connect the console replays recent
history; the runner discards that burst (everything before the first short idle gap), so a flow only sees its own
output. A `Brightscript Debugger>` prompt in live output means the app crashed.

**Fix:** close any other client on 8085 and re-run. Use `ROKU_LOG_PORT` for a different console port. Failed
steps write a `<flow>-failure/` bundle with `log-tail.txt` (last 50 lines). See [E2E flows](/e2e/flows).

## Screenshot fails, or the app is not in front (Home)

**Symptom:** `screenshot not ok: no sideloaded app is in the foreground (launch the dev channel first)`, or
`launch of <id> did not hold: Home in front after <n> ms`, or a failure bundle containing `screenshot-error.json`
instead of an image.

**Cause:** the device screenshot is of the sideloaded dev channel only, so it fails while Home or another app is
in front. The launch readiness check tolerates Home for a short grace window after launch, then fails the launch.
If the tree read hangs or fails, readiness falls back to the app UI tree instead of waiting forever, so a slow
tree read is not by itself a failed launch. A screenshot also needs the device dev password.

**Fix:** check the app launched and stayed up (a crash or back-out sends the device to Home), and that the dev
password is set. `screenshot-error.json` holds the exact reason.
