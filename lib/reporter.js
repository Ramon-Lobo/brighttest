'use strict';
const fs = require('fs');
const path = require('path');

// Shared test reporter used by every run lane (headless default, --coverage, --device). Rooibos emits the
// same console markers in all of them, so one parser drives a consistent, grouped, Jest-style view:
//   > SUITE: <name>            → a suite (≈ one spec file) starts
//   >>>> Describe: <group>     → a group (we don't print these, but they carry a Location)
//   >>>>>> It: <name>          → a test starts; the following `Location:` is its file:line
//   <<<< END It: <name> (PASS|FAIL)
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
    if ((m = line.match(/<<<<\s*END It:\s+(.+?)\s+\((PASS|FAIL)\)/))) {
      const name = m[1].trim();
      const ok = m[2] === 'PASS';
      state.cases.push({ suite: state.suite, name, ok, loc: state.curLoc });
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

// Parse the final report tree for each failed test's error message, keyed by test name.
function failureMessages(out) {
  const msgs = {};
  const lines = out.split(/\r\n|\r|\n/).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
  let pending = null;
  for (const line of lines) {
    let m = line.match(/\|--(.+?)\s*:\s*\.*\s*FAIL\b/);
    if (m) { pending = m[1].trim(); continue; }
    if (pending) {
      m = line.match(/Error Message:\s*(.+)$/);
      if (m) { msgs[pending] = m[1].trim(); pending = null; }
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
  if (!failures.length) return;
  const msgs = failureMessages(out);
  process.stdout.write('\n' + c.red(c.bold(`  Failures (${failures.length})`)) + '\n');
  for (const f of failures) {
    const where = f.suite ? `${f.suite} › ${f.name}` : f.name;
    process.stdout.write('\n  ' + c.red('✗ ') + c.bold(where) + '\n');
    if (f.loc) process.stdout.write('    ' + c.grey(f.loc) + '\n');
    const frame = f.loc ? codeFrame(cfg, f.loc, c) : '';
    if (frame) process.stdout.write(frame + '\n');
    const reason = msgs[f.name];
    if (reason) process.stdout.write('    ' + c.yellow(reason) + '\n');
  }
}

module.exports = { palette, relLoc, makeReporter, lineSplitter, failureMessages, codeFrame, printFailures };
