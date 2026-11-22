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
  logrendezvous_on: 'logrendezvous on',
  logrendezvous_off: 'logrendezvous off',
};

// The console greets every connection with `<device serial> (Roku <model> - <firmware>)`. The serial
// is a device identifier and must never reach API responses, logs or saved profiling runs, so the
// banner line is removed from everything this module returns. Only that line shape is touched: a
// serial-like string inside real command output is kept.
const BANNER_LINE = /^[ \t>]*\S+[ \t]+\(Roku [^)\r\n]*\)[ \t]*(?:\r?\n|$)/gm;
function stripBanner(text) {
  return String(text).replace(BANNER_LINE, '');
}


// Commands that act on the "execution target". The console's default target is `main` (the system
// UI), where these return nothing useful on current firmware; the channel's own target must be
// selected first with `target <n>`. Global commands (free, plugins, fps_display, ...) do not need it.
const TARGETED = new Set([
  'chanperf', 'loaded_textures', 'sgperf_start', 'sgperf_clear', 'sgperf_report', 'sgperf_stop',
]);

// `target list` → [{ index, name, selected }]; lines look like `* [5] My Channel` / `  [0] main`.
function parseTargets(raw) {
  const out = [];
  for (const line of String(raw).split(/\r?\n/)) {
    const m = line.match(/^[ \t>]*(\*)?[ \t]*\[(\d+)\][ \t]+(.+?)[ \t]*$/);
    if (m) out.push({ index: Number(m[2]), name: m[3], selected: !!m[1] });
  }
  return out;
}

// Pick the entry for a channel title: exact (case-insensitive) first, then a unique substring match.
// `main` is never a channel match.
function pickTarget(targets, channel) {
  const want = String(channel || '').trim().toLowerCase();
  if (!want) return null;
  const cands = targets.filter((t) => t.name.toLowerCase() !== 'main');
  const exact = cands.find((t) => t.name.toLowerCase() === want);
  if (exact) return exact;
  const part = cands.filter((t) => t.name.toLowerCase().includes(want) || want.includes(t.name.toLowerCase()));
  return part.length === 1 ? part[0] : null;
}

// Run one console command and collect its output until the stream stays quiet for `quietMs`.
// Resolves { raw } — raw text with the echoed prompt/banner lines trimmed off.
//
// With `opts.channel` (the dev channel's title, e.g. from /query/active-app) and a targeted command,
// the same connection first sends `target list`, selects the matching entry, then sends the command.
// The target is per connection and each request opens its own connection, so selection is done once
// per request (there is no cross-request cache to go stale when the channel restarts and its pid/index
// changes). Device check pending (DQ-1): whether selection is what makes sgperf/chanperf/loaded_textures
// return real data on fw 16 is verified only against recorded transcripts.
function run(host, name, { port = 8080, quietMs = 600, timeoutMs = 8000, channel = null } = {}) {
  const cmd = COMMANDS[name];
  if (!cmd) return Promise.reject(new Error(`unknown console command: ${name}`));
  const needTarget = !!channel && TARGETED.has(name);

  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host, port });
    let buf = '';
    let start = 0;       // buf offset where the current step's response begins
    let waiting = null;  // { resolve } for the in-flight step
    let quietTimer = null;
    let done = false;
    let picked = null;   // the selected target entry, when this request selected one

    const finish = (err, value) => {
      if (done) return;
      done = true;
      clearTimeout(quietTimer);
      clearTimeout(hardTimer);
      sock.destroy();
      if (err) return reject(err);
      resolve(value);
    };

    // Strip the banner, then the echoed command line (a line holding just the command, not a
    // substring of the output) and the trailing prompt. If no echo is found, return what we have.
    const clean = (text, line) => {
      const t = stripBanner(text);
      const esc = line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const echo = t.match(new RegExp(`(?:^|\\n)>?[ \\t]*${esc}[ \\t]*(?:\\r?\\n|$)`));
      let body = echo ? t.slice(echo.index + echo[0].length) : t.replace(/^>/, '');
      return body.replace(/^[\r\n]+/, '').replace(/[\r\n>\s]+$/, '');
    };

    // Send one line, resolve with its cleaned response once the output goes quiet.
    const step = (line) => new Promise((res) => {
      start = buf.length;
      waiting = { line, res };
      sock.write(line + '\r\n');
    });

    const hardTimer = setTimeout(() => finish(new Error(`console command timed out after ${timeoutMs}ms`)), timeoutMs);

    sock.on('connect', () => {
      // Small delay so the banner lands before the first command.
      setTimeout(async () => {
        try {
          if (needTarget) {
            const targets = parseTargets(await step('target list'));
            const t = pickTarget(targets, channel);
            if (!t) {
              const names = targets.map((x) => x.name).join(', ') || 'none';
              return finish(new Error(`console target not found for channel "${channel}" (targets: ${names})`));
            }
            const sel = parseTargets(await step(`target ${t.index}`)).find((x) => x.selected);
            if (sel && sel.index !== t.index) return finish(new Error(`console target selection failed (wanted [${t.index}] ${t.name})`));
            picked = t;
          }
          const raw = await step(cmd);
          // A listed-but-background entry answers with a stub command set: every targeted command is
          // "Command not recognized". Make that an explicit error instead of a confusing empty result.
          if (picked && /^[ \t>]*Command not recognized[ \t]*$/m.test(raw)) {
            const err = new Error(`target "${picked.name}" answered "Command not recognized" (stub command set; seen with the channel in the background, and on some devices with it in front)`);
            err.status = STATUS.stubTarget.status;
            err.reason = STATUS.stubTarget.reason;
            return finish(err);
          }
          finish(null, { raw });
        } catch (e) { finish(e); }
      }, 150);
    });
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      if (!waiting) return;
      clearTimeout(quietTimer);
      quietTimer = setTimeout(() => {
        const w = waiting; waiting = null;
        w.res(clean(buf.slice(start), w.line));
      }, quietMs);
    });
    sock.on('error', (e) => finish(new Error(`console ${host}:${port}: ${e.message}`)));
    sock.on('close', () => finish(new Error('console closed before the response completed')));
  });
}

// ── reply status ─────────────────────────────────────────────────────────────────────────────────
// One constant per status. Reasons describe the reply that was observed, not what a firmware supports.
const STATUS = {
  ok: { status: 'ok', reason: 'reply parsed' },
  empty: { status: 'empty', reason: 'no output came back before the quiet wait ended' },
  notImplemented: { status: 'not-implemented', reason: 'reply observed: "Not implemented"' },
  needsSceneGraph: { status: 'needs-scene-graph', reason: 'reply observed: "only works when a Scene Graph screen is displayed"' },
  unavailable: { status: 'unavailable', reason: 'reply observed: "mem and cpu data not available"' },
  stubTarget: { status: 'stub-target', reason: 'target answered "Command not recognized" (stub command set; seen with the channel in the background, and on some devices with it in front)' },
  needsDevChannel: { status: 'needs-dev-channel', reason: 'reply observed: "can only be used while a developer channel is running"' },
  notRecognized: { status: 'not-recognized', reason: 'reply observed: "Command not recognized" (no target selected, or not a stub-target path)' },
  unknown: { status: 'unknown', reason: 'reply did not match a known shape' },
};
// Commands whose normal reply is empty (sgperf lifecycle, toggles).
const EMPTY_IS_NORMAL = new Set(['sgperf_start', 'sgperf_stop', 'sgperf_clear', 'logrendezvous_on', 'logrendezvous_off', 'fps_display_on', 'fps_display_off']);

// Font glyph table that follows `loaded_textures`' preamble: header `Family-Size-<bold>-<italic>  File`,
// then rows like `Roku UI Regular-34--   <SYSTEM FONT>`.
const MAX_FONT_LINE = 512;
const MAX_FONT_ROWS = 500;
function parseFonts(raw) {
  const fonts = [];
  let inTable = false;
  for (const line of String(raw).split(/\r?\n/)) {
    if (fonts.length >= MAX_FONT_ROWS) break;
    if (line.length > MAX_FONT_LINE) continue; // bound regex work on hostile input
    if (/^\s*Family-Size-/i.test(line)) { inTable = true; continue; }
    if (!inTable) continue;
    const m = line.match(/^\s*(.+?)-(\d+)-\S*\s{2,}(.+?)\s*$/);
    if (!m) continue;
    // clean() trims trailing prompt characters, which also eats the `>` of a last `<SYSTEM FONT>` row.
    const lost = /^<[^>]*$/.test(m[3]);
    const file = lost ? `${m[3]}>` : m[3];
    fonts.push({ family: m[1], size: Number(m[2]), file, line: lost ? `${line.trim()}>` : line.trim() });
  }
  return fonts;
}

// Classify a reply (already stripped of prompt/echo) → { status, reason, fonts? }; case-insensitive.
function classify(name, raw, parsed) {
  const text = String(raw);
  const out = (s, extra) => ({ status: s.status, reason: s.reason, ...extra });
  const fonts = name === 'loaded_textures' ? parseFonts(text) : null;
  const withFonts = fonts ? { fonts } : undefined;
  if (/only works when a scene graph screen is displayed/i.test(text)) return out(STATUS.needsSceneGraph, withFonts);
  if (/not implemented/i.test(text)) return out(STATUS.notImplemented, withFonts);
  if (/mem and cpu data not available/i.test(text)) return out(STATUS.unavailable);
  if (/can only be used while a developer channel is running/i.test(text)) return out(STATUS.needsDevChannel);
  if (/^[ \t>]*Command not recognized[ \t]*$/im.test(text)) return out(STATUS.notRecognized);
  if (!text.trim()) return EMPTY_IS_NORMAL.has(name) ? out(STATUS.ok, { reason: 'empty reply is the normal reply for this command' }) : out(STATUS.empty);
  if (EMPTY_IS_NORMAL.has(name)) return out(STATUS.unknown);
  if (PARSERS[name]) return parsed && parsed.ok ? out(STATUS.ok) : out(STATUS.unknown);
  if (fonts) return out(STATUS.ok, withFonts);
  return out(STATUS.ok, { reason: 'reply received; no parser for this command' });
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
// Device shape `thread node calls: create 1201 + op 902  @ 0.0% rendezvous` (one per line, no thread
// name) yields { name: 'node-calls', kind: 'node-calls', creates, ops, rendezvousPct, line }. `kind` is
// present only on these entries; the other fields keep their existing names and types.
function parseSgperf(raw) {
  const threads = [];
  const other = [];
  for (const line of String(raw).split(/\r?\n/)) {
    if (!/\d/.test(line)) continue;
    const nc = line.match(/thread node calls:\s*create\s+([\d,]+)\s*\+\s*op\s+([\d,]+)(?:\s*@\s*([\d.]+)\s*%\s*rendezvous)?/i);
    if (nc) {
      threads.push({
        name: 'node-calls',
        kind: 'node-calls',
        creates: Number(nc[1].replace(/,/g, '')),
        ops: Number(nc[2].replace(/,/g, '')),
        rendezvousPct: nc[3] !== undefined ? Number(nc[3]) : null,
        line: line.trim(),
      });
      continue;
    }
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

// `chanperf` → { ok, mem, anon, file, shared, swap, cpu, user, sys } from
//   channel: mem=28460KiB{anon=7288,file=20992,shared=180,swap=0},%cpu=0{user=0,sys=0}
// Memory in KiB, CPU in percent. `channel: mem and cpu data not available` (no channel running / wrong
// target) → { ok:false, error }. Not-a-number or missing fields are null.
function parseChanperf(raw) {
  const text = String(raw);
  const line = text.split(/\r?\n/).find((l) => /mem=/.test(l));
  if (!line) {
    const msg = text.split(/\r?\n/).map((l) => l.replace(/^[ \t>]*channel:\s*/, '').trim()).find(Boolean);
    return { ok: false, error: msg || 'no chanperf data' };
  }
  const num = (re) => { const m = line.match(re); return m ? Number(m[1]) : null; };
  const out = {
    mem: num(/\bmem=([\d.]+)/),
    anon: num(/\banon=([\d.]+)/),
    file: num(/\bfile=([\d.]+)/),
    shared: num(/\bshared=([\d.]+)/),
    swap: num(/\bswap=([\d.]+)/),
    cpu: num(/%cpu=([\d.]+)/),
    user: num(/\buser=([\d.]+)/),
    sys: num(/\bsys=([\d.]+)/),
  };
  return { ok: out.mem !== null, ...out };
}

const PARSERS = { free: parseFree, sgperf_report: parseSgperf, chanperf: parseChanperf };

// Run + parse in one call; `parsed` is null for commands with no parser (raw is always returned).
async function query(host, name, opts) {
  const { raw } = await run(host, name, opts);
  const parser = PARSERS[name];
  const parsed = parser ? parser(raw) : null;
  return { name, raw, parsed, ...classify(name, raw, parsed) };
}

module.exports = { STATUS, classify, parseFonts, COMMANDS, TARGETED, run, query, stripBanner, parseChanperf, parseTargets, pickTarget, parseFree, parseSgperf };
