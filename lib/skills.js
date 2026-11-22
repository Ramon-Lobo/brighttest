'use strict';
const fs = require('fs');
const path = require('path');
const { palette } = require('./reporter');

// `brighttest skills` — install / export / update / list / uninstall AI-agent teaching material ("skills")
// into a project. Skills follow the open Agent Skills format (agentskills.io): a folder with a SKILL.md
// (name + description frontmatter) plus references/. ONE canonical source is adapted to each agent's
// convention. Core fs/path + global fetch only (Node 18+); no dependencies.

const SKILLS_DIR = path.join(__dirname, '..', 'skills');
const VERSION = require('../package.json').version;
const RAW = 'https://raw.githubusercontent.com/Ramon-Lobo/brighttest';

// ---- agent registry --------------------------------------------------------

function fileMarker(name) {
  return `<!-- brighttest skills:${name} v${VERSION} — managed by \`brighttest skills\`; edits are overwritten on update -->`;
}
function cursorRender(bundle, fm, name) {
  return [
    '---',
    `description: ${fm.description || 'Writing Rooibos tests with brighttest'}`,
    'globs: ["**/*.spec.bs"]',
    'alwaysApply: false',
    '---',
    fileMarker(name),
    '',
    bundle,
  ].join('\n');
}
function plainRender(bundle, fm, name) { return fileMarker(name) + '\n\n' + bundle; }

// kind: 'folder' (verbatim skill dir), 'file' (one flattened doc), 'block' (managed block in a shared file)
const AGENTS = {
  claude:      { label: 'Claude Code',    kind: 'folder', dir: (cwd) => path.join(cwd, '.claude', 'skills') },
  agentskills: { label: 'Agent Skills',   kind: 'folder', dir: (cwd, o) => path.resolve(cwd, (o && o.skillsDir) || '.agents/skills') },
  cursor:      { label: 'Cursor',         kind: 'file',   file: (cwd, n) => path.join(cwd, '.cursor', 'rules', `${n}.mdc`), render: cursorRender },
  windsurf:    { label: 'Windsurf',       kind: 'file',   file: (cwd, n) => path.join(cwd, '.windsurf', 'rules', `${n}.md`), render: plainRender },
  cline:       { label: 'Cline',          kind: 'file',   file: (cwd, n) => path.join(cwd, '.clinerules', `${n}.md`), render: plainRender },
  zed:         { label: 'Zed',            kind: 'block',  file: (cwd) => path.join(cwd, '.rules') },
  agents:      { label: 'AGENTS.md',      kind: 'block',  file: (cwd) => path.join(cwd, 'AGENTS.md') },
  copilot:     { label: 'GitHub Copilot', kind: 'block',  file: (cwd) => path.join(cwd, '.github', 'copilot-instructions.md') },
};
const ALIASES = { opencode: 'agents', codex: 'agents', hermes: 'agentskills' };
const ALL_AGENTS = Object.keys(AGENTS);

function detectAgents(cwd) {
  const has = (p) => fs.existsSync(path.join(cwd, p));
  const found = [];
  if (has('.claude')) found.push('claude');
  if (has('.agents') || has('.agent')) found.push('agentskills');
  if (has('.cursor')) found.push('cursor');
  if (has('.windsurf') || has('.windsurfrules')) found.push('windsurf');
  if (has('.clinerules')) found.push('cline');
  if (has('.rules')) found.push('zed');
  if (has('AGENTS.md') || has('opencode.json') || has('opencode.jsonc')) found.push('agents');
  if (has('.github')) found.push('copilot');
  return [...new Set(found)];
}

function resolveTargets(opts, cwd) {
  if (opts.agent) {
    const raw = opts.agent.toLowerCase();
    if (raw === 'all') return ALL_AGENTS.slice();
    const key = ALIASES[raw] || raw;
    if (!AGENTS[key]) {
      throw userError(`unknown agent '${opts.agent}' — expected: ${ALL_AGENTS.concat(Object.keys(ALIASES)).join(', ')}, all`);
    }
    return [key];
  }
  return detectAgents(cwd);
}

function userError(msg) { const e = new Error(msg); e.userFacing = true; return e; }

// ---- skill source (local disk or remote GitHub) ----------------------------

function localManifest() {
  return JSON.parse(fs.readFileSync(path.join(SKILLS_DIR, 'manifest.json'), 'utf8'));
}

function loadLocalSkills(only) {
  let entries = localManifest().skills;
  if (only) { entries = entries.filter((s) => s.name === only); if (!entries.length) throw userError(`unknown skill '${only}'`); }
  return entries.map((s) => {
    const files = {};
    for (const f of s.files) files[f] = fs.readFileSync(path.join(SKILLS_DIR, s.name, f), 'utf8');
    return { name: s.name, files };
  });
}

async function fetchText(url) {
  const r = await fetch(url);
  if (!r.ok) throw userError(`fetch failed (${r.status}) for ${url}`);
  return r.text();
}

async function loadRemoteSkills(ref, only) {
  const base = `${RAW}/${ref}/skills`;
  let man;
  try { man = JSON.parse(await fetchText(`${base}/manifest.json`)); }
  catch (e) { throw userError(`could not read the skills manifest at ref '${ref}'. Is the ref correct and pushed? (${e.message})`); }
  let entries = man.skills || [];
  if (only) { entries = entries.filter((s) => s.name === only); if (!entries.length) throw userError(`skill '${only}' not found at ref '${ref}'`); }
  const payloads = [];
  for (const s of entries) {
    const files = {};
    for (const f of s.files) files[f] = await fetchText(`${base}/${s.name}/${f}`);
    payloads.push({ name: s.name, files });
  }
  let remoteVersion = ref;
  try { remoteVersion = JSON.parse(await fetchText(`${RAW}/${ref}/package.json`)).version || ref; } catch (e) { /* keep ref */ }
  return { payloads, remoteVersion };
}

// ---- content transforms ----------------------------------------------------

function parseFrontmatter(md) {
  const fm = {};
  let body = md;
  const m = md.match(/^---\n([\s\S]*?)\n---\n?/);
  if (m) {
    for (const line of m[1].split('\n')) {
      const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
      if (kv && kv[2] !== '') fm[kv[1]] = kv[2].trim();
    }
    body = md.slice(m[0].length);
  }
  return { fm, body };
}

function demoteHeadings(md) {
  return md.split('\n').map((l) => (/^#{1,5} /.test(l) ? '#' + l : l)).join('\n');
}

// Flatten a skill (SKILL.md + references/*) into one self-contained markdown doc for single-file agents.
function buildBundle(payload) {
  const { fm, body } = parseFrontmatter(payload.files['SKILL.md']);
  let head = body;
  const cut = head.search(/\n#+\s+Reference files\b/);
  if (cut !== -1) head = head.slice(0, cut);
  head = head.trim();
  const refPaths = Object.keys(payload.files).filter((f) => f !== 'SKILL.md').sort();
  const sections = refPaths.map((f) => demoteHeadings(payload.files[f]).trim());
  return { fm, bundle: [head, ...sections].join('\n\n---\n\n') + '\n' };
}

// ---- fs helpers ------------------------------------------------------------

function writeFilesTo(destDir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const dest = path.join(destDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content);
  }
}

function isNonEmptyDir(p) {
  try { return fs.statSync(p).isDirectory() && fs.readdirSync(p).length > 0; } catch (e) { return false; }
}

function rel(cwd, p) { const r = path.relative(cwd, p); return r.startsWith('..') ? p : r; }

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function oldVersionIn(text, name) {
  const m = text.match(new RegExp('brighttest skills:' + escapeRe(name) + ' v([\\d.]+)'));
  return m ? m[1] : null;
}
function versionNote(oldV) { return oldV && oldV !== VERSION ? `v${oldV} → v${VERSION}` : null; }

function upsertManagedBlock(file, name, block) {
  const begin = `<!-- BEGIN brighttest:${name} -->`;
  const end = `<!-- END brighttest:${name} -->`;
  const re = new RegExp('\\n?' + escapeRe(begin) + '[\\s\\S]*?' + escapeRe(end) + '\\n?');
  const managed = `${begin}\n${fileMarker(name)}\n${block.trim()}\n${end}\n`;
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, managed);
    return { action: 'created' };
  }
  const cur = fs.readFileSync(file, 'utf8');
  const note = versionNote(oldVersionIn(cur, name));
  const hasBegin = cur.includes(begin), hasEnd = cur.includes(end);
  if (hasBegin && hasEnd) { fs.writeFileSync(file, cur.replace(re, '\n' + managed)); return { action: 'updated', note }; }
  if (hasBegin !== hasEnd) return { action: 'skipped', note: 'malformed managed block (BEGIN/END mismatch) — fix manually' };
  fs.writeFileSync(file, cur.replace(/\s*$/, '') + '\n\n' + managed);
  return { action: 'updated', note: 'appended block (existing content preserved)' };
}

// ---- per-skill writer / remover -------------------------------------------

function writeSkillToAgent(cwd, agentKey, payload, opts) {
  const a = AGENTS[agentKey];
  if (a.kind === 'folder') {
    const dest = path.join(a.dir(cwd, opts), payload.name);
    const skillFile = path.join(dest, 'SKILL.md');
    let action = 'created';
    if (fs.existsSync(skillFile)) {
      const ours = fs.readFileSync(skillFile, 'utf8').includes(`name: ${payload.name}`);
      if (!ours && !opts.force) return { agent: agentKey, skill: payload.name, path: rel(cwd, dest), action: 'skipped', note: 'exists and not brighttest-owned — use --force' };
      action = 'updated';
    }
    writeFilesTo(dest, payload.files);
    return { agent: agentKey, skill: payload.name, path: rel(cwd, dest), action };
  }
  if (a.kind === 'file') {
    const { fm, bundle } = buildBundle(payload);
    const dest = a.file(cwd, payload.name);
    let action = 'created', note = null;
    if (fs.existsSync(dest)) {
      const cur = fs.readFileSync(dest, 'utf8');
      const ours = cur.includes(`brighttest skills:${payload.name}`);
      if (!ours && !opts.force) return { agent: agentKey, skill: payload.name, path: rel(cwd, dest), action: 'skipped', note: 'exists and not brighttest-owned — use --force' };
      action = 'updated'; note = versionNote(oldVersionIn(cur, payload.name));
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, a.render(bundle, fm, payload.name));
    return { agent: agentKey, skill: payload.name, path: rel(cwd, dest), action, note };
  }
  // block
  const { bundle } = buildBundle(payload);
  const dest = a.file(cwd);
  return { agent: agentKey, skill: payload.name, path: rel(cwd, dest), ...upsertManagedBlock(dest, payload.name, bundle) };
}

function removeSkillFromAgent(cwd, agentKey, name, opts) {
  const a = AGENTS[agentKey];
  if (a.kind === 'folder') {
    const dest = path.join(a.dir(cwd, opts), name);
    if (!fs.existsSync(dest)) return { agent: agentKey, skill: name, path: rel(cwd, dest), action: 'absent' };
    const ours = fs.existsSync(path.join(dest, 'SKILL.md')) && fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8').includes(`name: ${name}`);
    if (!ours && !opts.force) return { agent: agentKey, skill: name, path: rel(cwd, dest), action: 'skipped', note: 'not brighttest-owned — use --force' };
    fs.rmSync(dest, { recursive: true, force: true });
    return { agent: agentKey, skill: name, path: rel(cwd, dest), action: 'removed' };
  }
  if (a.kind === 'file') {
    const dest = a.file(cwd, name);
    if (!fs.existsSync(dest)) return { agent: agentKey, skill: name, path: rel(cwd, dest), action: 'absent' };
    const ours = fs.readFileSync(dest, 'utf8').includes(`brighttest skills:${name}`);
    if (!ours && !opts.force) return { agent: agentKey, skill: name, path: rel(cwd, dest), action: 'skipped', note: 'not brighttest-owned — use --force' };
    fs.rmSync(dest, { force: true });
    return { agent: agentKey, skill: name, path: rel(cwd, dest), action: 'removed' };
  }
  // block
  const dest = a.file(cwd);
  if (!fs.existsSync(dest)) return { agent: agentKey, skill: name, path: rel(cwd, dest), action: 'absent' };
  const begin = `<!-- BEGIN brighttest:${name} -->`, end = `<!-- END brighttest:${name} -->`;
  const cur = fs.readFileSync(dest, 'utf8');
  if (!cur.includes(begin)) return { agent: agentKey, skill: name, path: rel(cwd, dest), action: 'absent' };
  const re = new RegExp('\\n?' + escapeRe(begin) + '[\\s\\S]*?' + escapeRe(end) + '\\n?');
  fs.writeFileSync(dest, cur.replace(re, '\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, ''));
  return { agent: agentKey, skill: name, path: rel(cwd, dest), action: 'removed' };
}

// ---- commands --------------------------------------------------------------

function installPayloads(payloads, opts, c, header) {
  const cwd = process.cwd();
  const targets = resolveTargets(opts, cwd);
  if (targets.length === 0) { printNoAgents(c); return 0; }
  const records = [];
  for (const t of targets) {
    for (const p of payloads) {
      try { records.push(writeSkillToAgent(cwd, t, p, opts)); }
      catch (e) { records.push({ agent: t, skill: p.name, path: '', action: 'failed', note: e.message }); }
    }
  }
  printSummary(header, records, c);
  return records.some((r) => r.action === 'failed') ? 1 : 0;
}

function install(opts, c) {
  return installPayloads(loadLocalSkills(opts.skill), opts, c, `brighttest skills — installed (v${VERSION})`);
}

async function update(opts, c) {
  const ref = opts.ref || 'main';
  process.stdout.write('  ' + c.dim(`fetching skills from ${ref}…`) + '\n');
  const { payloads, remoteVersion } = await loadRemoteSkills(ref, opts.skill);
  return installPayloads(payloads, opts, c, `brighttest skills — updated from ${ref} (v${remoteVersion})`);
}

function exportSkill(opts, c) {
  const cwd = process.cwd();
  const outRoot = path.resolve(cwd, opts.out || 'brighttest-skills');
  const payloads = loadLocalSkills(opts.skill);
  const conflict = payloads.find((p) => isNonEmptyDir(path.join(outRoot, p.name)));
  if (conflict && !opts.force) {
    process.stderr.write('  ' + c.red(`brighttest skills: ${rel(cwd, path.join(outRoot, conflict.name))} already exists — use --force to overwrite.`) + '\n');
    return 1;
  }
  for (const p of payloads) writeFilesTo(path.join(outRoot, p.name), p.files);
  process.stdout.write(
    '\n  ' + c.green('✓') + ` exported ${payloads.length} skill(s) to ` + c.bold(rel(cwd, outRoot)) + '\n' +
    payloads.map((p) => '    ' + c.dim('• ' + p.name)).join('\n') + '\n\n' +
    '  Each folder is an Agent Skills–format skill (SKILL.md + references/). Drop it where your agent reads\n' +
    '  skills, or let brighttest place it: ' + c.dim('brighttest skills install --agent <name>') + '\n',
  );
  return 0;
}

function list(opts, c) {
  const cwd = process.cwd();
  const skills = loadLocalSkills().map((p) => ({ name: p.name, fm: parseFrontmatter(p.files['SKILL.md']).fm }));
  process.stdout.write('\n  ' + c.bold(`brighttest skills (v${VERSION})`) + '\n\n  ' + c.dim('Available skills') + '\n');
  for (const s of skills) {
    process.stdout.write('  ' + c.green('•') + ' ' + c.bold(s.name) + '\n');
    if (s.fm.description) process.stdout.write('    ' + c.dim(wrap(s.fm.description, 92, '    ')) + '\n');
  }
  const detected = detectAgents(cwd);
  process.stdout.write('\n  ' + c.dim('Detected agents in this project: ') + (detected.length ? detected.map((d) => AGENTS[d].label).join(', ') : 'none') + '\n');
  process.stdout.write('  ' + c.dim('Install: ') + 'brighttest skills install' + c.dim(detected.length ? '' : ' --agent <claude|cursor|agents|copilot|windsurf|cline|zed|agentskills|all>') + '\n');
  return 0;
}

function uninstall(opts, c) {
  const cwd = process.cwd();
  const targets = resolveTargets(opts, cwd);
  if (targets.length === 0) { process.stdout.write('  ' + c.dim('No agents detected and no --agent given; nothing to remove.') + '\n'); return 0; }
  const names = (opts.skill ? [opts.skill] : localManifest().skills.map((s) => s.name));
  const records = [];
  for (const t of targets) for (const n of names) {
    try { records.push(removeSkillFromAgent(cwd, t, n, opts)); }
    catch (e) { records.push({ agent: t, skill: n, path: '', action: 'failed', note: e.message }); }
  }
  printSummary('brighttest skills — uninstall', records, c);
  return records.some((r) => r.action === 'failed') ? 1 : 0;
}

// ---- output ----------------------------------------------------------------

function wrap(s, width, indent) {
  const words = s.split(/\s+/); const lines = []; let line = '';
  for (const w of words) { if ((line + ' ' + w).trim().length > width) { lines.push(line); line = w; } else line = (line ? line + ' ' : '') + w; }
  if (line) lines.push(line);
  return lines.join('\n' + indent);
}

function printNoAgents(c) {
  process.stdout.write(
    '\n  ' + c.bold('No AI-agent config detected in this project.') + '\n' +
    '  Pick a target with --agent (or --agent all):\n\n' +
    ['claude', 'cursor', 'agents', 'copilot', 'windsurf', 'cline', 'zed', 'agentskills']
      .map((k) => `  ${c.dim('•')} brighttest skills install --agent ${k.padEnd(11)} ${c.dim(AGENTS[k].label)}`).join('\n') + '\n' +
    `  ${c.dim('•')} brighttest skills export ${' '.repeat(19)} ${c.dim('dump raw skill folders to place manually')}\n`,
  );
}

function printSummary(header, records, c) {
  const sym = { created: c.green('✓'), updated: c.yellow('~'), removed: c.yellow('−'), skipped: c.grey('•'), absent: c.grey('·'), failed: c.red('✗') };
  process.stdout.write('\n  ' + c.bold(header) + '\n');
  for (const r of records) {
    process.stdout.write(
      `  ${sym[r.action] || '?'} ${c.dim(r.action.padEnd(7))} ${AGENTS[r.agent] ? AGENTS[r.agent].label : r.agent} ${c.dim('· ' + r.skill)}` +
      (r.path ? ` ${c.dim('→ ' + r.path)}` : '') + (r.note ? ` ${c.dim('(' + r.note + ')')}` : '') + '\n',
    );
  }
  const n = (a) => records.filter((r) => r.action === a).length;
  const parts = ['created', 'updated', 'removed', 'skipped', 'failed'].filter(n).map((a) => `${n(a)} ${a}`);
  if (parts.length) process.stdout.write('  ' + c.dim(parts.join(' · ')) + '\n');
  if (n('skipped')) process.stdout.write('  ' + c.dim('Re-run with --force to overwrite files not created by brighttest.') + '\n');
}

// ---- drift check (`skills --check`) ---------------------------------------

// Same shape scripts/gen-skills-manifest.js writes; built in memory only.
function walkMd(dir, base) {
  let out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out = out.concat(walkMd(path.join(dir, e.name), rel));
    else if (e.name.endsWith('.md')) out.push(rel);
  }
  return out;
}

function generateManifest(root) {
  const skills = fs.readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(root, d.name, 'SKILL.md')))
    .map((d) => ({ name: d.name, files: walkMd(path.join(root, d.name), '').sort() }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { schema: 'brighttest-skills/v1', skills };
}

// Returns { ok, missing, drift: [paths] }. Never writes.
function checkManifest(root) {
  const file = path.join(root, 'manifest.json');
  if (!fs.existsSync(file)) return { ok: false, missing: true, drift: [] };
  let committed;
  try { committed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return { ok: false, invalid: true, drift: [] }; }
  const flat = (m) => {
    const set = new Set();
    for (const sk of (m && m.skills) || []) for (const f of sk.files || []) set.add(`${sk.name}/${f}`);
    return set;
  };
  const a = flat(generateManifest(root)), b = flat(committed);
  const drift = [];
  for (const f of a) if (!b.has(f)) drift.push(`${f} (on disk, not in manifest)`);
  for (const f of b) if (!a.has(f)) drift.push(`${f} (in manifest, not on disk)`);
  drift.sort();
  if (!drift.length && JSON.stringify(generateManifest(root)) !== JSON.stringify(committed)) drift.push('manifest.json (ordering or schema differs)');
  return { ok: drift.length === 0, drift };
}

function check(root, out = process.stdout, err = process.stderr) {
  const r = checkManifest(root);
  if (r.missing) { err.write('brighttest skills --check: skills/manifest.json is missing; run `npm run skills:manifest`.\n'); return 1; }
  if (r.invalid) { err.write('brighttest skills --check: skills/manifest.json is not valid JSON; run `npm run skills:manifest`.\n'); return 1; }
  if (!r.ok) {
    err.write(`brighttest skills --check: manifest drift (${r.drift.length}); run \`npm run skills:manifest\`:\n`);
    for (const d of r.drift) err.write(`  ${d}\n`);
    return 1;
  }
  out.write('skills manifest is up to date\n');
  return 0;
}

// ---- trigger collision check (AGT-04) --------------------------------------

// skills: [{ name, fm }]. Returns a list of problem strings (empty = ok). Pure and offline.
function collisionCheck(skills) {
  const problems = [];
  const names = new Set(skills.map((s) => s.name));
  const owner = new Map();
  for (const s of skills) {
    const phrases = (s.fm.triggers || '').split(';').map((p) => p.trim().toLowerCase().replace(/\s+/g, ' ')).filter(Boolean);
    if (!phrases.length) problems.push(`${s.name}: missing triggers`);
    for (const p of phrases) {
      if (owner.has(p) && owner.get(p) !== s.name) problems.push(`trigger '${p}' claimed by both ${owner.get(p)} and ${s.name}`);
      else owner.set(p, s.name);
    }
    const w = s.fm['when-not-to-use'];
    if (!w) { problems.push(`${s.name}: missing when-not-to-use`); continue; }
    const named = [...w.matchAll(/\(use ([a-z0-9-]+)\)/g)].map((m) => m[1]);
    if (!named.length) problems.push(`${s.name}: when-not-to-use names no neighbouring skill as '(use <skill>)'`);
    for (const n of named) if (!names.has(n) || n === s.name) problems.push(`${s.name}: when-not-to-use points at unknown or self skill '${n}'`);
  }
  return problems;
}

// ---- snippet validation (AGT-06) -------------------------------------------

// Pull fenced code blocks out of markdown. Returns [{ lang, code, line }] (line = fence line, 1-based).
function extractSnippets(md) {
  const out = [];
  const lines = md.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(/^(\s*)```\s*([\w-]*)\s*$/);
    if (!open) continue;
    const start = i + 1;
    const body = [];
    i++;
    while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++]);
    if (i >= lines.length) out.push({ lang: open[2], code: body.join('\n'), line: start, unterminated: true });
    else out.push({ lang: open[2], code: body.join('\n'), line: start });
  }
  return out;
}

// Every `--flag` token the CLI parser accepts, scraped from the source text of bin/cli.js.
function knownCliFlags(cliSrc) {
  const set = new Set(['--']);
  for (const m of cliSrc.matchAll(/'(--?[A-Za-z][\w-]*)'/g)) set.add(m[1]);
  return set;
}

// Shell snippets: `bash -n` syntax check (placeholders like <host> are neutralised first), plus every
// `--flag` on a `brighttest ...` line must exist in the CLI's parser.
function checkShell(code, flags) {
  const problems = [];
  const neutral = code.replace(/<[A-Za-z][\w .|-]*>/g, 'X').replace(/\.\.\./g, 'X');
  const r = require('child_process').spawnSync('bash', ['-n'], { input: neutral, encoding: 'utf8' });
  if (r.status !== 0) problems.push(`shell syntax: ${(r.stderr || '').trim().split('\n')[0]}`);
  if (flags) {
    for (const ln of code.split('\n')) {
      if (!/(^|[\s;&|(])(npx\s+)?brighttest\s/.test(ln)) continue;
      const seg = ln.slice(ln.search(/brighttest\s/)).split(/\s--\s/)[0].split(/[|;&]|\s#\s/)[0];
      for (const m of seg.matchAll(/(?:^|\s)(--?[A-Za-z][\w-]*)/g)) {
        if (!flags.has(m[1])) problems.push(`unknown CLI flag ${m[1]} in: ${ln.trim()}`);
      }
    }
  }
  return problems;
}

// YAML snippets are e2e flow fragments (a step list, or a flow with steps:) parsed by the real flow
// parser. CI-config excerpts (`jobs:`/`on:`/`name:`) and flow-config fragments are skipped.
function checkYaml(code) {
  const { parseFlow } = require('./e2e/flow');
  const body = code.replace(/^\s*#.*$/gm, '').trim();
  if (!body || /^(jobs|on|name|env|permissions)\s*:/m.test(body)) return [];
  let src = body.split('\n').filter((l) => !/^\s*-\s*\.\.\.\s*$/.test(l)).join('\n'); // `- ...` = elided steps
  if (/^-\s/.test(body)) src = 'steps:\n' + src.split('\n').map((l) => '  ' + l).join('\n');
  else if (!/^steps\s*:/m.test(body)) return [];
  try { parseFlow(src); } catch (e) { return [`e2e flow does not parse: ${e.message}`]; }
  return [];
}

function checkJson(code) {
  let stripped = code.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n').trim();
  if (/\.\.\./.test(stripped)) return []; // elided excerpt
  if (/^"[^"]+"\s*:/.test(stripped)) stripped = '{' + stripped + '}'; // property excerpt of a larger object
  try { JSON.parse(stripped); return []; } catch (e) { return [`invalid JSON: ${e.message}`]; }
}

// BrightScript: block openers/closers must balance (function/sub/if/for/while/try, end *), and
// brackets/quotes close. Deliberately shallow; the headless runner is the real compiler.
function checkBrightScript(code) {
  const problems = [];
  const stack = [];
  let depth = 0;
  for (const raw of code.split('\n')) {
    let ln = raw.replace(/"(?:[^"]|"")*"/g, '""').replace(/'.*$/, '').replace(/\brem\b.*$/i, '').trim().toLowerCase();
    if (!ln) continue;
    ln = ln.replace(/^@\w+(\([^)]*\))?\s*/, '');
    let m;
    // one-line fragments (`function f() : stmt : ' ...`) are illustrative, not complete blocks
    if (/\s:\s/.test(ln) && /^(function|sub)\b/.test(ln)) continue;
    if ((m = ln.match(/^end\s+(function|sub|for|while|try|if|namespace|class|interface|enum)\b/))) {
      const top = stack.pop();
      if (top !== m[1]) problems.push(`unbalanced block: 'end ${m[1]}' closes ${top || 'nothing'}`);
    } else if (/^next\b/.test(ln)) {
      const top = stack.pop();
      if (top !== 'for') problems.push(`unbalanced block: 'next' closes ${top || 'nothing'}`);
    } else if ((m = ln.match(/^(?:(?:public|private|protected|override|static|async)\s+)*(function|sub|namespace|class|interface|enum|try)\b/)) && !/^(end)\b/.test(ln)) {
      if (!/\bend\s+(function|sub)\s*$/.test(ln)) stack.push(m[1]);
    } else if (/\b(function|sub)\s*\(/.test(ln) && !/\bend\s+(function|sub)\s*$/.test(ln) && !/^(?:(?:public|private|protected|override|static|async)\s+)*(function|sub)\b/.test(ln)) {
      stack.push(/\bfunction\s*\(/.test(ln) ? 'function' : 'sub'); // anonymous function in an expression
    } else if (/^(for|while)\b/.test(ln)) stack.push(ln.startsWith('for') ? 'for' : 'while');
    else if (/^if\b/.test(ln) && /\bthen\s*$/.test(ln)) stack.push('if');
    depth += (ln.match(/[([{]/g) || []).length - (ln.match(/[)\]}]/g) || []).length;
    if (depth < 0) { problems.push(`unbalanced brackets: ${raw.trim()}`); depth = 0; }
  }
  if (depth > 0) problems.push('unbalanced brackets: unclosed ( [ or {');
  if (stack.length) problems.push(`unclosed block: ${stack.join(', ')}`);
  return problems;
}

// Validate one snippet. Returns problem strings (empty = ok). Unknown languages and untagged fences pass.
function validateSnippet(sn, ctx = {}) {
  if (sn.unterminated) return ['unterminated code fence'];
  switch (sn.lang) {
    case 'json': return checkJson(sn.code);
    case 'yaml': case 'yml': return checkYaml(sn.code);
    case 'sh': case 'bash': return checkShell(sn.code, ctx.flags);
    case 'brightscript': case 'brs': return checkBrightScript(sn.code);
    default: return [];
  }
}

// Validate every snippet in every skill markdown file under `root`. Returns [{ file, line, lang, problem }].
function validateSkillSnippets(root = SKILLS_DIR, cliFile = path.join(__dirname, '..', 'bin', 'cli.js')) {
  const flags = fs.existsSync(cliFile) ? knownCliFlags(fs.readFileSync(cliFile, 'utf8')) : null;
  const failures = [];
  for (const s of generateManifest(root).skills) {
    for (const f of s.files) {
      const file = `${s.name}/${f}`;
      for (const sn of extractSnippets(fs.readFileSync(path.join(root, s.name, f), 'utf8'))) {
        for (const problem of validateSnippet(sn, { flags })) failures.push({ file, line: sn.line, lang: sn.lang, problem });
      }
    }
  }
  return failures;
}

// ---- entry -----------------------------------------------------------------

async function run(cfg, opts) {
  const c = palette(!!process.stdout.isTTY);
  if (opts.check) return check(SKILLS_DIR);
  if (!fs.existsSync(path.join(SKILLS_DIR, 'manifest.json'))) {
    process.stderr.write('  ' + c.red('brighttest skills: bundled skill assets are missing (packaging bug).') + '\n');
    return 1;
  }
  try {
    switch (opts.skillsAction) {
      case 'export': return exportSkill(opts, c);
      case 'update': return await update(opts, c);
      case 'list': return list(opts, c);
      case 'uninstall': return uninstall(opts, c);
      default: return install(opts, c);
    }
  } catch (e) {
    process.stderr.write('  ' + c.red('brighttest skills: ' + e.message) + '\n');
    return 1;
  }
}

module.exports = { parseFrontmatter, collisionCheck, run, check, checkManifest, generateManifest, detectAgents, resolveTargets, loadLocalSkills, buildBundle, upsertManagedBlock, extractSnippets, validateSnippet, validateSkillSnippets, knownCliFlags, ALL_AGENTS };
