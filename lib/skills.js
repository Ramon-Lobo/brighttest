'use strict';
const fs = require('fs');
const path = require('path');
const { palette } = require('./reporter');

// `brighttest skills` — install / export / update / list / uninstall AI-agent teaching material ("skills")
// into a project. Skills follow the open Agent Skills format (agentskills.io): a folder with a SKILL.md
// (name + description frontmatter) plus references/. ONE canonical source is adapted to each agent's
// convention. Core fs/path + global fetch only (Node 22+); no dependencies.

const SKILLS_DIR = path.join(__dirname, '..', 'skills');
const VERSION = require('../package.json').version;
const RAW = 'https://raw.githubusercontent.com/Ramon-Lobo/brighttest';

// ---- agent registry --------------------------------------------------------

function fileMarker(name) {
  return `<!-- brighttest skills:${name} v${VERSION} — managed by \`brighttest skills\`; edits are overwritten on update -->`;
}
// Marker of the always-on safety block / file (one per target, not per skill).
function safetyMarker(version) {
  return `<!-- brighttest skills v${version} — managed by \`brighttest skills\`; edits are overwritten on update -->`;
}
function plainRender(bundle, fm, name) { return fileMarker(name) + '\n\n' + bundle; }
function cursorSafetyRender(text, version) {
  return ['---', 'description: brighttest rules that always apply (device lease, secrets, claims)', 'alwaysApply: true', '---', safetyMarker(version), '', text.trim(), ''].join('\n');
}
function plainSafetyRender(text, version) { return safetyMarker(version) + '\n\n' + text.trim() + '\n'; }

const AGENTS_DIR_SKILLS = (cwd) => path.join(cwd, '.agents', 'skills');
// skills: where the skills go. 'folder' = verbatim skill dir; 'flat' = one body-only doc per skill (refs copied to .agents/skills).
// safety: where the always-on rules go. 'block' = managed block `brighttest` (safety + skill index) in a shared file;
//         'file' = a brighttest-owned rule file (safety only).
const AGENTS = {
  claude:      { label: 'Claude Code',    skills: { kind: 'folder', dir: (cwd) => path.join(cwd, '.claude', 'skills') },
                 safety: { kind: 'block', file: (cwd) => path.join(cwd, 'CLAUDE.md') },
                 agents: { dir: (cwd) => path.join(cwd, '.claude', 'agents'), ext: '.md', render: (a, v) => renderClaudeAgent(a, v) } },
  agentskills: { label: 'Agent Skills',   skills: { kind: 'folder', dir: (cwd, o) => path.resolve(cwd, (o && o.skillsDir) || '.agents/skills') },
                 safety: { kind: 'block', file: (cwd) => path.join(cwd, 'AGENTS.md') } },
  cursor:      { label: 'Cursor',         skills: { kind: 'folder', dir: AGENTS_DIR_SKILLS },
                 safety: { kind: 'file', file: (cwd) => path.join(cwd, '.cursor', 'rules', 'brighttest-safety.mdc'), render: cursorSafetyRender },
                 legacyFile: (cwd, n) => path.join(cwd, '.cursor', 'rules', `${n}.mdc`) },
  windsurf:    { label: 'Windsurf',       skills: { kind: 'flat', file: (cwd, n) => path.join(cwd, '.windsurf', 'rules', `${n}.md`), render: plainRender, refs: AGENTS_DIR_SKILLS },
                 safety: { kind: 'file', file: (cwd) => path.join(cwd, '.windsurf', 'rules', 'brighttest-safety.md'), render: plainSafetyRender } },
  cline:       { label: 'Cline',          skills: { kind: 'flat', file: (cwd, n) => path.join(cwd, '.clinerules', `${n}.md`), render: plainRender, refs: AGENTS_DIR_SKILLS },
                 safety: { kind: 'file', file: (cwd) => path.join(cwd, '.clinerules', 'brighttest-safety.md'), render: plainSafetyRender } },
  zed:         { label: 'Zed',            skills: { kind: 'folder', dir: AGENTS_DIR_SKILLS },
                 safety: { kind: 'block', file: (cwd) => path.join(cwd, '.rules') } },
  agents:      { label: 'AGENTS.md',      skills: { kind: 'folder', dir: AGENTS_DIR_SKILLS },
                 safety: { kind: 'block', file: (cwd) => path.join(cwd, 'AGENTS.md') } },
  copilot:     { label: 'GitHub Copilot', skills: { kind: 'folder', dir: (cwd) => path.join(cwd, '.github', 'skills') },
                 safety: { kind: 'block', file: (cwd) => path.join(cwd, '.github', 'copilot-instructions.md') },
                 agents: { dir: (cwd) => path.join(cwd, '.github', 'agents'), ext: '.agent.md', render: (a, v) => renderCopilotAgent(a, v) } },
};
const ALIASES = { opencode: 'agents', codex: 'agents', hermes: 'agentskills' };
const ALL_AGENTS = Object.keys(AGENTS);
const SAFETY_MAX_BYTES = 6 * 1024; // bytes brighttest may add to any always-on file (design 3.3 rule c)

function detectAgents(cwd) {
  const has = (p) => fs.existsSync(path.join(cwd, p));
  const found = [];
  if (has('.claude') || has('CLAUDE.md')) found.push('claude');
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
  const man = localManifest();
  validateManifestEntries(man, 'skills/manifest.json');
  let entries = man.skills;
  if (only) { entries = entries.filter((s) => s.name === only); if (!entries.length) throw userError(`unknown skill '${only}'`); }
  return entries.map((s) => {
    const files = {};
    for (const f of s.files) files[f] = fs.readFileSync(path.join(SKILLS_DIR, s.name, f), 'utf8');
    return { name: s.name, files };
  });
}

// Always-on safety text named by a v2 manifest, or null (v1 manifest: no always-on).
function loadLocalSafety() {
  const man = localManifest();
  if (!man.alwaysOn || !man.alwaysOn.file) return null;
  validateManifestEntries(man, 'skills/manifest.json');
  return validateSafetyText(fs.readFileSync(path.join(SKILLS_DIR, man.alwaysOn.file), 'utf8'), 'skills/_always-on/safety.md');
}

// Neutral agent definitions (skills/_agents/<name>.md): [{ name, text, hosts }]; installBundle renders each for the
// targets named in its `hosts` (default claude).
// `root` overrides the skills folder (tests); then the folder is scanned, otherwise the bundled manifest decides.
function loadLocalAgents(root) {
  const base = root || SKILLS_DIR;
  const man = root ? { agents: readAgents(base, scanSkills(SKILLS_DIR).map((s) => s.name)) } : localManifest();
  return (man.agents || []).map((a) => {
    if (!SKILL_NAME_RE.test(a.name) || !validRelFile(a.file)) throw userError(`invalid agent entry ${JSON.stringify(a.name)}`);
    return { name: a.name, hosts: a.hosts || ['claude'], text: fs.readFileSync(path.join(base, a.file), 'utf8') };
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
  validateManifestEntries(man, `manifest at ref '${ref}'`);
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
  // v1 manifest (no `schema: .../v2`, no alwaysOn): skills only. v2: also the always-on safety text.
  const v2 = man.schema === 'brighttest-skills/v2' && man.alwaysOn && man.alwaysOn.file;
  const safety = v2 ? validateSafetyText(await fetchText(`${base}/${SAFETY_FILE}`), `safety text at ref '${ref}'`) : null;
  const agents = [];
  if (v2) {
    for (const a of man.agents || []) {
      agents.push({ name: a.name, hosts: a.hosts || ['claude'], text: await fetchText(`${base}/${a.file}`) });
    }
  }
  return { payloads, remoteVersion, safety, agents, manifestSchema: man.schema || 'brighttest-skills/v1' };
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

// ---- input validation (a --ref manifest is untrusted) ----

const SKILL_NAME_RE = /^[a-z0-9-]+$/;
const SAFETY_FILE = '_always-on/safety.md';

// A relative path inside a skill folder: no absolute path, drive letter, backslash, NUL or `..` segment.
function validRelFile(f) {
  if (typeof f !== 'string' || !f || f.includes('\0') || f.includes('\\')) return false;
  if (f.startsWith('/') || /^[A-Za-z]:/.test(f)) return false;
  // Windows drops a trailing dot or space from a name, so `a.` and `a ` would alias `a`.
  return f.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..' && !/[. ]$/.test(seg));
}

function validateManifestEntries(man, where) {
  for (const s of man.skills || []) {
    if (!s || typeof s.name !== 'string' || !SKILL_NAME_RE.test(s.name)) throw userError(`${where}: invalid skill name ${JSON.stringify(s && s.name)} (expected [a-z0-9-]+)`);
    if (!Array.isArray(s.files) || !s.files.every(validRelFile)) throw userError(`${where}: skill '${s.name}' lists an unsafe file path`);
  }
  for (const a of man.agents || []) {
    if (!a || typeof a.name !== 'string' || !SKILL_NAME_RE.test(a.name)) throw userError(`${where}: invalid agent name ${JSON.stringify(a && a.name)} (expected [a-z0-9-]+)`);
    if (!validRelFile(a.file) || !/^_agents\/[^/]+\.md$/.test(a.file)) throw userError(`${where}: agent '${a.name}' lists an unsafe file path`);
  }
  if (man.alwaysOn && man.alwaysOn.file !== SAFETY_FILE) throw userError(`${where}: alwaysOn.file must be ${SAFETY_FILE}`);
}

function validateSafetyText(text, where) {
  if (/<!--\s*(BEGIN|END)\s+brighttest\b/i.test(text)) throw userError(`${where}: safety text contains brighttest block markers`);
  if (countLines(text) > ALWAYS_ON_MAX) throw userError(`${where}: safety text is over ${ALWAYS_ON_MAX} lines`);
  if (Buffer.byteLength(text) > SAFETY_MAX_BYTES) throw userError(`${where}: safety text is over ${SAFETY_MAX_BYTES} bytes`);
  return text;
}

// ---- fs helpers ------------------------------------------------------------

// `rel` resolved under `base`; throws when it would land outside.
function safeJoin(base, relPath) {
  const dest = path.resolve(base, relPath);
  const r = path.relative(path.resolve(base), dest);
  if (!r || r.startsWith('..') || path.isAbsolute(r)) throw userError(`refusing to write outside ${base}: ${relPath}`);
  return dest;
}

// Refuse a write whose path is inside the project lexically but resolves (through a symlink) outside it.
function assertNoEscape(root, target) {
  const lex = path.relative(path.resolve(root), path.resolve(target));
  if (lex.startsWith('..') || path.isAbsolute(lex)) return; // explicit location outside the project (e.g. --skills-dir): the user's choice
  let probe = path.resolve(target);
  while (!fs.existsSync(probe)) { const up = path.dirname(probe); if (up === probe) return; probe = up; }
  const r = path.relative(fs.realpathSync(root), fs.realpathSync(probe));
  if (r.startsWith('..') || path.isAbsolute(r)) throw userError(`refusing to write through a symlink that resolves outside the project: ${lex.split(path.sep).join('/')}`);
}

// Rename can fail briefly on Windows (EPERM/EBUSY: antivirus, an editor or indexer holds the file). Retry a few
// times with a short backoff; when it still fails, say it is transient rather than blaming file permissions.
const RENAME_RETRIES = 5;
function sleepMs(ms) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (e) { /* no wait available: retry at once */ } }
function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt++) {
    try { return fs.renameSync(from, to); }
    catch (e) {
      if (process.platform !== 'win32' || (e.code !== 'EPERM' && e.code !== 'EBUSY')) throw e;
      if (attempt >= RENAME_RETRIES) {
        const err = new Error(`${path.basename(to)} could not be replaced (${e.code}, still busy after ${RENAME_RETRIES} retries); another program may have it open: close it and re-run`);
        err.code = e.code; err.transient = true;
        throw err;
      }
      sleepMs(10 * 2 ** attempt);
    }
  }
}

// Temp file + rename in the same dir; keeps the mode; never replaces a read-only file or a symlink itself,
// and refuses a dangling symlink (writing would silently swap the link for a regular file).
function atomicWrite(file, content, root) {
  if (root) assertNoEscape(root, file);
  let target = file, mode = null, st = null;
  try { st = fs.lstatSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (st) {
    if (st.isSymbolicLink()) {
      try { target = fs.realpathSync(file); }
      catch (e) { throw userError(`${path.basename(file)} is a symlink whose target does not exist; refusing to replace it with a regular file (fix or remove the link)`); }
    }
    mode = fs.statSync(target).mode & 0o777;
    try { fs.accessSync(target, fs.constants.W_OK); } catch (e) { const err = new Error(`${path.basename(file)} is read-only`); err.code = 'EACCES'; throw err; }
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.bt-tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    fs.writeFileSync(tmp, content);
    if (mode != null) fs.chmodSync(tmp, mode);
    renameWithRetry(tmp, target);
  } catch (e) { try { fs.rmSync(tmp, { force: true }); } catch (e2) { /* best effort */ } throw e; }
}

function writeFilesTo(destDir, files, root) {
  for (const [relPath, content] of Object.entries(files)) {
    atomicWrite(safeJoin(destDir, relPath), content, root);
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

// ---- managed block `brighttest` (safety + skill index) -------------------------

const BLOCK_BEGIN = '<!-- BEGIN brighttest -->';
const BLOCK_END = '<!-- END brighttest -->';

function detectEol(text) {
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/\n/g) || []).length - crlf;
  return crlf > lf ? '\r\n' : '\n';
}
const toEol = (text, eol) => text.replace(/\r\n/g, '\n').split('\n').join(eol);
// Locate one managed block (marker lines outside code fences). Returns null when absent; throws a clear error when
// the markers are unbalanced, out of order or duplicated. { index, length, lead, trail } include adjoining line breaks.
function findBlock(text, begin, end, file) {
  const begins = [], ends = [];
  let pos = 0, fence = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const f = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (f) {
      if (!fence) fence = { ch: f[1][0], len: f[1].length };
      else if (f[1][0] === fence.ch && f[1].length >= fence.len && line.trim() === f[1]) fence = null;
    } else if (!fence) {
      if (line.trimEnd() === begin) begins.push({ start: pos, stop: pos + line.trimEnd().length });
      else if (line.trimEnd() === end) ends.push({ start: pos, stop: pos + line.trimEnd().length });
    }
    pos += raw.length + 1;
  }
  const name = path.basename(file || 'file');
  const bad = (why) => userError(`${name}: managed block ${begin} is malformed (${why}); fix the file by hand, nothing was changed`);
  if (!begins.length && !ends.length) return null;
  if (begins.length > 1 || ends.length > 1) throw bad('duplicate BEGIN/END markers');
  if (!begins.length || !ends.length) throw bad(begins.length ? 'BEGIN without END' : 'END without BEGIN');
  if (ends[0].start < begins[0].start) throw bad('END before BEGIN');
  let start = begins[0].start, stop = ends[0].stop;
  const lead = start > 0 ? (text.slice(Math.max(0, start - 2), start) === '\r\n' ? '\r\n' : '\n') : '';
  start -= lead.length;
  const trail = text.startsWith('\r\n', stop) ? '\r\n' : text.startsWith('\n', stop) ? '\n' : '';
  return { index: start, length: stop + trail.length - start, lead, trail };
}

// Create / update the one `brighttest` block in a shared file. Merge, never overwrite: everything outside
// the block is preserved byte for byte (CRLF files stay CRLF). Returns { action, note? }.
function upsertBlock(file, inner, version, root) {
  const body = `${BLOCK_BEGIN}\n${safetyMarker(version)}\n${inner.trim()}\n${BLOCK_END}`;
  if (!fs.existsSync(file)) {
    atomicWrite(file, body + '\n', root);
    return { action: 'created' };
  }
  const cur = fs.readFileSync(file, 'utf8');
  const eol = detectEol(cur);
  const block = toEol(body, eol);
  const m = findBlock(cur, BLOCK_BEGIN, BLOCK_END, file);
  let next, note = null;
  if (m) {
    note = versionNote(oldBlockVersion(cur));
    next = cur.slice(0, m.index) + m.lead + block + m.trail + cur.slice(m.index + m.length);
  } else if (cur === '') {
    next = block + eol;
  } else {
    // keep the user's bytes exactly: a file ending in a line break gets a blank line + block + break; one without gets break + block
    next = /\n$/.test(cur) ? cur + eol + block + eol : cur + eol + block;
    note = 'appended block (existing content preserved)';
  }
  if (next === cur) return { action: 'unchanged' };
  atomicWrite(file, next, root);
  return { action: 'updated', note };
}

// Remove a managed block (given its markers). A block we appended at the end takes its separator with it, so the
// file returns to its original bytes. A file left empty is kept (never deleted). Returns true when removed.
function removeBlockText(file, begin, end, root) {
  if (!fs.existsSync(file)) return false;
  const cur = fs.readFileSync(file, 'utf8');
  const m = findBlock(cur, begin, end, file);
  if (!m) return false;
  const pre = cur.slice(0, m.index), post = cur.slice(m.index + m.length);
  // Keep one separator between the text before and after, never two: a blank line on either side of the block
  // already is that separator.
  const eolAt = /^(\r\n|\n)/.exec(post);
  let mid = m.lead && m.trail ? m.lead : '', rest = post;
  if (eolAt && post !== '') { if (!m.lead) rest = post.slice(eolAt[0].length); else if (/\n$/.test(pre)) mid = ''; }
  const next = post === '' ? pre : pre + mid + rest;
  atomicWrite(file, next, root);
  return true;
}

function oldBlockVersion(text) { const m = text.match(/brighttest skills v([\w.-]+)/); return m ? m[1] : null; }

// Legacy per-skill blocks `<!-- BEGIN brighttest:<skill> -->` that carry our marker. Returns their skill names.
function legacyBlockNames(text) {
  const out = [];
  let fence = null;
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  lines.forEach((line, i) => {
    const f = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (f) { if (!fence) fence = { ch: f[1][0], len: f[1].length }; else if (f[1][0] === fence.ch && f[1].length >= fence.len && line.trim() === f[1]) fence = null; return; }
    if (fence) return;
    const m = line.trimEnd().match(/^<!-- BEGIN brighttest:([a-z0-9-]+) -->$/);
    if (m && (lines[i + 1] || '').startsWith(`<!-- brighttest skills:${m[1]} v`)) out.push(m[1]);
  });
  return out;
}

function skillIndex(payloads, dirRel) {
  const lines = [`Installed brighttest skills (full text in \`${dirRel}/<name>/SKILL.md\`; load one when its description matches):`];
  for (const p of payloads) {
    const d = (parseFrontmatter(p.files['SKILL.md']).fm.description || '').replace(/\s+/g, ' ');
    lines.push(`- ${p.name}: ${d.length > 90 ? d.slice(0, 87).replace(/\s+\S*$/, '') + '...' : d}`);
  }
  return lines.join('\n');
}

function safetyText(safety, version) { return safety.replace(/<version>/g, version).trim(); }

// ---- per-skill writer / remover -------------------------------------------

function refsNote(cwd, a, name) {
  const dir = path.join(a.skills.refs(cwd), name, 'references');
  return rel(cwd, dir).split(path.sep).join('/');
}

function writeSkillToAgent(cwd, agentKey, payload, opts) {
  const a = AGENTS[agentKey];
  const s = a.skills;
  if (!SKILL_NAME_RE.test(payload.name)) throw userError(`invalid skill name ${JSON.stringify(payload.name)}`);
  if (s.kind === 'folder') {
    const dest = safeJoin(s.dir(cwd, opts), payload.name);
    const skillFile = path.join(dest, 'SKILL.md');
    let action = 'created';
    if (fs.existsSync(skillFile)) {
      const ours = fs.readFileSync(skillFile, 'utf8').includes(`name: ${payload.name}`);
      if (!ours && !opts.force) return { agent: agentKey, skill: payload.name, path: rel(cwd, dest), action: 'skipped', note: 'exists and not brighttest-owned — use --force' };
      action = 'updated';
    }
    writeFilesTo(dest, payload.files, cwd);
    return { agent: agentKey, skill: payload.name, path: rel(cwd, dest), action };
  }
  // flat: SKILL.md body only; references go to <.agents/skills>/<n>/references/ and are linked by path.
  const { fm, body } = parseFrontmatter(payload.files['SKILL.md']);
  let head = body;
  const cut = head.search(/\n#+\s+Reference files\b/);
  if (cut !== -1) head = head.slice(0, cut);
  const refPaths = Object.keys(payload.files).filter((f) => f !== 'SKILL.md').sort();
  let text = head.trim();
  if (refPaths.length) {
    text += `\n\n## References\n\nRead these when you need the detail (paths from the project root):\n\n` +
      refPaths.map((f) => `- ${refsNote(cwd, a, payload.name).replace(/references$/, '')}${f}`).join('\n');
  }
  const dest = s.file(cwd, payload.name);
  let action = 'created', note = null;
  if (fs.existsSync(dest)) {
    const cur = fs.readFileSync(dest, 'utf8');
    const ours = cur.includes(`brighttest skills:${payload.name}`);
    if (!ours && !opts.force) return { agent: agentKey, skill: payload.name, path: rel(cwd, dest), action: 'skipped', note: 'exists and not brighttest-owned — use --force' };
    action = 'updated'; note = versionNote(oldVersionIn(cur, payload.name));
  }
  atomicWrite(dest, s.render(text + '\n', fm, payload.name), cwd);
  const skipped = [];
  for (const f of refPaths) {
    const rf = safeJoin(path.join(s.refs(cwd), payload.name), f);
    const content = payload.files[f];
    if (fs.existsSync(rf)) {
      const cur = fs.readFileSync(rf, 'utf8');
      if (!cur.includes(`brighttest skills:${payload.name}`)) {
        if (cur === content || cur === content.replace(/\r?\n/g, '\r\n')) continue; // identical copy from a folder install: leave it
        if (!opts.force) { skipped.push(f); continue; }
      }
    }
    atomicWrite(rf, `${fileMarker(payload.name)}\n\n${content}`, cwd);
  }
  if (skipped.length) note = [note, `kept ${skipped.length} reference file(s) not brighttest-owned — use --force`].filter(Boolean).join('; ');
  return { agent: agentKey, skill: payload.name, path: rel(cwd, dest), action, note };
}

function removeSkillFromAgent(cwd, agentKey, name, opts) {
  const a = AGENTS[agentKey];
  if (!SKILL_NAME_RE.test(name)) throw userError(`invalid skill name ${JSON.stringify(name)}`);
  const s = a.skills;
  if (s.kind === 'folder') {
    const dest = path.join(s.dir(cwd, opts), name);
    if (!fs.existsSync(dest)) return { agent: agentKey, skill: name, path: rel(cwd, dest), action: 'absent' };
    const ours = fs.existsSync(path.join(dest, 'SKILL.md')) && fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8').includes(`name: ${name}`);
    if (!ours && !opts.force) return { agent: agentKey, skill: name, path: rel(cwd, dest), action: 'skipped', note: 'not brighttest-owned — use --force' };
    fs.rmSync(dest, { recursive: true, force: true });
    return { agent: agentKey, skill: name, path: rel(cwd, dest), action: 'removed' };
  }
  const dest = s.file(cwd, name);
  if (!fs.existsSync(dest)) return { agent: agentKey, skill: name, path: rel(cwd, dest), action: 'absent' };
  const ours = fs.readFileSync(dest, 'utf8').includes(`brighttest skills:${name}`);
  if (!ours && !opts.force) return { agent: agentKey, skill: name, path: rel(cwd, dest), action: 'skipped', note: 'not brighttest-owned — use --force' };
  fs.rmSync(dest, { force: true });
  removeOwnedRefs(cwd, a, name);
  return { agent: agentKey, skill: name, path: rel(cwd, dest), action: 'removed' };
}

// Reference copies written by a flat target carry our marker; only those are removed (empty dirs are pruned).
function removeOwnedRefs(cwd, a, name) {
  const root = path.join(a.skills.refs(cwd), name, 'references');
  if (!fs.existsSync(root)) return;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); if (!fs.readdirSync(p).length) fs.rmdirSync(p); }
      else if (fs.readFileSync(p, 'utf8').includes(`brighttest skills:${name}`)) fs.rmSync(p, { force: true });
    }
  };
  walk(root);
  for (const d of [root, path.join(a.skills.refs(cwd), name)]) { try { if (!fs.readdirSync(d).length) fs.rmdirSync(d); } catch (e) { /* not empty or gone */ } }
}

// ---- agent definitions (Claude subagents, `.claude/agents/<name>.md`) ----------------------------------------

// Ownership marker: the installer wrote this file. Placed right after the frontmatter (a subagent file must start
// with `---`). Uninstall and update act only on files that carry it for the same name.
function agentMarker(name, version) {
  return `<!-- brighttest agent:${name} v${version} — managed by \`brighttest skills\`; edits are overwritten on update -->`;
}
function agentOwned(text, name) { return new RegExp('^<!-- brighttest agent:' + escapeRe(name) + ' v', 'm').test(text); }

// Neutral source -> Claude subagent file: the same frontmatter minus `hosts` (not a Claude key), then the marker, then the body.
function renderClaudeAgent(a, version) {
  const m = a.text.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) throw userError(`agent '${a.name}': missing frontmatter`);
  const fm = parseFrontmatter(a.text).fm;
  if (!fm.description) throw userError(`agent '${a.name}': frontmatter needs a description`);
  const lines = m[1].split('\n').filter((l) => !/^hosts\s*:/.test(l));
  return ['---', ...lines, '---', agentMarker(a.name, version), '', m[2].trim(), ''].join('\n');
}

// Claude tool name -> GitHub Copilot tool alias. Copilot tool names are harness-specific and unknown names are ignored
// (ADOPT-23); the aliases below are NOT yet verified on a real Copilot install. Unmapped names pass through.
const COPILOT_TOOLS = { Read: 'read', Write: 'edit', Edit: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit', Grep: 'search', Glob: 'search', Bash: 'execute', WebFetch: 'web', WebSearch: 'web' };

// Neutral source -> Copilot custom agent (`.github/agents/<name>.agent.md`): name, description, mapped tools; `skills` and
// `hosts` are not Copilot keys and are dropped. Then the marker, then the unchanged body.
function renderCopilotAgent(a, version) {
  const m = a.text.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) throw userError(`agent '${a.name}': missing frontmatter`);
  const fm = parseFrontmatter(a.text).fm;
  if (!fm.description) throw userError(`agent '${a.name}': frontmatter needs a description`);
  const lines = m[1].split('\n').filter((l) => /^(name|description)\s*:/.test(l));
  if (fm.tools) {
    const tools = [...new Set(listField(fm.tools).map((t) => COPILOT_TOOLS[t] || t))];
    lines.push(`tools: [${tools.join(', ')}]`);
  }
  return ['---', ...lines, '---', agentMarker(a.name, version), '', m[2].trim(), ''].join('\n');
}

function writeAgentToTarget(cwd, agentKey, agent, version) {
  const dest = path.join(AGENTS[agentKey].agents.dir(cwd), `${agent.name}${AGENTS[agentKey].agents.ext}`);
  const base = { agent: agentKey, skill: `agent:${agent.name}`, path: rel(cwd, dest) };
  const out = AGENTS[agentKey].agents.render(agent, version);
  if (fs.existsSync(dest)) {
    const cur = fs.readFileSync(dest, 'utf8');
    // never overwrite a user's file, --force included: it is theirs, not ours
    if (!agentOwned(cur, agent.name)) return { ...base, action: 'skipped', note: 'exists and not brighttest-owned (--force does not apply to agents)' };
    if (cur === out) return { ...base, action: 'unchanged' };
    atomicWrite(dest, out, cwd);
    const old = cur.match(new RegExp('brighttest agent:' + escapeRe(agent.name) + ' v([\\w.-]+) '));
    return { ...base, action: 'updated', note: versionNote(old && old[1]) };
  }
  atomicWrite(dest, out, cwd);
  return { ...base, action: 'created' };
}

// Remove every marked file in the target's agents dir (also agents no longer shipped), then the dir if it is empty.
function removeAgentsFromTarget(cwd, agentKey) {
  const dir = AGENTS[agentKey].agents.dir(cwd);
  const ext = AGENTS[agentKey].agents.ext;
  const records = [];
  let entries = [];
  try { entries = fs.readdirSync(dir).sort(); } catch (e) { return records; }
  for (const e of entries) {
    const n = e.endsWith(ext) ? e.slice(0, -ext.length) : '';
    const f = path.join(dir, e);
    if (!n || !SKILL_NAME_RE.test(n)) continue;
    let st; try { st = fs.lstatSync(f); } catch (err) { continue; }
    if (!st.isFile()) continue;
    if (agentOwned(fs.readFileSync(f, 'utf8'), n)) { fs.rmSync(f, { force: true }); records.push({ agent: agentKey, skill: `agent:${n}`, path: rel(cwd, f), action: 'removed' }); }
  }
  try { if (!fs.readdirSync(dir).length) fs.rmdirSync(dir); } catch (e) { /* not empty or gone */ }
  return records;
}

// ---- always-on safety (block or file) + migration ------------------------------------------------------------

function safetyRel(cwd, a) { return rel(cwd, a.safety.file(cwd)); }

function writeSafety(cwd, agentKey, payloads, safety, version, opts) {
  const a = AGENTS[agentKey];
  const f = a.safety.file(cwd);
  const base = { agent: agentKey, skill: 'safety', path: safetyRel(cwd, a) };
  const text = safetyText(safety, version);
  if (a.safety.kind === 'file') {
    const out = a.safety.render(text, version);
    if (Buffer.byteLength(out) > SAFETY_MAX_BYTES) return { ...base, action: 'failed', note: `safety file would exceed ${SAFETY_MAX_BYTES} bytes` };
    if (fs.existsSync(f)) {
      const cur = fs.readFileSync(f, 'utf8');
      if (!/brighttest skills v[\w.-]+ /.test(cur) && !opts.force) return { ...base, action: 'skipped', note: 'exists and not brighttest-owned — use --force' };
      if (cur === out) return { ...base, action: 'unchanged' };
      atomicWrite(f, out, cwd);
      return { ...base, action: 'updated', note: versionNote(oldBlockVersion(cur)) };
    }
    atomicWrite(f, out, cwd);
    return { ...base, action: 'created' };
  }
  const dirRel = rel(cwd, a.skills.dir(cwd, opts)).split(path.sep).join('/');
  const inner = text + '\n\n' + skillIndex(payloads, dirRel);
  if (Buffer.byteLength(inner) > SAFETY_MAX_BYTES) return { ...base, action: 'failed', note: `block would exceed ${SAFETY_MAX_BYTES} bytes` };
  return { ...base, ...upsertBlock(f, inner, version, cwd) };
}

// brighttest-owned flattened files (`<dir>/<skill>.mdc` carrying our marker) left by the v1 installer. `names` =
// the skills of this run; null = every file that carries our marker, including skills no longer in the manifest.
function legacyFiles(cwd, a, names) {
  if (!a.legacyFile) return [];
  const out = [];
  const owned = (f, n) => { try { return fs.statSync(f).isFile() && new RegExp('^<!-- brighttest skills:' + escapeRe(n) + ' v', 'm').test(fs.readFileSync(f, 'utf8')); } catch (e) { return false; } };
  if (names) {
    for (const n of names) { const f = a.legacyFile(cwd, n); if (owned(f, n)) out.push({ name: n, file: f }); }
    return out;
  }
  const ext = path.extname(a.legacyFile(cwd, 'x'));
  const dir = path.dirname(a.legacyFile(cwd, 'x'));
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch (e) { return out; }
  for (const e of entries.sort()) {
    const n = path.basename(e, ext);
    if (e.endsWith(ext) && SKILL_NAME_RE.test(n) && owned(path.join(dir, e), n)) out.push({ name: n, file: path.join(dir, e) });
  }
  return out;
}

// Legacy per-skill blocks and brighttest-owned flattened files for targets that moved to folders.
// `names` = the skills of this run (a `--skill X` run leaves other legacy blocks alone); null = a full run, which
// also migrates blocks and files of skills that are no longer in the manifest. Each item is isolated: one failure
// (e.g. a malformed legacy block) is a `failed` record and does not hide the items that did migrate.
// Returns { records, failed }.
function migrateLegacy(cwd, agentKey, names) {
  const a = AGENTS[agentKey];
  const records = [];
  let failed = false;
  const fail = (n, p, e) => { failed = true; records.push({ agent: agentKey, skill: n, path: p, action: 'failed', note: `legacy migration: ${e.message}` }); };
  if (a.safety.kind === 'block') {
    const f = a.safety.file(cwd);
    if (fs.existsSync(f)) {
      let found = [];
      try { found = legacyBlockNames(fs.readFileSync(f, 'utf8')).filter((x) => !names || names.includes(x)); } catch (e) { fail('migration', rel(cwd, f), e); }
      for (const n of found) {
        try {
          removeBlockText(f, `<!-- BEGIN brighttest:${n} -->`, `<!-- END brighttest:${n} -->`, cwd);
          records.push({ agent: agentKey, skill: n, path: rel(cwd, f), action: 'migrated', note: 'legacy per-skill block removed' });
        } catch (e) { fail(n, rel(cwd, f), e); }
      }
    }
  }
  for (const { name, file } of legacyFiles(cwd, a, names)) {
    try {
      fs.rmSync(file, { force: true });
      records.push({ agent: agentKey, skill: name, path: rel(cwd, file), action: 'migrated', note: 'flattened file replaced by a skill folder' });
    } catch (e) { fail(name, rel(cwd, file), e); }
  }
  return { records, failed };
}

// ---- hook + MCP config merges (opt-in: --with-hook, --with-mcp) -------------------------------------------------
// Merge into the user's own JSON files; never overwrite. A file that is not strict JSON, or a key of the wrong type or
// holding a different brighttest value, is refused and nothing is written. Entries are identified by exact deep
// equality with what we write (JSON has no comments, so there is no marker); uninstall removes only such entries.

const HOOK_ENTRY = { matcher: 'Bash', hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/node_modules/brighttest/bin/cli.js" device hook', timeout: 5 }] };
const MCP_ENTRY = { command: 'node', args: ['node_modules/brighttest/bin/cli.js', 'mcp'] };
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const same = (a, b) => JSON.stringify(sortDeep(a)) === JSON.stringify(sortDeep(b));

// -> { data, indent, eol, exists } or throws a user-facing error (invalid JSON / not an object)
function readJsonConfig(file, rootKeyHint) {
  if (!fs.existsSync(file)) return { data: {}, indent: 2, eol: '\n', exists: false };
  const text = fs.readFileSync(file, 'utf8');
  let data;
  try { data = JSON.parse(text.replace(/^﻿/, '')); }
  catch (e) { throw userError(`${path.basename(file)} is not valid JSON (${e.message}); left unchanged. Comments and trailing commas are not supported. Add this entry by hand:\n${rootKeyHint}`); }
  if (!isObj(data)) throw userError(`${path.basename(file)} does not hold a JSON object; left unchanged. Add this entry by hand:\n${rootKeyHint}`);
  const m = text.match(/^[ \t]+(?=")/m);
  return { data, indent: m ? m[0] : 2, eol: text.includes('\r\n') ? '\r\n' : '\n', exists: true };
}
function writeJsonConfig(file, cfg, root) {
  let out = JSON.stringify(cfg.data, null, cfg.indent) + '\n';
  if (cfg.eol === '\r\n') out = out.replace(/\n/g, '\r\n');
  atomicWrite(file, out, root);
}

function mergeHook(cwd) {
  const file = path.join(cwd, '.claude', 'settings.json');
  const base = { agent: 'claude', skill: 'hook', path: rel(cwd, file) };
  const snippet = JSON.stringify({ hooks: { PreToolUse: [HOOK_ENTRY] } }, null, 2);
  const cfg = readJsonConfig(file, snippet);
  const d = cfg.data;
  if (d.hooks !== undefined && !isObj(d.hooks)) throw userError(`.claude/settings.json: "hooks" is not an object; left unchanged. Add this entry by hand:\n${snippet}`);
  if (d.hooks && d.hooks.PreToolUse !== undefined && !Array.isArray(d.hooks.PreToolUse)) throw userError(`.claude/settings.json: "hooks.PreToolUse" is not an array; left unchanged. Add this entry by hand:\n${snippet}`);
  const list = (d.hooks && d.hooks.PreToolUse) || [];
  if (list.some((e) => same(e, HOOK_ENTRY))) return { ...base, action: 'unchanged' };
  d.hooks = d.hooks || {};
  d.hooks.PreToolUse = [...list, HOOK_ENTRY];
  writeJsonConfig(file, cfg, cwd);
  return { ...base, action: cfg.exists ? 'updated' : 'created' };
}

function mergeMcp(cwd) {
  const file = path.join(cwd, '.mcp.json');
  const base = { agent: 'claude', skill: 'mcp', path: rel(cwd, file) };
  const snippet = JSON.stringify({ mcpServers: { brighttest: MCP_ENTRY } }, null, 2);
  const cfg = readJsonConfig(file, snippet);
  const d = cfg.data;
  if (d.mcpServers !== undefined && !isObj(d.mcpServers)) throw userError(`.mcp.json: "mcpServers" is not an object; left unchanged. Add this entry by hand:\n${snippet}`);
  if (d.mcpServers && d.mcpServers.brighttest !== undefined) {
    if (same(d.mcpServers.brighttest, MCP_ENTRY)) return { ...base, action: 'unchanged' };
    throw userError(`.mcp.json already has a different "brighttest" server; left unchanged. Remove it or merge by hand:\n${snippet}`);
  }
  d.mcpServers = { ...(d.mcpServers || {}), brighttest: MCP_ENTRY };
  writeJsonConfig(file, cfg, cwd);
  return { ...base, action: cfg.exists ? 'updated' : 'created' };
}

// Remove only entries identical to ours. Keeps the file (and any other content), even if it ends up with empty containers.
function unmergeHook(cwd) {
  const file = path.join(cwd, '.claude', 'settings.json');
  const base = { agent: 'claude', skill: 'hook', path: rel(cwd, file) };
  const cfg = readJsonConfig(file, '');
  const list = cfg.data.hooks && cfg.data.hooks.PreToolUse;
  if (!Array.isArray(list) || !list.some((e) => same(e, HOOK_ENTRY))) return { ...base, action: 'absent' };
  cfg.data.hooks.PreToolUse = list.filter((e) => !same(e, HOOK_ENTRY));
  if (!cfg.data.hooks.PreToolUse.length) delete cfg.data.hooks.PreToolUse;
  if (!Object.keys(cfg.data.hooks).length) delete cfg.data.hooks;
  writeJsonConfig(file, cfg, cwd);
  return { ...base, action: 'removed' };
}

function unmergeMcp(cwd) {
  const file = path.join(cwd, '.mcp.json');
  const base = { agent: 'claude', skill: 'mcp', path: rel(cwd, file) };
  const cfg = readJsonConfig(file, '');
  const s = cfg.data.mcpServers;
  if (!isObj(s) || s.brighttest === undefined) return { ...base, action: 'absent' };
  if (!same(s.brighttest, MCP_ENTRY)) return { ...base, action: 'skipped', note: 'brighttest server was edited: left in place' };
  delete s.brighttest;
  writeJsonConfig(file, cfg, cwd);
  return { ...base, action: 'removed' };
}

// Install: opts.withHook / opts.withMcp (claude target only); a refusal is a `failed` record and writes nothing.
// Uninstall: always tries both, removing only entries identical to ours; an unreadable file is `skipped`, not an error.
function configRecords(cwd, targets, opts, remove) {
  const records = [];
  if (!remove && !opts.withHook && !opts.withMcp) return records;
  if (!targets.includes('claude')) {
    if (!remove) records.push({ agent: 'claude', skill: 'hook/mcp', path: '', action: 'skipped', note: '--with-hook/--with-mcp apply to the claude target only' });
    return records;
  }
  const steps = [];
  if (remove || opts.withHook) steps.push(['hook', remove ? unmergeHook : mergeHook]);
  if (remove || opts.withMcp) steps.push(['mcp', remove ? unmergeMcp : mergeMcp]);
  for (const [name, fn] of steps) {
    try { records.push(fn(cwd)); }
    catch (e) { records.push({ agent: 'claude', skill: name, path: '', action: remove ? 'skipped' : 'failed', note: e.message }); }
  }
  return records;
}

// ---- commands --------------------------------------------------------------

// bundle: { payloads, safety (text or null), version, only (single-skill run), v1 (older manifest) }
function installBundle(bundle, opts, c, header) {
  const cwd = opts.cwd || process.cwd();
  const targets = resolveTargets(opts, cwd);
  if (targets.length === 0) { printNoAgents(c); return 0; }
  const { payloads } = bundle;
  const records = [];
  const names = payloads.map((p) => p.name);
  for (const t of targets) {
    let migrationFailed = false;
    if (bundle.safety != null) {
      try {
        const m = migrateLegacy(cwd, t, bundle.only ? names : null);
        records.push(...m.records);
        migrationFailed = m.failed;
      } catch (e) { migrationFailed = true; records.push({ agent: t, skill: 'migration', path: '', action: 'failed', note: e.message }); }
    }
    for (const p of payloads) {
      try { records.push(writeSkillToAgent(cwd, t, p, opts)); }
      catch (e) { records.push({ agent: t, skill: p.name, path: '', action: 'failed', note: e.message }); }
    }
    if (AGENTS[t].agents && !opts.noAgents && !bundle.only) {
      for (const ag of (bundle.agents || []).filter((x) => (x.hosts || ['claude']).includes(t))) {
        try { records.push(writeAgentToTarget(cwd, t, ag, bundle.version)); }
        catch (e) { records.push({ agent: t, skill: `agent:${ag.name}`, path: '', action: 'failed', note: e.message }); }
      }
    }
    if (bundle.safety != null && !opts.noSafety && !bundle.only) {
      // a legacy block that could not be removed stays; adding the new block next to it would duplicate the rules
      if (migrationFailed) { records.push({ agent: t, skill: 'safety', path: safetyRel(cwd, AGENTS[t]), action: 'skipped', note: 'legacy migration failed for this target: fix the file and re-run' }); continue; }
      try { records.push(writeSafety(cwd, t, payloads, bundle.safety, bundle.version, opts)); }
      catch (e) { records.push({ agent: t, skill: 'safety', path: safetyRel(cwd, AGENTS[t]), action: 'failed', note: e.transient ? e.message : e.code === 'EACCES' || e.code === 'EPERM' ? `cannot write (${e.code}): file is read-only` : e.message }); }
    }
  }
  if (!bundle.only) records.push(...configRecords(cwd, targets, opts, false));
  printSummary(header, records, c);
  if (bundle.v1) process.stdout.write('  ' + c.dim(`The manifest at this ref is v1: installed skills only (no always-on safety block, no migration). Update from a newer ref for the safety block.`) + '\n');
  else if (bundle.only && !opts.noSafety) process.stdout.write('  ' + c.dim('Single-skill run (--skill): the always-on safety block was not touched.') + '\n');
  return records.some((r) => r.action === 'failed') ? 1 : 0;
}

function install(opts, c) {
  return installBundle({ payloads: loadLocalSkills(opts.skill), safety: loadLocalSafety(), agents: loadLocalAgents(opts.agentsRoot), version: VERSION, only: !!opts.skill }, opts, c, `brighttest skills — installed (v${VERSION})`);
}

async function update(opts, c) {
  const ref = opts.ref || 'main';
  process.stdout.write('  ' + c.dim(`fetching skills from ${ref}…`) + '\n');
  const r = await loadRemoteSkills(ref, opts.skill);
  return installBundle({ payloads: r.payloads, safety: r.safety, agents: r.agents, version: r.remoteVersion, only: !!opts.skill, v1: r.safety == null }, opts, c, `brighttest skills — updated from ${ref} (v${r.remoteVersion})`);
}

function exportSkill(opts, c) {
  const cwd = opts.cwd || process.cwd();
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

// Version brighttest last wrote for a target, read from our markers; null when nothing of ours is there.
function installedVersion(cwd, key, opts) {
  const a = AGENTS[key];
  const re = /brighttest skills(?::[\w-]+)? v([\w.-]+) /;
  const f = a.safety.file(cwd);
  if (fs.existsSync(f)) { const m = fs.readFileSync(f, 'utf8').match(re); if (m) return { version: m[1], what: 'safety' }; }
  if (a.skills.kind === 'flat') {
    for (const p of localManifest().skills) {
      const sf = a.skills.file(cwd, p.name);
      if (fs.existsSync(sf)) { const m = fs.readFileSync(sf, 'utf8').match(re); if (m) return { version: m[1], what: 'skills' }; }
    }
  } else if (fs.existsSync(path.join(a.skills.dir(cwd, opts), localManifest().skills[0].name, 'SKILL.md'))) {
    return { version: null, what: 'skills' };
  }
  return null;
}

function list(opts, c) {
  const cwd = opts.cwd || process.cwd();
  const skills = loadLocalSkills().map((p) => ({ name: p.name, fm: parseFrontmatter(p.files['SKILL.md']).fm }));
  process.stdout.write('\n  ' + c.bold(`brighttest skills (v${VERSION})`) + '\n\n  ' + c.dim('Available skills') + '\n');
  for (const s of skills) {
    process.stdout.write('  ' + c.green('•') + ' ' + c.bold(s.name) + '\n');
    if (s.fm.description) process.stdout.write('    ' + c.dim(wrap(s.fm.description, 92, '    ')) + '\n');
  }
  const detected = detectAgents(cwd);
  process.stdout.write('\n  ' + c.dim('Detected agents in this project: ') + (detected.length ? detected.map((d) => AGENTS[d].label).join(', ') : 'none') + '\n');
  const installed = ALL_AGENTS.map((k) => ({ k, v: installedVersion(cwd, k, opts) })).filter((x) => x.v);
  if (installed.length) {
    process.stdout.write('\n  ' + c.dim('Installed (version brighttest wrote vs this CLI)') + '\n');
    for (const { k, v } of installed) {
      const state = v.version == null ? 'no version marker (skills only, no safety block)' : v.version === VERSION ? `v${v.version}, up to date` : `v${v.version}, CLI is v${VERSION}: run \`brighttest skills install\` to refresh`;
      process.stdout.write(`  ${c.dim('•')} ${AGENTS[k].label}: ${state}\n`);
    }
  }
  process.stdout.write('  ' + c.dim('Install: ') + 'brighttest skills install' + c.dim(detected.length ? '' : ' --agent <claude|cursor|agents|copilot|windsurf|cline|zed|agentskills|all>') + '\n');
  return 0;
}

function uninstall(opts, c) {
  const cwd = opts.cwd || process.cwd();
  const targets = resolveTargets(opts, cwd);
  if (targets.length === 0) { process.stdout.write('  ' + c.dim('No agents detected and no --agent given; nothing to remove.') + '\n'); return 0; }
  const names = (opts.skill ? [opts.skill] : localManifest().skills.map((s) => s.name));
  const records = [];
  for (const t of targets) {
    for (const n of names) {
      try { records.push(removeSkillFromAgent(cwd, t, n, opts)); }
      catch (e) { records.push({ agent: t, skill: n, path: '', action: 'failed', note: e.message }); }
    }
    if (opts.skill) continue; // a single-skill uninstall leaves the shared safety block and index alone
    if (AGENTS[t].agents && !opts.noAgents) {
      try { records.push(...removeAgentsFromTarget(cwd, t)); }
      catch (e) { records.push({ agent: t, skill: 'agents', path: '', action: 'failed', note: e.message }); }
    }
    const a = AGENTS[t];
    const base = { agent: t, skill: 'safety', path: safetyRel(cwd, a) };
    try {
      const f = a.safety.file(cwd);
      if (a.safety.kind === 'block') {
        for (const n of legacyBlockNames(fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '')) {
          removeBlockText(f, `<!-- BEGIN brighttest:${n} -->`, `<!-- END brighttest:${n} -->`, cwd);
          records.push({ agent: t, skill: n, path: base.path, action: 'removed', note: 'legacy per-skill block' });
        }
        records.push({ ...base, action: removeBlockText(f, BLOCK_BEGIN, BLOCK_END, cwd) ? 'removed' : 'absent' });
      } else if (!fs.existsSync(f)) records.push({ ...base, action: 'absent' });
      else if (!/brighttest skills v[\w.-]+ /.test(fs.readFileSync(f, 'utf8')) && !opts.force) records.push({ ...base, action: 'skipped', note: 'not brighttest-owned — use --force' });
      else { fs.rmSync(f, { force: true }); records.push({ ...base, action: 'removed' }); }
      for (const { name, file } of legacyFiles(cwd, a, null)) {
        fs.rmSync(file, { force: true });
        records.push({ agent: t, skill: name, path: rel(cwd, file), action: 'removed', note: 'legacy flattened file' });
      }
    } catch (e) { records.push({ ...base, action: 'failed', note: e.message }); }
  }
  if (!opts.skill) records.push(...configRecords(cwd, targets, opts, true));
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
  const sym = { created: c.green('✓'), updated: c.yellow('~'), removed: c.yellow('−'), migrated: c.yellow('→'), unchanged: c.grey('='), skipped: c.grey('•'), absent: c.grey('·'), failed: c.red('✗') };
  process.stdout.write('\n  ' + c.bold(header) + '\n');
  for (const r of records) {
    process.stdout.write(
      `  ${sym[r.action] || '?'} ${c.dim(r.action.padEnd(7))} ${AGENTS[r.agent] ? AGENTS[r.agent].label : r.agent} ${c.dim('· ' + r.skill)}` +
      (r.path ? ` ${c.dim('→ ' + r.path)}` : '') + (r.note ? ` ${c.dim('(' + r.note + ')')}` : '') + '\n',
    );
  }
  const n = (a) => records.filter((r) => r.action === a).length;
  const parts = ['created', 'updated', 'unchanged', 'migrated', 'removed', 'skipped', 'failed'].filter(n).map((a) => `${n(a)} ${a}`);
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

const AGENT_HOSTS = ALL_AGENTS; // an agent file's `hosts` must name install targets

// Agents (skills/_agents/<name>.md): frontmatter name, hosts, skills. Validated here so the generator fails loudly.
function readAgents(root, skillNames) {
  const dir = path.join(root, '_agents');
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.md')).sort()) {
    const { fm } = parseFrontmatter(fs.readFileSync(path.join(dir, f), 'utf8'));
    const name = f.replace(/\.md$/, '');
    const skills = listField(fm.skills);
    const hosts = fm.hosts ? listField(fm.hosts) : ['claude'];
    for (const sk of skills) if (!skillNames.includes(sk)) throw new Error(`agent '${name}' names unknown skill '${sk}'`);
    for (const h of hosts) if (!AGENT_HOSTS.includes(h)) throw new Error(`agent '${name}' has unknown host '${h}' (expected: ${AGENT_HOSTS.join(', ')})`);
    out.push({ name, file: `_agents/${f}`, hosts, skills });
  }
  return out;
}

// brighttest-skills/v2. Throws on an agent that names an unknown skill or host.
function scanSkills(root) {
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(root, d.name, 'SKILL.md')))
    .map((d) => ({ name: d.name, files: walkMd(path.join(root, d.name), '').sort() }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function generateManifest(root) {
  const skills = scanSkills(root);
  const m = { schema: 'brighttest-skills/v2', cliVersion: VERSION, skills, agents: readAgents(root, skills.map((s) => s.name)) };
  const safety = path.join(root, '_always-on', 'safety.md');
  if (fs.existsSync(safety)) {
    const n = countLines(fs.readFileSync(safety, 'utf8'));
    if (n > ALWAYS_ON_MAX) throw new Error(`_always-on/safety.md is ${n} lines, at most ${ALWAYS_ON_MAX}`);
    m.alwaysOn = { file: '_always-on/safety.md', maxLines: ALWAYS_ON_MAX };
  }
  m.facts = 'facts.json';
  return m;
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
  let gen;
  try { gen = generateManifest(root); } catch (e) { return { ok: false, drift: [e.message] }; }
  const a = flat(gen), b = flat(committed);
  const drift = [];
  for (const f of a) if (!b.has(f)) drift.push(`${f} (on disk, not in manifest)`);
  for (const f of b) if (!a.has(f)) drift.push(`${f} (in manifest, not on disk)`);
  drift.sort();
  if (!drift.length && JSON.stringify(gen) !== JSON.stringify(committed)) drift.push('manifest.json (ordering or schema differs)');
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
  const repoRoot = path.join(root, '..');
  if (fs.existsSync(path.join(repoRoot, 'package.json')) && fs.existsSync(path.join(repoRoot, 'bin', 'cli.js'))) {
    const problems = factsProblems(repoRoot);
    if (problems.length) {
      err.write(`brighttest skills --check: facts gate (${problems.length}); fix the text or run \`npm run skills:manifest\`:\n`);
      for (const p of problems) err.write(`  ${p}\n`);
      return 1;
    }
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
function checkShell(code, flags, platform = process.platform, subs = null) {
  const problems = [];
  const neutral = code.replace(/<[A-Za-z][\w .|-]*>/g, 'X').replace(/\.\.\./g, 'X');
  // On win32 `bash` may be the WSL launcher (no distro), so the syntax check is skipped there; the flag check below still runs.
  const r = platform === 'win32' ? { status: 0 } : require('child_process').spawnSync('bash', ['-n'], { input: neutral, encoding: 'utf8' });
  if (r.status !== 0) problems.push(`shell syntax: ${(r.stderr || '').trim().split('\n')[0]}`);
  if (flags || subs) {
    for (const ln of code.split('\n')) {
      if (!/(^|[\s;&|(])(npx\s+)?brighttest\s/.test(ln)) continue;
      const seg = ln.slice(ln.search(/brighttest\s/)).split(/\s--\s/)[0].split(/[|;&]|\s#\s/)[0];
      if (subs) {
        const bad = unknownSubcommand(seg, subs);
        if (bad) problems.push(`unknown CLI subcommand '${bad}' in: ${ln.trim()}`);
      }
      if (!flags) continue;
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
    case 'sh': case 'bash': return checkShell(sn.code, ctx.flags, ctx.platform, ctx.subcommands);
    case 'brightscript': case 'brs': return checkBrightScript(sn.code);
    default: return [];
  }
}

// Validate every snippet in every skill markdown file under `root`. Returns [{ file, line, lang, problem }].
function validateSkillSnippets(root = SKILLS_DIR, cliFile = path.join(__dirname, '..', 'bin', 'cli.js')) {
  const cliSrc = fs.existsSync(cliFile) ? fs.readFileSync(cliFile, 'utf8') : null;
  const flags = cliSrc ? knownCliFlags(cliSrc) : null;
  const subcommands = cliSrc ? scrapeSubcommands(cliSrc) : null;
  const failures = [];
  for (const s of scanSkills(root)) {
    for (const f of s.files) {
      const file = `${s.name}/${f}`;
      for (const sn of extractSnippets(fs.readFileSync(path.join(root, s.name, f), 'utf8'))) {
        for (const problem of validateSnippet(sn, { flags, subcommands })) failures.push({ file, line: sn.line, lang: sn.lang, problem });
      }
    }
  }
  return failures;
}


// ---- facts gate (ADR 0023): skills/facts.json + claim rules ----------------------------------------------------

const FACTS_SCHEMA = 'brighttest-facts/v1';

// Every `brighttest <word> [<word>]` usage line in the `*_HELP` strings of bin/cli.js, as "word" or "word word".
// A first word that has children is not itself a subcommand ("device" alone is not listed).
function scrapeSubcommands(cliSrc) {
  const kids = new Map();
  for (const blk of cliSrc.matchAll(/const [A-Z0-9_]*HELP = `((?:[^`\\]|\\[\s\S])*)`/g)) {
    for (const ln of blk[1].split('\n')) {
      const m = ln.match(/^\s*brighttest\s+([a-z][a-z0-9-]*)(?:\s+([a-z][a-z0-9|-]*))?/);
      if (!m) continue;
      if (!kids.has(m[1])) kids.set(m[1], new Set());
      if (m[2]) for (const w of m[2].split('|')) if (w) kids.get(m[1]).add(w);
    }
  }
  const out = [];
  for (const [k, set] of kids) { if (set.size) for (const w of set) out.push(`${k} ${w}`); else out.push(k); }
  return new Set(out);
}

// Nonexistent subcommand named by a `brighttest ...` segment, or null. Flags, placeholders and a missing word pass.
function unknownSubcommand(seg, subs) {
  const toks = seg.trim().split(/\s+/).slice(1);
  const w1 = toks[0];
  if (!w1 || !/^[a-z][\w-]*$/.test(w1)) return null;
  const all = [...subs];
  const hasKids = all.some((s) => s.startsWith(w1 + ' '));
  if (!hasKids) return subs.has(w1) ? null : w1;
  const w2 = toks[1];
  if (!w2 || !/^[a-z][\w-]*$/.test(w2)) return null;
  return subs.has(`${w1} ${w2}`) ? null : `${w1} ${w2}`;
}

function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortDeep(v[k])]));
  return v;
}

function agentNames(repoRoot) {
  const dir = path.join(repoRoot, 'skills', '_agents');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, '')).sort();
}

// The facts object for a repo checkout (never written here). Constants come from the code, text from files.
function collectFacts(repoRoot) {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const cliSrc = fs.readFileSync(path.join(repoRoot, 'bin', 'cli.js'), 'utf8');
  const man = JSON.parse(fs.readFileSync(path.join(repoRoot, 'skills', 'manifest.json'), 'utf8'));
  const { DEVICE_LEASE_DEFAULTS, INSTRUMENT_DEFAULTS } = require('./config');
  const lease = require('./device-lease');
  const deps = pkg.dependencies || {};
  const L = DEVICE_LEASE_DEFAULTS;
  return sortDeep({
    schema: FACTS_SCHEMA,
    cliVersion: pkg.version,
    nodeMin: Number((String((pkg.engines && pkg.engines.node) || '').match(/(\d+)/) || [0, 0])[1]),
    skills: man.skills.map((s) => s.name).sort(),
    agents: agentNames(repoRoot),
    subcommands: [...scrapeSubcommands(cliSrc)].sort(),
    flags: [...knownCliFlags(cliSrc)].filter((f) => f !== '--').sort(),
    exitCodes: {
      leaseBusy: lease.LEASE_EXIT.busy, leaseLost: lease.LEASE_EXIT.lost, leaseDir: lease.LEASE_EXIT.dir,
      verifyInstrumented: require('./instrument/verify').EXIT_INSTRUMENTED, buildStrict: require('./instrument/build').EXIT_STRICT,
    },
    leaseDefaults: { wait: L.wait, maxHold: L.maxHold, sessionIdle: L.sessionIdle, sessionMax: L.sessionMax, studioIdle: L.studioIdle },
    hubDefaultPort: require('./instrument/hub').DEFAULT_HUB_PORT,
    instrumentDefaults: { strict: INSTRUMENT_DEFAULTS.strict },
    engines: { brsNode: deps['@ramonlobo/brs-node'], rooibos: deps['@ramonlobo/rooibos-roku'] },
  });
}

function renderFacts(facts) { return JSON.stringify(sortDeep(facts), null, 2) + '\n'; }

function listMd(dir, base = '') {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listMd(path.join(dir, e.name), rel));
    else if (e.name.endsWith('.md')) out.push(rel);
  }
  return out.sort();
}

// Sentences of a markdown text with their 1-based start line. A list item or table row is its own unit.
function sentencesOf(text) {
  const units = [];
  let cur = null;
  text.split('\n').forEach((ln, i) => {
    if (!ln.trim()) { cur = null; return; }
    if (cur && !/^\s*([-*]|\d+\.|\|)\s/.test(ln)) { cur.text += ' ' + ln.trim(); return; }
    cur = { line: i + 1, text: ln.trim() };
    units.push(cur);
  });
  const out = [];
  for (const u of units) for (const s of u.text.split(/(?<=[.!?])\s+(?=[A-Z0-9`*(])/)) out.push({ line: u.line, text: s });
  return out;
}

const EXIT_WORDS = {
  leaseBusy: /busy|timeout|timed out|wait/i,
  leaseLost: /lost|expired|not held/i,
  leaseDir: /lease dir|directory|unusable/i,
  verifyInstrumented: /instrument|marker|verify/i,
  buildStrict: /strict|could not instrument/i,
};

const BANNED = [
  { re: new RegExp('\\bNode(?:\\.js)? ?1' + '8\\b'), why: 'that Node major is below engines.node' },
  { re: new RegExp('group-' + 'writable', 'i'), why: 'the device lease is not shared across users' },
  { re: /testId/, unless: /\b(not|never|invisible|avoid|don't)\b/i, why: 'testId is invisible to sgnodes; select on id, text or subtype' },
  { re: /instrumentExclude/, why: 'use instrument.exclude' },
  { re: /--no-lease/, unless: /\b(never|not|don't)\b/i, why: '--no-lease only inside a "never" sentence' },
];

// Existing SKILL.md sizes (lines) are grandfathered at +10 %; a new skill gets 150. References: 200.
const SKILL_LINES_GRANDFATHERED = {
  'debugging-failing-tests': 118, 'setting-up-brighttest': 113, 'testing-app-state': 101, 'using-brighttest-mcp': 101,
  'using-brighttest-studio': 96, 'writing-e2e-flows': 167, 'writing-rooibos-tests': 114,
};
// examples.md predates the 200-line reference limit; remove this entry when the file is split (see docs/maintainers.md).
const REF_LINES_GRANDFATHERED = { 'writing-rooibos-tests/references/examples.md': 226 };
const SKILL_LINES_NEW = 150, REF_LINES_MAX = 200, DESCRIPTION_MAX = 1024, ALWAYS_ON_MAX = 45;

const countLines = (t) => t.replace(/\n$/, '').split('\n').length;

function listField(v) { return String(v || '').replace(/[\[\]]/g, '').split(',').map((x) => x.trim()).filter(Boolean); }

// Rules 2-9 over a checkout. Returns problem strings "<rule N> <file>[:line]: message".
function claimProblems(repoRoot, facts) {
  const P = [];
  const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');
  const skillFiles = listMd(path.join(repoRoot, 'skills')).map((f) => `skills/${f}`);
  const docFiles = listMd(path.join(repoRoot, 'docs')).map((f) => `docs/${f}`);
  const nodeFiles = [...skillFiles, ...docFiles];
  if (fs.existsSync(path.join(repoRoot, 'README.md'))) nodeFiles.push('README.md');

  // 2. Node claims
  const nodeRes = [/\bNode(?:\.js)?\s+v?(\d+)\+/gi, /\bnode\s*(?:>=|≥)\s*v?(\d+)/gi, /node-version:\s*['"]?(\d+)/gi];
  const nodeScan = (file, text) => {
    for (const re of nodeRes) for (const m of text.matchAll(re)) {
      if (Number(m[1]) !== facts.nodeMin) P.push(`rule 2 ${file}: Node claim '${m[0]}' differs from nodeMin ${facts.nodeMin}`);
    }
  };
  for (const f of nodeFiles) nodeScan(f, read(f));
  const cliSrc = read('bin/cli.js');
  for (const blk of cliSrc.matchAll(/const [A-Z0-9_]*HELP = `((?:[^`\\]|\\[\s\S])*)`/g)) nodeScan('bin/cli.js', blk[1]);

  // 3. Skill lists
  const sameSet = (a, b) => a.length === b.length && [...a].sort().join() === [...b].sort().join();
  const helpBlk = cliSrc.match(/const SKILLS_HELP = `((?:[^`\\]|\\[\s\S])*)`/);
  const helpList = helpBlk && helpBlk[1].match(/Skills \([^)]*\):([\s\S]*?)\.\n/);
  const helpNames = helpList ? helpList[1].split(',').map((x) => x.trim()).filter(Boolean) : [];
  if (!sameSet(helpNames, facts.skills)) P.push(`rule 3 bin/cli.js: SKILLS_HELP lists [${helpNames.join(', ')}], expected [${facts.skills.join(', ')}]`);
  if (fs.existsSync(path.join(repoRoot, 'docs/guide/agent-skills.md'))) {
    const doc = read('docs/guide/agent-skills.md');
    const tbl = doc.slice(Math.max(0, doc.search(/^\|\s*Skill\s*\|\s*Teaches/m))).split(/\n\s*\n/)[0];
    const rows = [...tbl.matchAll(/^\|\s*`([a-z0-9-]+)`\s*\|/gm)].map((m) => m[1]).filter((n) => facts.skills.includes(n) || !/\s/.test(n));
    const tableNames = rows.filter((n) => !/^\./.test(n) && !n.includes('/'));
    if (!sameSet(tableNames, facts.skills)) P.push(`rule 3 docs/guide/agent-skills.md: skills table lists [${tableNames.join(', ')}], expected [${facts.skills.join(', ')}]`);
  }

  // 5-7 over skills/ text
  const ec = facts.exitCodes;
  const exitNums = { [ec.leaseBusy]: 'leaseBusy', [ec.leaseLost]: 'leaseLost', [ec.leaseDir]: 'leaseDir', [ec.verifyInstrumented]: 'verifyInstrumented', [ec.buildStrict]: 'buildStrict' };
  const L = facts.leaseDefaults;
  const durKeys = [
    { re: /wait/gi, allow: [L.wait], name: 'wait' },
    { re: /hold/gi, allow: [L.maxHold], name: 'hold' },
    { re: /idle/gi, allow: [L.sessionIdle, L.studioIdle], name: 'idle' },
    { re: /session/gi, allow: [L.sessionIdle, L.sessionMax], name: 'session' },
  ];
  for (const f of skillFiles) {
    const text = read(f);
    for (const s of sentencesOf(text)) {
      const where = `${f}:${s.line}`;
      // 5. exit-code claims
      if (/\bexits?\b/i.test(s.text)) {
        for (const m of s.text.matchAll(/\b(?:exits?|exit codes?|codes?)\b(?:\s+\S+){0,3}?\s+(\d{1,3})(?![\w.%])/gi)) {
          const key = exitNums[m[1]];
          if (key && !EXIT_WORDS[key].test(s.text)) P.push(`rule 5 ${where}: exit ${m[1]} claim lacks its meaning (${key})`);
        }
      }
      // 6. defaults
      for (const m of s.text.matchAll(/\b(30m|60m|10m|45m)\b/g)) {
        // an explicit override (`--wait 10m`, `wait=10m`) is not a default claim
        if (/(--[\w-]+(\s+|=)|=)$/.test(s.text.slice(0, m.index))) continue;
        const before = s.text.slice(Math.max(0, m.index - 40), m.index);
        let best = null;
        for (const k of durKeys) for (const km of before.matchAll(k.re)) if (!best || km.index > best.at) best = { at: km.index, k };
        if (best && !best.k.allow.includes(m[1])) P.push(`rule 6 ${where}: '${m[1]}' near '${best.k.name}' differs from the default (${best.k.allow.join(' or ')})`);
      }
      if (/\bhub\b/i.test(s.text) && /default/i.test(s.text)) {
        for (const m of s.text.matchAll(/\b(8\d{3})\b/g)) {
          if (/(--[\w-]+(\s+|=)|=)$/.test(s.text.slice(0, m.index))) continue;
          if (Number(m[1]) !== facts.hubDefaultPort) P.push(`rule 6 ${where}: hub port ${m[1]} differs from hubDefaultPort ${facts.hubDefaultPort}`);
        }
      }
      // 7. banned claims
      for (const b of BANNED) if (b.re.test(s.text) && !(b.unless && b.unless.test(s.text))) P.push(`rule 7 ${where}: banned claim ${b.re} (${b.why})`);
    }
  }

  // 8. size gate
  const skillsDir = path.join(repoRoot, 'skills');
  for (const name of facts.skills) {
    const sk = path.join(skillsDir, name, 'SKILL.md');
    if (!fs.existsSync(sk)) continue;
    const txt = fs.readFileSync(sk, 'utf8');
    const max = SKILL_LINES_GRANDFATHERED[name] ? Math.ceil(SKILL_LINES_GRANDFATHERED[name] * 1.1) : SKILL_LINES_NEW;
    if (countLines(txt) > max) P.push(`rule 8 skills/${name}/SKILL.md: ${countLines(txt)} lines, at most ${max}`);
    const d = parseFrontmatter(txt).fm.description || '';
    if (d.length > DESCRIPTION_MAX) P.push(`rule 8 skills/${name}/SKILL.md: description is ${d.length} chars, at most ${DESCRIPTION_MAX}`);
    for (const f of listMd(path.join(skillsDir, name, 'references'))) {
      const rel = `${name}/references/${f}`;
      const n = countLines(fs.readFileSync(path.join(skillsDir, rel), 'utf8'));
      const rmax = REF_LINES_GRANDFATHERED[rel] ? Math.ceil(REF_LINES_GRANDFATHERED[rel] * 1.1) : REF_LINES_MAX;
      if (n > rmax) P.push(`rule 8 skills/${rel}: ${n} lines, at most ${rmax}`);
    }
  }
  const alwaysOn = path.join(skillsDir, '_always-on', 'safety.md');
  if (fs.existsSync(alwaysOn) && countLines(fs.readFileSync(alwaysOn, 'utf8')) > ALWAYS_ON_MAX) P.push(`rule 8 skills/_always-on/safety.md: more than ${ALWAYS_ON_MAX} lines`);

  // 9. agents
  for (const name of agentNames(repoRoot)) {
    const file = `skills/_agents/${name}.md`;
    const { fm, body } = parseFrontmatter(read(file));
    for (const sk of listField(fm.skills)) if (!facts.skills.includes(sk)) P.push(`rule 9 ${file}: skill '${sk}' does not exist`);
    if (listField(fm.tools).includes('Agent')) P.push(`rule 9 ${file}: tools must not contain Agent`);
    if (/brighttest device|device with|\broku\b/i.test(body) && !(/--no-lease/.test(body) && /device unlock --force/.test(body))) {
      P.push(`rule 9 ${file}: device-touching agent lacks the forbidden-actions lines (--no-lease, device unlock --force)`);
    }
  }
  return P;
}

// Rule 1 (drift) + rules 2-9. Empty list = ok. Rule 4 runs in the snippet validation (checkShell).
function factsProblems(repoRoot) {
  const P = [];
  const facts = collectFacts(repoRoot);
  const file = path.join(repoRoot, 'skills', 'facts.json');
  if (!fs.existsSync(file)) P.push('rule 1 skills/facts.json is missing; run `npm run skills:manifest`');
  else if (fs.readFileSync(file, 'utf8') !== renderFacts(facts)) P.push('rule 1 skills/facts.json differs from the code (facts drift); run `npm run skills:manifest`');
  P.push(...claimProblems(repoRoot, facts));
  const cli = path.join(repoRoot, 'bin', 'cli.js');
  for (const f of validateSkillSnippets(path.join(repoRoot, 'skills'), cli)) {
    if ((f.lang === 'sh' || f.lang === 'bash') && !/^shell syntax/.test(f.problem)) P.push(`rule 4 skills/${f.file}:${f.line}: ${f.problem}`);
  }
  return P;
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

module.exports = { SAFETY_MAX_BYTES, writeFilesTo, validRelFile, parseFrontmatter, collisionCheck, run, check, checkManifest, generateManifest, detectAgents, resolveTargets, loadLocalSkills, buildBundle, upsertBlock, extractSnippets, validateSnippet, validateSkillSnippets, knownCliFlags, ALL_AGENTS, checkShell, scrapeSubcommands, collectFacts, renderFacts, claimProblems, factsProblems, FACTS_SCHEMA };
