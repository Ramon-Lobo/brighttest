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

## Coverage % looks low

Coverage reflects only the lines your tests exercised. A big utility file with a few tested functions will
show a low percentage — that's accurate, not a bug. It climbs as you add tests.

## The old `brs` package errors on Node 22

The original `brs` (sjbarag) `0.45.x` throws `Cannot read properties of undefined (reading 'toLowerCase')`
even on hello-world under Node 22. It's unmaintained — use `brs-node` (what brighttest depends on).
