'use strict';
const crypto = require('crypto');
const { defaultQueue } = require('./ecpq');

// ECP device driver for the e2e lane. Everything the runner does TO a device goes through here:
// launch/deep-link, keypresses (incl. text via Lit_), device-info, and dev screenshots. Uses only the
// global fetch + node:crypto (the dev screenshot endpoint needs HTTP Digest auth, which fetch has no
// built-in support for), matching brighttest's zero-dependency ethos.
//
// Two HTTP surfaces are involved:
//   • ECP    — http://<host>:<ecp-port, default 8060>/…  (no auth) — launch, keypress, query/*
//   • Dev UI — http://<host>/…       (Digest auth as rokudev:<password>) — plugin_inspect + /pkgs/*.jpg

const { resolveEcpPort, parseDeviceInfo } = require('../devices');

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Build one field of a Digest `Authorization` header from a parsed challenge.
function buildDigestHeader({ user, password, method, uri, challenge }) {
  const realm = challenge.realm || '';
  const nonce = challenge.nonce || '';
  const qop = challenge.qop; // e.g. "auth"
  const opaque = challenge.opaque;
  const ha1 = md5(`${user}:${realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);
  const parts = [`username="${user}"`, `realm="${realm}"`, `nonce="${nonce}"`, `uri="${uri}"`];
  let response;
  if (qop) {
    const nc = '00000001';
    const cnonce = crypto.randomBytes(8).toString('hex');
    response = md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`);
    parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  } else {
    response = md5(`${ha1}:${nonce}:${ha2}`);
  }
  parts.push(`response="${response}"`);
  if (opaque) parts.push(`opaque="${opaque}"`);
  return 'Digest ' + parts.join(', ');
}

// Parse a `WWW-Authenticate: Digest …` header into a key/value map.
function parseChallenge(header) {
  const out = {};
  const body = String(header || '').replace(/^Digest\s+/i, '');
  for (const m of body.matchAll(/(\w+)=(?:"([^"]*)"|([^,]*))/g)) {
    out[m[1]] = m[2] !== undefined ? m[2] : (m[3] || '').trim();
  }
  return out;
}

// fetch() that transparently answers an HTTP Digest 401 challenge (one retry). `uri` is the request
// path used in the digest computation (must match exactly what the server expects).
async function digestFetch(url, uri, { user, password, method = 'GET', body, headers = {} } = {}) {
  const first = await fetch(url, { method, body, headers });
  if (first.status !== 401) return first;
  const challenge = parseChallenge(first.headers.get('www-authenticate'));
  const auth = buildDigestHeader({ user, password, method, uri, challenge });
  return fetch(url, { method, body, headers: { ...headers, Authorization: auth } });
}

// Minimal multipart/form-data body builder. `fields` is an array of {name, value} (string parts) and
// {name, filename, contentType, data} (file parts). Returns { body: Buffer, contentType }.
function multipart(fields) {
  const boundary = '----brighttest' + crypto.randomBytes(12).toString('hex');
  const chunks = [];
  for (const f of fields) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${f.name}"`;
    if (f.filename !== undefined) head += `; filename="${f.filename}"`;
    head += '\r\n';
    if (f.contentType) head += `Content-Type: ${f.contentType}\r\n`;
    head += '\r\n';
    chunks.push(Buffer.from(head, 'utf8'));
    chunks.push(Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.value ?? ''), 'utf8'));
    chunks.push(Buffer.from('\r\n', 'utf8'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

// 'png' | 'jpg' from magic bytes, else null. Pure (testable).
function sniffImageExt(buf) {
  if (buf && buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf && buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  return null;
}

// A device handle bound to a host (+ optional dev password for screenshots).
function createDevice({ host, password, ecpPort }) {
  if (!host) throw new Error('createDevice requires a host');
  const port = resolveEcpPort(ecpPort); // explicit option, else ROKU_ECP_PORT, else 8060
  const base = `http://${host}:${port}`;
  const qkey = port === 8060 ? host : `${host}:${port}`; // distinct queue lane per ECP endpoint

  // Every call goes through the per-host queue (lib/e2e/ecpq.js): one at a time per device, per-endpoint
  // spacing, one retry on a transient failure. Each request is time-bound: without it a sgnodes query can hang
  // indefinitely while the render thread is busy (e.g. decoding fullscreen video), stalling the whole run.
  const queued = (path, fn, qopts) => defaultQueue.run(qkey, defaultQueue.endpointKind(path), fn, qopts);
  const ecpGet = (path, timeoutMs = 6000) => queued(path, async () => {
    const r = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
    return { status: r.status, text: await r.text() };
  });
  const ecpPost = (path, timeoutMs = 6000) => queued(path, async () => {
    const r = await fetch(`${base}${path}`, { method: 'POST', signal: AbortSignal.timeout(timeoutMs) });
    return { status: r.status, text: await r.text().catch(() => '') };
  }, { idempotent: false }); // keypress/launch act on the device: retry only when provably undelivered

  // One screenshot attempt (two Digest-authed steps on port 80):
  //   1) POST /plugin_inspect  mysubmit=Screenshot  → generates /pkgs/dev.{jpg,png}
  //   2) GET  that path                              → the image bytes
  async function captureScreenshot() {
    const user = 'rokudev';
    const dev = `http://${host}`;
    const { body, contentType } = multipart([
      { name: 'mysubmit', value: 'Screenshot' },
      { name: 'archive', filename: '', contentType: 'application/octet-stream', data: Buffer.alloc(0) },
    ]);
    const gen = await digestFetch(`${dev}/plugin_inspect`, '/plugin_inspect', {
      user, password, method: 'POST', body, headers: { 'Content-Type': contentType },
    });
    const html = await gen.text();
    if (gen.status >= 400) throw new Error(`screenshot generate failed (HTTP ${gen.status})`);
    // Deterministic, not transient: the installer only screenshots while a sideloaded app is in front. No retry.
    if (/screenshot not ok/i.test(html)) {
      throw Object.assign(
        new Error('screenshot not ok: no sideloaded app is in the foreground (launch the dev channel first)'),
        { code: 'SCREENSHOT_NOT_FOREGROUND' }
      );
    }
    const m = html.match(/["']([^"']*\/pkgs\/dev\.(?:jpg|png))["']/i) || html.match(/(\/pkgs\/dev\.(?:jpg|png))/i);
    const imgPath = m ? m[1] : '/pkgs/dev.jpg';
    const img = await digestFetch(`${dev}${imgPath}`, imgPath, { user, password, method: 'GET' });
    if (img.status >= 400) throw new Error(`screenshot fetch failed (HTTP ${img.status})`);
    const buf = Buffer.from(await img.arrayBuffer());
    // The bytes decide the extension, not the URL; fall back to the URL only for unrecognised data.
    const ext = sniffImageExt(buf) || (imgPath.toLowerCase().endsWith('.png') ? 'png' : 'jpg');
    return { buffer: buf, ext };
  }

  return {
    host,
    hasPassword: !!password,

    // The full capability record (the shared parser in lib/devices.js, serial included: callers must not
    // print `serial` unless the user opted in). Throws only when the device does not answer 200.
    async deviceCapabilities() {
      const { status, text } = await ecpGet('/query/device-info');
      if (status !== 200) throw new Error(`device-info HTTP ${status} (is ${host} a Roku on the LAN?)`);
      return { ...parseDeviceInfo(text), model: (text.match(/<model-name>([^<]*)/) || [])[1] || null, name: (text.match(/<user-device-name>([^<]*)/) || [])[1] || null };
    },

    async deviceInfo() {
      const caps = await this.deviceCapabilities();
      return {
        model: caps.model,
        firmware: caps.softwareVersion,
        developerEnabled: caps.developerEnabled === true,
        // true only when the device said so (a missing tag is unknown, not disabled): the preflight uses it.
        developerDisabled: caps.developerEnabled === false,
        ecpSettingMode: caps.ecpSettingMode,
        name: caps.name,
        // The UI coordinate space node bounds are expressed in ("1080p" / "720p"). The studio overlay
        // needs it to size its viewBox — a Scene's own bounds are the union of its descendants, so the
        // tree cannot be trusted for this.
        uiResolution: caps.uiResolution,
      };
    },

    // Launch appId (default 'dev'); optional deep-link params (contentId/mediaType, plus any extras).
    async launch(appId = 'dev', params = {}) {
      const qs = Object.entries(params)
        .filter(([, v]) => v !== undefined && v !== null)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&');
      const { status } = await ecpPost(`/launch/${encodeURIComponent(appId)}${qs ? `?${qs}` : ''}`);
      if (status >= 400) throw new Error(`launch ${appId} failed (HTTP ${status})`);
      return status;
    },

    // Press one remote key. Throws on the Limited-mode 403 with actionable guidance.
    async keypress(key) {
      const { status } = await ecpPost(`/keypress/${encodeURIComponent(key)}`);
      if (status === 403) {
        throw new Error(
          'keypress refused (HTTP 403). Set the device to Permissive: ' +
          'Settings → System → Advanced → Control by mobile apps → Network access → Permissive.'
        );
      }
      if (status >= 400) throw new Error(`keypress ${key} failed (HTTP ${status})`);
      return status;
    },

    // Press a key N times, settling briefly between presses.
    async keypressSeq(key, count = 1, gapMs = 120) {
      for (let i = 0; i < count; i++) {
        await this.keypress(key);
        if (i < count - 1) await sleep(gapMs);
      }
    },

    // Type text on an on-screen keyboard via Lit_ keypresses (one per character). The raw char is passed
    // through — keypress() URL-encodes exactly once (double-encoding turns a space into Lit_%2520 → 400).
    async text(str, gapMs = 60) {
      for (const ch of String(str)) {
        await this.keypress(`Lit_${ch}`);
        await sleep(gapMs);
      }
    },

    // Query the media player state via ECP (no auth, no render-thread contention) — reliable during
    // fullscreen video where sgnodes stalls. Returns { state, position, duration } (ms, when present).
    async mediaPlayer() {
      const { text } = await ecpGet('/query/media-player');
      return parseMediaPlayer(text);
    },

    // Capture a dev screenshot to a PNG/JPG buffer (queued with a 500 ms end-to-start gap).
    screenshot() {
      if (!password) return Promise.reject(new Error('screenshot requires the device dev --password'));
      return defaultQueue.run(qkey, 'screenshot', captureScreenshot);
    },

    // What is in front right now: { id, name, type, version, uiLocation, home }. See parseActiveApp.
    async activeApp() {
      const { status, text } = await ecpGet('/query/active-app');
      if (status !== 200) throw new Error(`active-app HTTP ${status}`);
      return parseActiveApp(text);
    },

    // True on any Home shape (never keyed on firmware version).
    async isHome() {
      return (await this.activeApp()).home;
    },

    // Low-level escape hatches (used by sgnodes.js for the query endpoints).
    ecpGet,
    ecpPost,
    base,
  };
}

// Parse a /query/media-player XML response → { state, position, duration }. Pure (testable).
// Roku states include: close, startup, buffer, play, pause, finished, error.
function parseMediaPlayer(xml) {
  const text = String(xml || '');
  const state = (text.match(/<player\b[^>]*\bstate="([^"]*)"/i) || [])[1] || 'none';
  const position = (text.match(/<position>\s*(\d+)/i) || [])[1];
  const duration = (text.match(/<duration>\s*(\d+)/i) || [])[1];
  return { state, position: position ? Number(position) : null, duration: duration ? Number(duration) : null };
}

// Parse a /query/active-app XML response → { id, name, type, version, uiLocation, home }. Pure (testable).
// Home is recognised by shape, never by firmware: a bare `<app>Roku</app>` (idle), the transient
// `id="native-ui"` seen right after a Home press, and the Dynamic Menu (`type="home"`). All three occur on one
// firmware. Anything else (dev channel, an installed channel) is not Home.
function parseActiveApp(xml) {
  const m = String(xml || '').match(/<app\b([^>]*?)(?:\/>|>([^<]*)<\/app>)/i);
  if (!m) return { id: null, name: null, type: null, version: null, uiLocation: null, home: false };
  const attr = (n) => (m[1].match(new RegExp(`\\b${n}="([^"]*)"`, 'i')) || [])[1] || null;
  const id = attr('id');
  const type = attr('type');
  const name = (m[2] || '').trim() || null;
  const home = type === 'home' || id === 'native-ui' || (id === null && name === 'Roku');
  return { id, name, type, version: attr('version'), uiLocation: attr('ui-location'), home };
}

module.exports = { createDevice, parseActiveApp, sniffImageExt, buildDigestHeader, parseChallenge, multipart, parseMediaPlayer };
