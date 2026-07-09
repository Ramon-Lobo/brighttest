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

function ensureFile(file, content, force, cwd, c, records) {
  const exists = fs.existsSync(file);
  if (exists && !force) { records.push({ action: 'kept', path: rel(cwd, file) }); return; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  records.push({ action: exists ? 'overwrote' : 'created', path: rel(cwd, file) });
}

function ensureGitignore(cwd, c, records) {
  const file = path.join(cwd, '.gitignore');
  let cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const have = new Set(cur.split(/\r?\n/).map((l) => l.trim()));
  const missing = GITIGNORE_ENTRIES.filter((e) => !have.has(e));
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

function run(cfg, opts) {
  const c = palette(!!process.stdout.isTTY);
  const cwd = process.cwd();
  const records = [];

  ensureFile(path.join(cwd, 'brighttest.json'), CONFIG, opts.force, cwd, c, records);
  ensureFile(path.join(cwd, 'source', 'tests', 'Example.spec.bs'), EXAMPLE_SPEC, opts.force, cwd, c, records);
  ensureGitignore(cwd, c, records);
  ensureTestScript(cwd, records);

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
    (records.some((r) => r.action === 'kept') ? `  ${c.dim('(Some files already existed and were kept — re-run with --force to overwrite.)')}\n` : ''),
  );
  return 0;
}

module.exports = { run };
