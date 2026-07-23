# brighttest — Live Demo Runbook

**Audience:** engineering leads / decision-makers · **Slot:** 20–30 min · **Format:** live terminal demo, no slides

**The one-sentence pitch:** *"Roku testing today means packaging tests into the app, sideloading to a
device, and reading results back over telnet. brighttest keeps the mature stack — the BrighterScript
compiler, the Rooibos framework — but adds a headless lane so the same test files run in ~2 seconds with
no device at all. Same specs also run on real hardware, and a cross-check mode proves the fast lane
tells the truth."*

The whole demo runs against the bundled `examples/sample-app`, which exercises every lane. No device is
required for the core story — that's the point, and it's also what makes this demo bulletproof in a
conference room.

---

## Before the room (pre-flight — do this once, off-screen)

```bash
cd examples/sample-app          # from the brighttest repo root
node --version                  # must be 22+  (the headless simulator needs it)
```

- [ ] Terminal font bumped to ~18pt; window wide enough for the coverage table (it's ~90 cols).
- [ ] Do a throwaway run of each command below so the first live run isn't paying cold-start cost.
- [ ] Have `source/tests/Counter.spec.bs` and `source/tests/Format.spec.bs` open in your editor.
- [ ] (Optional device beat) If you want the E2E lane live: a Roku in developer mode on the same
      network, ECP **Network access = Permissive**, and its IP + dev password. If not, you'll show the
      captured screenshots in `.brighttest/e2e/screenshots/` instead — decide now, don't fumble live.
- [ ] `git status` clean, so the "break a test" beat resets with one `git checkout`.

**Framing to open with (30 sec):** don't explain the tool yet. Ask the room: *"How long does it take you
to find out a BrightScript change didn't break anything?"* The honest answer is minutes-to-hours and a
device. That gap is the whole product.

---

## The demo arc (5 beats, each tied to a business outcome)

Timings below are real, measured on the sample app. Say the number out loud — the speed *is* the demo.

### Beat 1 — "Tests run in seconds, on a laptop, no device" (~2 min)

```bash
node ../../bin/cli.js --no-sgnode
```

Expected: 10 passed in **~1.8s**, one `@SGNode` suite explicitly skipped.

> **The point (say this):** "That's the inner loop. A developer runs this on every save. No cable, no
> sideload, no telnet — the thing that used to need hardware now costs less than a page refresh."

### Beat 2 — "And that includes SceneGraph node tests" (~3 min) — *the money beat*

Open `source/tests/Counter.spec.bs` in the editor first. Show it's a **real node** — `@SGNode("Counter")`
— and the test sets `m.top.count` and asserts on `m.top.doubled`, i.e. it exercises the **onChange
observer cascade**.

```bash
node ../../bin/cli.js
```

Expected: 13 passed across 2 suites in **~2.7s**. The "Counter component" suite now runs.

> **The point:** "This is the part people assume needs a device. It doesn't. The component's onChange
> wiring runs headless. Most of what teams currently defer to manual device testing can move left into
> seconds-fast CI." This is the beat that changes minds — linger here.

### Beat 3 — "Coverage, no hardware" (~3 min)

```bash
node ../../bin/cli.js --coverage
```

Expected: 13 passed in **~3.1s**, a per-file coverage table, and `LCOV: coverage/lcov.info` written.

> **The point:** "Same run, real LCOV. This drops straight into Coveralls/Codecov or `genhtml` — coverage
> gates in CI with zero device fleet to maintain. Point out `Format.brs` at 95%, and that the untested
> panels show up as 0% — the report is honest, not decorative."

### Beat 4 — "It fails loudly — so it belongs in CI" (~3 min)

Break one assertion live (edit `Format.spec.bs`, e.g. change an expected value), then:

```bash
node ../../bin/cli.js --no-sgnode ; echo "exit=$?"
```

Expected: a red failure and **`exit=1`** (a passing run is `exit=0` — verified).

```bash
git checkout source/tests/Format.spec.bs      # reset
```

> **The point:** "Non-zero exit on failure is the whole CI contract. This is a `run-on-every-PR` gate, not
> a nightly job someone ignores. With `--lcov`, a *missing* coverage report also fails the build, so CI
> can't silently lose coverage."

### Beat 5 — "The same specs run on-device, and cross-check proves the fast lane is faithful" (~3–5 min)

This is the trust argument for leads — the natural skeptic question is *"can I actually trust a
simulator?"* Answer it head-on.

- The **exact same** `.spec.bs` files run on real hardware: `brighttest --device --host <ip> --password <pw>` (also emits LCOV).
- **Cross-check** runs both lanes and diffs per-test results, failing on any divergence:
  `brighttest --cross-check --host <ip> --password <pw>`.
- `@deviceOnly` marks the rare test that only makes sense on hardware (render/animation timing, firmware
  quirks); headless skips it, device runs it, cross-check reports it as device-only — *not* a divergence.

> **The point:** "You adopt the fast lane without giving up the device. Cross-check is the safety net: run
> it in nightly CI and it fails the moment the simulator and hardware disagree. So 'is the fast lane a lie'
> becomes a test that either passes or breaks the build — not a matter of faith."

**Optional device beat (E2E UI journeys) — only if you have a device wired up:**

```bash
node ../../bin/cli.js e2e run flows/ --host <ip> --password <pw> --video
```

Deterministic UI tests from readable YAML: launch the channel, D-pad focus path-finding, text entry,
assert on the live screen, per-step screenshots + session video. **No device? Show the captured output
instead** — open `.brighttest/e2e/screenshots/*.jpg` (home→details, search-typed, settings-focus) and the
flow files in `flows/`. Say: "these are generated artifacts from a real run — screenshots and video per
step, so a failure comes with a picture, not just a stack trace."

**Putting the Roku screen on the projector.** For smooth, real-time video use an HDMI capture card into
QuickTime (New Movie Recording). For a software-only, no-hardware option, run the bundled live viewer and
project the browser tab — it polls the dev screenshot endpoint (~1 fps, a slideshow) and serves an
auto-updating MJPEG stream:

```bash
node scripts/roku-live-view.js --host <ip> --password <pw>   # then open http://localhost:8600
```

Good enough to watch a flow step through live; for smooth animation you still want the HDMI card.

---

## Close: the ask (2 min)

Land on the decision, not the features. Suggested framing:

1. **The win:** the majority of our Roku tests can run in ~2s per commit, in CI, on any laptop or runner —
   no device fleet in the critical path. Coverage gates come for free.
2. **The safety:** we don't abandon device testing. Cross-check keeps the fast lane honest; `@deviceOnly`
   covers the true hardware cases.
3. **The lift is low:** it's standard Rooibos syntax — **no lock-in, no rewrite**. Teams already on Rooibos
   run their existing specs as-is. It's a thin orchestrator over BrighterScript + Rooibos + brs-engine,
   not a new engine we own.
4. **Concrete ask:** pick one channel, wire `brighttest --coverage --lcov` into its PR check this sprint,
   and add a nightly `--cross-check` against one device. Report back speed + coverage numbers in two weeks.

---

## Q&A prep (decision-maker objections, with answers)

- **"Can we trust a simulator over real hardware?"** → That's exactly what `--cross-check` is for: it
  diffs both lanes per-test and fails on divergence. Run it nightly; trust becomes a CI signal, not an
  opinion. The rare genuinely-hardware behavior is tagged `@deviceOnly`.
- **"Do we have to rewrite our tests?"** → No. It runs standard Rooibos specs. If a team already uses
  Rooibos, their specs work unchanged. Same files run headless and on-device.
- **"What can't it test?"** → Real render/animation timing and firmware quirks — the `@deviceOnly` and
  E2E lanes cover those on actual hardware. Be honest about this; it strengthens credibility.
- **"Who maintains it / bus factor?"** → It's a thin orchestrator over three mature, community-maintained
  projects (BrighterScript, Rooibos, brs-engine) — we aren't maintaining a BrightScript engine. But be
  straight: it depends on two *forked* packages carrying our headless fixes. See the dedicated risk
  section below — a technical lead will push on this.
- **"What does CI cost?"** → The default and coverage lanes need zero devices — they run on any Node 22+
  runner. Only `--device`/`--cross-check` touch hardware, and those can be a smaller nightly job.
- **"How do new tests get written?"** → Rooibos `@describe`/`@it`, `@params`, mocks/stubs/spies; there's
  also an AI-agent skill pack (`brighttest skills install`) for scaffolding specs.

---

## Risk talking point: the forked toolchain (know this cold)

This is the one question a technical decision-maker should and will press on. Answer it head-on — the
credibility comes from not hand-waving it.

**What's actually forked.** brighttest is a thin orchestrator; it has no framework code of its own. It
depends on two **published, scoped fork packages** that carry the fixes making headless SceneGraph testing
faithful:

- **`@ramonlobo/brs-node`** (fork of lvcabral/brs-engine) — a synchronous nested-flush fix so XML
  `onChange` cascades fire headless, plus a no-op `roTextToSpeech` so widgets that create it don't crash
  node init.
- **`@ramonlobo/rooibos-roku`** (fork of rokucommunity/rooibos) — a promise-settling fix so `@SGNode`
  node suites actually complete on the simulator, the `@deviceOnly` annotation, and global-context seeding.

Delivery today is clean: `npm i -D brighttest` pulls both **from npm** — no vendoring, no `patch-package`,
no postinstall step. (Older docs mention patches; that was the pre-publication model and is now historical.)

**Where we stand *right now* (verified today):** both forks sit at **exact parity with the latest upstream
release** — `@ramonlobo/rooibos-roku` `5.16.4` vs upstream `rooibos-roku` `5.16.4`, and
`@ramonlobo/brs-node` `2.2.0` vs upstream `brs-engine` `2.2.0`. **We are not behind. The risk is future
drift, not present-day lag** — which means today is the cheapest moment to put guardrails in place.

**So can we fall behind? Yes — these are the real risks, in order:**

1. **Bus factor (biggest).** The forks live under a personal npm scope (`@ramonlobo`) and personal source
   repos. If that one person is unavailable, nobody bumps or rebuilds them. This is an org risk, not a
   code risk.
2. **Upstream drift.** rokucommunity/rooibos and lvcabral/brs-engine keep shipping bug fixes, firmware/
   BrightScript-compat updates, and features. The forks only pick those up when someone manually rebases.
   Do nothing and we slowly fall behind upstream fixes.
3. **Rebase friction.** The fixes aren't trivial cherry-picks. The `onChange` fix is a one-token edit to a
   **370 KB single-line minified bundle**; the `roTextToSpeech` addition required a full **source rebuild
   at a git tag**. Re-basing onto a new upstream is real engineering, not a version bump.
4. **Silent breakage on bump.** The headless driver couples to Rooibos's **internal compiled shape**
   (the `RuntimeConfig` suite map, `groupsData`, `funcName`/`rawParams`, `TestResult`/`BaseTestSuite`, and
   the LCOV console format). These are stable across 5.x but are *not* a public API — a bump can move them,
   and nothing but running the lanes will catch it.

**Best strategies to keep it working (this is the plan to commit to):**

1. **Upstream the fixes — the durable exit.** Land the three fixes as PRs to rokucommunity/rooibos and
   lvcabral/brs-engine. Once merged and released, drop the forks and depend on the **stock** packages with
   a normal version range. This eliminates drift *and* bus-factor at once. It's stated as the project's
   goal already — the ask is to treat it as scheduled work, not "eventually." Track each PR.
2. **De-risk the bus factor now.** Move the fork packages from the personal `@ramonlobo` scope to an **org
   scope**, give **≥2 maintainers** publish access + 2FA recovery, and put the fork *source* repos under
   org control. The rebuild recipes (including the minified-bundle steps) are already written down in
   `docs/maintainers.md` — keep them current so a rebase doesn't depend on one person's memory.
3. **Gate every fork bump with the three-lane regression check.** After *any* bump, run headless +
   coverage + `--cross-check` against a known suite and confirm counts match device and cross-check is
   **0 divergent**. Wire this as a required CI job on any dependency change so a bad bump can't merge.
4. **Run `--cross-check` nightly against a real device.** This is the ultimate guard that the forked
   simulator still mirrors hardware. If a firmware update or an upstream change causes divergence,
   cross-check fails loudly and tells you — you find out from CI, not from a shipped bug.
5. **Watch upstream releases.** Subscribe to rooibos/brs-engine releases; when they ship, deliberately
   evaluate a rebase. We're at parity today — set the watch up now so "on latest" stays a decision, not an
   accident.

**One-line summary for the room:** *"It's a maintenance liability concentrated in one person and two
forked dependencies — currently at parity with upstream, and unusually well-protected by cross-check and
thorough internals docs. The strategic fix is upstreaming the patches; the operational fix is org-owning
the forks and CI-gating every bump against a real device."*

---

## One-card cheat sheet (keep this visible while presenting)

| Beat | Command | Result | Say |
|---|---|---|---|
| 1 Inner loop | `brighttest --no-sgnode` | 10 pass, ~1.8s | "no device, per-save" |
| 2 Node tests | `brighttest` | 13 pass, ~2.7s | "SceneGraph headless — the surprise" |
| 3 Coverage | `brighttest --coverage` | +LCOV, ~3.1s | "CI coverage gate, no hardware" |
| 4 CI contract | `brighttest --no-sgnode; echo $?` | exit=1 on fail | "fails the PR loudly" |
| 5 Trust | `brighttest --cross-check --host …` | both lanes diffed | "fast lane proven faithful" |

*(prefix each with `node ../../bin/cli.js` in the sample app, or `npx brighttest` in a real project.)*
