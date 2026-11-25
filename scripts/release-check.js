#!/usr/bin/env node
'use strict';
// Release-pipeline helpers used by .github/workflows/release.yml (and unit-tested in test/release-check.test.js).
//   node scripts/release-check.js pack <npm-pack-json-file>   validate the tarball file list
//   node scripts/release-check.js deps                        check every dependency range resolves on npm
//   node scripts/release-check.js integrity <npm-pack-json-file>   the tarball's sha512 integrity from `npm pack --json`
//   node scripts/release-check.js filename <npm-pack-json-file>    the tarball file name from `npm pack --json`
//   node scripts/release-check.js stage-id <log-file>         stage id from `npm stage publish` output
//   node scripts/release-check.js dist-tag <version>          print the dist-tag to stage under (next for prereleases)
//   node scripts/release-check.js version-ok <npm-version>    exit 0 when npm >= 11.15.0 (staged publishing needs it)
// Exit codes: 0 ok, 1 findings, 2 usage.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const FORBIDDEN = [/^test\//, /^scripts\//, /^docs\//, /^design\//, /^planning\//, /^\.github\//, /^examples\//];
const REQUIRED_PREFIXES = ['bin/', 'lib/', 'skills/'];
const REQUIRED_FILES = ['bin/cli.js', 'lib/studio/public/index.html', 'package.json'];

function validatePack(files) {
  const findings = [];
  const list = files.map((f) => String(f).replace(/\\/g, '/'));
  for (const f of list) if (FORBIDDEN.some((re) => re.test(f))) findings.push(`tarball contains a path that must not ship: ${f}`);
  for (const p of REQUIRED_PREFIXES) if (!list.some((f) => f.startsWith(p))) findings.push(`tarball has nothing under ${p}`);
  for (const f of REQUIRED_FILES) if (!list.includes(f)) findings.push(`tarball is missing ${f}`);
  return findings;
}

function parsePackJson(text) {
  const data = JSON.parse(text);
  const entry = Array.isArray(data) ? data[0] : data;
  if (!entry || !Array.isArray(entry.files)) throw new Error('npm pack --json output has no files list');
  return entry.files.map((f) => f.path);
}

function packField(text, field) {
  const data = JSON.parse(text);
  const entry = Array.isArray(data) ? data[0] : data;
  const v = entry && entry[field];
  if (!v || typeof v !== 'string') throw new Error(`npm pack --json output has no ${field}`);
  return v;
}

// npm prints: + brighttest@0.8.0 (staged with id <id>)
function parseStageId(text) {
  const m = /staged with id ([A-Za-z0-9_-]+)/.exec(String(text));
  return m ? m[1] : '';
}

function isPrerelease(version) {
  return /^\d+\.\d+\.\d+-/.test(String(version).replace(/^v/, ''));
}

function distTagFor(version) {
  return isPrerelease(version) ? 'next' : 'latest';
}

function npmAtLeast(version, min = [11, 15, 0]) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version).trim());
  if (!m) return false;
  const v = [+m[1], +m[2], +m[3]];
  for (let i = 0; i < 3; i++) { if (v[i] !== min[i]) return v[i] > min[i]; }
  return true;
}

// view(spec) -> resolved version string, or '' when nothing matches.
function checkDeps(deps, view) {
  const findings = [];
  for (const [name, range] of Object.entries(deps || {})) {
    let got = '';
    try { got = view(`${name}@${range}`); } catch (e) { got = ''; }
    if (!got) findings.push(`dependency ${name}@${range} does not resolve on npm (publish it first)`);
  }
  return findings;
}

function npmView(spec) {
  const r = spawnSync('npm', ['view', spec, 'version', '--json'], { encoding: 'utf8', shell: process.platform === 'win32' });
  if (r.status !== 0) return '';
  const out = (r.stdout || '').trim();
  if (!out) return '';
  try { const j = JSON.parse(out); return Array.isArray(j) ? String(j[j.length - 1] || '') : String(j || ''); } catch (e) { return ''; }
}

function main(argv) {
  const cmd = argv[0];
  if (cmd === 'pack' && argv[1]) {
    let files;
    try { files = parsePackJson(fs.readFileSync(argv[1], 'utf8')); } catch (e) { console.error(`release-check: ${e.message}`); return 1; }
    const findings = validatePack(files);
    for (const f of findings) console.error(`release-check: ${f}`);
    if (!findings.length) console.log(`release-check: tarball ok (${files.length} files)`);
    return findings.length ? 1 : 0;
  }
  if (cmd === 'deps') {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const findings = checkDeps(pkg.dependencies, npmView);
    for (const f of findings) console.error(`release-check: ${f}`);
    if (!findings.length) console.log(`release-check: all ${Object.keys(pkg.dependencies || {}).length} dependency ranges resolve on npm`);
    return findings.length ? 1 : 0;
  }
  if ((cmd === 'integrity' || cmd === 'filename') && argv[1]) {
    try {
      const v = packField(fs.readFileSync(argv[1], 'utf8'), cmd);
      if (cmd === 'integrity' && !/^sha512-[A-Za-z0-9+/]+=*$/.test(v)) throw new Error(`unexpected integrity ${v}`);
      console.log(v);
      return 0;
    } catch (e) { console.error(`release-check: ${e.message}`); return 1; }
  }
  if (cmd === 'stage-id' && argv[1]) {
    const id = parseStageId(fs.readFileSync(argv[1], 'utf8'));
    if (id) console.log(id);
    return id ? 0 : 1;
  }
  if (cmd === 'dist-tag' && argv[1]) { console.log(distTagFor(argv[1])); return 0; }
  if (cmd === 'version-ok' && argv[1]) return npmAtLeast(argv[1]) ? 0 : 1;
  console.error('usage: release-check.js pack <file> | integrity <file> | filename <file> | stage-id <log> | deps | dist-tag <version> | version-ok <npm-version>');
  return 2;
}

module.exports = { packField, parseStageId, validatePack, parsePackJson, isPrerelease, distTagFor, npmAtLeast, checkDeps };
if (require.main === module) process.exit(main(process.argv.slice(2)));
