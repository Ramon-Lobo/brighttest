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
// Cache name: the host, plus _p<port> for a non-default ECP port (so two fakes on one host do not share a key).
function nameFor(host, port) {
  const p = port == null || port === '' ? 8060 : Number(port);
  return bareHost(host) + (p !== 8060 ? `_p${p}` : '');
}
function readMap(dir) {
  try { const m = JSON.parse(fs.readFileSync(cachePath(dir), 'utf8')); return m && typeof m === 'object' ? m : {}; } catch { return {}; }
}

// Remember host -> lease key for the hook and for the read-failure fallback (best effort; hashes only).
// The directory is created 0700 and the file 0600, like the lease directory itself.
function rememberKey(dir, host, key, port) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const m = readMap(dir);
    const names = [nameFor(host, port)];
    if (names[0] !== nameFor(host)) names.push(nameFor(host)); // the hook knows only the host: last lane wins there
    if (names.every((n) => m[n] === key)) return;
    for (const n of names) m[n] = key;
    const tmp = `${cachePath(dir)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(m), { mode: 0o600 });
    fs.renameSync(tmp, cachePath(dir));
  } catch { /* best effort */ }
}
function recalledKey(dir, host, port) {
  const k = readMap(dir)[nameFor(host, port)];
  return typeof k === 'string' && /^id-[0-9a-f]{16}$/.test(k) ? k : null;
}
// Hosts (lowercase, no port) the cache knows, for the hook's host list.
function recalledHosts(dir) {
  return Object.keys(readMap(dir)).map((n) => n.replace(/_p\d+$/, '')).filter(Boolean);
}

module.exports = { IDENTITY_TIMEOUT_MS, readIdentity, rememberKey, recalledKey, recalledHosts, processCache };
