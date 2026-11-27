'use strict';
// Changelog helper for docs/changelog.md (design: docs-changelog, ADR 0037). Plain Node, no dependencies.
//   node scripts/changelog.js draft [--from <tag>] [--to <ref>] [--prs]   print a Markdown draft from conventional commits
//   node scripts/changelog.js check [--tags] [--version X.Y.Z | --version-env] [--file F]  validate the changelog (exit 0 clean, 1 findings, 2 usage)
//   node scripts/changelog.js stamp [--version X.Y.Z] [--date D] [--file F]  turn Unreleased into a release section
//   node scripts/changelog.js slice --upto vX.Y.Z --tree <dir> [--out F]   changelog cut to a tag, for old versioned builds
//   node scripts/changelog.js notes vX.Y.Z                                 print one section's body
//   node scripts/changelog.js pages [--from-tag vX.Y.Z] [--write] [--version X.Y.Z]  page list for the New/Updated badges
// git and gh go through an injected run(cmd, args) => { status, stdout, stderr } so tests can mock them.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const badges = require('./docs-badges.js');

// ---- Tunables (edit here) ----
const DROP_TYPES = ['docs', 'test', 'chore', 'ci', 'build', 'style', 'refactor'];
const INTERNAL_SCOPES = ['adopt-eval', 'agents', 'scripts', 'fixtures', 'fake-roku', 'examples', 'deps'];
const SCOPE_AREAS = [
  ['Studio', ['studio', 'perfetto']],
  ['Instrumentation and app state', ['instrument', 'state', 'hub', 'spec-api', 'config']],
  ['Network faults', ['net']],
  ['E2E', ['e2e', 'ecp']],
  ['Adoption (assess, init, skills)', ['assess', 'skills', 'init', 'greenfield']],
  ['Agent surface (MCP)', ['mcp']],
  ['Devices and lease', ['lease', 'device', 'devices', 'doctor']],
  ['CLI and lanes', ['cli', 'headless', 'reporter', 'cov', 'engines', 'build', 'pkg', 'package']],
];
const OTHER_AREA = 'Other';
const SECURITY_WORDS = ['mask', 'redact', 'token', 'cross-origin', 'credential', '0600', 'secret'];
const SECTIONS = ['Breaking changes', 'Security', 'Features', 'Improvements', 'Fixes', 'Upgrade notes'];
const ID_ALLOWLIST = ['UTF-8', 'UTF-16', 'SHA-1', 'SHA-256', 'SHA-384', 'SHA-512', 'ISO-8601'];

// ---- Runner ----
function defaultRun(cmd, args, opts) {
  const r = spawnSync(cmd, args, Object.assign({ encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }, opts));
  return { status: r.error ? null : r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error };
}

// ---- Version helpers ----
const VER_RE = /^v?(\d+)\.(\d+)\.(\d+)$/;
// A prerelease (0.8.0-rc.0) gets no changelog section: stamp leaves Unreleased alone, check does not require a section
// for it, and its release notes are the Unreleased body. The stable release that follows stamps the section.
const PRE_RE = /^v?\d+\.\d+\.\d+-[0-9A-Za-z.-]+$/;
function cmpVer(a, b) {
  const pa = VER_RE.exec(a), pb = VER_RE.exec(b);
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d) return d;
  }
  return 0;
}
const anchorOf = (v) => 'v' + v.replace(/^v/, '').replace(/\./g, '-');

// ---- draft ----
function parseSubject(subject) {
  const m = /^(\w+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/.exec(subject.trim());
  if (!m) return null;
  return { type: m[1].toLowerCase(), scope: (m[2] || '').toLowerCase(), bang: !!m[3], text: m[4] };
}

function parseLog(raw) {
  const out = [];
  for (const chunk of raw.split('\x1e')) {
    if (!chunk.trim()) continue;
    const parts = chunk.split('\x1f');
    if (parts.length < 4) continue;
    const files = parts.slice(3).join('\x1f').split('\n').map((s) => s.trim()).filter(Boolean);
    out.push({ hash: parts[0].trim(), subject: parts[1], body: parts[2], files });
  }
  return out;
}

function scrub(text) {
  let t = text;
  t = t.replace(/\s*\(?\b(?:review|lint|ci)\s+fix(?:es)?\b\)?:?/gi, '');
  t = t.replace(/\s*\(?\bADR[ -]?\d+(?:\s+amendment(?:\s*\([a-z0-9]\))?)?\)?:?/gi, '');
  t = t.replace(/\s*\[?\b[A-Z]{2,}-[A-Z]?\d+\b\]?:?/g, '');
  t = t.replace(/\s*\(?\b(?:[TM]\d+(?:\/[TM]\d+)*)\b\)?:?/g, '');
  t = t.replace(/\s*\(?\bPhase \d+\w*\b\)?:?/gi, '');
  t = t.replace(/\(\s*\)/g, '').replace(/\s{2,}/g, ' ').replace(/^[\s:,;-]+|[\s:,;-]+$/g, '');
  return t ? t[0].toUpperCase() + t.slice(1) : t;
}

function areaOf(scope) {
  for (const [area, scopes] of SCOPE_AREAS) if (scopes.includes(scope)) return area;
  return OTHER_AREA;
}

const isTestFile = (f) => /(^|\/)(test|tests|__tests__|fixtures)\//.test(f) || /\.(test|spec)\.[a-z]+$/.test(f);

function classify(commit, existsAtFrom) {
  const p = parseSubject(commit.subject);
  if (!p) return { drop: 'unparsed' };
  const breaking = p.bang || /BREAKING[ -]CHANGE/.test(commit.body);
  if (!breaking && DROP_TYPES.includes(p.type)) return { drop: 'type' };
  if (INTERNAL_SCOPES.includes(p.scope)) return { drop: 'scope' };
  let section;
  if (breaking) section = 'Breaking changes';
  else if (p.type === 'feat') section = 'Features';
  else if (p.type === 'perf') section = 'Improvements';
  else if (p.type === 'fix') section = 'Fixes';
  else return { drop: 'type' };
  const sourceFiles = commit.files.filter((f) => !isTestFile(f));
  if (p.type === 'fix' && !breaking) {
    if (!sourceFiles.length || !sourceFiles.some(existsAtFrom)) return { drop: 'internal-fix' };
    if (SECURITY_WORDS.some((w) => p.text.toLowerCase().includes(w))) section = 'Security candidates';
  }
  return { section, scope: p.scope, area: areaOf(p.scope), text: scrub(p.text), raw: commit.subject, files: sourceFiles };
}

const phraseKey = (e) => e.section + '|' + e.scope + '|' + e.text.toLowerCase().split(/\s+/).slice(0, 3).join(' ');

function foldSeries(entries) {
  const groups = [];
  const byKey = new Map();
  for (const e of entries) {
    // Fold only when the leading phrase matches (same section and scope); sharing one file is not enough.
    const key = phraseKey(e);
    let g = byKey.get(key);
    if (!g) {
      g = { section: e.section, area: e.area, items: [] };
      groups.push(g);
      byKey.set(key, g);
    }
    g.items.push(e);
  }
  return groups;
}

function minNode(range) {
  const m = /(\d+)(?:\.(\d+))?/.exec(range || '');
  return m ? Number(m[1]) + (m[2] ? Number(m[2]) / 1000 : 0) : null;
}

function depLines(fromPkg, toPkg) {
  const lines = { improvements: [], breaking: [] };
  if (!fromPkg || !toPkg) return lines;
  const fd = fromPkg.dependencies || {}, td = toPkg.dependencies || {};
  for (const name of Object.keys(td).sort()) {
    if (fd[name] === td[name]) continue;
    const fork = name.startsWith('@ramonlobo/');
    const what = fd[name] ? `updated to ${td[name]} (was ${fd[name]})` : `added at ${td[name]}`;
    lines.improvements.push(fork ? `**Dependencies:** Engine fork ${name} ${what}` : `**Dependencies:** ${name} ${what}`);
  }
  for (const name of Object.keys(fd).sort()) {
    if (!(name in td)) lines.improvements.push(`**Dependencies:** ${name} removed`);
  }
  const fn = (fromPkg.engines || {}).node, tn = (toPkg.engines || {}).node;
  if (fn !== tn && tn) {
    const a = minNode(fn), b = minNode(tn);
    if (a !== null && b !== null && b > a) lines.breaking.push(`**Node:** minimum Node.js is now ${tn} (was ${fn})`);
    else lines.improvements.push(`**Node:** supported Node.js range is now ${tn}${fn ? ` (was ${fn})` : ''}`);
  }
  return lines;
}

function latestTag(run, cwd) {
  const r = run('git', ['tag', '--list', 'v*', '--sort=-v:refname'], { cwd });
  return (r.stdout || '').split('\n').map((s) => s.trim()).find((t) => /^v\d+\.\d+\.\d+$/.test(t)) || null;
}

function resolvePrs(commits, run, repoSlug, notes) {
  const gh = run('gh', ['auth', 'status'], {});
  if (gh.status !== 0) {
    notes.push('--prs: gh is not installed or not authenticated; PR numbers skipped.');
    return;
  }
  for (const c of commits) {
    const r = run('gh', ['api', `repos/${repoSlug}/commits/${c.hash}/pulls`, '--jq', '.[0].number'], {});
    const n = r.status === 0 ? (r.stdout || '').trim() : '';
    if (/^\d+$/.test(n)) c.pr = n;
  }
}

function repoSlugOf(run, cwd) {
  const r = run('git', ['remote', 'get-url', 'origin'], { cwd });
  const m = /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\s*$/.exec(r.stdout || '');
  return m ? m[1] : '{owner}/{repo}';
}

function draft(opts, run, cwd) {
  const notes = [];
  const from = opts.from || latestTag(run, cwd);
  if (!from) throw new Error('no v* tag found; pass --from <ref>');
  const to = opts.to || 'HEAD';
  const log = run('git', ['log', '--no-merges', '--reverse', '--name-only', '--format=%x1e%H%x1f%s%x1f%b%x1f', `${from}..${to}`], { cwd });
  if (log.status !== 0) {
    const ex = new Error(`bad ref: git log ${from}..${to} failed (${(log.stderr || '').trim() || 'unknown ref'}); check --from/--to`);
    ex.code = 'BADREF';
    throw ex;
  }
  const commits = parseLog(log.stdout);

  const existsCache = new Map();
  const existsAtFrom = (f) => {
    if (!existsCache.has(f)) existsCache.set(f, run('git', ['cat-file', '-e', `${from}:${f}`], { cwd }).status === 0);
    return existsCache.get(f);
  };

  const kept = [], droppedInternal = [];
  for (const c of commits) {
    const r = classify(c, existsAtFrom);
    if (r.drop === 'internal-fix') droppedInternal.push(c.subject);
    if (r.drop) continue;
    Object.assign(c, r);
    kept.push(c);
  }
  if (opts.prs) resolvePrs(kept, run, repoSlugOf(run, cwd), notes);

  const readPkg = (ref) => {
    const r = run('git', ['show', `${ref}:package.json`], { cwd });
    try { return r.status === 0 ? JSON.parse(r.stdout) : null; } catch (e) { return null; }
  };
  const deps = depLines(readPkg(from), readPkg(to));

  const groups = foldSeries(kept);
  const bySection = {};
  const add = (section, area, line) => {
    ((bySection[section] = bySection[section] || {})[area] = bySection[section][area] || []).push(line);
  };
  for (const g of groups) {
    const prs = [...new Set(g.items.map((i) => i.pr).filter(Boolean))].map((n) => `#${n}`);
    const suffix = prs.length ? ` (${prs.join(', ')})` : '';
    const first = g.items[0];
    let line = `- **${g.area}:** ${first.text}`;
    if (g.items.length > 1) {
      line += ` (${g.items.length} related changes)${suffix}\n` +
        `  <!-- series: ${g.items.map((i) => i.raw.replace(/-->/g, '--&gt;')).join(' | ')} -->`;
    } else line += suffix;
    add(g.section, g.area, line);
  }
  for (const l of deps.breaking) add('Breaking changes', 'Dependencies', `- ${l}`);
  for (const l of deps.improvements) add('Improvements', 'Dependencies', `- ${l}`);

  const out = [];
  out.push(`<!-- Draft for ${from}..${to}. Curate for users: rewrite lines, move items between sections, add upgrade notes. Never paste as is. -->`);
  for (const n of notes) out.push(`<!-- note: ${n} -->`);
  out.push('');
  const order = ['Breaking changes', 'Security candidates', 'Features', 'Improvements', 'Fixes'];
  for (const section of order) {
    const areas = bySection[section];
    if (!areas) continue;
    out.push(`### ${section}`);
    if (section === 'Security candidates') out.push('<!-- Confirm each one is a security fix in released code, then move to "### Security". -->');
    for (const area of Object.keys(areas).sort((a, b) => (a === OTHER_AREA) - (b === OTHER_AREA) || a.localeCompare(b))) {
      out.push(...areas[area]);
    }
    out.push('');
  }
  if (droppedInternal.length) {
    out.push(`<!-- internal fixes (dropped): fixes to code added after ${from}, ${droppedInternal.length} commits`);
    for (const s of droppedInternal) out.push(`  ${s.replace(/-->/g, '--&gt;')}`);
    out.push('-->');
    out.push('');
  }
  return { text: out.join('\n'), notes };
}

// ---- changelog parsing ----
function splitSections(text) {
  const lines = text.split('\n');
  const sections = [];
  let cur = null;
  const head = [];
  lines.forEach((line, i) => {
    if (/^## /.test(line)) {
      cur = { heading: line, start: i, lines: [] };
      sections.push(cur);
    } else if (cur) cur.lines.push(line);
    else head.push(line);
  });
  return { head, sections };
}

const VERSION_HEADING = /^## v(\d+\.\d+\.\d+) - (\d{4}-\d{2}-\d{2}) \{#(v\d+-\d+-\d+)\}\s*$/;
const UNRELEASED_HEADING = /^## Unreleased \{#unreleased\}\s*$/;
const entryLines = (lines) => lines.filter((l) => /^\s*[-*] \S/.test(l));
// Entry lines that are not under Upgrade notes.
function changeLines(lines) {
  let inUpgrade = false;
  const out = [];
  for (const l of lines) {
    const h = /^### (.+?)(?:\s*\{#.*\})?\s*$/.exec(l);
    if (h) inUpgrade = h[1] === 'Upgrade notes';
    else if (!inUpgrade && /^\s*[-*] \S/.test(l)) out.push(l);
  }
  return out;
}

function sectionVersion(s) {
  const m = VERSION_HEADING.exec(s.heading);
  return m ? m[1] : null;
}

function check(text, opts) {
  const findings = [];
  const f = (msg) => findings.push(msg);
  const { sections } = splitSections(text);
  if (!sections.length) f('no "## " sections found');
  else if (!UNRELEASED_HEADING.test(sections[0].heading)) f(`first section must be "## Unreleased {#unreleased}", found: ${sections[0].heading}`);

  const seen = new Set();
  for (const s of sections) {
    const isUnrel = UNRELEASED_HEADING.test(s.heading);
    const m = VERSION_HEADING.exec(s.heading);
    if (!isUnrel && !m) {
      f(`bad section heading (want "## vX.Y.Z - YYYY-MM-DD {#vX-Y-Z}"): ${s.heading}`);
      continue;
    }
    if (isUnrel && s !== sections[0]) f('"## Unreleased" must be the first section');
    const label = isUnrel ? 'Unreleased' : 'v' + m[1];
    if (m) {
      if (m[3] !== anchorOf(m[1])) f(`${label}: anchor should be {#${anchorOf(m[1])}}`);
      if (seen.has(m[1])) f(`${label}: duplicate section`);
      seen.add(m[1]);
      const re = new RegExp('/compare/[^)\\s]*v' + m[1].replace(/\./g, '\\.') + '\\)');
      if (!s.lines.some((l) => re.test(l))) f(`${label}: missing compare link ("[Full diff](.../compare/vA...v${m[1]})")`);
    }
    // Section headings: allowed, in order.
    let last = -1;
    const names = [];
    for (const l of s.lines) {
      const h = /^### (.+?)(?:\s*\{#[^}]*\})?\s*$/.exec(l);
      if (!/^###(?!#)/.test(l)) continue;
      if (!h) { f(`${label}: malformed heading: ${l}`); continue; }
      const idx = SECTIONS.indexOf(h[1]);
      names.push(h[1]);
      if (idx < 0) f(`${label}: section "${h[1]}" is not allowed (use ${SECTIONS.join(', ')})`);
      else if (idx < last) f(`${label}: section "${h[1]}" is out of order (order: ${SECTIONS.join(', ')})`);
      else last = idx;
    }
    if (names.includes('Breaking changes') && !names.includes('Upgrade notes')) f(`${label}: has Breaking changes but no Upgrade notes subsection`);
  }

  // Banned tokens, per line.
  let inFence = false;
  text.split('\n').forEach((raw, i) => {
    if (/^\s*```/.test(raw)) { inFence = !inFence; return; }
    if (inFence) return;
    let line = raw;
    for (const a of ID_ALLOWLIST) line = line.split(a).join('');
    const bad = [
      [/\b[A-Z]{2,}-[A-Z]?\d+\b/, 'ticket-like ID'],
      [/\bADR \d+/, 'ADR number'],
      [/\bPhase \d/, 'phase marker'],
      [/\bT\d+\b/, 'task ID'],
    ];
    for (const [re, what] of bad) {
      const m = re.exec(line);
      if (m) f(`line ${i + 1}: ${what} "${m[0]}"`);
    }
  });

  if (opts && opts.version && !PRE_RE.test(opts.version)) {
    const v = opts.version.replace(/^v/, '');
    const s = sections.find((x) => sectionVersion(x) === v);
    if (!s) f(`no section for v${v}`);
    else if (!changeLines(s.lines).length) f(`section v${v} has no entries`);
  }
  if (opts && opts.tags) {
    const tagVers = opts.tags.filter((t) => /^v\d+\.\d+\.\d+$/.test(t)).map((t) => t.slice(1));
    for (const t of tagVers) if (!sections.some((s) => sectionVersion(s) === t)) f(`tag v${t} has no changelog section`);
    for (const s of sections) {
      const v = sectionVersion(s);
      if (v && !tagVers.includes(v)) f(`section v${v} has no matching tag`);
    }
  }
  return findings;
}

// ---- stamp ----
function stampText(text, version, date, compareBase, firstRef) {
  const v = version.replace(/^v/, '');
  if (!VER_RE.test(v)) throw new Error(`bad version: ${version}`);
  const { sections } = splitSections(text);
  const un = sections.find((s) => UNRELEASED_HEADING.test(s.heading));
  if (!un) throw new Error('no "## Unreleased {#unreleased}" section');
  if (!entryLines(un.lines).length) {
    const e = new Error('Unreleased has no entries; add the release notes to docs/changelog.md first');
    e.code = 'EMPTY';
    throw e;
  }
  if (sections.some((s) => sectionVersion(s) === v)) throw new Error(`section v${v} already exists`);
  const prev = sections.map(sectionVersion).filter(Boolean).sort((a, b) => cmpVer(b, a))[0];
  let body = un.lines.slice();
  while (body.length && !body[body.length - 1].trim()) body.pop();
  while (body.length && !body[0].trim()) body.shift();
  const out = [`## v${v} - ${date} {#${anchorOf(v)}}`, ''].concat(body);
  if (compareBase && (prev || firstRef)) out.push('', `[Full diff](${compareBase}/compare/${prev ? 'v' + prev : firstRef}...v${v})`);
  const lines = text.split('\n');
  const before = lines.slice(0, un.start);
  const nextStart = sections[sections.indexOf(un) + 1] ? sections[sections.indexOf(un) + 1].start : lines.length;
  const after = lines.slice(nextStart);
  return before.concat(['## Unreleased {#unreleased}', ''], out, [''], after).join('\n').replace(/\n{3,}/g, '\n\n');
}

function compareBaseOf(text, run, cwd) {
  const m = /(https:\/\/github\.com\/[^/\s)]+\/[^/\s)]+)\/compare\//.exec(text);
  if (m) return m[1];
  const slug = repoSlugOf(run, cwd);
  return slug.includes('{') ? null : `https://github.com/${slug}`;
}

// ---- release page list (docs/.vitepress/release-pages.json) ----
const PAGES_KEEP = 2;
const pagesFileOf = (root) => path.join(root, 'docs', '.vitepress', 'release-pages.json');

function readPagesFile(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (j && j.schema === 1 && Array.isArray(j.releases)) return j;
  } catch (ex) { /* missing or malformed: start over */ }
  return { schema: 1, releases: [] };
}

// Add (or replace) the entry for `version`, sort by semver, keep the newest PAGES_KEEP.
function withEntry(data, version, pages) {
  const v = version.replace(/^v/, '');
  const releases = data.releases.filter((r) => r && VER_RE.test(r.version) && r.version !== v).concat([{ version: v, pages }]);
  releases.sort((a, b) => cmpVer(a.version, b.version));
  return { schema: 1, releases: releases.slice(-PAGES_KEEP) };
}

const writePagesFile = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
};

// ---- slice ----
function sliceText(text, upto, treeDir) {
  const v = upto.replace(/^v/, '');
  if (!VER_RE.test(v)) throw new Error(`bad version: ${upto}`);
  const { head, sections } = splitSections(text);
  const keep = sections.filter((s) => {
    const sv = sectionVersion(s);
    return sv && cmpVer(sv, v) <= 0;
  });
  const docsDir = path.join(treeDir, 'docs');
  const linkRe = /(?<!!)\[([^\]]*)\]\(([^)\s]+)\)/g;
  const fix = (line) => line.replace(linkRe, (all, label, target) => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) return all;
    const file = target.split('#')[0].split('?')[0];
    if (!/\.md$/.test(file)) return all;
    return fs.existsSync(path.join(docsDir, file)) ? all : label;
  });
  const out = head.map(fix);
  for (const s of keep) out.push(s.heading, ...s.lines.map(fix));
  return out.join('\n').replace(/\n+$/, '') + '\n';
}

// ---- notes ----
function notesOf(text, version) {
  const v = version.replace(/^v/, '');
  const { sections } = splitSections(text);
  const s = PRE_RE.test(v) ? sections.find((x) => UNRELEASED_HEADING.test(x.heading)) : sections.find((x) => sectionVersion(x) === v);
  if (!s) return null;
  return s.lines.join('\n').replace(/^\s+|\s+$/g, '') + '\n';
}

// ---- CLI ----
function parseArgs(argv, valueFlags, boolFlags) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (valueFlags.includes(a)) {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      opts[a.slice(2)] = argv[++i];
    } else if (boolFlags.includes(a)) opts[a.slice(2)] = true;
    else if (a.startsWith('--')) throw new Error(`unknown flag ${a}`);
    else opts._.push(a);
  }
  return opts;
}

const USAGE = `usage: changelog.js <draft|check|stamp|slice|notes|pages> [options]
  draft [--from <tag>] [--to <ref>] [--prs]
  check [--tags] [--version X.Y.Z | --version-env] [--file F]
  stamp [--version X.Y.Z] [--date YYYY-MM-DD] [--file F]
  slice --upto vX.Y.Z --tree <dir> [--out F] [--file F]
  notes vX.Y.Z [--file F]
  pages [--from-tag vX.Y.Z] [--write] [--version X.Y.Z]
(stamp also appends the working tree's page list to docs/.vitepress/release-pages.json; --no-pages skips that)`;

function main(argv, env) {
  const e = Object.assign({
    run: defaultRun,
    cwd: process.cwd(),
    root: path.join(__dirname, '..'),
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
    env: process.env,
    today: () => new Date().toISOString().slice(0, 10),
  }, env);
  const out = (s) => e.stdout(s.endsWith('\n') ? s : s + '\n');
  const err = (s) => e.stderr(s.endsWith('\n') ? s : s + '\n');
  const cmd = argv[0];
  let opts;
  const usage2 = (msg) => { err(`${msg}\n${USAGE}`); return 2; };
  try {
    const rest = argv.slice(1);
    switch (cmd) {
      case 'draft': opts = parseArgs(rest, ['--from', '--to'], ['--prs']); break;
      case 'check': opts = parseArgs(rest, ['--version', '--file'], ['--tags', '--version-env']); break;
      case 'stamp': opts = parseArgs(rest, ['--version', '--date', '--file'], ['--no-pages']); break;
      case 'pages': opts = parseArgs(rest, ['--from-tag', '--version'], ['--write']); break;
      case 'slice': opts = parseArgs(rest, ['--upto', '--tree', '--out', '--file'], []); break;
      case 'notes': opts = parseArgs(rest, ['--file'], []); break;
      default: err(USAGE); return 2;
    }
  } catch (ex) {
    err(`${ex.message}\n${USAGE}`);
    return 2;
  }

  if (cmd === 'draft') {
    for (const k of ['from', 'to']) {
      if (opts[k] !== undefined && (opts[k].startsWith('-') || !opts[k])) return usage2(`--${k} must be a ref and must not start with "-": ${opts[k]}`);
    }
    try {
      const r = draft(opts, e.run, e.cwd);
      out(r.text);
      for (const n of r.notes) err(n);
      return 0;
    } catch (ex) {
      err(ex.message);
      return ex.code === 'BADREF' || ex.message.startsWith('no v* tag') ? 2 : 1;
    }
  }

  if (cmd === 'pages') {
    const pagesFile = pagesFileOf(e.root);
    let pages, version;
    if (opts['from-tag']) {
      const tag = opts['from-tag'];
      if (!VER_RE.test(tag) || tag.startsWith('-')) return usage2(`--from-tag must look like v0.7.0: ${tag}`);
      const r = e.run('git', ['ls-tree', '-r', '--name-only', tag, 'docs'], { cwd: e.root });
      if (r.status !== 0) { err(`git ls-tree ${tag} failed (${(r.stderr || '').trim() || 'unknown tag'}); fetch tags first`); return 1; }
      const files = (r.stdout || '').split('\n').map((s) => s.trim()).filter((s) => s.startsWith('docs/')).map((s) => s.slice(5));
      pages = badges.pagesFromFiles(files, { srcExclude: ['lite/**'] });
      version = tag.replace(/^v/, '');
    } else {
      pages = badges.listPages(path.join(e.root, 'docs'), { srcExclude: ['lite/**'] });
      version = opts.version || e.env.npm_package_version;
      if (!version || !VER_RE.test(version)) return usage2('pages without --from-tag needs --version X.Y.Z (or npm_package_version)');
      version = version.replace(/^v/, '');
    }
    if (!pages.length) { err('changelog: no pages found'); return 1; }
    if (opts.write) {
      writePagesFile(pagesFile, withEntry(readPagesFile(pagesFile), version, pages));
      out(`changelog: wrote ${pages.length} pages for v${version} to ${path.relative(e.root, pagesFile)}`);
    } else out(JSON.stringify({ version, pages }, null, 2));
    return 0;
  }

  const file = path.resolve(e.cwd, opts.file || path.join(e.root, 'docs', 'changelog.md'));
  if (!fs.existsSync(file)) {
    err(`changelog not found: ${file}`);
    return 2;
  }
  const text = fs.readFileSync(file, 'utf8');

  if (cmd === 'check') {
    let tags;
    if (opts.tags) {
      const r = e.run('git', ['tag', '--list', 'v*'], { cwd: e.root });
      if (r.status !== 0) { err('git tag failed'); return 2; }
      tags = (r.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
    }
    let version = opts.version;
    if (opts['version-env']) {
      version = e.env.npm_package_version;
      if (!version) { err('check --version-env needs npm_package_version (run it from an npm script)'); return 2; }
    }
    const findings = check(text, { tags, version });
    if (findings.length) {
      for (const x of findings) err(`changelog: ${x}`);
      return 1;
    }
    out('changelog: ok');
    return 0;
  }

  if (cmd === 'stamp') {
    const version = opts.version || e.env.npm_package_version;
    if (!version) { err('stamp needs --version X.Y.Z (or npm_package_version)'); return 2; }
    if (PRE_RE.test(version)) { out(`changelog: v${version.replace(/^v/, '')} is a prerelease; Unreleased left in place`); return 0; }
    const date = opts.date || e.today();
    const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    const dt = dm && new Date(Date.UTC(+dm[1], +dm[2] - 1, +dm[3]));
    if (!dm || dt.getUTCFullYear() !== +dm[1] || dt.getUTCMonth() !== +dm[2] - 1 || dt.getUTCDate() !== +dm[3]) {
      return usage2(`--date must be a real date as YYYY-MM-DD: ${date}`);
    }
    try {
      const fr = e.run('git', ['rev-list', '--max-parents=0', 'HEAD'], { cwd: e.root });
      const firstRef = fr.status === 0 ? (fr.stdout || '').trim().split('\n')[0].slice(0, 12) : '';
      const next = stampText(text, version, date, compareBaseOf(text, e.run, e.root), firstRef || null);
      fs.writeFileSync(file, next);
      out(`changelog: stamped v${version.replace(/^v/, '')}`);
      const docsDir = path.join(e.root, 'docs');
      if (!opts['no-pages'] && fs.existsSync(docsDir)) {
        const pages = badges.listPages(docsDir, { srcExclude: ['lite/**'] });
        const pagesFile = pagesFileOf(e.root);
        if (fs.existsSync(pagesFile)) {
          try { JSON.parse(fs.readFileSync(pagesFile, 'utf8')); } catch (ex) {
            err(`changelog: warning: ${path.relative(e.root, pagesFile)} does not parse (${ex.message}); starting its list over`);
          }
        }
        writePagesFile(pagesFile, withEntry(readPagesFile(pagesFile), version, pages));
        out(`changelog: recorded ${pages.length} pages for v${version.replace(/^v/, '')} in ${path.relative(e.root, pagesFile)}`);
      }
      return 0;
    } catch (ex) {
      err(`changelog: ${ex.message}`);
      return ex.code === 'EMPTY' ? 1 : (/^bad version/.test(ex.message) ? 2 : 1);
    }
  }

  if (cmd === 'slice') {
    if (!opts.upto || !opts.tree) { err(`slice needs --upto and --tree\n${USAGE}`); return 2; }
    try {
      const s = sliceText(text, opts.upto, path.resolve(e.cwd, opts.tree));
      if (opts.out) {
        fs.mkdirSync(path.dirname(path.resolve(e.cwd, opts.out)), { recursive: true });
        fs.writeFileSync(path.resolve(e.cwd, opts.out), s);
      } else out(s);
      return 0;
    } catch (ex) {
      err(`changelog: ${ex.message}`);
      return 2;
    }
  }

  if (cmd === 'notes') {
    if (opts._.length !== 1 || !(VER_RE.test(opts._[0]) || PRE_RE.test(opts._[0]))) { err(`notes needs one version like v0.7.0\n${USAGE}`); return 2; }
    const body = notesOf(text, opts._[0]);
    if (body === null) { err(`changelog: no section for ${opts._[0]}`); return 1; }
    out(body);
    return 0;
  }
  return 2;
}

module.exports = {
  main, draft, check, stampText, sliceText, notesOf, parseLog, parseSubject, classify, scrub, areaOf,
  foldSeries, depLines, splitSections, cmpVer, resolvePrs, withEntry,
};

if (require.main === module) process.exit(main(process.argv.slice(2)));
