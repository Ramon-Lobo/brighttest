'use strict';
const fs = require('fs');
const path = require('path');

// JUnit XML for `brighttest e2e run --junit <file>`. Written by hand (no dependency) and deterministic:
// no timestamps, durations or random ids, so the same results give the same bytes.
//
// A record is { suite, name, status: 'passed'|'failed'|'skipped', step?, code?, message? }.
// One <testsuite> per flow file (suite), one <testcase> per run of that flow (a deep-link matrix run adds
// its contentId to the case name).

// Escape for XML text and attribute values; drop characters XML 1.0 cannot carry.
function esc(v) {
  return String(v == null ? '' : v)
    .replace(/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
    .replace(/\r/g, '&#13;').replace(/\n/g, '&#10;').replace(/\t/g, '&#9;');
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function failureMessage(r) {
  const where = r.step ? `step ${r.step}: ` : '';
  const code = r.code ? `${r.code}: ` : '';
  return `${where}${code}${r.message || 'failed'}`;
}

function buildJunit(records) {
  const sorted = records.slice().sort((a, b) => cmp(a.suite, b.suite) || cmp(a.name, b.name));
  const suites = new Map();
  for (const r of sorted) {
    if (!suites.has(r.suite)) suites.set(r.suite, []);
    suites.get(r.suite).push(r);
  }
  const count = (list, s) => list.filter((r) => r.status === s).length;
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>'];
  lines.push(`<testsuites name="brighttest e2e" tests="${sorted.length}" failures="${count(sorted, 'failed')}" skipped="${count(sorted, 'skipped')}">`);
  for (const [suite, list] of suites) {
    lines.push(`  <testsuite name="${esc(suite)}" tests="${list.length}" failures="${count(list, 'failed')}" skipped="${count(list, 'skipped')}">`);
    for (const r of list) {
      const open = `    <testcase classname="${esc(suite)}" name="${esc(r.name)}"`;
      if (r.status === 'failed') {
        const type = r.code ? ` type="${esc(r.code)}"` : '';
        lines.push(`${open}>`, `      <failure message="${esc(failureMessage(r))}"${type}>${esc(failureMessage(r))}</failure>`, '    </testcase>');
      } else if (r.status === 'skipped') {
        lines.push(`${open}>`, `      <skipped message="${esc(r.message || 'skipped')}"/>`, '    </testcase>');
      } else lines.push(`${open}/>`);
    }
    lines.push('  </testsuite>');
  }
  lines.push('</testsuites>', '');
  return lines.join('\n');
}

function writeJunit(file, records) {
  const out = path.resolve(file);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, buildJunit(records));
  return out;
}

module.exports = { esc, buildJunit, writeJunit };
