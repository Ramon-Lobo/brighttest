'use strict';
// Hub events file of an e2e run: one NDJSON object per hub request/event, with a timestamp, written next to the
// run's other artifacts (`hub-events.ndjson`). Created only when the run starts a hub; stderr/stdout output is unchanged.
// Best-effort: a write failure never changes the run.
const fs = require('fs');
const path = require('path');

const FILE = 'hub-events.ndjson';
const REQUEST = /request (\S+) (\S+) -> (\d+) \((\d+) response bytes(?:, source ([^)]+))?\)/;
const AGENT_KEYS = ['id', 'seq', 'op', 'ok', 'error', 'phase']; // the only data keys written for src 'agent'
const MAX_DATA = 2000; // chars of event data kept per line; bigger payloads are dropped, not truncated mid-JSON

function createHubEvents({ dir, now = Date.now } = {}) {
  const file = path.join(dir, FILE);
  let active = false;
  let detach = null;
  const write = (obj) => {
    if (!active) return;
    try { fs.appendFileSync(file, JSON.stringify({ ts: new Date(now()).toISOString(), ...obj }) + '\n'); } catch { /* best-effort */ }
  };
  // A hub log line (`[brighttest hub] ...`): request lines get method/path/status/bytes/source fields, others stay raw.
  function log(line) {
    const s = String(line);
    const m = REQUEST.exec(s);
    if (m) write({ kind: 'request', method: m[1], path: m[2], status: Number(m[3]), bytes: Number(m[4]), source: m[5] || null, line: s });
    else write({ kind: 'log', line: s });
  }
  const reqs = new Map();
  return {
    file,
    get active() { return active; },
    // Start the file (truncates a previous one) and follow the hub's own event stream when it has one.
    open(hub) {
      try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, ''); } catch { return; }
      active = true;
      if (hub && hub.events && typeof hub.events.on === 'function') {
        const h = (ev) => {
          if (!ev) return;
          let data = ev.data;
          // Agent-sourced events carry app data (state snapshots, custom events): keep only timing-relevant keys.
          if (ev.src === 'agent') {
            const kept = {};
            if (data && typeof data === 'object') for (const k of AGENT_KEYS) if (data[k] !== undefined && (data[k] === null || typeof data[k] !== 'object')) kept[k] = data[k];
            data = kept;
          }
          let dropped = false;
          try { if (JSON.stringify(data === undefined ? null : data).length > MAX_DATA) { data = undefined; dropped = true; } } catch { data = undefined; dropped = true; }
          write({ kind: 'event', src: ev.src || null, name: ev.kind || null, ...(data !== undefined ? { data } : {}), ...(dropped ? { dataDropped: true } : {}) });
        };
        hub.events.on('event', h);
        detach = () => { try { hub.events.removeListener('event', h); } catch { /* ignore */ } };
      }
    },
    log,
    // Net proxy events (same mapping as the hub's request log line: method, path without query, status, byte count; never a body).
    net(kind, data) {
      if (!active || !data) return;
      if (kind === 'net.request') {
        let p = '?';
        try { p = new URL(String(data.url)).pathname; } catch { /* keep ? */ }
        reqs.set(data.id, { method: String(data.method || ''), path: p });
        if (reqs.size > 1000) reqs.delete(reqs.keys().next().value);
      } else if (kind === 'net.response' || (kind === 'net.error' && Number.isInteger(data.status))) {
        const r = reqs.get(data.id) || { method: '?', path: '?' };
        reqs.delete(data.id);
        const source = kind === 'net.response' ? (data.source || '?') : (data.refused ? 'refused' : 'error');
        log(`[brighttest hub] request ${r.method} ${r.path} -> ${data.status} (${Number(data.bytes) || 0} response bytes, source ${source})`);
      } else if (kind === 'net.error') {
        const r = reqs.get(data.id) || { method: '?', path: '?' };
        reqs.delete(data.id);
        write({ kind: 'request', method: r.method, path: r.path, status: null, bytes: null, source: data.kind || 'error', line: `[brighttest hub] request ${r.method} ${r.path} failed (${data.kind || 'error'})` });
      }
    },
    close() { if (detach) detach(); detach = null; active = false; },
  };
}

module.exports = { createHubEvents, FILE };
