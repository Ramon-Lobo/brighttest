'use strict';
const fs = require('fs');
const net = require('net');
const path = require('path');
const linemapLib = require('../instrument/linemap');

// Device log capture on the BrightScript debug console (port 8085). ADR 0006.
//
// This module is the only owner of the 8085 connection in a process (the device allows exactly one client).
// It splits the stream into lines, flushes a partial line after 250 ms, strips ANSI escapes, drops the history
// the console replays on connect, and keeps a ring buffer of sequence-numbered lines that assertions and
// failure bundles read. A `Brightscript Debugger>` prompt means the app crashed into the debugger.
// Node core `net` only. The reader must only run inside the e2e lane's device lease (run.js opens it after the
// lease is acquired and closes it before release).

const DEFAULTS = {
  port: 8085,
  flushMs: 250,         // a partial line (no newline yet) is flushed after this long
  replayIdleMs: 60,     // replayed history is the burst of lines before the first idle gap this long
  ringSize: 5000,
  connectTimeoutMs: 3000,
  tailLines: 50,        // N: last lines kept in a failure bundle
};

const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b[@-Z\\-_]/g;
const PROMPT_RE = /Brightscript Debugger>/i;
const IN_USE_RE = /Console connection is already in use/i;

const stripAnsi = (s) => String(s).replace(ANSI_RE, '');

// ---- backtrace parser (shared with the headless lane) --------------------------------------------

// Parse a BrightScript runtime-error transcript out of console lines. Returns null when there is no
// runtime error. Shape: { message, code, file, line, location, frames: [{ index, fn, file, line }] }.
// `location` is "pkg:/path.brs(42)" for the top frame, `summary` a one-line human form.
function parseBacktrace(input) {
  const lines = (Array.isArray(input) ? input : String(input).split(/\r?\n/)).map((l) => stripAnsi(typeof l === 'string' ? l : l.text));
  let head = null;
  let headIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    // Old form: a case-sensitive "Runtime Error" / "BRIGHTSCRIPT: ERROR" prefix, so the lowercase "runtime error"
    // inside the "(runtime error &hXX)" tag can never act as the prefix.
    const m = /(?:Runtime Error|BRIGHTSCRIPT: ERROR)[:.\s]+(?:[\w.]+:\s*)?(.*?)(?:\s*\(runtime error (&h[0-9a-f]+)\))?(?:\s+in\s+(\S+?)\((\d+)\))?\s*$/.exec(lines[i]);
    if (m) {
      // Prefer the "Runtime Error" line (banner of the debugger stop) over the earlier BRIGHTSCRIPT line.
      if (!head || /Runtime Error/.test(lines[i])) { head = m; headIdx = i; }
      if (/Runtime Error/.test(lines[i])) break;
      continue;
    }
    // fw 16 form: no prefix; "<message> (runtime error &hXX) in pkg:/file.brs(line)". The message is the text
    // before the tag, kept verbatim apart from trailing whitespace.
    const n = /^(.*?)\s*\(runtime error (&h[0-9a-f]+)\)(?:\s+in\s+(\S+?)\((\d+)\))?\s*$/.exec(lines[i]);
    if (n && n[1].trim()) { head = n; headIdx = i; head.verbatim = true; break; }
  }
  const frames = [];
  const btAt = lines.findIndex((l, i) => i >= Math.max(headIdx, 0) && /^\s*Backtrace:?\s*$/i.test(l));
  if (btAt >= 0) {
    for (let i = btAt + 1; i < lines.length; i++) {
      const fm = /^\s*#(\d+)\s+(.*\S)\s*$/.exec(lines[i]);
      if (fm) { frames.push({ index: Number(fm[1]), fn: fm[2].replace(/^(Function|Sub)\s+/i, ''), file: null, line: null }); continue; }
      const lm = /file\/line:\s*(\S+?)\((\d+)\)/i.exec(lines[i]);
      if (lm && frames.length) { const f = frames[frames.length - 1]; f.file = lm[1]; f.line = Number(lm[2]); continue; }
      if (/^\s*(Local Variables|Brightscript Debugger)/i.test(lines[i])) break;
    }
  }
  if (!head && !frames.length) return null;
  const top = frames.find((f) => f.file) || null;
  const file = (head && head[3]) || (top && top.file) || null;
  const lineNo = (head && head[4] ? Number(head[4]) : null) || (top && top.line) || null;
  const message = (head && (head.verbatim ? head[1].trim() : head[1].replace(/[.\s]+$/, ''))) || 'runtime error';
  const code = head && head[2] ? head[2] : null;
  const location = file ? `${file}(${lineNo})` : null;
  return {
    message, code, file, line: lineNo, location, frames,
    summary: `${message}${code ? ` (runtime error ${code})` : ''}${location ? ` at ${location}` : ''}`,
  };
}

// ---- the reader ----------------------------------------------------------------------------------

// Pattern forms for assertLog/expectNoLog: a plain string (substring) or "/regex/flags".
function toMatcher(pattern) {
  const s = String(pattern);
  const m = /^\/(.+)\/([gimsuy]*)$/.exec(s);
  if (m) {
    let re;
    try { re = new RegExp(m[1], m[2].replace('g', '')); } catch (e) { throw new Error(`invalid log pattern ${s}: ${e.message}`); }
    return (line) => re.test(line);
  }
  return (line) => line.includes(s);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function createLogs(host, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const ring = [];            // { seq, t, text }
  let nextSeq = 1;
  let socket = null;
  let partial = '';
  let flushTimer = null;
  let idleTimer = null;
  let replayEndSeq = null;    // first seq that is live (not replayed history); null while replay is arriving
  let flowStartSeq = 1;
  let launchSeq = null;
  let crashInfo = null;
  let state = { connected: false, error: null, closed: false };

  function push(text) {
    const clean = stripAnsi(text).replace(/\r/g, '');
    const entry = { seq: nextSeq++, t: Date.now(), text: clean };
    ring.push(entry);
    if (ring.length > o.ringSize) ring.shift();
    if (!state.error && entry.seq === 1 && IN_USE_RE.test(clean)) {
      state.error = 'Console connection is already in use: another client (a telnet session or other tool) holds port 8085 on this device.';
    }
    // A prompt in the replayed history is the previous run's crash, not this run's: only live lines count.
    if (replayEndSeq !== null && PROMPT_RE.test(clean)) noteCrash();
  }

  function noteCrash() {
    if (crashInfo) return;
    const bt = parseBacktrace(ring.map((e) => e.text).slice(-200));
    crashInfo = { at: Date.now(), seq: nextSeq - 1, backtrace: bt, summary: bt ? bt.summary : 'stopped at the BrightScript debugger prompt' };
  }

  function flushPartial() {
    clearTimeout(flushTimer); flushTimer = null;
    if (partial !== '') { const p = partial; partial = ''; push(p); }
  }

  function armIdle() {
    if (replayEndSeq !== null) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { flushPartial(); replayEndSeq = nextSeq; }, o.replayIdleMs);
    idleTimer.unref && idleTimer.unref();
  }

  function onData(buf) {
    armIdle();
    partial += buf.toString('utf8');
    const parts = partial.split('\n');
    partial = parts.pop();
    for (const p of parts) push(p);
    // The debugger prompt never ends in a newline: detect it as soon as it is in the partial buffer.
    if (partial !== '' && PROMPT_RE.test(stripAnsi(partial))) flushPartial();
    clearTimeout(flushTimer); flushTimer = null;
    if (partial !== '') { flushTimer = setTimeout(flushPartial, o.flushMs); flushTimer.unref && flushTimer.unref(); }
  }

  const visible = () => {
    const from = Math.max(replayEndSeq === null ? Infinity : replayEndSeq, flowStartSeq);
    return ring.filter((e) => e.seq >= from);
  };

  const api = {
    options: o,
    get connected() { return state.connected; },
    get error() { return state.error; },
    get nextSeq() { return nextSeq; },

    // Open the connection. Resolves { ok } or { ok:false, error } (never rejects, never hangs).
    connect() {
      return new Promise((resolve) => {
        let done = false;
        const fin = (r) => { if (!done) { done = true; clearTimeout(t); resolve(r); } };
        const s = net.connect({ host, port: o.port });
        socket = s;
        const t = setTimeout(() => { state.error = `8085 connect timed out after ${o.connectTimeoutMs} ms`; s.destroy(); fin({ ok: false, error: state.error }); }, o.connectTimeoutMs);
        s.on('connect', () => { state.connected = true; armIdle(); fin({ ok: true }); });
        s.on('data', onData);
        s.on('error', (e) => { if (!state.error) state.error = `8085 ${e.code || e.message}`; fin({ ok: false, error: state.error }); });
        s.on('close', () => { state.connected = false; state.closed = true; flushPartial(); });
      });
    },

    // Start a flow: only lines from now on (and past the replayed history) count for it.
    beginFlow() { flushPartial(); flowStartSeq = nextSeq; launchSeq = null; },
    markLaunch() { launchSeq = nextSeq; crashInfo = null; }, // a launch starts the app afresh: an earlier crash is stale
    get launchSeq() { return launchSeq; },

    // Visible lines of the current flow, optionally only seq > since.
    lines(since = 0) { return visible().filter((e) => e.seq > since); },
    tail(n = o.tailLines) { return ring.slice(-n); },
    all() { return ring.slice(); },
    crash() { return crashInfo; },
    clearCrash() { crashInfo = null; },
    flush() { flushPartial(); },

    // Poll until a visible line matches. Resolves the entry or null.
    async waitForLine(pattern, timeoutMs, intervalMs = 25) {
      const match = toMatcher(pattern);
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const hit = visible().find((e) => match(e.text));
        if (hit) return hit;
        if (crashInfo || state.error) return null;
        if (Date.now() >= deadline) return null;
        await sleep(intervalMs);
      }
    },

    close() {
      clearTimeout(flushTimer); clearTimeout(idleTimer);
      flushPartial();
      if (socket) { socket.destroy(); socket = null; }
      state.connected = false;
    },

    // Write the flow's visible lines to `file` as "seq<TAB>text".
    writeArtifact(file) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const body = visible().map((e) => `${e.seq}\t${e.text}`).join('\n');
      fs.writeFileSync(file, body ? body + '\n' : '');
      return file;
    },
  };
  return api;
}

// assertLog: a line matching `pattern` appears (polled up to timeoutMs). Throws a step-style Error.
async function assertLog(logs, pattern, timeoutMs) {
  if (!logs || logs.error || (!logs.connected && logs.lines().length === 0)) throw new Error(unavailable(logs));
  const hit = await logs.waitForLine(pattern, timeoutMs);
  if (hit) return { detail: `seq ${hit.seq}: ${truncate(hit.text)}` };
  if (logs.crash()) throw new Error(`assertLog ${JSON.stringify(String(pattern))}: app crashed first (${logs.crash().summary})`);
  const last = logs.lines().slice(-3).map((e) => e.text).join(' | ');
  throw new Error(`assertLog ${JSON.stringify(String(pattern))} not seen within ${timeoutMs / 1000}s${last ? ` (last lines: ${truncate(last, 200)})` : ' (no log lines yet)'}`);
}

// expectNoLog: no line seen so far in this flow matches `pattern`. Deterministic: it reads what is buffered
// (after flushing a partial line); it does not wait.
function expectNoLog(logs, pattern) {
  if (!logs || logs.error || (!logs.connected && logs.lines().length === 0)) throw new Error(unavailable(logs).replace('assertLog', 'expectNoLog'));
  logs.flush();
  const match = toMatcher(pattern);
  const hit = logs.lines().find((e) => match(e.text));
  if (hit) throw new Error(`expectNoLog ${JSON.stringify(String(pattern))}: matched seq ${hit.seq}: ${truncate(hit.text)}`);
  return { detail: `no line matches ${JSON.stringify(String(pattern))}` };
}

function unavailable(logs) {
  return `log capture unavailable${logs && logs.error ? `: ${logs.error}` : ' (the 8085 console was not opened)'}`;
}

const truncate = (s, n = 120) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

// ---- failure bundle ------------------------------------------------------------------------------

// Write <dir>/ with error.json, log-tail.txt (last N lines), tree.xml (best effort) and the screenshot (or a
// screenshot-error.json), plus net-refused.txt when `netRefused` (a summary line) is given. `shot` is what maybeScreenshot returned: a file path, { error } or null.
// `cfg` (optional) is the resolved config: when given, a crash's backtrace frames are translated through the build's
// `bt-linemap.json` (see instrument.lineMap): each mapped frame keeps its package `line` and gains `sourceLine`, and
// error.json carries `lineMapNote` (one line) when there is no usable map. Without `cfg` the bundle is unchanged.
async function writeFailureBundle(dir, { flow, step, error, logs, shot, device, netRefused = null, tailLines = DEFAULTS.tailLines, cfg = null }) {
  fs.mkdirSync(dir, { recursive: true });
  const crash = logs && logs.crash();
  const tail = logs ? logs.tail(tailLines) : [];
  fs.writeFileSync(path.join(dir, 'log-tail.txt'), tail.map((e) => `${e.seq}\t${e.text}`).join('\n') + (tail.length ? '\n' : ''));
  const err = {
    flow, step: step ? { op: step.op, line: step.line } : null, message: error && error.message ? error.message : String(error),
    crash: crash ? { summary: crash.summary, backtrace: crash.backtrace } : null,
    logError: logs && logs.error ? logs.error : null, tailLines: tail.length,
  };
  if (crash && crash.backtrace && cfg) {
    const loaded = linemapLib.loadLineMap(linemapLib.resolveLineMapPath(cfg));
    if (loaded.map) {
      const t = linemapLib.translateBacktrace(crash.backtrace, loaded.map);
      err.crash = { summary: t.backtrace.summary, backtrace: t.backtrace };
      if (!t.mapped && t.backtrace.sourceLine === undefined) err.lineMapNote = 'source lines not mapped: no frame is in a rewritten file of the line map';
    } else err.lineMapNote = loaded.note;
  }
  // A typed state failure (STATE_*) also records its code; other failures leave the field out.
  if (error && typeof error.code === 'string' && /^STATE_/.test(error.code)) err.code = error.code;
  if (netRefused) { // passthrough requests the allow-list refused during this flow (the usual cause of a dead feed)
    err.netRefused = netRefused;
    fs.writeFileSync(path.join(dir, 'net-refused.txt'), netRefused + '\n');
  }
  fs.writeFileSync(path.join(dir, 'error.json'), JSON.stringify(err, null, 2) + '\n');
  if (shot && typeof shot === 'string') {
    fs.copyFileSync(shot, path.join(dir, 'screenshot' + path.extname(shot)));
  } else {
    const reason = shot && shot.error ? shot.error : 'screenshot not captured (disabled or no dev password)';
    fs.writeFileSync(path.join(dir, 'screenshot-error.json'), JSON.stringify({ error: reason }, null, 2) + '\n');
  }
  if (device && typeof device.ecpGet === 'function') {
    try {
      const { text } = await device.ecpGet('/query/sgnodes/all', 3000);
      fs.writeFileSync(path.join(dir, 'tree.xml'), text);
    } catch (e) {
      fs.writeFileSync(path.join(dir, 'tree-error.json'), JSON.stringify({ error: e.message }, null, 2) + '\n');
    }
  }
  return dir;
}

module.exports = { createLogs, assertLog, expectNoLog, writeFailureBundle, parseBacktrace, stripAnsi, toMatcher, DEFAULTS };
