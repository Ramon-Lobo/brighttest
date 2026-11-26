#!/usr/bin/env node
'use strict';
// Reduces the raw output of probe-api.js and probe-behavior.js to a small, stable, line-oriented
// fingerprint and diffs it against a committed baseline. Volatile fields (timings, timestamps, node
// version, pty-driven event records, free-text diagnostics) are dropped on purpose.
//
//   node baseline.js make <probe-raw.json> <behavior-raw.json> [out]     write a fingerprint (default: stdout)
//   node baseline.js diff <baseline> <probe-raw.json> <behavior-raw.json> [--strict]
//
// diff always prints the changed keys. It exits 1 on any difference only with --strict, so a stock
// engine (expected to drift from the patched baseline) can be reported without failing the job.
const fs = require('fs');
const crypto = require('crypto');

// Behaviour records whose value is random by design.
const VOLATILE = /(^|\.)rnd$/;
const short = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 8);

function fingerprint(api, beh) {
  const lines = [];
  for (const r of api.results) {
    const base = `api ${r.cat}/${r.name}`;
    lines.push(`${base} code=${r.code} timeout=${r.timeout}`);
    for (const rec of r.recs) lines.push(`${base} ${rec.kind} ${rec.name} ${rec.status} ${short(rec.extra)}`);
  }
  for (const l of beh.language) lines.push(`lang ${l.id} ${l.status} ${l.match} ${short(l.actual)}`);
  for (const [app, b] of Object.entries(beh.behavior || {})) {
    lines.push(`behavior ${app} complete=${b.complete} count=${b.count}`);
    for (const [k, v] of Object.entries(b.values)) if (!VOLATILE.test(k)) lines.push(`behavior ${app} ${k} ${short(v)}`);
  }
  return [...new Set(lines)].sort();
}

function diffLines(base, now) {
  const a = new Set(base), b = new Set(now);
  return { removed: base.filter((l) => !b.has(l)), added: now.filter((l) => !a.has(l)) };
}

const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
// Lines starting with '#' are the header (which engine the baseline was taken from) and are not compared.
const readLines = (p) => fs.readFileSync(p, 'utf8').split('\n').filter((l) => l && !l.startsWith('#'));
const header = (api) => `# engine ${api.engine.name}@${api.engine.version}`;

function main(argv) {
  const [cmd, ...rest] = argv;
  const strict = rest.includes('--strict');
  const args = rest.filter((x) => x !== '--strict');
  if (cmd === 'make' && args.length >= 2) {
    const api = read(args[0]);
    const out = [header(api), ...fingerprint(api, read(args[1]))].join('\n') + '\n';
    if (args[2]) fs.writeFileSync(args[2], out); else process.stdout.write(out);
    return 0;
  }
  if (cmd === 'diff' && args.length >= 3) {
    const d = diffLines(readLines(args[0]), fingerprint(read(args[1]), read(args[2])));
    for (const l of d.removed) console.log(`- ${l}`);
    for (const l of d.added) console.log(`+ ${l}`);
    console.log(`probe baseline: ${d.removed.length} removed, ${d.added.length} added`);
    return strict && (d.removed.length || d.added.length) ? 1 : 0;
  }
  console.error('usage: baseline.js make <probe-raw> <behavior-raw> [out] | diff <baseline> <probe-raw> <behavior-raw> [--strict]');
  return 2;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { fingerprint, diffLines, header };
