'use strict';
// Client for the Roku SceneGraph debug console (telnet, port 8080) — the surface behind `sgperf`,
// `free`, `loaded_textures`, `logrendezvous` and friends. Documented in Roku's "debugging channels"
// guide; the same port RokuCommunity's roku-debug drives for its SceneGraph commands.
//
// Two properties shape this client:
//   • The console is line-oriented with no end-of-response delimiter, so a response is "everything
//     until the output goes quiet" (quiet-gap collection, like roku-debug's request pipeline).
//   • The port accepts a limited number of concurrent connections (and a VS Code debug session may
//     already hold one), so this client connects per REQUEST batch and disconnects promptly.
//
// Commands are whitelisted. This runs inside the studio server, one HTTP call away from a browser —
// an open proxy into a telnet port is not a feature.

const net = require('net');

// command name (API-safe) -> the console command actually sent. sgperf is a lifecycle:
// start → (exercise the app) → report → stop/clear.
const COMMANDS = {
  free: 'free',
  chanperf: 'chanperf',
  plugins: 'plugins',
  loaded_textures: 'loaded_textures',
  r2d2_bitmaps: 'r2d2_bitmaps',
  sgnodes_roots: 'sgnodes roots',
  sgperf_start: 'sgperf start',
  sgperf_clear: 'sgperf clear',
  sgperf_report: 'sgperf report',
  sgperf_stop: 'sgperf stop',
  fps_display_on: 'fps_display 1',
  fps_display_off: 'fps_display 0',
  logrendezvous_status: 'logrendezvous status',
  logrendezvous_on: 'logrendezvous on',
  logrendezvous_off: 'logrendezvous off',
};

// Run one console command and collect its output until the stream stays quiet for `quietMs`.
// Resolves { raw } — raw text with the echoed prompt/banner lines trimmed off.
function run(host, name, { port = 8080, quietMs = 600, timeoutMs = 8000 } = {}) {
  const cmd = COMMANDS[name];
  if (!cmd) return Promise.reject(new Error(`unknown console command: ${name}`));

  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host, port });
    let buf = '';
    let sent = false;
    let quietTimer = null;
    let done = false;

    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(quietTimer);
      clearTimeout(hardTimer);
      sock.destroy();
      if (err) return reject(err);
      // Drop the banner/echo: everything up to (and including) the line echoing our command, plus any
      // trailing prompt. If the echo isn't found, return the whole buffer — raw beats empty.
      const idx = buf.indexOf(cmd);
      const body = idx >= 0 ? buf.slice(idx + cmd.length) : buf;
      resolve({ raw: body.replace(/^[\r\n]+/, '').replace(/[\r\n>\s]+$/, '') });
    };

    const hardTimer = setTimeout(() => finish(new Error(`console command timed out after ${timeoutMs}ms`)), timeoutMs);

    sock.on('connect', () => {
      // Small delay so the banner lands before the command — keeps the echo-trim reliable.
      setTimeout(() => { sock.write(cmd + '\r\n'); sent = true; }, 150);
    });
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      if (!sent) return;
      clearTimeout(quietTimer);
      quietTimer = setTimeout(() => finish(), quietMs);
    });
    sock.on('error', (e) => finish(new Error(`console ${host}:${port}: ${e.message}`)));
    sock.on('close', () => finish());
  });
}

// ── tolerant parsers ─────────────────────────────────────────────────────────────────────────────
// Exact output formats vary by firmware and are not formally documented, so each parser extracts what
// it recognises and callers always get the raw text too. Parsers validated against a live device get
// their formats pinned in tests; until then they are best-effort.

// `free` → { ok, entries: [{label, bytes}] } — lines shaped like "<label>: <n>[ KiB|MiB| bytes]".
function parseFree(raw) {
  const entries = [];
  for (const line of String(raw).split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z][\w ()/-]*?)\s*[:=]\s*([\d,]+)\s*(KiB|MiB|KB|MB|bytes|B)?/i);
    if (!m) continue;
    let bytes = Number(m[2].replace(/,/g, ''));
    const unit = (m[3] || 'B').toLowerCase();
    if (unit.startsWith('k')) bytes *= 1024;
    else if (unit.startsWith('m')) bytes *= 1024 * 1024;
    entries.push({ label: m[1].trim(), bytes });
  }
  return { ok: entries.length > 0, entries };
}

// `sgperf report` → { ok, threads: [{name, creates, ops, rendezvousPct}] } — best-effort: pick up
// "thread <name/id> ... N create(s) ... N op(s) ... N%" shapes; keep every numbered line we can't
// classify under `other` so nothing silently vanishes.
function parseSgperf(raw) {
  const threads = [];
  const other = [];
  for (const line of String(raw).split(/\r?\n/)) {
    if (!/\d/.test(line)) continue;
    const t = line.match(/thread\s+(?:node\s+)?(?:operations\s+)?[:#]?\s*([\w./-]+)/i);
    const creates = line.match(/([\d,]+)\s*create/i);
    const ops = line.match(/([\d,]+)\s*op/i);
    const rdv = line.match(/([\d.]+)\s*%?\s*rendezvous|rendezvous[^\d]*([\d.]+)\s*%/i);
    if (t || creates || ops || rdv) {
      threads.push({
        name: t ? t[1] : `line${threads.length}`,
        creates: creates ? Number(creates[1].replace(/,/g, '')) : null,
        ops: ops ? Number(ops[1].replace(/,/g, '')) : null,
        rendezvousPct: rdv ? Number(rdv[1] || rdv[2]) : null,
        line: line.trim(),
      });
    } else {
      other.push(line.trim());
    }
  }
  return { ok: threads.length > 0, threads, other };
}

const PARSERS = { free: parseFree, sgperf_report: parseSgperf };

// Run + parse in one call; `parsed` is null for commands with no parser (raw is always returned).
async function query(host, name, opts) {
  const { raw } = await run(host, name, opts);
  const parser = PARSERS[name];
  return { name, raw, parsed: parser ? parser(raw) : null };
}

module.exports = { COMMANDS, run, query, parseFree, parseSgperf };
