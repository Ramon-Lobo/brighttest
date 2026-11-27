# Troubleshooting & how it works

::: info At a glance
**What it is for:** the sharp edges found building and validating brighttest, each with its root cause and fix. Most are already handled by the tool; this page explains why.

**You will:**
- find your symptom in the table below
- read its cause and apply the fix
- check a device with `doctor` and the engine with `doctor --engines`

**First command:** `npx brighttest doctor --host <roku-ip>`
:::

For mistakes specific to writing tests, see [Common mistakes](/writing-tests/mistakes).

## Symptom → fix

One row per problem on this page. Follow the link for the details.

| Symptom (links to details) | Fix |
|---|---|
| [`Cannot find name 'rooibos'` or duplicate `_` errors at build](#cannot-find-name-rooibos-duplicate-errors-at-build) | Make `rooibos-roku` resolvable (generated bsconfig already does) |
| [`Use of uninitialized variable` at a suite class](#use-of-uninitialized-variable-pointing-at-a-suite-class) | Put specs under `source/` |
| [Headless run: 0 passed / 0 failed](#headless-run-produces-no-results-0-passed-0-failed) | Already handled; see the four causes |
| [`RUN CRASHED (EXIT_BRIGHTSCRIPT_CRASH)`](#headless-run-says-run-crashed-exit-brightscript-crash) | Fix the error line above the crash |
| [`assertEqual` fails on equal-looking numbers](#assertequal-fails-on-equal-looking-numbers) | Compare with `m.assertTrue(x = ...)` |
| [`--printLcov` wrote no file](#printlcov-produced-no-file-and-how-lcov-actually-works) | Use brighttest's `--lcov` |
| [Which interpreter runs my tests?](#interpreter-notes) | `brs-node`, not `@rokucommunity/brs` |
| [`@SGNode` suite hangs on the device](#sgnode-node-tests-hang-forever-device-lane) | Set `autoImportComponentScript: true` |
| [`no device output for Ns (idle watchdog)`](#device-run-aborted-no-device-output-for-ns-idle-watchdog) | Tune `--idle-timeout`; keep `@async` tests calling done |
| [`APP_CRASHED` in an e2e wait](#e2e-run-fails-with-app-crashed) | Check the app launched and stayed up |
| [Coverage % looks low](#coverage-looks-low) | Nothing wrong; add tests |
| [Old `brs` errors on Node 22](#the-old-brs-package-errors-on-node-22) | Use `brs-node` |
| [Is the device ready (Limited ECP, developer mode off)?](#brighttest-doctor-is-the-device-ready) | `brighttest doctor` and its fix text |
| [Device cannot reach the hub](#the-device-cannot-reach-the-hub) | Hub probe, then its `fix:` line |
| [What can the headless engine do?](#brighttest-doctor-engines-what-can-the-headless-engine-do) | `brighttest doctor --engines` |
| [Waiting for the lease, exit 75, 77 or 78, lease never frees](#waiting-for-the-device-lease-exit-75-77-or-78) | `device status`, then per code |
| [Console command: `Command not recognized` or nothing](#console-command-answers-command-not-recognized-or-returns-nothing) | Bring the channel to the foreground |
| [`sgperf` report is empty](#sgperf-report-is-empty) | Exercise the app between start and report |
| [`assertLog` sees nothing or old lines](#assertlog-sees-nothing-or-old-lines-from-a-previous-run) | Free port 8085 |
| [Screenshot fails, Home in front](#screenshot-fails-or-the-app-is-not-in-front-home) | Check the app stayed up and the password is set |
| [Long device run stalls at about 10 minutes](#long-device-runs-stop-after-about-10-minutes) | `device with --keepalive` |
| [None of these](#still-stuck) | File a report |

## Build and headless problems

Errors while compiling specs or running them on the simulator.

### "Cannot find name 'rooibos'" / duplicate `_` errors at build

- **Symptom:** `Cannot find name 'rooibos'`, or duplicate `_` function errors at build.
- **Cause:** the `rooibos-roku` bsc plugin didn't load, so `@suite`/`@it` were never processed and the classes look like plain (duplicate) functions.
- **Fix (already in brighttest):** the generated bsconfig references the plugin by **absolute path**, so `bsc` finds it regardless of npm hoisting. In your own bsconfig, make `rooibos-roku` resolvable from the project root.

### "Use of uninitialized variable" pointing at a suite class

- **Cause:** the spec lives outside a compiled path (for example top-level `tests/`). Roku only compiles `source/` and `components/`, so the suite class is never defined even though the runtime references it.
- **Fix:** put specs under `source/`, for example `source/tests/*.spec.bs`.

### Headless run produces no results (0 passed / 0 failed)

Four distinct causes, all handled by the tool now.

| Cause | How brighttest handles it |
|---|---|
| The lightweight `@rokucommunity/brs` interpreter errors with `Expected property name after '.'` on Rooibos's own `.brs` | Uses **`brs-node`**, whose parser handles it |
| The default lane builds with coverage off, for speed | Coverage runs headless via **`--coverage`**, which boots the scene-based Rooibos runner on the simulator so the collector's field observers work: no device, real LCOV |
| Loading `components/**` `.brs` flat causes duplicate `Init` | The headless driver loads **only `source/**`** (plus itself) |
| brs-node separates lines with `\r` | The result parser splits on `\r\n|\r|\n` |

### Headless run says "RUN CRASHED (EXIT_BRIGHTSCRIPT_CRASH)"

- **Cause:** the engine hit a runtime error it cannot catch (for example `invalid.method()` in a node's `init()`) and stopped. The run is incomplete and fails.
- **What you see:** the running case is listed as failed (also in the JUnit file). Cases not yet started are not listed, because nothing names them.
- **Fix:** find the error line just above the crash in the output, fix it, re-run.

### `assertEqual` fails on equal-looking numbers

- **Symptom:** `expected "2147483647 (Float)" to equal "2147483647 (Double)"`.
- **Cause:** Rooibos's `assertEqual` is **type-strict** across numeric subtypes.
- **Fix:** compare by value with a coercing `=`: `m.assertTrue(x = 2147483647)`. More in [Assertions](/writing-tests/assertions).

### `--printLcov` produced no file (and how LCOV actually works)

- **Cause:** `printLcov` is a **bsconfig `rooibos` option**, not just a CLI flag. Even then Rooibos **prints** the LCOV to the console; it never writes a file.
- **Fix:** use brighttest's `--lcov`. It:
  1. sets `rooibos.printLcov: true` on the coverage build (headless `--coverage` or device),
  2. captures the run output,
  3. scrapes the `TN:/SF:/DA:/LF:/LH:/end_of_record` blocks,
  4. drops framework-internal (`…/rooibos/…`) records,
  5. writes a clean `lcov.info`.

::: warning Missing coverage fails the run
If `--lcov` is requested and no coverage comes back, the run fails on purpose, so CI cannot silently lose coverage.
:::

### Coverage % looks low

Not a bug. Coverage reflects only the lines your tests exercised: a big utility file with a few tested functions shows a low percentage. It climbs as you add tests.

### The old `brs` package errors on Node 22

- **Symptom:** the original `brs` (sjbarag) `0.45.x` throws `Cannot read properties of undefined (reading 'toLowerCase')`, even on hello-world under Node 22.
- **Fix:** it is unmaintained. Use `brs-node` (what brighttest depends on).

## Interpreter notes

Which BrightScript interpreter does what.

| Interpreter | Notes |
|---|---|
| `@rokucommunity/brs` | Lightweight, fast, good for pure logic. **No** crypto, **cannot parse the Rooibos runtime**. Not used by brighttest's Rooibos lane |
| `brs-node` (`brs-cli`) | Fuller component set incl. crypto and a **SceneGraph engine**; parses the Rooibos runtime. brighttest's headless interpreter (shipped as `@ramonlobo/brs-node`) |

- The **default** lane uses a lightweight SceneGraph-off driver for speed. The **`--coverage`** lane runs the full scene-based Rooibos runner on brs-node's SceneGraph engine, so `@SGNode` suites and coverage run headless.
- The default lane mounts the staged build as the package root: your manifest is read (`bs_const` honoured, `roAppInfo` title and version from the manifest, `pkg:/manifest` readable). `splash_min_time` is forced to `0` in the staged copy only. See [store fixtures](/guide/store-fixtures#pkg-in-the-headless-run).

## Device lane problems

Runs on a real Roku that hang, abort or crash.

### `@SGNode` node tests hang forever (device lane)

- **Symptom:** the device run reaches a node (`@SGNode`) suite and never returns; eventually `did not indicate test completion`.
- **Cause:**
  1. Rooibos generates a `<Node>_component.xml` (extending the component under test) and a same-named `.brs` with the node's `init()` (which registers the `rooibosRunSuite` observer) and the `rooibosRunSuite()` handler.
  2. BrighterScript auto-links a component's same-named script only when the **`autoImportComponentScript`** compiler option is on.
  3. Without it, the XML never includes its own `.brs`, so the component falls back to the base component's `init`. The observer is never registered, `rooibosRunSuite` does nothing, and the main-thread runner waits forever on `rooibosTestResult` (its `while` loop has no timeout).
- **Fix (already in brighttest):** the generated device bsconfig sets `"autoImportComponentScript": true`. If you run Rooibos yourself, set it: it is a hard requirement for `@SGNode` tests (RokuCommunity Rooibos issue #203). It is not a coverage problem: node tests work with coverage on once the script is linked.

### Device run aborted: "no device output for Ns (idle watchdog)"

- **Symptom:** a `--device` run stops with `run aborted: no device output for Ns (idle watchdog)`, or `[roku-test] no device output for Ns` from the Rooibos CLI.
- **Cause:** the device printed nothing for too long. Two watchdogs exist:

| Watchdog | Limit | Notes |
|---|---|---|
| Rooibos CLI | 90 s of silence | Exits on its own; its line normally wins |
| brighttest device lane | 120 s (`DEFAULT_IDLE_S` in `lib/device.js`) | Backstop; fires only when the CLI itself wedges |

- **Fix:** set the lane value with `--idle-timeout <sec>` or the `deviceIdleTimeout` config key (`0` disables; the flag wins). `--timeout <sec>` (default 900) is the separate overall limit.

::: warning Known limit: `@async` tests that never call done
With stock Rooibos, an `@async` test that never calls done prints `[Rooibos Result]: PASS` after about 5 s. The run looks like a pass and the watchdog never fires (the device is not silent). Keep async tests calling done, and cross-check suspicious passes on the headless lane.
:::

### Long device runs stop after about 10 minutes

- **Symptom:** a long device run with no key presses stalls at about 10 minutes. App timers stop firing and the run fails or times out, though the lease is valid and the app did not crash.
- **Cause (measured on the device side, not in the test run's code):** the device screensaver is the likely cause, not proven.
- **Fix:** `brighttest device with --keepalive -- <long command>` (below).

::: details Measurements (one lab device, firmware 16.0.4.853)
- A probe channel with no app code and no network stopped its scene timer at about 595 s after launch, with no input. Its task thread kept running; the app left at about 1140 s with no Home press.
- The stall counts from the last input, not launch: one key at about 306 s moved it to about 905 s (about 599 s after that key).
- The screensaver (`screensaver` in `query/active-app`) appeared at about 601 s with no input.
- Long runs of a sample channel that sent no keys hit the same window; one agent loop stopped at about 600 s.
- Another lab device with a different firmware did not start the app in the probe test, so the window is not confirmed on a second device.
- **Confirmed on a long run:** one host-side ECP `Fwd` keypress every 240 s kept the scene timer, main tick and agent loop running for a full 45 minutes, on both arms of the test, with no stall at about 595 s and no screensaver. Without input: timer stops about 595 to 600 s after the last input, screensaver at about 601 s, app exits at about 1140 s.
:::

::: warning Only `Fwd` every 240 s is tested
The key has to come from the host over ECP. Other keys and other intervals are not tested; do not assume they work.
:::

Workarounds:

1. **Built in:** `brighttest device with --keepalive -- <long command>` sends one ECP `Fwd` from the host every 240 s while the command runs (`--keepalive=<sec>` to change; minimum 60, `0` = off), under the lease `device with` already holds. See [`--keepalive`](/guide/device-lease#keeping-the-app-alive-on-long-runs-keepalive). It applies to `device with` only; `e2e run` does not use it. Check the app does nothing unwanted on `Fwd`.
2. **Device setting:** make the screensaver or idle setting start later than the run. This changes the device, so its owner decides. Do not change it silently on a shared device.

Relaunching the app between flows is not a documented fix; it is not built.

## Device readiness

Check the device and the hub before a run.

### `brighttest doctor`: is the device ready?

```sh
brighttest doctor --host <ip>            # firmware, ECP mode, developer mode, with the exact fix for anything wrong
brighttest doctor --host <ip> --json     # the same as JSON: model, softwareVersion, build, ecpSettingMode, developerEnabled, videoMode, deviceClass, checks[] (id, ok, fix); no serial
```

**Host resolution:** `--host`, then `ROKU_HOST` (environment or project `.env`; the environment wins), then the last cached device (`brighttest devices`). Doctor prints which one it used (`host: <ip> (from ROKU_HOST in .env)`) and warns when it picked among several cached devices. With no host from any of them it exits 2. `--ecp-port <n>` changes the ECP port, for example for a [stub device](full:/maintainers#device-free-tests-fake-roku-and-fake-origin).

::: warning Pages disagree on several cached devices
This page (and `lib/doctor.js`) says doctor warns and uses the last cached device. The [Quick start](/guide/getting-started) and [CLI reference](/guide/cli-reference) say device commands refuse when several devices are cached and none is chosen. Pass `--host` to be sure.
:::

| Item | Detail |
|---|---|
| Reads | `query/device-info` only: no password, no lease, no keypresses (the opt-in hub probe is the one exception) |
| Exit | 0 every check passes, 1 a check fails or the device does not answer, 2 usage error |
| Serial | Hidden unless `--show-serial` |
| No `video-mode` (some firmware, e.g. 16.0.4) | Falls back to `ui-resolution`, prints `video mode: <value> (ui-resolution; no video-mode)`; JSON carries `videoModeSource` |
| `environment:` section (`environment[]` in JSON) | `ROKU_HOST` (set or not; from shell, `.env`, cache or flag; malformed `ip:pw` or a list is flagged), `ROKU_PASSWORD` (set and where from, never the value; only needed for sideload, instrument and screenshots), `BRIGHTTEST_HUB_TOKEN` (unset, ok or malformed; must be 32 lowercase hex), set `BRIGHTTEST_*` names. A missing host points to `brighttest setup`. Exit codes do not change |
| Hub line | When the device answers: bind address, default port 8790, advertised LAN address, and `hub reach: not tested (set BRIGHTTEST_DOCTOR_HUB_PROBE=1 and ROKU_PASSWORD; replaces the dev channel)`. Nothing is sent to the device for it. JSON: `hub` |

The two fixable states:

| State | Fix |
|---|---|
| **Limited** ECP | Settings → System → Advanced system settings → Control by mobile apps → Network access → Permissive |
| **Developer mode disabled** | Enable it with the remote sequence the fix text prints |

`brighttest e2e run` runs the same check first. On a Limited or developer-disabled device it stops before the device lease, any launch or any keypress, and prints the same fix text.

### The device cannot reach the hub

- **Symptom:** the instrumented app's hello never arrives, or an `e2e run` with `net` stalls.
- **Check:** `BRIGHTTEST_DOCTOR_HUB_PROBE=1 brighttest doctor --host <ip>` (needs `ROKU_PASSWORD`; replaces the dev channel, so re-sideload your app after).
- **Fix:** if `hub reach` is `not-reached`, follow its `fix:` line: allow node through the firewall on the hub port, no Wi-Fi client isolation, no VPN on the LAN route, set `instrument.hub.host` when there are several interfaces. See "The LAN hub on a device, and `doctor`" in the [instrument guide](/guide/instrument).

### `brighttest doctor --engines`: what can the headless engine do?

```sh
brighttest doctor --engines          # capability table, engine flavor (patched or stock), probe result
brighttest doctor --engines --json   # the same as JSON
```

Runs a tiny probe app (`brs/probes/engine-caps/`) with the resolved `brs-node` and compares its behavior with the `package.json#brighttest` metadata. No device is contacted.

| Exit | Meaning |
|---|---|
| 0 | Probe and metadata agree |
| 1 | Probe fails or disagrees (a patch was lost or added without updating the stamp; the message names the patch and both values) |
| 2 | No engine installed |

- An engine without a stamp has no metadata, so its probe column is shown as evidence only.
- The probe app is **host-only** (`brighttest_host_only=1` in its manifest is informational; nothing enforces it, the guard in `Main` does). It checks patched behavior and creates nodes without a scene, which crashes a real Roku, so `Main` prints a refusal and exits off the headless engine.

::: warning `BRS-02` is non-device
`BRS-02` (`Label.forceUpperCase`) is a headless convenience a real Roku lacks. The table marks it NON-DEVICE, and a headless run on an engine that has it warns on stderr for each use in your sources, for example `nondevice-field: Label.forceUpperCase used in source/tests/Title.spec.bs:12 (non-device behavior: ...)`. Specs relying on it will not match the device.
:::

### "Waiting for the device lease" / exit 75, 77 or 78

Device commands queue for the device ([device lease](/guide/device-lease)). Run `npx brighttest device status` to see the holder (agent, purpose, worktree, since when) and the queue.

| Exit | Cause | Fix |
|---|---|---|
| **75** | Device busy (`--wait 0`) or the wait timed out. "Device in use", not "unreachable" (that is a network error) | Wait longer (`--wait 1h` or `BRIGHTTEST_LEASE_WAIT`), or ask the holder |
| **77** | Lease lost (force-unlocked), hold reached its `--max` deadline, or the `BRIGHTTEST_LEASE` token is no longer held | Re-run |
| **78** | Lease directory (`~/.brighttest/leases` or `BRIGHTTEST_LEASE_DIR`) not writable or disk full; the message names the path | Fix the directory |
| Never frees | A crashed holder frees within about a second unless a child it started still runs (`device status` shows the PID) | If the holder is yours and stuck: `npx brighttest device unlock --force --host <ip> --reason "…" [--kill]` |

## E2E and Studio problems

Failures in flows and Studio's console tools.

### E2E run fails with `APP_CRASHED`

- **Symptom:** a `brighttest e2e run` wait fails fast with `APP_CRASHED: app <id> is no longer in front (active: ...); it exited or crashed`, instead of timing out on a selector.
- **Cause:** after a missed poll, the wait asked which app is active and it was not the app under test. Non-retryable (`retryable: false`).
- **Fix:** check the app launched and was not halted (a crash, a back-out to Home, another app taking over), then re-run.

### Console command answers "Command not recognized" (or returns nothing)

- **Symptom:** a Studio console command (`sgperf`, `textures`, `chanperf`) returns nothing, or fails with `target "<name>" answered "Command not recognized" (stub command set; seen with the channel in the background, and on some devices with it in front)`, or `console target not found for channel "<name>" (targets: ...)`.
- **Cause:** these commands act on the console's execution target, which defaults to `main` (the system UI), where they return nothing useful. Studio selects the channel's target for you (`target list`, then `target <n>`). A listed target can answer with a stub command set, where every targeted command is "Command not recognized"; seen with the channel in the background and on some devices in the foreground, so the cause is not settled.
- **Fix:** launch the channel, bring it to the foreground, retry. If the stub reply persists in front, it is the device's reply, not a Studio fault. If the target is not found, check the channel name against the listed targets.

::: details Other console statuses
Other replies are named by a `status` (`needs-dev-channel`, `needs-scene-graph`, `not-implemented`, `unavailable`, `empty`, `unknown`) with a `reason` quoting what was observed. Global commands (`free`, `plugins`, `fps_display`) need no target.
:::

### `sgperf` report is empty

- **Symptom:** `sgperf` start then report returns an empty report (parsed as not ok), though a target is selected.
- **Cause:** the report lists per-thread node activity between start and report. An idle app with no node work in that window has nothing to report. Not a Studio defect.
- **Fix:** exercise the app between start and report (navigate, scroll, open a screen), then report again. A missing or stub target is an explicit error; an idle app is just empty.

### `assertLog` sees nothing, or old lines from a previous run

- **Symptom:** `assertLog` times out, or the run fails with `Console connection is already in use` / `log capture unavailable: ...`.
- **Cause:** log capture reads the BrightScript console on port 8085, which allows exactly one client; telnet or another tool blocks it. On connect the console replays history; the runner discards that burst (everything before the first short idle gap), so a flow sees only its own output. A `Brightscript Debugger>` prompt in live output means the app crashed.
- **Fix:** close any other client on 8085 and re-run. `ROKU_LOG_PORT` sets another console port. Failed steps write a `<flow>-failure/` bundle with `log-tail.txt` (last 50 lines). See [E2E flows](/e2e/flows).

### Screenshot fails, or the app is not in front (Home)

- **Symptom:** `screenshot not ok: no sideloaded app is in the foreground (launch the dev channel first)`, `launch of <id> did not hold: Home in front after <n> ms`, or a failure bundle with `screenshot-error.json` instead of an image.
- **Cause:** the screenshot is of the sideloaded dev channel only, so it fails while Home or another app is in front. Launch readiness tolerates Home for a short grace window, then fails the launch. If the tree read hangs or fails, readiness falls back to the app UI tree, so a slow tree read alone is not a failed launch. Screenshots also need the dev password.
- **Fix:** check the app launched and stayed up (a crash or back-out sends the device Home) and the dev password is set. `screenshot-error.json` holds the exact reason.

## Still stuck

See [Reporting issues](/guide/reporting-issues) for what to include and what to remove before you file.

## Related

- [Common mistakes](/writing-tests/mistakes): errors from writing tests
- [Device lease](/guide/device-lease): queueing, exit codes, `--keepalive`
- [CLI reference](/guide/cli-reference): every flag and exit code

**Full guide:** [Troubleshooting & how it works](full:/guide/troubleshooting) — the original wording.
