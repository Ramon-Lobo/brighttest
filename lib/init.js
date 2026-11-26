'use strict';
const fs = require('fs');
const path = require('path');
const { palette } = require('./reporter');

// `brighttest init` — scaffold a project for testing: brighttest.json, a first spec under source/tests/,
// git-ignore entries, and an npm test script. Non-destructive by default (existing files are left alone
// unless --force). Core fs/path only.

const CONFIG = `{
  "rootDir": ".",
  "sourceGlobs": ["manifest", "source/**/*", "components/**/*"],
  "testsFilePattern": "**/*.spec.bs",
  "stagingDir": ".brighttest"
}
`;

// A plain-BrightScript source/main.brs stays in the test build unchanged: the Rooibos plugin only injects its
// Rooibos_init launch hook into a Main it can transpile (.bs), so the app's own Main() would run instead of the
// runner and its event loop (wait(0, port)) hangs the headless run. Leave it out of the test build.
function configFor(cwd) {
  let dir = [];
  try { dir = fs.readdirSync(path.join(cwd, 'source')); } catch { /* no source/ */ }
  // the glob must use the real file name (a case-insensitive filesystem would match Main.brs for main.brs)
  const real = dir.find((n) => n.toLowerCase() === 'main.brs');
  if (!real) return CONFIG;
  return CONFIG.replace('"source/**/*", ', `"source/**/*", "!source/${real}", `);
}

const EXAMPLE_SPEC = `namespace tests
  ' Your first Rooibos suite. Specs must live under a compiled path (source/) and end in .spec.bs.
  ' Replace this with tests for your own source/ code — call your functions directly and assert on them.
  @suite("example")
  class ExampleTests extends rooibos.BaseTestSuite

    @describe("sanity")

    @it("runs a passing assertion")
    function _()
      m.assertEqual(2 + 3, 5)
    end function

    @it("compares floats to float literals (assertEqual is type-strict on numbers)")
    function _()
      m.assertEqual(1.5 + 1.5, 3.0)
    end function

  end class
end namespace
`;

const GITIGNORE_ENTRIES = ['.brighttest/', 'coverage/', 'reports/'];
const BROWNFIELD_GITIGNORE = ['.brighttest/', '*.bt-instrumented.zip'];

function ensureFile(file, content, force, cwd, c, records) {
  const exists = fs.existsSync(file);
  if (exists && !force) { records.push({ action: 'kept', path: rel(cwd, file) }); return; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  records.push({ action: exists ? 'overwrote' : 'created', path: rel(cwd, file) });
}

function ensureGitignore(cwd, c, records, entries = GITIGNORE_ENTRIES) {
  const file = path.join(cwd, '.gitignore');
  let cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const have = new Set(cur.split(/\r?\n/).map((l) => l.trim()));
  const missing = entries.filter((e) => !have.has(e));
  if (!missing.length) { records.push({ action: 'kept', path: '.gitignore' }); return; }
  const add = (cur && !cur.endsWith('\n') ? '\n' : '') + missing.join('\n') + '\n';
  fs.writeFileSync(file, cur + add);
  records.push({ action: cur ? 'updated' : 'created', path: '.gitignore', note: `+${missing.join(', ')}` });
}

function ensureTestScript(cwd, records) {
  const file = path.join(cwd, 'package.json');
  if (!fs.existsSync(file)) return;
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return; }
  pkg.scripts = pkg.scripts || {};
  if (pkg.scripts.test && !/^echo .*no test/i.test(pkg.scripts.test)) { records.push({ action: 'kept', path: 'package.json (test script)' }); return; }
  pkg.scripts.test = 'brighttest';
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
  records.push({ action: 'updated', path: 'package.json', note: '+test script' });
}

function rel(cwd, p) { const r = path.relative(cwd, p); return r.startsWith('..') ? p : r; }

// `init --brownfield`: for an app the user will not edit. Runs the static census, writes the `instrument` block into
// brighttest.json (merged into an existing one: valid keys kept, missing ones added, wrong-typed ones fixed; --force replaces the instrument block), proposes state.registrySections from the census, and adds the
// build outputs to .gitignore. No example spec, no npm test script.
async function runBrownfield(opts, cwd, c, records) {
  const { census } = require('./instrument/census');
  const cen = await census(cwd);
  const sections = [...new Set(cen.registrySections.map((r) => r.name).filter((n) => n && n !== '<dynamic>'))].sort();
  const file = path.join(cwd, 'brighttest.json');
  const existed = fs.existsSync(file);
  const { planMerge, formatChange, serialize } = require('./init-merge');
  const defaults = JSON.parse(configFor(cwd));
  let raw = '';
  let cfg = defaults;
  if (existed) {
    raw = fs.readFileSync(file, 'utf8');
    try { cfg = JSON.parse(raw); } catch (e) { throw new Error('brighttest.json is not valid JSON; fix it first (nothing was written)'); }
  }
  let plan;
  if (existed && opts.force && cfg && typeof cfg === 'object' && !Array.isArray(cfg)) {
    // --force: replace the instrument block (keeping its exclude list), as before; other keys still merge
    const prior = cfg.instrument && typeof cfg.instrument === 'object' ? cfg.instrument : null;
    const forced = { ...cfg, instrument: { strict: false, ...(prior && prior.exclude ? { exclude: prior.exclude } : {}), state: { registrySections: sections } } };
    plan = planMerge(forced, { defaults, sections });
    plan.changes.unshift({ kind: 'changed', key: 'instrument', old: cfg.instrument, new: forced.instrument });
  } else plan = planMerge(cfg, { defaults, sections });
  const changes = plan.changes;
  if (!existed) {
    plan = planMerge(defaults, { defaults, sections });
    if (!opts.dryRun) fs.writeFileSync(file, JSON.stringify(plan.next, null, 2) + '\n');
    records.push({ action: 'created', path: 'brighttest.json', note: `+instrument block, ${sections.length} registry section(s) proposed` });
  } else if (!changes.length) {
    records.push({ action: 'kept', path: 'brighttest.json', note: 'unchanged (valid)' });
  } else {
    if (!opts.dryRun) {
      fs.writeFileSync(file + '.bak', raw);
      fs.writeFileSync(file, serialize(plan.next, raw));
    }
    records.push({ action: opts.dryRun ? 'would-update' : 'updated', path: 'brighttest.json', note: opts.dryRun ? 'dry run, nothing written' : 'previous copy in brighttest.json.bak' });
    for (const ch of changes) records.push({ action: 'change', path: formatChange(ch) });
  }
  if (!opts.dryRun) ensureGitignore(cwd, c, records, BROWNFIELD_GITIGNORE);
  return { cen, sections };
}

// `init --greenfield`: copy the BTStore/BTHttp templates (version header line first) into source/brighttest/
// and make sure the manifest's bs_const has BT_AGENT=false. Idempotent: existing copies are kept (unless --force),
// existing consts are preserved, and a BT_AGENT const already present is never duplicated or flipped.
const TEMPLATE_DIR = path.join(__dirname, 'instrument', 'greenfield');
const GREENFIELD_FILES = ['BTStore.brs', 'BTHttp.brs'];

function ensureBsConst(cwd, records) {
  const file = path.join(cwd, 'manifest');
  if (!fs.existsSync(file)) { records.push({ action: 'kept', path: 'manifest', note: 'not found; add bs_const=BT_AGENT=false yourself' }); return; }
  const cur = fs.readFileSync(file, 'utf8');
  const eol = cur.includes('\r\n') ? '\r\n' : '\n';
  const lines = cur.split(/\r?\n/);
  const i = lines.findIndex((l) => /^\s*bs_const\s*=/.test(l));
  if (i < 0) {
    fs.writeFileSync(file, cur + (cur && !/\n$/.test(cur) ? eol : '') + 'bs_const=BT_AGENT=false' + eol);
    records.push({ action: 'updated', path: 'manifest', note: '+bs_const=BT_AGENT=false' });
    return;
  }
  const val = lines[i].replace(/^\s*bs_const\s*=/, '').trim();
  const consts = val ? val.split(';').map((x) => x.trim()).filter(Boolean) : [];
  // bsc lowercases const names, so match case-insensitively; never duplicate or flip an existing one.
  if (consts.some((x) => /^bt_agent\s*=/i.test(x))) { records.push({ action: 'kept', path: 'manifest (bs_const)' }); return; }
  consts.push('BT_AGENT=false');
  lines[i] = 'bs_const=' + consts.join(';');
  fs.writeFileSync(file, lines.join(eol));
  records.push({ action: 'updated', path: 'manifest', note: '+BT_AGENT=false in bs_const' });
}

function runGreenfield(opts, cwd, c, records) {
  for (const name of GREENFIELD_FILES) {
    const content = fs.readFileSync(path.join(TEMPLATE_DIR, name), 'utf8');
    ensureFile(path.join(cwd, 'source', 'brighttest', name), content, opts.force, cwd, c, records);
  }
  ensureBsConst(cwd, records);
}

async function run(cfg, opts) {
  const c = palette(!!process.stdout.isTTY);
  const cwd = process.cwd();
  const records = [];

  if (opts.greenfield && opts.brownfield) { process.stderr.write('[brighttest init] --greenfield and --brownfield cannot be combined\n'); return 1; }

  if (opts.brownfield) {
    let r;
    try { r = await runBrownfield(opts, cwd, c, records); } catch (e) { process.stderr.write(`[brighttest init --brownfield] ${e.message}\n`); return 1; }
    const sym = { created: c.green('✓'), updated: c.green('✓'), 'would-update': c.yellow('~'), change: c.dim('-'), kept: c.grey('•') };
    process.stdout.write('\n  ' + c.bold('brighttest init --brownfield') + '\n');
    for (const x of records) process.stdout.write(`  ${sym[x.action] || '?'} ${c.dim((x.action === 'change' ? '' : x.action).padEnd(12))} ${x.path}` + (x.note ? ` ${c.dim('(' + x.note + ')')}` : '') + '\n');
    const k = r.cen.counts;
    process.stdout.write(`\n  Census: ${r.cen.scenes.length} scene(s), ${k.tasks} task(s), ${r.cen.network.setUrlSites.length} setUrl site(s), ${r.cen.skipped.filter((s) => !s.informational).length} could not instrument.\n`);
    process.stdout.write(`  Proposed registry sections: ${r.sections.length ? r.sections.join(', ') : '(none found)'}\n`);
    process.stdout.write(`\n  Next:\n    ${c.dim('•')} full report:  ${c.bold('npx brighttest instrument census --out .brighttest/census')}\n    ${c.dim('•')} build:        ${c.bold('npx brighttest instrument build')}\n`);
    return 0;
  }

  // In greenfield mode --force refreshes only the templates; project files are never overwritten.
  const projForce = opts.greenfield ? false : opts.force;
  ensureFile(path.join(cwd, 'brighttest.json'), configFor(cwd), projForce, cwd, c, records);
  ensureFile(path.join(cwd, 'source', 'tests', 'Example.spec.bs'), EXAMPLE_SPEC, projForce, cwd, c, records);
  ensureGitignore(cwd, c, records);
  ensureTestScript(cwd, records);
  if (opts.greenfield) runGreenfield(opts, cwd, c, records);

  const sym = { created: c.green('✓'), updated: c.green('✓'), overwrote: c.yellow('~'), kept: c.grey('•') };
  process.stdout.write('\n  ' + c.bold('brighttest init') + '\n');
  for (const r of records) {
    process.stdout.write(`  ${sym[r.action] || '?'} ${c.dim(r.action.padEnd(9))} ${r.path}` + (r.note ? ` ${c.dim('(' + r.note + ')')}` : '') + '\n');
  }
  process.stdout.write(
    '\n  Next:\n' +
    `    ${c.dim('•')} run your tests:        ${c.bold('npx brighttest')}\n` +
    `    ${c.dim('•')} teach your AI agent:   ${c.bold('npx brighttest skills install')}\n` +
    `    ${c.dim('•')} coverage (no device):  ${c.bold('npx brighttest --coverage')}\n` +
    (opts.greenfield ? `    ${c.dim('•')} in Scene/Task components, add:  ${c.bold('<script type="text/brightscript" uri="pkg:/source/brighttest/BTStore.brs" />')}\n      (and BTHttp.brs the same way)\n` : '') +
    (records.some((r) => r.action === 'kept') ? `  ${c.dim('(Some files already existed and were kept — re-run with --force to overwrite.)')}\n` : ''),
  );
  return 0;
}

module.exports = { run };
