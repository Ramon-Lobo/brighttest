'use strict';
const fs = require('fs');
const path = require('path');

// Shared test reporter used by every run lane (headless default, --coverage, --device). Rooibos emits the
// same console markers in all of them, so one parser drives a consistent, grouped, Jest-style view:
//   > SUITE: <name>            → a suite (≈ one spec file) starts
//   >>>> Describe: <group>     → a group (we don't print these, but they carry a Location)
//   >>>>>> It: <name>          → a test starts; the following `Location:` is its file:line
//   <<<< END It: <name> (PASS|FAIL|CRASH)
// and a final [START TEST REPORT] tree whose `Error Message:` lines give each failure's reason.

// ANSI palette — no-ops when `on` is false so CI logs stay plain.
function palette(on) {
  const w = (a, b) => (s) => (on ? `\x1b[${a}m${s}\x1b[${b}m` : String(s));
  return { dim: w(2, 22), bold: w(1, 22), green: w(32, 39), red: w(31, 39), grey: w(90, 39), yellow: w(33, 39) };
}

// `file:///abs/path.spec.bs:NN` → project-relative `path:NN` (falls back to the absolute path).
function relLoc(cfg, raw) {
  let p = String(raw).replace(/^file:\/\//, '').replace(/^\/([A-Za-z]:)/, '$1');
  const m = p.match(/^(.*):(\d+)$/);
  let line = '';
  if (m) { p = m[1]; line = m[2]; }
  let r = path.relative(cfg.rootDir, p);
  if (r.startsWith('..') || path.isAbsolute(r)) r = p;
  return line ? `${r}:${line}` : r;
}

// Streaming reporter: prints a header per suite (with its file) and a ✓/✗ per test as each completes,
// and collects the cases for the end-of-run summary. Feed it one (ANSI-stripped) line at a time.
function makeReporter(cfg, color) {
  const c = palette(color);
  const state = { suite: null, fileShown: false, curLoc: null, cases: [], passed: 0, failed: 0 };
  function onLine(line) {
    let m;
    if ((m = line.match(/^\s*>\s*SUITE:\s*(.+?)>{2,}\s*$/))) {
      state.suite = m[1].trim();
      state.fileShown = false;
      process.stdout.write('\n' + c.bold(state.suite) + '\n');
      return;
    }
    if ((m = line.match(/^\s*Location:\s*(file:\/\/\S+)/))) {
      state.curLoc = relLoc(cfg, m[1]);
      if (state.suite && !state.fileShown) {
        process.stdout.write('  ' + c.grey(state.curLoc.replace(/:\d+$/, '')) + '\n');
        state.fileShown = true;
      }
      return;
    }
    if ((m = line.match(/<<<<\s*END It:\s+(.+?)\s+\((PASS|FAIL|CRASH)\)/))) {
      const name = m[1].trim();
      const ok = m[2] === 'PASS';
      // A crashed test ends `(CRASH)`, not `(FAIL)`: it is a failure too, so it gets its own ✗ line and case.
      state.cases.push({ suite: state.suite, name, ok, crashed: m[2] === 'CRASH', loc: state.curLoc });
      if (ok) { state.passed++; process.stdout.write('  ' + c.green('✓') + ' ' + c.dim(name) + '\n'); }
      else { state.failed++; process.stdout.write('  ' + c.red('✗ ' + name) + '\n'); }
      state.curLoc = null;
    }
  }
  return { onLine, state };
}

// Feed a growing stream of bytes; splits into complete lines (handling \r, \n, \r\n) and ANSI-strips each.
function lineSplitter(onLine) {
  let buf = '';
  return {
    push(chunk) {
      buf += chunk;
      const parts = buf.split(/\r\n|\r|\n/);
      buf = parts.pop();
      for (const raw of parts) onLine(raw.replace(/\x1b\[[0-9;]*m/g, ''));
    },
    flush() { if (buf) { onLine(buf.replace(/\x1b\[[0-9;]*m/g, '')); buf = ''; } },
  };
}

// Rooibos prints an authoritative end-of-run summary inside its [START/END TEST REPORT] block:
//     Total: N
//     Passed: P
//     Crashed: C
//     Failed: F
//     Ignored: I
//   RESULT: Success|Fail
// The per-test `<<<< END It: <name> (PASS|FAIL)` markers we stream are padded to a fixed 81-char width,
// so a long test name truncates the `(PASS|FAIL)` and the marker stops matching — which would undercount
// (a long-named FAILING test could go uncounted and the run report a false pass). This summary is the
// source of truth for the tally and the exit code. Returns null if no summary block was found.
function parseSummary(out) {
  let s = null;
  for (const raw of String(out).split(/\r\n|\r|\n/)) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, '');
    let m = line.match(/^\s*Total:\s*(\d+)\s*$/); // "Total:" only, not "Total Coverage:"
    if (m) { s = { total: +m[1], passed: 0, crashed: 0, failed: 0, ignored: 0 }; continue; }
    if (!s) continue; // ignore Passed:/Failed: that appear before any Total: (defensive)
    if ((m = line.match(/^\s*Passed:\s*(\d+)/))) { s.passed = +m[1]; continue; }
    if ((m = line.match(/^\s*Crashed:\s*(\d+)/))) { s.crashed = +m[1]; continue; }
    if ((m = line.match(/^\s*Failed:\s*(\d+)/))) { s.failed = +m[1]; continue; }
    if ((m = line.match(/^\s*Ignored:\s*(\d+)/))) { s.ignored = +m[1]; continue; }
  }
  return s; // last "Total:" block wins → the grand total
}

// A failed/crashed report-tree line. Rooibos pads with fillText(..., 60), so a long name loses the ` : ` and prints
// `|--name.....CRASH`; anchored to end of line so a passing test whose name contains "CRASH" never matches.
const TREE_FAIL = /\|--(.*?)(?:\s*:\s*\.*|\.{3,})\s*(FAIL|CRASH)(?:\s*\(-?\d+ms\))?\s*$/;

// Names of report-tree entries marked FAIL or CRASH (`|--<name> : ... FAIL|CRASH`), in order, de-duplicated.
function treeFailures(out) {
  const names = [];
  for (const raw of String(out).split(/\r\n|\r|\n/)) {
    const m = raw.replace(/\x1b\[[0-9;]*m/g, '').match(TREE_FAIL);
    if (m && !names.includes(m[1].trim())) names.push(m[1].trim());
  }
  return names;
}

// Every test line in the final report tree (`| |--name : ....PASS (3ms)`), in order, with its status. Group lines
// (`|-name`) and `|   |--Test : file://...` detail lines never match.
const TREE_CASE = /^\s*\|\s+\|--(.*?)(?:\s*:\s*\.*|\.{3,})\s*(PASS|FAIL|CRASH)(?:\s*\(-?\d+ms\))?\s*$/;

function treeCases(out) {
  const cases = [];
  for (const raw of String(out).split(/\r\n|\r|\n/)) {
    const m = raw.replace(/\x1b\[[0-9;]*m/g, '').match(TREE_CASE);
    if (m) cases.push({ name: m[1].trim(), status: m[2] });
  }
  return cases;
}

// Names in the markers and the tree are cut to a fixed width by Rooibos: the START marker keeps the full name, the
// END marker keeps ~56 characters plus `...` (and loses its `(PASS)` status), and the tree keeps ~49. So a name is
// normalised (trailing `...` removed) and two names match when they are equal or, for long names (>= 40 chars), when
// one is a prefix of the other. Short names must match exactly so `sync 1` never matches `sync 10`.
const normName = (n) => String(n).trim().replace(/\s*\.{3}$/, '').trim();
function sameName(a, b) {
  a = normName(a); b = normName(b);
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 40 && long.startsWith(short);
}
// An @params case prints `[1,2]` in the tree but `<name> 0`, `<name> 1`... in the streamed markers, so it can only
// be matched by position (see droppedCases).
const isParamsName = (n) => /^\[.*\]$/.test(n);

// Cases Rooibos lists in its report tree as PASS that never streamed an `END It` marker, when its own summary
// counted fewer tests than the tree lists, or when a streamed `It:` start marker never got its END. This is what
// an @async case in an @SGNode suite does when it never calls m.done() before its timeout: the node stops running
// the suite, the remaining cases are never executed (even a failing assertion in one still shows PASS), and the
// summary prints `Total: 0 ... RESULT: Success`. Each dropped case is returned with the reason to print; the caller
// counts them as failures so the run cannot pass silently.
// The summary gate alone is not enough: Rooibos counts @ignore'd tests in `Total` while the tree omits them, and
// the stalled node suite adds 0, so other suites' ignored tests can lift Total to the tree size. The unfinished
// `It:` marker opens the gate in that case.
// Detected: the stalled case and every PASS tree case after it that never streamed an END. Not detected: a case the
// node suite skipped with @ignore before the stall is listed in the tree as PASS with no END marker, and Rooibos
// reports `Ignored: 0` for it, so it cannot be told apart from a dropped case and is counted as one.
function droppedCases(out) {
  const summary = parseSummary(out);
  if (!summary) return [];
  const tree = treeCases(out);
  const lines = String(out).split(/\r\n|\r|\n/).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
  const ended = [];
  const started = [];
  for (const line of lines) {
    let m = line.match(/<<<<\s*END It:\s+(.+?)\s*(?:\((?:PASS|FAIL|CRASH)\)\s*)?<*\s*$/);
    if (m) { ended.push(m[1]); continue; } // a truncated END (long name) has no status but the case did finish
    if ((m = line.match(/^\s*>{6}\s*It:\s*(.+?)\s*>{2,}\s*$/))) started.push(m[1]);
  }
  const pool = ended.slice();
  const take = (name) => { const i = pool.findIndex((e) => sameName(e, name)); if (i < 0) return false; pool.splice(i, 1); return true; };
  const open = started.find((n) => !take(n));
  if (summary.total >= tree.length && open === undefined) return [];

  const left = ended.slice();
  const takeLeft = (name) => { const i = left.findIndex((e) => sameName(e, name)); if (i < 0) return false; left.splice(i, 1); return true; };
  const ran = tree.map((t) => (isParamsName(t.name) ? null : takeLeft(t.name)));
  // @params cases: whatever streamed END markers are left over belong to them, in order.
  let spare = left.length;
  tree.forEach((t, i) => { if (ran[i] === null) { ran[i] = spare > 0; if (spare > 0) spare--; } });

  const missing = tree.filter((t, i) => !ran[i] && t.status === 'PASS'); // a FAIL/CRASH entry is counted by treeFailures
  const stalled = open === undefined ? null : missing.find((t) => sameName(t.name, open)) ||
    (tree.some((t) => sameName(t.name, open)) ? undefined : missing.find((t) => isParamsName(t.name))); // else: do not guess
  return missing.map((t) => {
    const reason = t === stalled
      ? 'started but never finished: an @async case must call m.done() before its timeout; the suite stopped here'
      : open !== undefined
        ? `never ran: the suite stopped at "${normName(open)}" (an @async case that never called m.done() before its timeout); the PASS shown for it is not real (or it is an @ignore'd case)`
        : `never ran: Rooibos counted ${summary.total} test(s) but its report lists ${tree.length}; the PASS shown for it is not real (or it is an @ignore'd case)`;
    return { name: t.name, reason };
  });
}

// The engine prints `------ Finished '<pkg>' execution [EXIT_BRIGHTSCRIPT_CRASH] ------` when the BrightScript run dies
// on a runtime error it cannot catch (for example a crash in a node's init). A clean run is stopped by brighttest at
// the Rooibos shutdown marker before the engine prints this line. Anything streamed before the crash looks green, and
// Rooibos may never print its summary, so the crash is its own failure: the case that was running when the engine died
// (an `It:` marker with no END) is reported failed, or one `run crashed` entry when no case was open. Cases that never
// started cannot be named: nothing lists them.
const CRASH_LINE = /^\s*-{2,}\s*Finished\b.*\bexecution\s+\[(EXIT_BRIGHTSCRIPT_CRASH)\]/;
function engineCrash(out) {
  const lines = String(out).split(/\r\n|\r|\n/).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
  const reason = (lines.map((l) => l.match(CRASH_LINE)).find(Boolean) || [])[1];
  if (!reason) return null;
  const pool = [];
  const started = [];
  for (const line of lines) {
    let m = line.match(/<<<<\s*END It:\s+(.+?)\s*(?:\((?:PASS|FAIL|CRASH)\)\s*)?<*\s*$/);
    if (m) { pool.push(m[1]); continue; }
    if ((m = line.match(/^\s*>{6}\s*It:\s*(.+?)\s*>{2,}\s*$/))) started.push(m[1]);
  }
  const open = started.filter((n) => { const i = pool.findIndex((e) => sameName(e, n)); if (i < 0) return true; pool.splice(i, 1); return false; });
  const why = `the run crashed (${reason}) before this case finished; the engine stopped, so later cases never ran`;
  const cases = open.length ? open.map((name) => ({ name, reason: why })) : [{ name: 'run crashed', reason: `the run crashed (${reason}) and the results are incomplete: cases that had not started are not listed` }];
  return { reason, cases };
}

// Lane verdict from the console output: failures = failed + crashed from the summary (never fewer than the
// streamed ✗ count); a `RESULT: Fail` line with no counted failure still counts as one. A crashed test prints
// no `(FAIL)` END marker, so the streamed tally alone misses it.
// The report tree is a third source: a beforeEach crash in an async (@SGNode) group can print a `|--name : CRASH`
// line yet leave the summary at Total 0 / Success. max (not sum) so nothing is counted twice.
function laneFailures(out, streamedFailed) {
  const summary = parseSummary(out);
  let failed = Math.max(streamedFailed || 0, summary ? summary.failed + summary.crashed : 0, treeFailures(out).length);
  failed = Math.max(failed, (streamedFailed || 0) + droppedCases(out).length);
  const crash = engineCrash(out);
  if (crash) failed = Math.max(failed, (streamedFailed || 0) + crash.cases.length);
  if (failed === 0 && /^\s*RESULT:\s*Fail\b/im.test(String(out).replace(/\x1b\[[0-9;]*m/g, ''))) failed = 1;
  return { failed, summary, crash };
}

// Parse the final report tree for each failed test's error message, keyed by test name.
function failureMessages(out) {
  const msgs = {};
  const lines = out.split(/\r\n|\r|\n/).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
  let pending = null;
  for (const line of lines) {
    let m = line.match(TREE_FAIL);
    if (m) { pending = m[1].trim(); continue; }
    if (pending) {
      // A failed test reports `Error Message:`; a crashed one reports `Message:` (the runtime error text).
      m = line.match(/(?:Error )?Message:\s*(.+)$/);
      if (m) { msgs[pending] = m[1].replace(/\s*\(runtime error &h[0-9a-f]+\)/i, '').trim(); pending = null; }
    }
  }
  return msgs;
}

// A small code frame: Rooibos reports the test's declaration line, so show the test body (decl → the next
// `end function/sub`, capped) — the failing assertion lives inside it.
function codeFrame(cfg, loc, c) {
  const m = /^(.*):(\d+)$/.exec(loc || '');
  if (!m) return '';
  const file = path.resolve(cfg.rootDir, m[1]);
  const ln = +m[2];
  let lines;
  try { lines = fs.readFileSync(file, 'utf8').split(/\r\n|\r|\n/); } catch (e) { return ''; }
  if (ln < 1 || ln > lines.length) return '';
  const maxEnd = Math.min(lines.length, ln + 9);
  let end = Math.min(lines.length, ln);
  for (let i = ln; i <= maxEnd; i++) {
    end = i;
    if (/^\s*end\s+(function|sub)\b/i.test(lines[i - 1] || '')) break;
  }
  const width = String(end).length;
  const rows = [];
  for (let i = ln; i <= end; i++) {
    rows.push('    ' + c.dim(`${String(i).padStart(width)} │ `) + c.grey(lines[i - 1] || ''));
  }
  return rows.join('\n');
}

// Print the end-of-run failure summary: each failure as `Suite › test`, its file:line, a code frame, and
// the assertion reason.
function printFailures(cfg, out, cases, color) {
  const c = palette(color);
  const failures = cases.filter((t) => !t.ok);
  // Failures that only appear in the report tree (e.g. a beforeEach crash that never streamed an END marker).
  const known = new Set(failures.map((t) => t.name));
  for (const name of treeFailures(out)) if (!known.has(name)) failures.push({ name, ok: false });
  const dropped = droppedCases(out);
  const known2 = new Set(failures.map((t) => t.name));
  for (const d of dropped) if (!known2.has(d.name)) failures.push({ name: d.name, ok: false, dropped: d.reason });
  const crash = engineCrash(out);
  if (crash) for (const d of crash.cases) if (!failures.some((t) => t.name === d.name)) failures.push({ name: d.name, ok: false, dropped: d.reason });
  if (!failures.length) return;
  const msgs = failureMessages(out);
  process.stdout.write('\n' + c.red(c.bold(`  Failures (${failures.length})`)) + '\n');
  for (const f of failures) {
    const where = f.suite ? `${f.suite} › ${f.name}` : f.name;
    process.stdout.write('\n  ' + c.red('✗ ') + c.bold(where) + '\n');
    if (f.loc) process.stdout.write('    ' + c.grey(f.loc) + '\n');
    const frame = f.loc ? codeFrame(cfg, f.loc, c) : '';
    if (frame) process.stdout.write(frame + '\n');
    const reason = f.dropped || msgs[f.name];
    if (reason) process.stdout.write('    ' + c.yellow(reason) + '\n');
  }
}

// One-line device label for reports: model plus firmware (and build) when known. Never includes the serial.
function deviceLabel(info) {
  const i = info || {};
  const fw = i.softwareVersion || i.firmware;
  const build = i.build || i.softwareBuild;
  return [i.host, i.model, fw ? `firmware ${fw}${build ? ` (build ${build})` : ''}` : null].filter(Boolean).join(' · ');
}

module.exports = { deviceLabel, palette, relLoc, makeReporter, lineSplitter, parseSummary, laneFailures, treeFailures, treeCases, droppedCases, engineCrash, failureMessages, codeFrame, printFailures };
