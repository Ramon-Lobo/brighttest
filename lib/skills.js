'use strict';
const fs = require('fs');
const path = require('path');
const { palette } = require('./reporter');

// `brighttest skills` — install AI-agent teaching material ("skills") into a project, adapting ONE
// canonical source (the Claude Code skill dir) to each agent's format. Core fs/path only.

const SKILL_NAME = 'writing-rooibos-tests';
// Bundled source lives beside bin/ and lib/ (same __dirname-relative idiom as brs/headless_runner.brs).
const SRC_DIR = path.join(__dirname, '..', 'skills', SKILL_NAME);
const REF_ORDER = ['pitfalls.md', 'limitations.md', 'examples.md', 'cheatsheet.md'];

const KNOWN_AGENTS = ['claude', 'cursor', 'agents', 'copilot'];
const BEGIN = `<!-- BEGIN brighttest:${SKILL_NAME} -->`;
const END = `<!-- END brighttest:${SKILL_NAME} -->`;
const MANAGED_NOTE = '<!-- Managed by `brighttest skills`. Edits inside this block are overwritten on re-install. -->';
const CURSOR_MARKER = `<!-- brighttest-managed: ${SKILL_NAME} -->`;

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
const BLOCK_RE = new RegExp('\\n?' + escapeRe(BEGIN) + '[\\s\\S]*?' + escapeRe(END) + '\\n?');

// ---- source ----------------------------------------------------------------

// Parse the canonical SKILL.md + reference files. Hand-rolled frontmatter parse (no yaml dep).
function readSource() {
  const raw = fs.readFileSync(path.join(SRC_DIR, 'SKILL.md'), 'utf8');
  const fm = { name: SKILL_NAME, description: '' };
  let body = raw;
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (m) {
    for (const line of m[1].split('\n')) {
      const kv = line.match(/^(\w+):\s*(.*)$/);
      if (kv) fm[kv[1]] = kv[2].trim();
    }
    body = raw.slice(m[0].length);
  }
  const refs = REF_ORDER.map((f) => ({ file: f, body: fs.readFileSync(path.join(SRC_DIR, f), 'utf8') }));
  return { frontmatter: fm, skillBody: body, refs };
}

// Push every markdown heading down one level (# -> ##), so a reference file's H1 becomes a section header
// under the SKILL body when everything is inlined into one document.
function demoteHeadings(md) {
  return md.split('\n').map((l) => (/^#{1,5} /.test(l) ? '#' + l : l)).join('\n');
}

// Concatenate SKILL body + reference files into a single self-contained markdown document (for the
// single-file agent formats). Drops the SKILL body's trailing "Reference files" links (now inlined).
function buildBundle(src) {
  let head = src.skillBody;
  const cut = head.search(/\n#+\s+Reference files\b/);
  if (cut !== -1) head = head.slice(0, cut);
  head = head.trim();
  const sections = src.refs.map((r) => demoteHeadings(r.body).trim());
  return [head, ...sections].join('\n\n---\n\n') + '\n';
}

// ---- fs helpers ------------------------------------------------------------

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, e.name);
    const d = path.join(to, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function isNonEmptyDir(p) {
  try { return fs.statSync(p).isDirectory() && fs.readdirSync(p).length > 0; } catch (e) { return false; }
}

// Create/replace our managed block in a possibly user-owned file, never clobbering surrounding content.
function upsertManagedBlock(file, block) {
  const managed = `${BEGIN}\n${MANAGED_NOTE}\n${block.trim()}\n${END}\n`;
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, managed);
    return { action: 'created' };
  }
  const cur = fs.readFileSync(file, 'utf8');
  const hasBegin = cur.includes(BEGIN);
  const hasEnd = cur.includes(END);
  if (hasBegin && hasEnd) {
    fs.writeFileSync(file, cur.replace(BLOCK_RE, '\n' + managed));
    return { action: 'updated' };
  }
  if (hasBegin !== hasEnd) {
    return { action: 'skipped', note: 'malformed managed block (BEGIN/END mismatch) — fix manually' };
  }
  fs.writeFileSync(file, cur.replace(/\s*$/, '') + '\n\n' + managed);
  return { action: 'updated', note: 'appended block (existing content preserved)' };
}

// ---- per-format writers (each returns { agent, path, action, note? }) ------

function writeClaude(cwd, src, force) {
  const dest = path.join(cwd, '.claude', 'skills', SKILL_NAME);
  const skillFile = path.join(dest, 'SKILL.md');
  let action = 'created';
  if (fs.existsSync(skillFile)) {
    const ours = fs.readFileSync(skillFile, 'utf8').includes(`name: ${SKILL_NAME}`);
    if (!ours && !force) {
      return { agent: 'claude', path: rel(cwd, dest), action: 'skipped', note: 'exists and not brighttest-owned — re-run with --force' };
    }
    action = 'updated';
  }
  copyDir(SRC_DIR, dest);
  return { agent: 'claude', path: rel(cwd, skillFile), action };
}

function writeCursor(cwd, bundle, fm, force) {
  const dest = path.join(cwd, '.cursor', 'rules', `${SKILL_NAME}.mdc`);
  const frontmatter = [
    '---',
    `description: ${fm.description || 'Writing Rooibos tests (*.spec.bs) with brighttest'}`,
    'globs: ["**/*.spec.bs"]',
    'alwaysApply: false',
    '---',
    CURSOR_MARKER,
    '',
  ].join('\n');
  let action = 'created';
  if (fs.existsSync(dest)) {
    const ours = fs.readFileSync(dest, 'utf8').includes(CURSOR_MARKER);
    if (!ours && !force) {
      return { agent: 'cursor', path: rel(cwd, dest), action: 'skipped', note: 'exists and not brighttest-owned — re-run with --force' };
    }
    action = 'updated';
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, frontmatter + '\n' + bundle);
  return { agent: 'cursor', path: rel(cwd, dest), action };
}

function writeAgents(cwd, bundle) {
  const dest = path.join(cwd, 'AGENTS.md');
  return { agent: 'agents', path: rel(cwd, dest), ...upsertManagedBlock(dest, bundle) };
}

function writeCopilot(cwd, bundle) {
  const dest = path.join(cwd, '.github', 'copilot-instructions.md');
  return { agent: 'copilot', path: rel(cwd, dest), ...upsertManagedBlock(dest, bundle) };
}

function rel(cwd, p) { const r = path.relative(cwd, p); return r.startsWith('..') ? p : r; }

// ---- orchestration ---------------------------------------------------------

function detectAgents(cwd) {
  const found = [];
  if (fs.existsSync(path.join(cwd, '.claude'))) found.push('claude');
  if (fs.existsSync(path.join(cwd, '.cursor'))) found.push('cursor');
  if (fs.existsSync(path.join(cwd, 'AGENTS.md'))) found.push('agents');
  if (fs.existsSync(path.join(cwd, '.github'))) found.push('copilot');
  return found;
}

function resolveTargets(opts, cwd) {
  if (opts.agent) {
    const a = opts.agent.toLowerCase();
    if (a === 'all') return KNOWN_AGENTS.slice();
    if (KNOWN_AGENTS.includes(a)) return [a];
    const err = new Error(`unknown agent '${opts.agent}' — expected: ${KNOWN_AGENTS.join(', ')}, all`);
    err.userFacing = true;
    throw err;
  }
  return detectAgents(cwd);
}

function install(opts) {
  const c = palette(!!process.stdout.isTTY);
  const cwd = process.cwd();
  const targets = resolveTargets(opts, cwd);

  if (targets.length === 0) {
    process.stdout.write(
      '\n  ' + c.bold('No AI-agent config detected in this project.') + '\n' +
      '  Choose where to install the "writing-rooibos-tests" skill:\n\n' +
      `  ${c.dim('•')} brighttest skills install --agent claude    ${c.dim('(.claude/skills/)')}\n` +
      `  ${c.dim('•')} brighttest skills install --agent cursor    ${c.dim('(.cursor/rules/)')}\n` +
      `  ${c.dim('•')} brighttest skills install --agent agents    ${c.dim('(AGENTS.md)')}\n` +
      `  ${c.dim('•')} brighttest skills install --agent copilot   ${c.dim('(.github/copilot-instructions.md)')}\n` +
      `  ${c.dim('•')} brighttest skills install --agent all       ${c.dim('(all of the above)')}\n` +
      `  ${c.dim('•')} brighttest skills export                    ${c.dim('(dump raw files to place manually)')}\n`,
    );
    return 0;
  }

  const src = readSource();
  const bundle = buildBundle(src);
  const records = [];
  for (const t of targets) {
    try {
      if (t === 'claude') records.push(writeClaude(cwd, src, opts.force));
      else if (t === 'cursor') records.push(writeCursor(cwd, bundle, src.frontmatter, opts.force));
      else if (t === 'agents') records.push(writeAgents(cwd, bundle));
      else if (t === 'copilot') records.push(writeCopilot(cwd, bundle));
    } catch (e) {
      records.push({ agent: t, path: '', action: 'failed', note: e.message });
    }
  }
  printSummary(records, c);
  return records.some((r) => r.action === 'failed') ? 1 : 0;
}

function exportSkill(opts) {
  const c = palette(!!process.stdout.isTTY);
  const cwd = process.cwd();
  const outRoot = path.resolve(cwd, opts.out || 'brighttest-skills');
  const dest = path.join(outRoot, SKILL_NAME);
  if (isNonEmptyDir(dest) && !opts.force) {
    process.stderr.write('  ' + c.red(`brighttest skills: ${rel(cwd, dest)} already exists — re-run with --force to overwrite.`) + '\n');
    return 1;
  }
  copyDir(SRC_DIR, dest);
  const files = REF_ORDER.concat('SKILL.md').sort();
  process.stdout.write(
    '\n  ' + c.green('✓') + ' exported the ' + c.bold(SKILL_NAME) + ' skill to ' + c.bold(rel(cwd, dest)) + '\n' +
    '    ' + c.dim(files.join(', ')) + '\n\n' +
    '  Place these where your agent reads project instructions, e.g.:\n' +
    `    ${c.dim('•')} Claude Code  → copy the folder to .claude/skills/${SKILL_NAME}/\n` +
    `    ${c.dim('•')} Cursor       → add SKILL.md's content to a .cursor/rules/*.mdc\n` +
    `    ${c.dim('•')} AGENTS.md    → paste into your AGENTS.md\n` +
    `    ${c.dim('•')} Copilot      → paste into .github/copilot-instructions.md\n` +
    `  ${c.dim('(Or let brighttest do it: brighttest skills install --agent <name>.)')}\n`,
  );
  return 0;
}

function printSummary(records, c) {
  const sym = { created: c.green('✓'), updated: c.yellow('~'), skipped: c.grey('•'), failed: c.red('✗') };
  const label = { claude: 'Claude Code', cursor: 'Cursor', agents: 'AGENTS.md', copilot: 'GitHub Copilot' };
  process.stdout.write('\n  ' + c.bold('brighttest skills — writing-rooibos-tests') + '\n');
  for (const r of records) {
    const line = `  ${sym[r.action] || '?'} ${label[r.agent] || r.agent}` +
      (r.path ? ` ${c.dim('→ ' + r.path)}` : '') +
      (r.note ? ` ${c.dim('(' + r.note + ')')}` : '');
    process.stdout.write(line + '\n');
  }
  const n = (a) => records.filter((r) => r.action === a).length;
  const parts = [];
  if (n('created')) parts.push(`${n('created')} created`);
  if (n('updated')) parts.push(`${n('updated')} updated`);
  if (n('skipped')) parts.push(`${n('skipped')} skipped`);
  if (n('failed')) parts.push(`${n('failed')} failed`);
  process.stdout.write('  ' + c.dim(parts.join(' · ')) + '\n');
  if (n('skipped')) process.stdout.write('  ' + c.dim('Re-run with --force to overwrite skipped brighttest-owned files.') + '\n');
}

function run(cfg, opts) {
  const c = palette(!!process.stdout.isTTY);
  if (!fs.existsSync(SRC_DIR)) {
    process.stderr.write('  ' + c.red('brighttest skills: bundled skill assets are missing (packaging bug).') + '\n');
    return 1;
  }
  try {
    return (opts.skillsAction === 'export') ? exportSkill(opts) : install(opts);
  } catch (e) {
    process.stderr.write('  ' + c.red('brighttest skills: ' + e.message) + '\n');
    return 1;
  }
}

module.exports = { run, detectAgents, resolveTargets, readSource, buildBundle, upsertManagedBlock };
