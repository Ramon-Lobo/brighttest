'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const dgram = require('dgram');

// Device resolution, credential cache, and SSDP discovery — shared by the CLI and the studio.
//
// Credentials resolve with precedence: explicit flag → environment (process env + a project .env) →
// cache (the last device connected). The cache lives at ~/.brighttest/devices.json (0600) and maps a
// host to its dev password + name, plus the last host used, so you don't have to pass --host/--password
// every time. Roku dev passwords are low-sensitivity local-network secrets; they're stored in plaintext
// in your home dir with owner-only permissions.

// Cache path is overridable via BRIGHTTEST_CACHE (used by tests); defaults to ~/.brighttest/devices.json.
const cacheFile = () => process.env.BRIGHTTEST_CACHE || path.join(os.homedir(), '.brighttest', 'devices.json');

// ---- project .env (KEY=value lines; quotes optional) ------------------------------------------
function loadDotEnv(dir) {
  const out = {};
  try {
    for (const line of fs.readFileSync(path.join(dir || process.cwd(), '.env'), 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (!m) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      out[m[1]] = v;
    }
  } catch { /* no .env */ }
  return out;
}

// ---- credential cache -------------------------------------------------------------------------
function loadCache() {
  try { return JSON.parse(fs.readFileSync(cacheFile(), 'utf8')); } catch { return { devices: {}, lastHost: null }; }
}
function saveCache(cache) {
  try {
    const f = cacheFile();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(cache, null, 2));
    fs.chmodSync(f, 0o600);
  } catch { /* best-effort */ }
}
function rememberDevice(host, password, name) {
  if (!host) return;
  const c = loadCache();
  const prev = c.devices[host] || {};
  c.devices[host] = { name: name || prev.name || null, password: password ?? prev.password ?? null, lastUsed: Date.now() };
  c.lastHost = host;
  saveCache(c);
}
function cachedPassword(host) { return (loadCache().devices[host] || {}).password || null; }
function cachedDevices() {
  const c = loadCache();
  return Object.entries(c.devices).map(([host, d]) => ({ host, name: d.name, hasPassword: !!d.password, lastUsed: d.lastUsed, last: host === c.lastHost }));
}

// ---- resolution -------------------------------------------------------------------------------
// Returns { host, password, source } where source ∈ flag | env | cache | none.
function resolveDevice({ host, password, cwd } = {}) {
  const env = { ...loadDotEnv(cwd), ...process.env };
  const cache = loadCache();
  const h = host || env.ROKU_HOST || cache.lastHost || null;
  let p = password || env.ROKU_PASSWORD || null;
  if (!p && h) p = cachedPassword(h);
  const source = host ? 'flag' : env.ROKU_HOST ? 'env' : cache.lastHost ? 'cache' : 'none';
  return { host: h, password: p, source };
}

// ---- SSDP discovery ---------------------------------------------------------------------------
// Roku devices answer an SSDP M-SEARCH for `roku:ecp`. Collect responders, then enrich each with its
// device-info (name + model). Pure Node (dgram + fetch); no dependencies.
function ssdpSearch({ timeoutMs = 3000 } = {}) {
  return new Promise((resolve) => {
    const found = new Map();
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const probe = Buffer.from(
      ['M-SEARCH * HTTP/1.1', 'HOST: 239.255.255.250:1900', 'MAN: "ssdp:discover"', 'ST: roku:ecp', 'MX: 3', '', ''].join('\r\n'),
    );
    sock.on('message', (buf) => {
      const m = /LOCATION:\s*http:\/\/(\d+\.\d+\.\d+\.\d+):8060/i.exec(buf.toString());
      if (m && !found.has(m[1])) found.set(m[1], { host: m[1] });
    });
    sock.on('error', () => {});
    sock.bind(() => {
      try { sock.setBroadcast(true); } catch {}
      const send = () => { try { sock.send(probe, 0, probe.length, 1900, '239.255.255.250'); } catch {} };
      send(); setTimeout(send, 250);
    });
    setTimeout(() => { try { sock.close(); } catch {} resolve([...found.values()]); }, timeoutMs);
  });
}

async function deviceInfo(host, timeoutMs = 1500) {
  try {
    const r = await fetch(`http://${host}:8060/query/device-info`, { signal: AbortSignal.timeout(timeoutMs) });
    const t = await r.text();
    const g = (tag) => ((new RegExp(`<${tag}>([^<]*)</${tag}>`, 'i').exec(t) || [])[1] || '').trim();
    return {
      name: g('user-device-name') || g('friendly-device-name') || g('default-device-name') || 'Roku',
      model: g('friendly-model-name') || g('model-name') || '',
      id: g('serial-number') || host,
    };
  } catch { return { name: 'Roku', model: '', id: host }; }
}

async function discover(opts) {
  const list = await ssdpSearch(opts);
  await Promise.all(list.map(async (d) => Object.assign(d, await deviceInfo(d.host), { hasPassword: !!cachedPassword(d.host) })));
  return list.sort((a, b) => a.host.localeCompare(b.host));
}

module.exports = {
  cacheFile, loadDotEnv, loadCache, saveCache, rememberDevice, cachedPassword, cachedDevices,
  resolveDevice, discover, deviceInfo,
};
