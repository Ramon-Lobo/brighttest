'use strict';
const fs = require('fs');
const path = require('path');
const lease = require('./device-lease');

// Device identity for the lease key: the serial number (or device-id) from GET /query/device-info.
// One network call, bounded by IDENTITY_TIMEOUT_MS, cached per process (failures too, so a dead host costs
// the bound once). Any failure is a fallback to the address key, never an error. The identity itself is
// never logged or stored: only its hash (lease.hashSerial) and the resulting lease key.
const IDENTITY_TIMEOUT_MS = 1500;
const CACHE_FILE = 'identity-cache.json'; // <lease dir>: host -> lease key, read by the hook (no network there)
const processCache = new Map(); // `${host}:${port}` -> Promise<{ id, hash } | { reason }>

function tag(xml, name) {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([^<]*)</${name}>`, 'i').exec(xml);
  const v = m ? m[1].trim() : '';
  return v === '' ? null : v;
}

async function fetchIdentity(host, port, timeoutMs, fetchImpl) {
  let res;
  try {
    res = await fetchImpl(`http://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}/query/device-info`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { reason: `device-info HTTP ${res.status}` };
    const xml = await res.text();
    const id = tag(xml, 'serial-number') || tag(xml, 'device-id');
    return id ? { id, hash: lease.hashSerial(id) } : { reason: 'device-info has no serial-number or device-id' };
  } catch (e) {
    const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return { reason: timedOut ? `device-info timed out after ${timeoutMs} ms` : 'device-info unreachable' };
  }
}

// -> { id, hash } or { reason }. Never throws.
function readIdentity(host, { port = 8060, timeoutMs = IDENTITY_TIMEOUT_MS, fetchImpl = globalThis.fetch, cache = processCache } = {}) {
  const ck = `${String(host).toLowerCase()}:${port}`;
  if (!cache.has(ck)) cache.set(ck, fetchIdentity(String(host), port, timeoutMs, fetchImpl).catch(() => ({ reason: 'device-info unreachable' })));
  return cache.get(ck);
}

function cachePath(dir) { return path.join(dir, CACHE_FILE); }
function bareHost(h) { return lease.stripHostPasswords(String(h || '')).trim().toLowerCase(); }

// Remember host -> lease key for the hook (best effort; hashes only).
function rememberKey(dir, host, key) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    let m = {};
    try { m = JSON.parse(fs.readFileSync(cachePath(dir), 'utf8')) || {}; } catch { /* new */ }
    const h = bareHost(host);
    if (m[h] === key) return;
    m[h] = key;
    const tmp = `${cachePath(dir)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(m));
    fs.renameSync(tmp, cachePath(dir));
  } catch { /* best effort */ }
}
function recalledKey(dir, host) {
  try {
    const k = (JSON.parse(fs.readFileSync(cachePath(dir), 'utf8')) || {})[bareHost(host)];
    return typeof k === 'string' && /^id-[0-9a-f]{16}$/.test(k) ? k : null;
  } catch { return null; }
}

module.exports = { IDENTITY_TIMEOUT_MS, readIdentity, rememberKey, recalledKey, processCache };
