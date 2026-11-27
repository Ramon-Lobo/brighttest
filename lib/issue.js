'use strict';
// `brighttest issue redact` and `issue check` (design: issue-reporting-skill 4.3; ADR 0054).
// Local only: reads files or stdin, writes files or stdout. No network, no device, no lease. Never prints a value that a
// detector matched: findings carry file, line and kind only. Exit 0 clean, 1 findings, 2 usage.
const fs = require('fs');
const path = require('path');
const redactor = require('./redact');
const { buildContext } = require('./redact-sources');

// Headings of the field-report form (.github/ISSUE_TEMPLATE/field_report.yml), in order. A test keeps them equal.
const ISSUE_SECTIONS = ['Summary', 'Severity', 'Area', 'Environment', 'Steps to reproduce', 'Expected behavior', 'Actual behavior', 'Evidence', 'Minimal reproduction', 'Before filing'];
const REQUIRED_SECTIONS = ['Summary', 'Severity', 'Area', 'Environment', 'Steps to reproduce', 'Expected behavior', 'Actual behavior', 'Before filing'];
const SEVERITIES = ['blocker', 'high', 'medium', 'low'];

const HELP = `usage:
  brighttest issue redact [<file>... | -] [-o <file|dir>] [--project <dir>] [--json]
  brighttest issue check  [<file>... | -] [--project <dir>] [--json]

redact  masks names, hosts, IPs, tokens, serials and personal paths with numbered placeholders (one mapping across all
        inputs), writes the result to stdout (one input) or -o, then checks what it wrote. Summary on stderr: counts only.
check   re-detects what a redaction would still change and lints the issue structure. Prints file:line kind (never the
        value) and a fingerprint: bt-xxxxxxxx.
Exit 0 clean, 1 findings (redact still writes its output), 2 usage. Nothing here uses the network.`;

function usageError(io, msg) { io.err(`[brighttest] issue: ${msg}\n${HELP}\n`); return 2; }

function parse(argv) {
  const o = { sub: null, files: [], out: null, project: null, json: false, help: false, error: null };
  const rest = [...argv];
  if (rest.length && !rest[0].startsWith('-')) o.sub = rest.shift();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--json') o.json = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a === '-o' || a === '--out' || a === '--project') {
      const v = rest[++i];
      if (v === undefined || (v.startsWith('-') && v !== '-')) { o.error = `${a} needs a value`; break; }
      if (a === '--project') o.project = v; else o.out = v;
    } else if (a.startsWith('--out=')) o.out = a.slice(6);
    else if (a.startsWith('--project=')) o.project = a.slice(10);
    else if (a === '-') o.files.push('-');
    else if (a.startsWith('-')) { o.error = `unknown flag ${a}`; break; }
    else o.files.push(a);
  }
  return o;
}

function readInputs(files, io) {
  const list = files.length ? files : ['-'];
  const inputs = [];
  for (const f of list) {
    if (f === '-') inputs.push({ name: '<stdin>', text: io.stdin() });
    else {
      let text;
      try { text = fs.readFileSync(f, 'utf8'); } catch (e) { return { error: `cannot read ${f}: ${e.code || 'error'}` }; }
      inputs.push({ name: f, text });
    }
  }
  return { inputs };
}

// ---- structure lint ----------------------------------------------------------------------------
// Sections are `###` headings (markdown body of a field report). A text with none of the known headings is a plain
// attachment (log, json): no structure lint, sections [].
function parseSections(text) {
  const out = [];
  let cur = null;
  for (const line of String(text).split('\n')) {
    const m = /^#{2,4}\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) { cur = { name: m[1].trim(), body: [] }; out.push(cur); } else if (cur) cur.body.push(line);
  }
  return out.map((s) => ({ name: s.name, body: s.body.join('\n').trim() }));
}
const findSection = (secs, name) => secs.find((s) => s.name.toLowerCase() === name.toLowerCase());

function lint(text) {
  const secs = parseSections(text);
  const known = secs.filter((s) => ISSUE_SECTIONS.some((n) => n.toLowerCase() === s.name.toLowerCase()));
  if (!known.length) return { sections: [], warnings: [] };
  const warnings = [];
  for (const n of REQUIRED_SECTIONS) {
    const s = findSection(secs, n);
    if (!s) warnings.push(`missing required section: ${n}`);
  }
  const actual = findSection(secs, 'Actual behavior');
  if (actual && !actual.body) warnings.push('Actual behavior is empty');
  const sev = findSection(secs, 'Severity');
  if (sev && sev.body && !SEVERITIES.includes(sev.body.split('\n')[0].trim().toLowerCase())) warnings.push(`Severity is not one of ${SEVERITIES.join(', ')}`);
  const env = findSection(secs, 'Environment');
  if (env && !/\d+\.\d+\.\d+/.test(env.body)) warnings.push('Environment has no brighttest version');
  return { sections: known.map((s) => s.name), warnings };
}

function fingerprintOf(text) {
  const secs = parseSections(text);
  const area = (findSection(secs, 'Area') || { body: '' }).body.split('\n')[0];
  const actual = (findSection(secs, 'Actual behavior') || { body: '' }).body;
  const pick = (s) => String(s).split('\n').find((l) => l.trim() && !/^```/.test(l.trim())) || '';
  const first = pick(actual) || pick(text);
  return redactor.fingerprint(area, first);
}

function checkTexts(inputs, ctx) {
  const leaks = [];
  const warnings = [];
  let sections = [];
  for (const i of inputs) {
    for (const l of redactor.verify(i.text, ctx)) leaks.push({ file: i.name, line: l.line, kind: l.kind });
    const r = lint(i.text);
    for (const w of r.warnings) warnings.push(inputs.length > 1 ? `${i.name}: ${w}` : w);
    if (r.sections.length) sections = r.sections;
  }
  const all = inputs.map((i) => i.text).join('\n');
  return { leaks, warnings, fingerprint: fingerprintOf(inputs.length === 1 ? inputs[0].text : all), sections };
}

function report(res, o, io) {
  if (o.json) { io.out(JSON.stringify(res) + '\n'); return; }
  for (const l of res.leaks) io.err(`${l.file}:${l.line} ${l.kind}\n`);
  for (const w of res.warnings) io.err(`warning: ${w}\n`);
  io.err(`fingerprint: ${res.fingerprint}\n`);
}

// ---- subcommands -------------------------------------------------------------------------------
function makeCtx(o, io) { return buildContext({ dir: path.resolve(o.project || io.cwd()), env: io.env, home: io.home }).ctx; }

function runCheck(o, io) {
  const r = readInputs(o.files, io);
  if (r.error) return usageError(io, r.error);
  const res = checkTexts(r.inputs, makeCtx(o, io));
  if (o.json) io.out(JSON.stringify(res) + '\n'); else report(res, o, io);
  return res.leaks.length ? 1 : 0;
}

function runRedact(o, io) {
  const r = readInputs(o.files, io);
  if (r.error) return usageError(io, r.error);
  if (r.inputs.length > 1 && !o.out) return usageError(io, 'several inputs need -o <dir>');
  const ctx = makeCtx(o, io);
  const outs = redactor.redact(r.inputs, ctx);
  const counts = {};
  for (const [i, out] of outs.entries()) {
    const a = r.inputs[i].text.split('\n'); const b = out.text.split('\n');
    counts[r.inputs[i].name] = a.reduce((n, l, j) => n + (l !== b[j] ? 1 : 0), 0);
  }
  if (!o.out) io.out(outs[0].text);
  else if (outs.length === 1 && !(fs.existsSync(o.out) && fs.statSync(o.out).isDirectory())) fs.writeFileSync(o.out, outs[0].text);
  else {
    fs.mkdirSync(o.out, { recursive: true });
    const used = new Set();
    for (const out of outs) {
      let n = out.name === '<stdin>' ? 'stdin.txt' : path.basename(out.name);
      while (used.has(n)) n = '_' + n;
      used.add(n);
      fs.writeFileSync(path.join(o.out, n), out.text);
    }
  }
  const res = checkTexts(outs, ctx);
  const summary = { changedLines: counts, skippedDenyTerms: ctx.skipped.length };
  if (o.json) io.out(JSON.stringify({ ...res, summary }) + '\n');
  else {
    io.err(`redacted ${outs.length} input(s); changed lines: ${Object.values(counts).reduce((a, b) => a + b, 0)}; skipped deny terms: ${ctx.skipped.length}\n`);
    report(res, o, io);
  }
  return res.leaks.length ? 1 : 0;
}

function run(argv, io = {}) {
  const env = {
    out: io.out || ((s) => process.stdout.write(s)),
    err: io.err || ((s) => process.stderr.write(s)),
    stdin: io.stdin || (() => { try { return fs.readFileSync(0, 'utf8'); } catch { return ''; } }),
    cwd: io.cwd || (() => process.cwd()),
    env: io.env || process.env,
    home: io.home,
  };
  const o = parse(argv);
  if (o.help && !o.error) { env.out(HELP + '\n'); return 0; }
  if (o.error) return usageError(env, o.error);
  if (o.sub === 'redact') return runRedact(o, env);
  if (o.sub === 'check') return runCheck(o, env);
  return usageError(env, o.sub ? `unknown action ${o.sub}` : 'an action is required (redact or check)');
}

module.exports = { run, lint, parseSections, fingerprintOf, ISSUE_SECTIONS, REQUIRED_SECTIONS, SEVERITIES, HELP };
