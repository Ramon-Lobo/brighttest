'use strict';
// Builds the redaction context (lib/redact.js createContext options) from the machine and the project: known secrets,
// automatic deny terms, the deny-list file. Reads files and the environment only; never spawns a process, never makes a
// network call, never prints or writes a value. Design: issue-reporting-skill D6, D7; ADR 0054.
const fs = require('fs');
const os = require('os');
const path = require('path');
const redact = require('./redact');

const SECRET_NAME = /PASS|TOKEN|SECRET|KEY|AUTH|COOKIE|SESSION|CREDENTIAL/i;
const ALWAYS = ['ROKU_PASSWORD', 'BRIGHTTEST_HUB_TOKEN', 'BRIGHTTEST_LEASE'];
const BORING_VALUE = /^(true|false|null|undefined|none|yes|no|\d+)$/i;

function readText(file) { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } }
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }

// KEY=value lines (quotes optional), same shape as lib/devices.js loadDotEnv, without its cwd default.
function parseDotEnv(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

// Environment and project .env: ROKU_PASSWORD, BRIGHTTEST_HUB_TOKEN, BRIGHTTEST_LEASE (3+ chars), and any variable whose
// name looks secret (6+ chars). The process environment wins over .env for the same name.
function knownSecretsFromEnv(env, dir) {
  const merged = { ...parseDotEnv(readText(path.join(dir, '.env'))), ...(env || {}) };
  const out = [];
  for (const [name, value] of Object.entries(merged)) {
    if (value == null) continue;
    const v = String(value);
    const always = ALWAYS.includes(name);
    if (!always && !SECRET_NAME.test(name)) continue;
    if (v.length < (always ? 3 : 6) || BORING_VALUE.test(v) || v.startsWith('<')) continue;
    out.push({ name, value: v });
  }
  return out;
}

function cacheFile(env, home) { return (env && env.BRIGHTTEST_CACHE) || path.join(home, '.brighttest', 'devices.json'); }
// Device cache (~/.brighttest/devices.json): passwords as DEVICE_PASSWORD, hosts as ip/host placeholders, names as deny terms.
function deviceCache(env, home) {
  const c = readJson(cacheFile(env, home));
  const secrets = [], names = [];
  if (!c || typeof c !== 'object') return { secrets, names };
  const devices = c.devices && typeof c.devices === 'object' ? c.devices : {};
  const hosts = [...Object.keys(devices), c.lastHost].filter(Boolean);
  for (const h of hosts) {
    const bare = String(h).split(':')[0];
    if (bare.length >= 3) secrets.push({ name: 'DEVICE_HOST', value: bare, as: /^\d{1,3}(\.\d{1,3}){3}$/.test(bare) ? 'ip' : 'host' });
  }
  for (const d of Object.values(devices)) {
    if (d && d.password && String(d.password).length >= 3) secrets.push({ name: 'DEVICE_PASSWORD', value: String(d.password) });
    if (d && d.name) names.push(String(d.name));
  }
  return { secrets, names };
}

// Manifest title and subtitle, package.json name, .git/config remote owner/repo and user, project folder, OS user, host.
function autoDenyTerms(dir, opts = {}) {
  const terms = [];
  const manifest = readText(path.join(dir, 'manifest'));
  if (manifest) for (const m of manifest.matchAll(/^\s*(title|subtitle)\s*=\s*(.+?)\s*$/gim)) terms.push(m[2]);
  const pkg = readJson(path.join(dir, 'package.json'));
  if (pkg && typeof pkg.name === 'string') terms.push(pkg.name.replace(/^@[^/]+\//, ''), ...(pkg.name.startsWith('@') ? [pkg.name.split('/')[0].slice(1)] : []));
  const git = readText(path.join(dir, '.git', 'config'));
  if (git) {
    for (const m of git.matchAll(/^\s*url\s*=\s*(.+?)\s*$/gim)) {
      const mm = /[:/]([^/:\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(m[1]);
      if (mm) terms.push(mm[1], mm[2]);
    }
    for (const m of git.matchAll(/^\s*(name|email)\s*=\s*(.+?)\s*$/gim)) terms.push(m[2], ...(m[1] === 'email' ? [m[2].split('@')[0]] : []));
  }
  terms.push(path.basename(path.resolve(dir)));
  try { terms.push(os.userInfo().username); } catch { /* no passwd entry */ }
  try { terms.push(os.hostname().replace(/\.local$/i, '')); } catch { /* ignore */ }
  if (opts.extraTerms) terms.push(...opts.extraTerms);
  return terms;
}

// .brighttest/issue-deny.txt: one term per line, `#` comments and blank lines ignored.
function denyFile(dir) {
  const text = readText(path.join(dir, '.brighttest', 'issue-deny.txt'));
  return text ? text.split(/\r?\n/).map((l) => l.replace(/^\s*#.*$/, '').trim()).filter(Boolean) : [];
}

// Docs host of the brighttest package itself stays readable (it is public).
function brighttestDocsHosts() {
  const pkg = readJson(path.join(__dirname, '..', 'package.json'));
  try { return pkg && pkg.homepage ? [new URL(pkg.homepage).hostname] : []; } catch { return []; }
}

// buildContext({ dir, env, home }) -> { ctx, notes }. notes lists counts only (never values).
function buildContext(opts = {}) {
  const dir = path.resolve(opts.dir || process.cwd());
  const env = opts.env || process.env;
  const home = opts.home || os.homedir();
  const cache = deviceCache(env, home);
  const envSecrets = knownSecretsFromEnv(env, dir);
  const ctx = redact.createContext({
    knownSecrets: [...envSecrets, ...cache.secrets],
    denyTerms: [...denyFile(dir), ...autoDenyTerms(dir, opts), ...cache.names],
    projectRoots: [dir, safeReal(dir)],
    homeDirs: [home, safeReal(home)],
    keepHosts: brighttestDocsHosts(),
  });
  return { ctx, notes: { knownSecrets: ctx.knownSecrets.length, denyTerms: ctx.denyTerms.length, skippedTerms: ctx.skipped.length } };
}
function safeReal(p) { try { return fs.realpathSync(p); } catch { return null; } }

module.exports = { buildContext, knownSecretsFromEnv, deviceCache, autoDenyTerms, denyFile, parseDotEnv };
