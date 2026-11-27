'use strict';
// `brighttest setup`: find or take a Roku host, check it like `doctor` (device-info only: no lease, no
// password, no keypress), and make it the project default by writing `ROKU_HOST=<host>` to the project
// `.env` (ADR 0049). It never asks for, reads out, stores or prints the dev password and never edits a
// shell profile; the shell lines are printed for the user to run.
const path = require('path');
const { palette } = require('./reporter');
const { validHost, writeProjectHost } = require('./env-writer');
const devices = require('./devices');
const doctor = require('./doctor');

const SHELLS = ['bash', 'zsh', 'sh', 'fish', 'powershell', 'cmd', 'all'];

function detectShell(env = process.env, platform = process.platform) {
  const sh = path.basename(String(env.SHELL || '')).toLowerCase();
  if (sh === 'fish') return 'fish';
  if (sh === 'zsh' || sh === 'bash' || sh === 'sh') return sh;
  if (platform === 'win32') return env.PSModulePath ? 'powershell' : 'cmd';
  return 'bash';
}

function shellLines(host, shell) {
  const all = {
    posix: `export ROKU_HOST=${host}`,
    fish: `set -gx ROKU_HOST ${host}`,
    powershell: `$env:ROKU_HOST = "${host}"`,
    cmd: `set ROKU_HOST=${host}`,
  };
  const key = shell === 'fish' ? 'fish' : shell === 'powershell' ? 'powershell' : shell === 'cmd' ? 'cmd' : 'posix';
  return { all, key };
}

function renderLines(host, shell) {
  const { all, key } = shellLines(host, shell);
  const out = [];
  const note = { powershell: 'current window only; persistent (new windows): setx ROKU_HOST ' + host, cmd: 'current window only; persistent (new windows): setx ROKU_HOST ' + host };
  const keys = shell === 'all' ? ['posix', 'fish', 'powershell', 'cmd'] : [key];
  const label = { posix: 'bash, zsh, sh', fish: 'fish', powershell: 'PowerShell', cmd: 'cmd' };
  for (const k of keys) out.push(`  ${label[k]}: ${all[k]}${note[k] ? `   (${note[k]})` : ''}`);
  return out;
}

function passwordInfo(host, resolve) {
  const r = resolve({ host, cwd: process.cwd() });
  if (!r.password) return { known: false, source: null };
  const dot = devices.loadDotEnv(process.cwd());
  const source = process.env.ROKU_PASSWORD ? 'env' : dot.ROKU_PASSWORD ? 'dotenv' : 'cache';
  return { known: true, source };
}

// opts: { host, write, print, shell, envFile, ecpPort, force, json }. Returns the exit code.
// deps: { discover, inspectDevice, ask, isTTY, resolveDevice, cwd, env, platform }.
async function run(opts = {}, deps = {}) {
  const out = (s) => process.stdout.write(s + '\n');
  const err = (s) => process.stderr.write(`[brighttest setup] ${s}\n`);
  const isTTY = deps.isTTY !== undefined ? deps.isTTY : !!(process.stdin.isTTY && process.stdout.isTTY);
  const ask = deps.ask || (async () => '');
  const cwd = deps.cwd || process.cwd();
  const c = palette(!!process.stdout.isTTY && !opts.json);
  const say = (s) => { if (!opts.json) out(s); };

  if (opts.write && opts.print) { err('--write and --print cannot be combined'); return 2; }
  const shell = opts.shell || detectShell(deps.env, deps.platform);
  if (!SHELLS.includes(shell)) { err(`--shell must be one of ${SHELLS.join(', ')}`); return 2; }
  let ecpPort;
  try { ecpPort = devices.resolveEcpPort(opts.ecpPort); } catch (e) { err(e.message); return 2; }

  // 1. host
  let host = opts.host;
  let name = null;
  if (host != null && host !== '') {
    if (!validHost(host)) { err('--host takes one bare IPv4 address or host name (no port, ip:password or list); the password is never taken here'); return 2; }
  } else {
    say('discovering Roku devices on the network…');
    const list = await (deps.discover || devices.discover)({ timeoutMs: 4000 });
    if (list.length === 1) {
      host = list[0].host; name = list[0].name || null;
      if (isTTY) {
        const a = (await ask(`found ${list[0].name || 'Roku'} · ${list[0].model || '?'} · ${host}. Use it? [Y/n] `)).toLowerCase();
        if (a === 'n' || a === 'no') { err('no host chosen: pass --host <ip>'); return 2; }
      }
    } else if (list.length > 1) {
      if (!isTTY) {
        err('several Rokus found and no terminal to choose in; pass --host <ip>:');
        for (const d of list) process.stderr.write(`  ${d.name || 'Roku'} · ${d.model || '?'} · ${d.host}\n`);
        return 2;
      }
      list.forEach((d, i) => out(`  ${i + 1}. ${d.name || 'Roku'}  ·  ${d.model || '?'}  ·  ${d.host}`));
      const pick = list[parseInt(await ask(`select a device [1-${list.length}]: `), 10) - 1];
      if (!pick) { err('no host chosen: pass --host <ip>'); return 2; }
      host = pick.host; name = pick.name || null;
    } else if (isTTY) {
      host = (await ask('no Roku found. Enter its IP address: ')).trim();
      if (!host) { err('no host chosen: pass --host <ip>'); return 2; }
      if (!validHost(host)) { err('that is not a bare IPv4 address or host name'); return 2; }
    } else { err('no Roku found on the network: pass --host <ip>'); return 2; }
  }

  // 2. check (device-info only)
  const r = await (deps.inspectDevice || doctor.inspectDevice)(host, ecpPort);
  const failed = (r.checks || []).filter((k) => !k.ok);
  const checks = (r.checks || []).map((k) => ({ id: k.id, ok: !!k.ok, fix: k.fix || null }));
  if (r.reachable) say(c.dim(`device: ${r.model || '?'} · ${host}  firmware ${r.softwareVersion || '?'}`));
  for (const k of failed) say(c.red(`✗ ${k.id}`) + `\n    fix: ${k.fix}`);
  const rec = { host, name, model: r.model || null, firmware: r.softwareVersion || null, checks };
  if (failed.length && !opts.force) {
    rec.wrote = null; rec.gitignore = 'skipped'; rec.passwordKnown = false; rec.passwordSource = null; rec.lines = shellLines(host, shell).all;
    if (opts.json) out(JSON.stringify(rec, null, 2)); else err('device check failed; nothing written (use --force to write anyway)');
    return 1;
  }
  if (failed.length) say(c.yellow('warning: writing anyway because of --force'));

  // 3. password status (never the value)
  const pw = passwordInfo(host, deps.resolveDevice || devices.resolveDevice);
  rec.passwordKnown = pw.known; rec.passwordSource = pw.source;
  say(pw.known ? c.dim(`dev password: known (from ${pw.source === 'dotenv' ? '.env' : pw.source === 'env' ? 'the environment' : 'the device cache'})`)
    : 'Screenshots need the dev password: set ROKU_PASSWORD in your environment, or run `brighttest devices` to cache it.');

  // 4. write
  let doWrite = false;
  if (opts.write) doWrite = true;
  else if (opts.print) doWrite = false;
  else if (isTTY) {
    const a = (await ask(`Save ROKU_HOST=${host} to ${opts.envFile || '.env'}? [Y/n] `)).toLowerCase();
    doWrite = a !== 'n' && a !== 'no';
  }
  rec.wrote = null; rec.gitignore = 'skipped';
  if (doWrite) {
    try {
      const w = writeProjectHost(cwd, host, { envFile: opts.envFile });
      rec.wrote = w.wrote; rec.gitignore = w.gitignore;
      say(c.green(`✓ wrote ROKU_HOST=${host} to ${w.wrote}`) + (w.gitignore === 'added' ? c.dim('  (added .env to .gitignore)') : ''));
    } catch (e) { err(`could not write: ${e.message}`); return 1; }
  } else say(c.dim('not written (use --write to save it to .env)'));

  // 5. shell lines
  rec.lines = shellLines(host, shell).all;
  say('To set it in your shell as well:');
  for (const l of renderLines(host, shell)) say(l);

  // 6. precedence notice
  const envHost = (deps.env || process.env).ROKU_HOST;
  if (rec.wrote && envHost && envHost !== host) say(c.yellow(`warning: ROKU_HOST in your environment (${envHost}) overrides .env; unset it or update it.`));
  if (rec.wrote && devices.cachedDevices().length > 1) say(c.dim('several devices are cached; the .env value now decides.'));

  // 7. summary
  if (opts.json) out(JSON.stringify(rec, null, 2));
  else if (rec.wrote) out(`brighttest will use ${r.model ? `${name || 'Roku'} (${r.model})` : host} at ${host} from .env. Check it any time with brighttest doctor.`);
  return 0;
}

module.exports = { run, detectShell, shellLines, SHELLS };
