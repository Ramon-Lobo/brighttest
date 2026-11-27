'use strict';
// The one writer of the project host: `ROKU_HOST=<host>` in the project `.env` (ADR 0049). Used by
// `brighttest setup` and by Studio's Settings "Save as project default". It touches only that one line,
// keeps every other byte (including ROKU_PASSWORD and the file's line ending), writes atomically, and
// makes sure `.env` is git-ignored. It never reads or writes a password.
const fs = require('fs');
const path = require('path');

// A bare IPv4 address or host name: no port, no `ip:pw`, no list, no whitespace or quotes.
function validHost(v) {
  const s = String(v == null ? '' : v);
  if (!s || s.length > 253) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(s)) return s.split('.').every((o) => Number(o) <= 255);
  return /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/.test(s);
}

// Pure string edit: replace the `key=` line in place (first match; later duplicates stay) or append one.
function upsertEnvLine(text, key, value) {
  const eol = /\r\n/.test(text) ? '\r\n' : '\n';
  const line = `${key}=${value}`;
  const re = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`);
  const parts = text.split(/\r?\n/);
  const i = parts.findIndex((l) => re.test(l));
  if (i >= 0) { parts[i] = line; return parts.join(eol); }
  if (text === '') return line + eol;
  return text + (/\n$/.test(text) ? '' : eol) + line + eol;
}

function inGitWorkTree(dir) {
  let d = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(d, '.git'))) return true;
    const up = path.dirname(d);
    if (up === d) return false;
    d = up;
  }
}

// Returns 'added' | 'present' | 'skipped' (not a git work tree).
function ensureEnvIgnored(dir) {
  if (!inGitWorkTree(dir)) return 'skipped';
  const file = path.join(dir, '.gitignore');
  const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (cur.split(/\r?\n/).some((l) => ['.env', '/.env', '*.env', '.env*'].includes(l.trim()))) return 'present';
  const eol = /\r\n/.test(cur) ? '\r\n' : '\n';
  fs.writeFileSync(file, cur + (cur && !/\n$/.test(cur) ? eol : '') + '.env' + eol);
  return 'added';
}

// writeProjectHost(dir, host, { envFile }) -> { wrote: <absolute path>, gitignore }. Throws on an invalid host.
function writeProjectHost(dir, host, { envFile } = {}) {
  if (!validHost(host)) throw new Error('invalid host: expected one bare IPv4 address or host name (no port, password or list)');
  const file = path.resolve(dir, envFile || '.env');
  let cur = '';
  let mode = 0o600;
  try { cur = fs.readFileSync(file, 'utf8'); mode = fs.statSync(file).mode & 0o777; } catch { /* new file */ }
  const next = upsertEnvLine(cur, 'ROKU_HOST', host);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, next, { mode });
    if (process.platform !== 'win32') fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* gone */ }
    throw e;
  }
  const gitignore = path.basename(file) === '.env' ? ensureEnvIgnored(path.dirname(file)) : 'skipped';
  return { wrote: file, gitignore };
}

module.exports = { validHost, upsertEnvLine, ensureEnvIgnored, writeProjectHost };
