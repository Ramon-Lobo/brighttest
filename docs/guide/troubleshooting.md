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

## Headless run says "RUN CRASHED (EXIT_BRIGHTSCRIPT_CRASH)"

The engine hit a runtime error it cannot catch (for example `invalid.method()` in a node's `init()`) and stopped, so
the run is incomplete and fails. The case that was running is listed as failed (and in the JUnit file); cases that had
not started are not listed, because nothing names them. Find the error line just above the crash in the output, fix it,
and re-run.

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
- The default lane mounts the staged build as the package root: your manifest is read (`bs_const` honoured,
  `roAppInfo` title/version from the manifest, `pkg:/manifest` readable) with `splash_min_time` forced to `0` in
  the staged copy only. See [store fixtures](./store-fixtures.md#pkg-in-the-headless-run).

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

Doctor also prints an `environment:` section (and `environment[]` in `--json`): `ROKU_HOST` (set or not, and from the shell, `.env`, the cache or the flag; a malformed value such as `ip:pw` or a list is flagged), `ROKU_PASSWORD` (set or not and where from, never the value; only needed for sideload, instrument and screenshots), `BRIGHTTEST_HUB_TOKEN` (unset, ok or malformed; must be 32 lowercase hex) and the `BRIGHTTEST_*` settings that are set (names only). A missing host points to `brighttest setup`. Exit codes do not change.

`--host` falls back to `ROKU_HOST` (set in the environment or in a project `.env`; the environment wins), then the last cached device (`brighttest devices`); doctor prints which one it used (`host: <ip> (from ROKU_HOST in .env)`) and warns when it picked among several cached devices; when none of them gives a host, doctor exits 2 (`--ecp-port <n>` changes the ECP port, for example for a
[stub device](/maintainers#device-free-tests-fake-roku-and-fake-origin)). By default it reads `query/device-info` only: no password, no lease, no keypresses (the opt-in hub probe below is the one
exception). Exit 0 when every check passes, 1 when a check fails or the device does not answer, 2 on a usage error. The serial number is hidden unless you pass `--show-serial`. Some firmware (16.0.4, for one) reports no `video-mode`, so doctor falls back to `ui-resolution` and prints `video mode: <value> (ui-resolution; no video-mode)`; JSON output carries `videoModeSource`.
The two fixable states are **Limited** ECP (Settings → System → Advanced system settings → Control by mobile
apps → Network access → Permissive) and **developer mode disabled** (enable it with the remote sequence the
fix text prints).

When the device answers, doctor also prints the hub it would use (bind address, default port 8790, and the LAN address it would advertise) and one line: `hub reach: not tested (set BRIGHTTEST_DOCTOR_HUB_PROBE=1 and ROKU_PASSWORD; replaces the dev channel)`. By default doctor sends nothing to the device for this; JSON output carries the same facts under `hub`.

`brighttest e2e run` runs the same check first. On a Limited or developer-disabled device it stops before the
device lease, any launch or any keypress, and prints the same fix text.

## The device cannot reach the hub

The instrumented app's hello never arrives, or an `e2e run` with `net` stalls. Run `BRIGHTTEST_DOCTOR_HUB_PROBE=1
brighttest doctor --host <ip>` (needs `ROKU_PASSWORD`; it replaces the dev channel, so re-sideload your app after). If
`hub reach` is `not-reached`, follow its `fix:` line: firewall for node on the hub port, no Wi-Fi client isolation, no
VPN on the LAN route, `instrument.hub.host` when there are several interfaces. See "The LAN hub on a device, and `doctor`"
in the instrument guide.

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

The probe app is **host-only** (`brighttest_host_only=1` in its manifest; that key is informational only and nothing enforces it, the guard in `Main` does). It checks patched-engine behavior and creates
nodes without a scene, which crashes a real Roku, so its `Main` prints a refusal and exits when it is not on the headless engine.

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

## Console command answers "Command not recognized" (or returns nothing)

**Symptom:** a Studio console command (`sgperf`, `textures`, `chanperf`) returns an empty result, or fails with
`target "<name>" answered "Command not recognized" (stub command set; seen with the channel in the background, and on some devices with it in front)`,
or `console target not found for channel "<name>" (targets: ...)`.

**Cause:** these commands act on the console's *execution target*, which defaults to `main` (the system UI),
where they return nothing useful. The channel's own target has to be selected first with `target <n>`; Studio
does this for you (`target list`, then `target <n>`). A listed target can answer
with a stub command set, where every targeted command is "Command not recognized". This was seen with the channel in
the background, and on some devices with it in the foreground, so the cause is not settled. Studio reports it as the
error above instead of an empty result. Other replies are named by a `status` (for example `needs-dev-channel`,
`needs-scene-graph`, `not-implemented`, `unavailable`, `empty`, `unknown`) with a `reason` quoting what was observed. Global commands (`free`, `plugins`, `fps_display`) need no target.

**Fix:** launch the channel and bring it to the foreground, then retry; if the stub reply persists with the channel in front, it is the device's reply, not a Studio fault. If the target is not found, check the channel
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

## Long device runs stop after about 10 minutes

**Symptom:** a long device run, with no key presses for a while, stalls at about 10 minutes. Timers in the app stop
firing and the run then fails or times out, even though the lease is still valid and the app did not crash.

**Cause (measured, on the device side):** this was measured on one lab device (firmware 16.0.4.853), not in the
test run's code. A probe channel with no app code and no network stopped its scene timer at about 595 s after
launch, with no input. Its task thread kept running, and the app left at about 1140 s with no Home press.

The stall is measured from the last input, not from launch. One remote key pressed at about 306 s after launch
moved the stall to about 905 s, about 599 s after that key. The device screensaver (shown as `screensaver` in
`query/active-app`) appeared at about 601 s with no input, so it is the likely cause, not proven. Long runs of a
sample channel that sent no keys hit the same window, and one agent loop stopped at about 600 s. Another lab device
with a different firmware did not start the app in the probe test, so the window is not confirmed on a second
device.

**Confirmed on a long run:** on the same lab device (firmware 16.0.4.853), one host-side ECP keypress (`Fwd`) every
240 s kept the app's scene timer, main tick and agent loop running for a full 45 minutes, on both arms of the test,
with no stall at about 595 s and no screensaver. Without input, the scene timer stops about 595 to 600 s after the
last input, the screensaver appears at about 601 s, and the app exits at about 1140 s. Only `Fwd` every 240 s was
tested. The key has to come from the host over ECP. Other keys and other intervals are not tested, so do not assume
they work.

**Workaround:**

- Use the built-in option: `brighttest device with --keepalive -- <long command>`. While the command runs, it sends
  one ECP `Fwd` keypress from the host every 240 s (`--keepalive=<sec>` to change it; minimum 60, `0` = off), under
  the lease `device with` already holds. See [`--keepalive`](/guide/device-lease#keeping-the-app-alive-on-long-runs-keepalive).
  It applies to `device with` only; `e2e run` does not use it. Check that the app does nothing unwanted on `Fwd`.
- Or change the device's own screensaver or idle setting so it starts later than the run. This changes a device
  setting, so the device owner should decide it. Do not change it silently on a shared device.

Relaunching the app between flows is not a documented fix; it is not built.
