'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');
const rules = require('./net-rules');

// Hub network proxy handler (design network-interception.md 4.3, D6, D8; NET-N-T4).
// Handles requests for /bt/<token>/net/;<original-url>: match -> mock | sequence | fault | passthrough(+record).
// The hub (hub.js) owns peer, token and lease checks and calls handle(req, res, target) for this route; this
// module never checks them. targetFromPath() pulls the original URL out of the request path.
//
// Faults (device codes measured in SP-6 [DV]):
//   reset   -> the socket is destroyed before any byte is written (device: -52 "Empty reply from server")
//   timeout -> headers + a few body bytes, then the response is held until the client gives up or holdMs passes
//              (device: -28 only when the app set SetMinimumTransferRate, otherwise no event at all)
//   status  -> that HTTP status (default 503)
//   delayMs -> wait before answering (any rule)
// Unmatched: policy "fail" answers 599 with a hint body + net.error {kind:"unmatched"}; "passthrough" sends it
// upstream, guarded by the allow-list and SSRF rules below.
// Refused passthrough answers 403 + net.error {kind:"upstream", detail:"refused: ..."} with no connection made.

const RING_MAX = 2000;
const SPILL_BYTES = 1024 * 1024;
const MAX_REQ_BODY = 16 * 1024 * 1024;
const MAX_CAPTURE = 32 * 1024 * 1024;
const REC_MAX_ENTRIES = 500;
const REC_MAX_BYTES = 64 * 1024 * 1024;
const MAX_REDIRECTS = 16;
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'trailers', 'transfer-encoding', 'upgrade', 'proxy-connection']);

// ---------------------------------------------------------------------------------------------------------------
// SSRF guard (D8)

function ipv4Parts(ip) {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip);
  return m ? m.slice(1).map(Number) : null;
}

// True for loopback, link-local (incl. cloud metadata), RFC1918, CGNAT, unspecified, ULA and v4-mapped forms of those.
function isBlockedAddress(addr) {
  let ip = String(addr).toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (mapped) ip = mapped[1];
  const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip);
  if (hexMapped) {
    const hi = parseInt(hexMapped[1], 16); const lo = parseInt(hexMapped[2], 16);
    ip = `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  const v4 = ipv4Parts(ip);
  if (v4) {
    const [a, b] = v4;
    return a === 0 || a === 127 || a === 10 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    if (ip === '::' || ip === '::1') return true;
    const first = parseInt(ip.split(':')[0] || '0', 16);
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00;
  }
  return true; // unparseable: refuse
}

function normalizeAllow(list) {
  return (list || []).map((raw) => {
    let s = String(raw).trim().toLowerCase();
    if (!s) return null;
    let port = null;
    const m6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(s);
    if (m6) { s = m6[1]; port = m6[2] ? Number(m6[2]) : null; } else {
      const m = /^([^:]+):(\d+)$/.exec(s);
      if (m) { s = m[1]; port = Number(m[2]); }
    }
    return { host: s, port, wildcard: s.startsWith('*.') };
  }).filter(Boolean);
}

function defaultLookup(host) {
  return new Promise((resolve, reject) => {
    dns.lookup(host, { all: true, verbatim: true }, (err, addrs) => (err ? reject(err) : resolve(addrs.map((a) => a.address))));
  });
}

// Decide whether the hub may connect to `urlStr`. Returns {ok, reason?, address?, family?}.
// Exact hosts in `allow` ("host" = any port, "host:port" = that port) may be private; "*.suffix" entries and
// everything else must resolve only to public addresses; hosts not listed are refused. No connection is made here.
async function checkTarget(urlStr, allow, lookup = defaultLookup) {
  let u;
  try { u = new URL(urlStr); } catch (e) { return { ok: false, reason: 'invalid url' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, reason: `scheme not allowed: ${u.protocol}` };
  if (u.username || u.password) return { ok: false, reason: 'credentials in the url are not allowed' };
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
  const portOk = (e) => e.port === null || e.port === port;
  const exact = allow.some((e) => !e.wildcard && e.host === host && portOk(e));
  const wild = !exact && allow.some((e) => e.wildcard && host.endsWith(e.host.slice(1)) && host.length > e.host.length - 1 && portOk(e));
  if (!exact && !wild) return { ok: false, reason: `host not in upstreamHosts: ${host}:${port}` };
  const isLiteral = net.isIP(host) !== 0;
  if (!exact && (host === 'localhost' || host.endsWith('.localhost'))) return { ok: false, reason: 'localhost is not allowed' };
  let addrs;
  if (isLiteral) addrs = [host];
  else {
    try { addrs = await lookup(host); } catch (e) { return { ok: false, reason: `cannot resolve ${host}` }; }
    if (!addrs.length) return { ok: false, reason: `cannot resolve ${host}` };
  }
  if (!exact) {
    const bad = addrs.find(isBlockedAddress);
    if (bad) return { ok: false, reason: `${host} resolves to a blocked address (${bad})` };
  }
  return { ok: true, address: addrs[0], family: net.isIPv6(addrs[0]) ? 6 : 4 };
}

// ---------------------------------------------------------------------------------------------------------------

function targetFromPath(reqUrl) {
  const i = String(reqUrl).indexOf('/net/;');
  if (i < 0) return null;
  return reqUrl.slice(i + 6);
}

function refuseConnect(req, socket) {
  socket.end('HTTP/1.1 405 Method Not Allowed\r\ncontent-length: 0\r\nconnection: close\r\n\r\n');
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) { reject(new Error('request body too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function flatHeaders(h) {
  const out = {};
  for (const [k, v] of Object.entries(h || {})) out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
  return out;
}

function createNetProxy(opts = {}) {
  const {
    ruleSet = rules.createRuleSet({ root: opts.root || null }), emit = () => {}, upstreamHosts = [], record = false,
    bodyDir = null, spillBytes = SPILL_BYTES, ringMax = RING_MAX, lookup = defaultLookup, upstreamTimeoutMs = 30000,
    now = Date.now, version = '0',
  } = opts;
  const root = opts.root || ruleSet.root || null;
  const allow = normalizeAllow(upstreamHosts);
  if (record && allow.length === 0) throw new rules.NetRuleError('net.record requires net.upstreamHosts (refusing to record without an allow-list)');
  let unmatched = opts.unmatched;
  const redactor = rules.makeRedactor({ ...(opts.redact || {}), warn: opts.warn || ((m) => process.stderr.write(`${m}\n`)) });
  const emitRedact = rules.makeRedactor({ ...(opts.redact || {}) });

  let seq = 0; let bodySeq = 0;
  const ring = []; // entries, oldest first
  const bodies = new Map(); // ref -> {buf} | {file, bytes}
  const recorded = [];
  let rec = null; // active startRecording window: { entries, bytes, overflow, maxEntries, maxBytes }
  const holds = new Set();
  let closed = false;

  function storeBody(buf) {
    if (!buf || !buf.length) return null;
    const ref = `b-${++bodySeq}`;
    if (bodyDir && buf.length > spillBytes) {
      fs.mkdirSync(bodyDir, { recursive: true });
      const file = path.join(bodyDir, `${ref}.bin`);
      fs.writeFileSync(file, buf);
      bodies.set(ref, { file, bytes: buf.length });
    } else bodies.set(ref, { buf, bytes: buf.length });
    return ref;
  }
  function getBody(ref) {
    const b = bodies.get(ref);
    if (!b) return null;
    return b.buf || fs.readFileSync(b.file);
  }
  function dropBody(ref) {
    const b = bodies.get(ref);
    if (!b) return;
    if (b.file) { try { fs.unlinkSync(b.file); } catch (e) { /* already gone */ } }
    bodies.delete(ref);
  }
  function pushEntry(e) {
    ring.push(e);
    while (ring.length > ringMax) {
      const old = ring.shift();
      dropBody(old.reqBodyRef); dropBody(old.resBodyRef);
    }
  }
  const sleep = (ms) => new Promise((r) => { const t = setTimeout(() => { holds.delete(t); r(); }, ms); holds.add(t); });

  function sendResponse(res, status, headers, body) {
    const h = { ...headers };
    delete h['content-length']; delete h['transfer-encoding']; delete h.connection;
    h['content-length'] = String(body.length);
    res.writeHead(status, h);
    res.end(body);
  }

  async function passthrough(req, res, entry, target, reqHeaders, reqBody, tStart) {
    let current = target; let method = req.method; let body = reqBody;
    let active = null;
    res.on('close', () => { if (!res.writableEnded && active) active.destroy(); });
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const chk = await checkTarget(current, allow, lookup);
      if (!chk.ok) return refused(res, entry, chk.reason, tStart);
      let u; try { u = new URL(current); } catch (e) { return refused(res, entry, 'invalid url', tStart); }
      const headers = {};
      for (const [k, v] of Object.entries(reqHeaders)) if (!HOP.has(k) && k !== 'host' && k !== 'content-length' && k !== 'accept-encoding') headers[k] = v;
      headers['accept-encoding'] = 'identity';
      if (body && body.length) headers['content-length'] = String(body.length);
      const lib = u.protocol === 'https:' ? https : http;
      const hostForTls = net.isIP(u.hostname.replace(/^\[|\]$/g, '')) ? undefined : u.hostname;
      const result = await new Promise((resolve) => {
        const ureq = lib.request({
          protocol: u.protocol, hostname: u.hostname.replace(/^\[|\]$/g, ''), port: u.port || undefined, path: u.pathname + u.search, method, headers,
          servername: hostForTls, timeout: upstreamTimeoutMs, agent: false,
          lookup: (h, o, cb) => (o && o.all ? cb(null, [{ address: chk.address, family: chk.family }]) : cb(null, chk.address, chk.family)),
        }, (ures) => resolve({ ures }));
        ureq.on('timeout', () => ureq.destroy(new Error('upstream timeout')));
        ureq.on('error', (err) => resolve({ err }));
        active = ureq;
        ureq.end(body && body.length ? body : undefined);
      });
      if (result.err) return upstreamError(res, entry, result.err.message, tStart);
      const ures = result.ures;
      const loc = ures.headers.location;
      if ([301, 302, 303, 307, 308].includes(ures.statusCode) && loc) {
        ures.resume();
        if (hop === MAX_REDIRECTS) return upstreamError(res, entry, 'too many redirects', tStart);
        try { current = new URL(loc, current).toString(); } catch (e) { return upstreamError(res, entry, 'bad redirect location', tStart); }
        if (ures.statusCode === 303 || ((ures.statusCode === 301 || ures.statusCode === 302) && method === 'POST')) { method = 'GET'; body = null; }
        continue;
      }
      return relay(res, entry, ures, tStart, current);
    }
    return undefined;
  }

  function relay(res, entry, ures, tStart, finalUrl) {
    return new Promise((resolve) => {
      const outHeaders = {};
      for (const [k, v] of Object.entries(ures.headers)) if (!HOP.has(k)) outHeaders[k] = v;
      const tHead = now();
      res.writeHead(ures.statusCode, outHeaders);
      const chunks = []; let n = 0; let truncated = false;
      ures.on('data', (c) => {
        if (n + c.length <= MAX_CAPTURE) { chunks.push(c); n += c.length; } else truncated = true;
        res.write(c);
      });
      ures.on('end', () => {
        res.end();
        const buf = Buffer.concat(chunks);
        finish(entry, {
          status: ures.statusCode, statusText: ures.statusMessage, resHeaders: flatHeaders(ures.headers), resBody: buf, source: 'passthrough',
          timings: { blocked: 0, wait: tHead - tStart, receive: now() - tHead }, truncated, finalUrl,
        });
        resolve();
      });
      ures.on('error', () => { res.destroy(); entry.error = 'upstream'; emit('net.error', { id: entry.id, kind: 'upstream', detail: 'upstream response aborted' }); resolve(); });
    });
  }

  function refused(res, entry, reason, tStart) {
    const body = Buffer.from(`brighttest net: passthrough refused (${reason}). Add the host to net.upstreamHosts to allow it.\n`);
    sendResponse(res, 403, { 'content-type': 'text/plain' }, body);
    entry.status = 403; entry.source = 'refused'; entry.error = reason; entry.ms = now() - tStart;
    emit('net.error', { id: entry.id, kind: 'upstream', detail: `refused: ${reason}`, refused: true, status: 403, bytes: body.length });
  }

  function upstreamError(res, entry, detail, tStart) {
    if (!res.headersSent) sendResponse(res, 502, { 'content-type': 'text/plain' }, Buffer.from(`brighttest net: upstream error: ${detail}\n`));
    else res.destroy();
    entry.status = 502; entry.source = 'passthrough'; entry.error = detail; entry.ms = now() - tStart;
    emit('net.error', { id: entry.id, kind: 'upstream', detail });
  }

  // Record the response on the entry, emit net.response, add to the HAR list when recording passthrough.
  function finish(entry, r) {
    entry.status = r.status; entry.source = r.source; entry.timings = r.timings; entry.ms = now() - entry.t0;
    entry.resBodyRef = storeBody(r.resBody);
    entry.resBytes = r.resBody ? r.resBody.length : 0;
    entry.resHeadersRaw = r.resHeaders; entry.statusText = r.statusText || '';
    emit('net.response', {
      id: entry.id, status: r.status, headers: redactor.enabled ? emitRedact.headers(r.resHeaders) : r.resHeaders, bodyRef: entry.resBodyRef || undefined,
      bytes: entry.resBytes, source: r.source, timings: { wait: r.timings.wait, receive: r.timings.receive },
    });
    if (record && r.source === 'passthrough') {
      const item = {
        startedDateTime: entry.t0, time: entry.ms, method: entry.method, url: r.finalUrl || entry.url, reqHeaders: entry.reqHeadersRaw,
        reqBody: entry.reqBody, status: r.status, statusText: r.statusText, resHeaders: r.resHeaders, resBody: r.resBody, timings: r.timings,
      };
      recorded.push(item);
      // Only an exchange that began inside the window belongs to it, even if it finishes after another window opened.
      const w = entry.window;
      if (w && w === rec && !w.overflow) {
        const bytes = (item.resBody ? item.resBody.length : 0) + (item.reqBody ? item.reqBody.length : 0);
        if (w.entries.length + 1 > w.maxEntries || w.bytes + bytes > w.maxBytes) { w.overflow = true; w.entries = []; w.bytes = 0; } else { w.entries.push(item); w.bytes += bytes; }
      }
    }
  }

  async function handle(req, res, target) {
    if (closed) { res.destroy(); return; }
    if (req.method === 'CONNECT') { res.writeHead(405, { 'content-length': '0' }); res.end(); return; }
    const t0 = now();
    const id = `r-${++seq}`;
    let reqBody;
    try { reqBody = await readBody(req, MAX_REQ_BODY); } catch (e) {
      if (!res.headersSent) { res.writeHead(413, { 'content-length': '0' }); res.end(); }
      return;
    }
    const reqHeaders = flatHeaders(req.headers);
    const entry = {
      id, t0, method: req.method, url: target, reqHeadersRaw: reqHeaders, reqBody: reqBody.length ? reqBody : null,
      reqBodyRef: storeBody(reqBody), rule: null, status: null, source: null, ms: null, error: null, window: rec,
    };
    pushEntry(entry);
    let parsed = null;
    try { parsed = new URL(target); } catch (e) { /* handled below */ }
    if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
      emit('net.request', { id, method: req.method, url: String(target), headers: {}, rule: null });
      const badBody = Buffer.from('brighttest net: the target is not an http(s) URL\n');
      sendResponse(res, 400, { 'content-type': 'text/plain' }, badBody);
      entry.status = 400; entry.error = 'bad target';
      emit('net.error', { id, kind: 'upstream', detail: 'bad target url', status: 400, bytes: badBody.length });
      return;
    }
    const m = ruleSet.match({ method: req.method, url: target, headers: reqHeaders, body: reqBody });
    entry.rule = m ? m.rule.id : null;
    emit('net.request', {
      id, method: req.method, url: emitRedact.url(target), headers: emitRedact.headers(reqHeaders), rule: entry.rule,
      bodyRef: entry.reqBodyRef || undefined,
    });

    try {
      if (!m) {
        const policy = unmatched || (ruleSet.configCount() > 0 ? 'fail' : 'passthrough');
        if (policy === 'fail') {
          const hint = `brighttest net: no rule matched ${req.method} ${emitRedact.url(target)}. Add a mock or fixture, or set unmatched to "passthrough" with net.upstreamHosts.\n`;
          sendResponse(res, 599, { 'content-type': 'text/plain' }, Buffer.from(hint));
          entry.status = 599; entry.source = 'unmatched'; entry.error = 'unmatched'; entry.ms = now() - t0;
          emit('net.error', { id, kind: 'unmatched', detail: `${req.method} ${emitRedact.url(target)}` });
          return;
        }
        await passthrough(req, res, entry, target, reqHeaders, reqBody, t0);
        return;
      }
      if (m.passthrough) { await passthrough(req, res, entry, target, reqHeaders, reqBody, t0); return; }
      const resp = m.response;
      if (resp.delayMs) await sleep(resp.delayMs);
      if (closed || res.destroyed) return;
      if (resp.fault && resp.fault.kind === 'reset') {
        entry.source = 'fault'; entry.error = 'fault:reset'; entry.ms = now() - t0;
        emit('net.error', { id, kind: 'fault:reset', detail: 'socket destroyed before any response byte' });
        req.socket.destroy();
        return;
      }
      if (resp.fault && resp.fault.kind === 'timeout') {
        const f = resp.fault;
        const partial = f.partialBytes === undefined ? 16 : f.partialBytes;
        entry.source = 'fault'; entry.error = 'fault:timeout';
        emit('net.error', { id, kind: 'fault:timeout', detail: `response held (holdMs ${f.holdMs === undefined ? 120000 : f.holdMs})` });
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(1048576) });
        if (partial > 0) res.write(Buffer.alloc(partial, 0x2e));
        await new Promise((resolve) => {
          const timer = setTimeout(done, f.holdMs === undefined ? 120000 : f.holdMs);
          function done() { clearTimeout(timer); holds.delete(done); res.destroy(); entry.ms = now() - t0; resolve(); }
          holds.add(done);
          res.on('close', done);
        });
        return;
      }
      if (resp.fault) { // status fault
        const body = Buffer.from(`brighttest net: injected ${resp.fault.status}\n`);
        sendResponse(res, resp.fault.status, { 'content-type': 'text/plain' }, body);
        finish(entry, { status: resp.fault.status, resHeaders: { 'content-type': 'text/plain' }, resBody: body, source: 'mock', timings: { blocked: 0, wait: resp.delayMs || 0, receive: 0 } });
        return;
      }
      const body = rules.resolveBody(resp, root);
      const headers = { ...resp.headers };
      const ct = rules.contentTypeFor(resp);
      if (ct && !headers['content-type']) headers['content-type'] = ct;
      const noBody = resp.status === 204 || resp.status === 304 || resp.status < 200;
      if (noBody) { res.writeHead(resp.status, headers); res.end(); } else sendResponse(res, resp.status, headers, body);
      finish(entry, {
        status: resp.status, resHeaders: headers, resBody: noBody ? Buffer.alloc(0) : body, source: m.rule.source === 'fixture' ? 'fixture' : 'mock',
        timings: { blocked: 0, wait: resp.delayMs || 0, receive: 0 },
      });
    } catch (err) {
      if (!res.headersSent) sendResponse(res, 500, { 'content-type': 'text/plain' }, Buffer.from(`brighttest net: ${err.message}\n`));
      else res.destroy();
      entry.status = 500; entry.error = err.message;
      emit('net.error', { id, kind: 'upstream', detail: err.message });
    }
  }

  return {
    handle,
    ruleSet,
    // BTNet_requests: raw (unredacted) log entries filtered by method, url glob, status.
    requests(filter = {}) {
      const urlOk = filter.url ? rules.compileUrlPattern(filter.url) : null;
      return ring.filter((e) => (!filter.method || e.method === String(filter.method).toUpperCase()) && (!urlOk || urlOk(e.url))
        && (filter.status === undefined || e.status === filter.status)).map((e) => ({
        id: e.id, method: e.method, url: e.url, headers: e.reqHeadersRaw, body: e.reqBody ? e.reqBody.toString('utf8') : '', status: e.status,
        ms: e.ms, rule: e.rule, source: e.source, error: e.error,
      }));
    },
    getBody,
    // Studio Network panel (NET-N-T10): completed exchanges still in the ring (raw, newest last) in the shape
    // rules.buildHar takes, or one exchange by id (null when gone).
    exchanges({ id = null } = {}) {
      return ring.filter((e) => e.resHeadersRaw && (id === null || e.id === id)).map((e) => ({
        id: e.id, startedDateTime: e.t0, time: e.ms || 0, method: e.method, url: e.url, reqHeaders: e.reqHeadersRaw, reqBody: e.reqBody,
        status: e.status, statusText: e.statusText, resHeaders: e.resHeadersRaw, resBytes: e.resBytes || 0, source: e.source, rule: e.rule,
        timings: e.timings, resBody: () => (e.resBodyRef ? getBody(e.resBodyRef) : null),
      }));
    },
    bodyFiles() { return [...bodies.values()].filter((b) => b.file).map((b) => b.file); },
    get size() { return ring.length; },
    har() { return rules.buildHar(recorded, { redact: { ...(opts.redact || {}), warn: opts.warn || ((m) => process.stderr.write(`${m}\n`)) }, version }); },
    writeHar(file) {
      const har = this.har();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(har, null, 2));
      return har.log.entries.length;
    },
    // Real recording window (NET-REC): only passthrough exchanges that START after startRecording and finish before
    // stopRecording are kept. The buffer is bounded; on overflow stopRecording throws and the window is dropped.
    startRecording(o = {}) {
      if (!record) throw new rules.NetRuleError('recording needs net.record and net.upstreamHosts');
      if (rec) throw new rules.NetRuleError('a recording is already active');
      rec = { entries: [], bytes: 0, overflow: false, maxEntries: o.maxEntries || REC_MAX_ENTRIES, maxBytes: o.maxBytes || REC_MAX_BYTES };
    },
    get recording() { return !!rec; },
    stopRecording() {
      if (!rec) throw new rules.NetRuleError('no recording is active');
      const w = rec; rec = null;
      if (w.overflow) throw new rules.NetRuleError(`recording buffer overflow (more than ${w.maxEntries} exchanges or ${w.maxBytes} bytes); the recording was discarded, record a shorter window`);
      return rules.buildHar(w.entries, { redact: { ...(opts.redact || {}), warn: opts.warn || ((m) => process.stderr.write(`${m}\n`)) }, version });
    },
    allowedHosts() { return allow.map((e) => (e.port ? `${e.host}:${e.port}` : e.host)); },
    setUnmatched(p) {
      if (p !== 'fail' && p !== 'passthrough') throw new rules.NetRuleError('unmatched must be "fail" or "passthrough"');
      unmatched = p;
    },
    close() {
      closed = true;
      for (const h of [...holds]) { if (typeof h === 'function') h(); else clearTimeout(h); }
      holds.clear();
    },
  };
}

module.exports = { createNetProxy, checkTarget, isBlockedAddress, normalizeAllow, targetFromPath, refuseConnect, RING_MAX, SPILL_BYTES };
