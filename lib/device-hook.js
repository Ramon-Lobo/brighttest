'use strict';
// Claude Code `PreToolUse` Bash guard (device-lease design section 4.9).
//
//   classify(cmd, { hosts, leaseValid, ports }) -> { decision: 'allow' | 'deny', rule, reason? }   pure
//   evaluate(payload, env)                      -> classify() with hosts/token state read from disk
//   main({ stdin, stdout, env })                -> the `brighttest device hook` subcommand; always exit 0
//
// Syntactic rule, no identity: a command is allowed when it is not a raw device access, or it is wrapped by a
// lease-aware command, or it carries a live lease token. Any internal failure, malformed stdin or a timeout
// means ALLOW (plus an events.log note): a broken guard must not brick the session.
// A URL whose host is an environment variable ($ROKU_HOST, ${ROKU_HOST:-x}) is treated as a Roku endpoint when its
// path is a mutating ECP path or its port is 8060 (read-only /query reads stay allowed, as for a literal host).
// Known gaps a hook cannot close: script files, hosts assembled in other ways (python/node one-liners, a URL
// built in a variable that holds the whole URL), MCP tools.

const path = require('path');
const lease = require('./device-lease');

const DEVICE_PORTS = [8060, 80, 8085, 8080, 8087, 8090];
const ECP_PORT = 8060;
const NETWORK_TOOLS = new Set(['curl', 'wget', 'http', 'https', 'httpie', 'xh', 'websocat', 'wscat']);
const SOCKET_TOOLS = new Set(['nc', 'ncat', 'netcat', 'telnet', 'socat']);
const HARMLESS_READS = /^\/query\/(device-info|active-app|apps)\/?$/;
const WRAPPERS = new Set(['sudo', 'env', 'time', 'nohup', 'command', 'exec', 'nice', 'stdbuf', 'builtin']);
const TOKEN_RE = /\bBRIGHTTEST_LEASE=([0-9a-f]{24})\b/;
const MAX_DEPTH = 3;
const MUTATING_ECP = /^\/(keypress|keydown|keyup|launch|install|input|search|exit-app|plugin_install|plugin_package|plugin_inspect)(\/|$)/;
const VAR_HOST_RE = /(^|:\/\/|@|=)(\$[a-z_][a-z0-9_]*|\$\{[^}]*\})(?::(\d+|\$[a-z_][a-z0-9_]*|\$\{[^}]*\}))?(?=$|[/?#,]|:)/g;

const FIXIT = 'Direct Roku access must hold the device lease. Re-run as:\n' +
  '  brighttest device with --as <you> --purpose "<what for>" -- <your command>\n' +
  '(status: brighttest device status). brighttest e2e, studio and --device lanes take the lease themselves.';
const NOBYPASS = 'Agents may not bypass the device lease (BRIGHTTEST_NO_LEASE / --no-lease). Remove it and run the ' +
  'command through the lease, for example:\n' +
  '  brighttest device with --as <you> --purpose "<what for>" -- <your command>\n' +
  '(status: brighttest device status). Only a human may override the lease.';

// ---- shell splitting ----------------------------------------------------------------------------
// Splits on unquoted ; & | newline, and tokenises each segment with quotes removed. Not a shell parser:
// $(...) and backticks are not entered, which is one of the documented false negatives.
function splitSegments(cmd) {
  const segs = [];
  let words = [], cur = '', has = false, q = null;
  const endWord = () => { if (has) words.push(cur); cur = ''; has = false; };
  const endSeg = () => { endWord(); if (words.length) segs.push(words); words = []; };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) {
      if (c === q) q = null;
      else if (q === '"' && c === '\\' && i + 1 < cmd.length) { cur += cmd[++i]; }
      else cur += c;
      continue;
    }
    if (c === '\\' && i + 1 < cmd.length) { cur += cmd[++i]; has = true; continue; }
    if (c === "'" || c === '"') { q = c; has = true; continue; }
    if (c === ';' || c === '&' || c === '|' || c === '\n' || c === '(' || c === ')' || c === '{' && cur === '' && !has) { endSeg(); continue; }
    if (c === ' ' || c === '\t') { endWord(); continue; }
    cur += c; has = true;
  }
  endSeg();
  return segs;
}

// Bodies of $(...) and `...` substitutions that are not inside single quotes (nested ones are found by recursion).
function extractSubstitutions(cmd) {
  const out = [];
  let sq = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === '\\') { i++; continue; }
    if (c === "'") { sq = !sq; continue; }
    if (sq) continue;
    if (c === '$' && cmd[i + 1] === '(' && cmd[i + 2] !== '(') {
      let d = 1, j = i + 2, q = null;
      for (; j < cmd.length && d > 0; j++) {
        const x = cmd[j];
        if (x === '\\') { j++; continue; }
        if (q) { if (x === q) q = null; continue; }
        if (x === "'" || x === '"') q = x;
        else if (x === '(') d++;
        else if (x === ')') d--;
      }
      out.push(cmd.slice(i + 2, d === 0 ? j - 1 : j));
    } else if (c === '`') {
      const j = cmd.indexOf('`', i + 1);
      out.push(cmd.slice(i + 1, j < 0 ? cmd.length : j));
      if (j < 0) break;
      i = j;
    }
  }
  return out;
}

const isAssign = (w) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w);

// Peel leading VAR=val, wrappers (sudo, env, time, timeout N …) off a word list.
function peel(words) {
  const assigns = [];
  let i = 0;
  for (;;) {
    const w = words[i];
    if (w === undefined) break;
    if (isAssign(w)) { assigns.push(w); i++; continue; }
    if (w === 'export' || w === 'declare' || w === 'typeset' || w === 'local') {
      i++;
      while (i < words.length && (isAssign(words[i]) || words[i].startsWith('-'))) { if (isAssign(words[i])) assigns.push(words[i]); i++; }
      break;
    }
    const b = path.basename(w);
    if (WRAPPERS.has(b)) { i++; while (i < words.length && (words[i].startsWith('-') || (b === 'env' && isAssign(words[i])))) { if (isAssign(words[i])) assigns.push(words[i]); i++; } continue; }
    if (b === 'timeout') { i++; while (i < words.length && words[i].startsWith('-')) i++; if (i < words.length) i++; continue; }
    break;
  }
  return { assigns, rest: words.slice(i) };
}

function isBrighttestCli(rest) {
  if (!rest.length) return false;
  const exe = path.basename(rest[0]);
  if (exe === 'brighttest') return true;
  const isCliJs = (w) => /(^|\/)bin\/cli\.js$/.test(w) || /(^|\/)\.bin\/brighttest$/.test(w) || /(^|\/)brighttest(\/bin\/cli\.js)?$/.test(w);
  if (exe === 'node' || exe === 'nodejs') {
    const script = rest.slice(1).find((w) => !w.startsWith('-'));
    return !!script && isCliJs(script);
  }
  if (exe === 'npx' || exe === 'pnpx' || exe === 'bunx') {
    const pkg = rest.slice(1).find((w) => !w.startsWith('-'));
    return pkg === 'brighttest';
  }
  return false;
}

function npxTarget(rest) {
  const exe = path.basename(rest[0] || '');
  if (exe === 'npx' || exe === 'pnpx' || exe === 'bunx') return rest.slice(1).find((w) => !w.startsWith('-')) || null;
  if ((exe === 'npm' || exe === 'pnpm' || exe === 'yarn') && ['exec', 'dlx', 'x'].includes(rest[1])) return rest.slice(2).find((w) => !w.startsWith('-')) || null;
  return null;
}

// ---- device matching ----------------------------------------------------------------------------
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Every device reference in one token: [{ host, port|null, known }]. A bare http(s)/ws(s) URL without a port is port 80.
function deviceRefs(tok, hosts, ports = DEVICE_PORTS) {
  const refs = [];
  const t = tok.toLowerCase();
  for (const h of hosts) {
    const re = new RegExp(`(^|[/@=,])\\[?${esc(h)}\\]?(?::(\\d+))?(?=$|[/?#,]|:)`, 'g');
    let m;
    while ((m = re.exec(t))) {
      let port = m[2] ? Number(m[2]) : null;
      if (port == null && /^[a-z][a-z0-9+.-]*:\/\//.test(t)) port = 80;
      refs.push({ host: h, port, known: true, path: t.slice(m.index + m[0].length) });
    }
  }
  // A host given as an environment variable is unknown to us: a mutating ECP path or the ECP port marks it a Roku.
  let mv;
  VAR_HOST_RE.lastIndex = 0;
  while ((mv = VAR_HOST_RE.exec(t))) {
    const rest = t.slice(mv.index + mv[0].length);
    const p = rest.split(/[?#]/)[0];
    const num = mv[3] && /^\d+$/.test(mv[3]) ? Number(mv[3]) : null;
    let port = null;
    if (num === ECP_PORT) port = ECP_PORT;
    else if (MUTATING_ECP.test(p) && (num == null || ports.includes(num))) port = ECP_PORT;
    if (port != null) refs.push({ host: null, port, known: false, variable: true, path: rest });
  }
  // An unregistered host on the ECP port is still a Roku.
  const re2 = /(?:^|[/@=])[a-z0-9.\-[\]:]+:8060(?=$|[/?#])/g;
  let m2;
  while ((m2 = re2.exec(t))) {
    if (!refs.some((r) => m2.index <= t.indexOf(r.host) + r.host.length && t.indexOf(r.host) >= 0)) {
      refs.push({ host: null, port: ECP_PORT, known: false, path: t.slice(m2.index + m2[0].length) });
    }
  }
  return refs;
}

function ecpPathOf(ref) {
  const p = (ref.path || '/').split(/[?#]/)[0];
  return p === '' ? '/' : p;
}

function isMutatingHttp(words) {
  const joined = words.slice(1);
  for (let i = 0; i < joined.length; i++) {
    const w = joined[i];
    if (/^(-d|-F|-T|-X|-G)$/.test(w) && w !== '-G') {
      if (w === '-X') { const v = (joined[i + 1] || '').toUpperCase(); if (v && v !== 'GET' && v !== 'HEAD') return true; continue; }
      return true;
    }
    if (/^-X(?!$)/.test(w) && !/^-X(GET|HEAD)$/i.test(w)) return true;
    if (/^--(data|data-[a-z]+|form|form-string|upload-file|json|post-data|post-file|method|body-data|body-file)(=|$)/.test(w)) {
      if (/^--method/.test(w)) { const v = (w.includes('=') ? w.split('=')[1] : joined[i + 1] || '').toUpperCase(); if (v === 'GET' || v === 'HEAD') continue; }
      return true;
    }
    if (/^-[a-zA-Z]*d[a-zA-Z]*$/.test(w) && !/^--/.test(w) && w.length > 2 && /^-[sSLkvi]*d$/.test(w)) return true; // -sd, -Ld …
    if (/^(POST|PUT|DELETE|PATCH)$/.test(w) && path.basename(words[0]) === 'http') return true;
  }
  return false;
}

// ---- segment rules ------------------------------------------------------------------------------
function denyOf(rule, reason) { return { decision: 'deny', rule, reason }; }

function classifySegment(words, ctx, depth) {
  const { assigns, rest } = peel(words);

  for (const a of assigns) {
    if (/^BRIGHTTEST_NO_LEASE=/.test(a)) return denyOf('no-lease', NOBYPASS);
  }
  if (!rest.length) return null;

  // Sub-shells: look inside `bash -c "…"` / `eval "…"`.
  const exe = path.basename(rest[0]);
  if (depth < MAX_DEPTH) {
    if (['bash', 'sh', 'zsh', 'dash', 'ksh'].includes(exe)) {
      const ci = rest.findIndex((w, i) => i > 0 && /^-[a-z]*c$/.test(w));
      if (ci > 0 && rest[ci + 1] != null) return classifyText(rest[ci + 1], ctx, depth + 1);
    }
    if (exe === 'eval') return classifyText(rest.slice(1).join(' '), ctx, depth + 1);
  }

  if (isBrighttestCli(rest)) {
    if (rest.includes('--no-lease')) return denyOf('no-lease', NOBYPASS);
    return { decision: 'allow', rule: 'lease-aware' };
  }

  const target = npxTarget(rest);
  if (exe === 'rooibos' || target === 'rooibos') return denyOf('rooibos', FIXIT);

  if (NETWORK_TOOLS.has(exe) || SOCKET_TOOLS.has(exe)) {
    const refs = [];
    for (const w of rest.slice(1)) refs.push(...deviceRefs(w, ctx.hosts, ctx.ports));
    if (SOCKET_TOOLS.has(exe)) {
      // `nc <host> <port>`: host and port are separate words.
      const args = rest.slice(1).filter((w) => !w.startsWith('-'));
      const hi = args.findIndex((w) => ctx.hosts.includes(w.toLowerCase().replace(/^\[|\]$/g, '')));
      if (hi >= 0) {
        const port = Number(args[hi + 1]);
        if (!Number.isNaN(port) && ctx.ports.includes(port)) refs.push({ host: args[hi], port, known: true, path: '/' });
      }
    }
    const device = refs.filter((r) => r.port == null ? false : (r.known ? ctx.ports.includes(r.port) : r.port === ECP_PORT));
    if (!device.length) return null;
    const harmless = NETWORK_TOOLS.has(exe) && !SOCKET_TOOLS.has(exe) && !isMutatingHttp(rest) &&
      device.every((r) => r.port === ECP_PORT && HARMLESS_READS.test(ecpPathOf(r)));
    if (harmless) return { decision: 'allow', rule: 'harmless-read' };
    return denyOf('raw-device', FIXIT);
  }

  // Bash's built-in network redirect.
  for (const w of rest) {
    const m = /\/dev\/(?:tcp|udp)\/([^/]+)\/(\d+)/.exec(w);
    if (m && (ctx.hosts.includes(m[1].toLowerCase()) ? ctx.ports.includes(Number(m[2])) : Number(m[2]) === ECP_PORT)) {
      return denyOf('raw-device', FIXIT);
    }
  }
  return null;
}

function classifyText(cmd, ctx, depth) {
  let fallthrough = { decision: 'allow', rule: 'not-device' };
  // Command substitutions inside quotes ("$(curl ...)", backticks) are not reached by the segment splitter.
  const tm0 = TOKEN_RE.exec(cmd);
  const tokenOk0 = !!tm0 && !!ctx.leaseValid(tm0[1]);
  const leaseAware = splitSegments(cmd).some((w) => isBrighttestCli(peel(w).rest));
  if (depth < MAX_DEPTH && !leaseAware) {
    for (const inner of extractSubstitutions(cmd)) {
      const r = classifyText(inner, ctx, depth + 1);
      if (r.decision === 'deny' && !(tokenOk0 && r.rule !== 'no-lease')) return r;
    }
  }
  const segs = splitSegments(cmd);
  // A live session token anywhere in the command covers its raw device calls (never the no-lease bypass).
  const tm = TOKEN_RE.exec(cmd);
  const tokenOk = !!tm && !!ctx.leaseValid(tm[1]);
  for (const words of segs) {
    const r = classifySegment(words, ctx, depth);
    if (!r) continue;
    if (r.decision === 'deny') {
      if (tokenOk && r.rule !== 'no-lease') { fallthrough = { decision: 'allow', rule: 'live-token' }; continue; }
      return r;
    }
    if (fallthrough.rule === 'not-device') fallthrough = r;
  }
  return fallthrough;
}

function classify(cmd, { hosts = [], leaseValid = () => false, ports = DEVICE_PORTS } = {}) {
  if (typeof cmd !== 'string' || !cmd.trim()) return { decision: 'allow', rule: 'not-device' };
  const ctx = { hosts: hosts.map((h) => String(h).toLowerCase()), leaseValid, ports };
  return classifyText(cmd, ctx, 0);
}

function denyOutput(reason) {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
}

// ---- disk state ---------------------------------------------------------------------------------
function hostList(v) {
  return String(v || '').split(',').map((h) => lease.stripHostPasswords(h).trim().toLowerCase()).filter(Boolean);
}

// Log key for a host: the identity key a lane recorded for it (no network in the hook), else the address key.
function keyFor(host, env) {
  try { return require('./device-identity').recalledKey(lease.defaultDir(env), host) || lease.keyFromAddress(host); } catch { return lease.keyFromAddress(host); }
}

function gatherState(payload, env) {
  const store = lease.createStore({ env });
  const hosts = new Set();
  const ports = new Set(DEVICE_PORTS);
  const cwd = (payload && typeof payload.cwd === 'string' && payload.cwd) || env.CLAUDE_PROJECT_DIR || process.cwd();
  const add = (v) => { for (const h of hostList(v)) hosts.add(h); };
  add(env.ROKU_HOST);
  try { add(require('./devices').loadDotEnv(cwd).ROKU_HOST); } catch { /* no .env */ }
  try { for (const d of require('./devices').cachedDevices()) add(d.host); } catch { /* no cache */ }
  let keys = [];
  try { keys = store.listKeys(); } catch { /* no lease dir */ }
  try { for (const h of require('./device-identity').recalledHosts(lease.defaultDir(env))) hosts.add(h); } catch { /* no cache */ }
  for (const k of keys) {
    const m = /^(.*?)(?:_p(\d+))?$/.exec(k);
    if (/^id-[0-9a-f]{16}$/.test(k)) { // identity key: not an address; the holder record names the host it was reached by
      try {
        const rec = store.readHolder(k);
        const dh = rec && rec.lease && rec.lease.device && rec.lease.device.host;
        if (dh && dh !== k) add(dh);
      } catch { /* unreadable holder */ }
      continue;
    }
    if (m[1] && !m[1].includes('_')) hosts.add(m[1]);
    if (m[2]) ports.add(Number(m[2]));
  }
  const leaseValid = (token) => {
    // A session token past its idle TTL or cap is invalid; a valid one is renewed (every use of it counts).
    try { return lease.tokenValid(token, { store, renew: true }); } catch { return false; }
  };
  const first = [...hostList(env.ROKU_HOST), ...hosts][0];
  return { store, hosts: [...hosts], ports: [...ports], leaseValid, logKey: first ? keyFor(first, env) : null };
}

function evaluate(payload, env = process.env) {
  const st = gatherState(payload, env);
  if (!payload || payload.tool_name !== 'Bash' || !payload.tool_input || typeof payload.tool_input.command !== 'string') {
    return { decision: 'allow', rule: 'not-bash', state: st };
  }
  const r = classify(payload.tool_input.command, { hosts: st.hosts, ports: st.ports, leaseValid: st.leaseValid });
  return { ...r, state: st };
}

function note(env, text) {
  try {
    const store = lease.createStore({ env });
    const hosts = hostList(env.ROKU_HOST);
    const key = hosts[0] ? keyFor(hosts[0], env) : (store.listKeys()[0] || null);
    if (key) store.logEvent(key, { ev: 'note', note: text });
  } catch { /* best effort */ }
}

function readStdin(stdin, timeoutMs) {
  return new Promise((resolve) => {
    let data = '';
    const timer = setTimeout(() => { done(null, 'timeout'); }, timeoutMs);
    const done = (v, why) => { clearTimeout(timer); stdin.removeListener('data', onData); resolve(v === null ? { timedOut: why } : { data: v }); };
    const onData = (c) => { data += c; };
    stdin.setEncoding && stdin.setEncoding('utf8');
    stdin.on('data', onData);
    stdin.once('end', () => done(data));
    stdin.once('error', () => done(data));
  });
}

// Exit code is 0 in every case: a deny is the stdout JSON, everything else prints nothing.
async function main({ stdin = process.stdin, stdout = process.stdout, env = process.env } = {}) {
  try {
    const timeoutMs = Number(env.BRIGHTTEST_HOOK_TIMEOUT_MS) > 0 ? Number(env.BRIGHTTEST_HOOK_TIMEOUT_MS) : 4000;
    const work = (async () => {
      const got = await readStdin(stdin, timeoutMs);
      if (got.timedOut) { note(env, 'hook: stdin timeout, allowed'); return null; }
      let payload;
      try { payload = JSON.parse(got.data); } catch { note(env, 'hook: malformed stdin, allowed'); return null; }
      // Test hook for the 5 s rule: delays classification so the watchdog below can be exercised.
      const delay = Number(env.BRIGHTTEST_HOOK_TEST_DELAY_MS);
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      const r = evaluate(payload, env);
      if (r.decision !== 'deny') return null;
      try {
        const sid = typeof payload.session_id === 'string' ? payload.session_id : null;
        const cmdText = lease.redactText(payload.tool_input.command, []).replace(/(-u\s+\S+|--user[= ]\S+|--password[= ]\S+|BRIGHTTEST_LEASE=\S+)/g, '***').slice(0, 200);
        if (r.state.logKey) {
          r.state.store.logEvent(r.state.logKey, {
            ev: 'hook-deny', rule: r.rule, sessionId: sid, agentId: payload.agent_id || null, command: cmdText,
          });
        }
      } catch { /* audit is best-effort */ }
      return r.reason;
    })();
    let watchdog;
    const guard = new Promise((resolve) => { watchdog = setTimeout(() => { note(env, 'hook: timeout, allowed'); resolve(null); }, timeoutMs); });
    const reason = await Promise.race([work.catch(() => null), guard]);
    clearTimeout(watchdog);
    if (reason) stdout.write(JSON.stringify(denyOutput(reason)) + '\n');
  } catch (e) {
    note(env, `hook: internal error, allowed (${e && e.message ? String(e.message).slice(0, 120) : 'unknown'})`);
  }
  return 0;
}

module.exports = { classify, extractSubstitutions, evaluate, main, splitSegments, denyOutput, DEVICE_PORTS, FIXIT, NOBYPASS };
