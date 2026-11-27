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
  brighttest issue collect [--host <ip>] [--include <path>]... [--out <dir>] [--area <area>] [--project <dir>] [--json]

redact  masks names, hosts, IPs, tokens, serials and personal paths with numbered placeholders (one mapping across all
        inputs), writes the result to stdout (one input) or -o, then checks what it wrote. Summary on stderr: counts only.
check   re-detects what a redaction would still change and lints the issue structure. Prints file:line kind (never the
        value) and a fingerprint: bt-xxxxxxxx.
collect writes <stagingDir>/issue/<stamp>/ with environment.json, ISSUE.md (skeleton), attachments/ (redacted text, 1 MB
        each, 5 MB total) and redaction.json (counts only), then checks the folder. --host adds a device-info read (no lease).
Exit 0 clean, 1 findings (redact still writes its output), 2 usage. Nothing here uses the network except collect --host.`;

function usageError(io, msg) { io.err(`[brighttest] issue: ${msg}\n${HELP}\n`); return 2; }

function parse(argv) {
  const o = { sub: null, files: [], out: null, host: null, includes: [], area: null, project: null, json: false, help: false, error: null };
  const rest = [...argv];
  if (rest.length && !rest[0].startsWith('-')) o.sub = rest.shift();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--json') o.json = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--host' || a === '--include' || a === '--area') {
      const v = rest[++i];
      if (v === undefined || v.startsWith('-')) { o.error = `${a} needs a value`; break; }
      if (a === '--host') o.host = v; else if (a === '--area') o.area = v; else o.includes.push(v);
    } else if (a.startsWith('--host=')) o.host = a.slice(7);
    else if (a.startsWith('--area=')) o.area = a.slice(7);
    else if (a.startsWith('--include=')) o.includes.push(a.slice(10));
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

// ---- collect -----------------------------------------------------------------------------------
// Writes a folder a person can read, edit and attach to a public issue. Everything written is redacted with one mapping
// and the folder is checked before exit. The device read (--host) is the doctor device-info GET: no lease, no password,
// no serial, and the host itself is never written.
const MAX_FILE = 1024 * 1024;
const MAX_TOTAL = 5 * 1024 * 1024;
const MAX_LINE = 64 * 1024; // the redactor is slow on very long lines
const BUNDLE_FILES = ['error.json', 'log-tail.txt', 'net-refused.txt'];
const pad = (n) => String(n).padStart(2, '0');
const stampOf = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

function countFiles(root) {
  const c = { brs: 0, xml: 0, spec: 0, truncated: false };
  let seen = 0;
  const walk = (dir, depth) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (c.truncated) return;
      if (e.isDirectory()) { if (depth < 8 && !['node_modules', '.git', '.brighttest', 'out', 'dist', 'coverage'].includes(e.name)) walk(path.join(dir, e.name), depth + 1); continue; }
      if (++seen > 20000) { c.truncated = true; return; }
      if (e.name.endsWith('.brs')) c.brs++;
      else if (e.name.endsWith('.xml')) c.xml++;
      if (/\.(spec|test)\.[a-z]+$/i.test(e.name) || /\.spec\.brs$/i.test(e.name)) c.spec++;
    }
  };
  walk(root, 0);
  return c;
}

function gitignored(projectDir, target) {
  const rel = path.relative(projectDir, target).split(path.sep).filter(Boolean);
  if (!rel.length || rel[0] === '..') return null; // outside the project: not our business
  let text;
  try { text = fs.readFileSync(path.join(projectDir, '.gitignore'), 'utf8'); } catch { return false; }
  const pats = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && !l.startsWith('!')).map((l) => l.replace(/^\//, '').replace(/\/$/, ''));
  for (let n = 1; n <= rel.length; n++) if (pats.includes(rel.slice(0, n).join('/')) || (n === 1 && pats.includes(rel[0]))) return true;
  return false;
}

function gatherEnvironment(o, env, projectDir, deviceInfo) {
  const pkg = require('../package.json');
  const e = {
    brighttest: pkg.version,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    ci: !!(env.CI && env.CI !== 'false' && env.CI !== '0'),
  };
  let cfg = {};
  try { cfg = require('./config').loadConfig(projectDir, null); } catch { cfg = {}; }
  const engines = {};
  try {
    const { engineFor } = require('./engines');
    for (const k of ['brsNode', 'rooibos']) {
      try { const g = engineFor(k, cfg); engines[k] = { name: String(g.name).split('/').pop(), version: g.version, flavor: g.flavor, ...(g.caps && g.caps.length ? { caps: g.caps } : {}) }; } catch { engines[k] = { unresolved: true }; }
    }
  } catch { /* engines module unavailable */ }
  e.engines = engines;
  const doctor = require('./doctor');
  const r0 = require('./devices').resolveDevice({ host: o.host || undefined, password: null, cwd: projectDir });
  e.doctorEnvironment = doctor.environmentReport(r0, { env, dot: require('./devices').loadDotEnv(projectDir) })
    .map((i) => ({ name: i.name, set: !!i.set, source: i.source, status: i.status }));
  e.envNames = Object.keys(env).filter((k) => /^(BRIGHTTEST_|ROKU_)/.test(k) && env[k] !== undefined && env[k] !== '').sort();
  let keys = [];
  try { keys = Object.keys(JSON.parse(fs.readFileSync(path.join(projectDir, 'brighttest.json'), 'utf8'))).sort(); } catch { keys = []; }
  e.configKeys = keys;
  const sc = countFiles(projectDir);
  e.project = { brs: sc.brs, xml: sc.xml, spec: sc.spec, ...(sc.truncated ? { truncated: true } : {}) };
  if (deviceInfo) e.device = deviceInfo;
  return e;
}

async function readDevice(host, env) {
  const ecp = require('./devices').resolveEcpPort(null);
  const r = await require('./doctor').inspectDevice(host, ecp);
  if (!r.reachable) return { reachable: false };
  return {
    reachable: true, model: r.model, firmware: r.softwareVersion, build: r.build, deviceClass: r.deviceClass,
    ecpMode: r.ecpSettingMode, developerMode: r.developerEnabled, videoMode: r.videoMode, uiResolution: r.uiResolution,
  };
}

function renderEnvironmentMd(e) {
  const L = [];
  L.push(`- brighttest: ${e.brighttest}`, `- Node: ${e.node} (${e.platform} ${e.arch})${e.ci ? ', CI' : ''}`);
  for (const [k, g] of Object.entries(e.engines)) L.push(`- ${k}: ${g.unresolved ? 'unresolved' : `${g.name}@${g.version} (${g.flavor})`}`);
  L.push(`- project files: ${e.project.brs} .brs, ${e.project.xml} .xml, ${e.project.spec} spec`);
  L.push(`- brighttest.json keys: ${e.configKeys.length ? e.configKeys.join(', ') : 'none'}`);
  L.push(`- environment variables set (names only): ${e.envNames.length ? e.envNames.join(', ') : 'none'}`);
  if (e.device) {
    const d = e.device;
    L.push(d.reachable
      ? `- device: ${d.model || '?'}, ${d.deviceClass || '?'}, firmware ${d.firmware || '?'}${d.build ? ` (build ${d.build})` : ''}, ECP ${d.ecpMode || '?'}, developer mode ${d.developerMode === null || d.developerMode === undefined ? '?' : d.developerMode ? 'enabled' : 'disabled'}`
      : '- device: not reachable');
  }
  return L.join('\n');
}

function skeleton(e, o, attached) {
  const prompt = {
    Summary: 'One or two sentences: what broke, in which command, and the impact.',
    Severity: 'blocker | high | medium | low',
    Area: o.area ? String(o.area).split(/\r?\n/)[0].trim() : 'Which part of brighttest (for example Headless, Device, End-to-end (e2e), Studio, Instrument).',
    'Steps to reproduce': 'Numbered steps, with the exact command.',
    'Expected behavior': 'What you expected to happen.',
    'Actual behavior': 'What happened instead (paste the first error line).',
    Evidence: attached.length ? attached.map((n) => `- attachments/${n}`).join('\n') : 'List the files you attach, or write: none.',
    'Minimal reproduction': 'A smaller project or file that shows it, or write: not yet.',
    'Before filing': 'Read every line of this file and remove anything private, then run: brighttest issue check ISSUE.md',
  };
  const out = ['<!-- Edit each section. Everything here was redacted automatically; read it before you file. -->', ''];
  for (const s of ISSUE_SECTIONS) { out.push(`### ${s}`, '', s === 'Environment' ? renderEnvironmentMd(e) : prompt[s], ''); }
  return out.join('\n');
}

// Returns { files: [{name,text}], leftOut: [{item,reason}] } or { error }.
function gatherAttachments(includes, cwd) {
  const files = [];
  const leftOut = [];
  let total = 0;
  const used = new Set();
  let bundleN = 0;
  const add = (rel, buf, idx) => {
    if (buf.length > MAX_FILE) { leftOut.push({ item: `include #${idx}`, reason: 'larger than 1 MB' }); return; }
    if (total + buf.length > MAX_TOTAL) { leftOut.push({ item: `include #${idx}`, reason: 'total attachments would pass 5 MB' }); return; }
    const text = buf.toString('utf8');
    if (buf.includes(0) || text.includes('\uFFFD')) { leftOut.push({ item: `include #${idx}`, reason: 'not a text file' }); return; }
    if (text.split('\n').some((l) => l.length > MAX_LINE)) { leftOut.push({ item: `include #${idx}`, reason: 'has a line longer than 64 KB (minified or single-line output; split it first)' }); return; }
    let name = rel;
    while (used.has(name)) name = path.posix.join(path.posix.dirname(name), '_' + path.posix.basename(name));
    used.add(name);
    total += buf.length;
    files.push({ name: path.posix.join('attachments', name), text });
  };
  for (const [n, inc] of includes.entries()) {
    const idx = n + 1;
    const p = path.resolve(cwd, inc);
    let st;
    try { st = fs.statSync(p); } catch { return { error: `cannot read include #${idx}` }; }
    if (st.isDirectory()) {
      if (!fs.existsSync(path.join(p, 'error.json'))) { leftOut.push({ item: `include #${idx}`, reason: 'a directory that is not an e2e failure bundle (name files explicitly)' }); continue; }
      const dirName = `failure-bundle-${++bundleN}`;
      for (const f of BUNDLE_FILES) {
        const fp = path.join(p, f);
        if (!fs.existsSync(fp)) continue;
        try { add(`${dirName}/${f}`, fs.readFileSync(fp), idx); } catch { leftOut.push({ item: `include #${idx}`, reason: `cannot read ${f}` }); }
      }
      leftOut.push({ item: `include #${idx}`, reason: 'tree.xml and screenshots left out on purpose' });
    } else {
      try { add(path.basename(p), fs.readFileSync(p), idx); } catch { return { error: `cannot read include #${idx}` }; }
    }
  }
  return { files, leftOut };
}

async function runCollect(o, io) {
  const projectDir = path.resolve(o.project || io.cwd());
  if (o.files.length) return usageError(io, 'collect takes --include <path>, not positional files');
  if (o.host !== null && !o.host) return usageError(io, '--host needs a value');
  const att = gatherAttachments(o.includes, io.cwd());
  if (att.error) return usageError(io, att.error);
  let staging = path.join(projectDir, '.brighttest');
  try { staging = require('./config').loadConfig(projectDir, null).stagingDir || staging; } catch { /* default */ }
  const dir = o.out ? path.resolve(io.cwd(), o.out) : path.join(staging, 'issue', stampOf(new Date()));
  if (fs.existsSync(dir) && (!fs.statSync(dir).isDirectory() || fs.readdirSync(dir).length)) return usageError(io, 'the output folder exists and is not empty');
  let device = null;
  if (o.host) {
    try { device = await readDevice(o.host, io.env); } catch { device = { reachable: false }; }
  }
  const e = gatherEnvironment(o, io.env, projectDir, device);
  const raw = [
    { name: 'environment.json', text: JSON.stringify(e, null, 2) + '\n' },
    { name: 'ISSUE.md', text: skeleton(e, o, att.files.map((f) => f.name.slice('attachments/'.length))) },
    ...att.files,
  ];
  const ctx = makeCtx(o, io);
  const counts = {};
  for (const r of raw) for (const l of redactor.verify(r.text, ctx)) counts[l.kind] = (counts[l.kind] || 0) + 1;
  const outs = redactor.redact(raw, ctx);
  const summary = { counts: Object.entries(counts).map(([kind, lines]) => ({ kind, lines })), skippedDenyTerms: ctx.skipped.length, files: outs.map((f) => f.name), leftOut: att.leftOut };
  outs.push({ name: 'redaction.json', text: JSON.stringify(summary, null, 2) + '\n' });
  const res = checkTexts(outs, ctx);
  for (const f of outs) {
    const target = path.join(dir, ...f.name.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, f.text);
  }
  if (!fs.existsSync(path.join(dir, 'attachments'))) fs.mkdirSync(path.join(dir, 'attachments'));
  const ignored = gitignored(projectDir, dir);
  const warnings = [];
  if (ignored === false) warnings.push('.brighttest/ is not in .gitignore: add it so this folder is not committed');
  const rel = (path.relative(io.cwd(), dir) || '.').split(path.sep).join('/');
  if (o.json) io.out(JSON.stringify({ dir: rel, files: outs.map((f) => f.name), leaks: res.leaks, leftOut: att.leftOut, warnings }) + '\n');
  else {
    io.out(`wrote ${rel}\n`);
    for (const f of outs) io.out(`  ${f.name}\n`);
    for (const l of att.leftOut) io.err(`left out: ${l.item}: ${l.reason}\n`);
    for (const w of warnings) io.err(`warning: ${w}\n`);
    for (const l of res.leaks) io.err(`${l.file}:${l.line} ${l.kind}\n`);
    io.err('Read ISSUE.md and the attachments line by line before you file anything.\n');
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
  if (o.sub === 'collect') return runCollect(o, env); // a Promise: the caller awaits
  return usageError(env, o.sub ? `unknown action ${o.sub}` : 'an action is required (redact, check or collect)');
}

module.exports = { run, lint, parseSections, fingerprintOf, ISSUE_SECTIONS, REQUIRED_SECTIONS, SEVERITIES, HELP };
