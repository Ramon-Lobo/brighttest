'use strict';
const crypto = require('crypto');

// ECP device driver for the e2e lane. Everything the runner does TO a device goes through here:
// launch/deep-link, keypresses (incl. text via Lit_), device-info, and dev screenshots. Uses only the
// global fetch + node:crypto (the dev screenshot endpoint needs HTTP Digest auth, which fetch has no
// built-in support for), matching brighttest's zero-dependency ethos.
//
// Two HTTP surfaces are involved:
//   • ECP    — http://<host>:8060/…  (no auth) — launch, keypress, query/*
//   • Dev UI — http://<host>/…       (Digest auth as rokudev:<password>) — plugin_inspect + /pkgs/*.jpg

const ECP_PORT = 8060;

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

// A device handle bound to a host (+ optional dev password for screenshots).
function createDevice({ host, password }) {
  if (!host) throw new Error('createDevice requires a host');
  const base = `http://${host}:${ECP_PORT}`;

  async function ecpGet(path) {
    const r = await fetch(`${base}${path}`);
    return { status: r.status, text: await r.text() };
  }
  async function ecpPost(path) {
    const r = await fetch(`${base}${path}`, { method: 'POST' });
    return { status: r.status, text: await r.text().catch(() => '') };
  }

  return {
    host,
    hasPassword: !!password,

    async deviceInfo() {
      const { status, text } = await ecpGet('/query/device-info');
      if (status !== 200) throw new Error(`device-info HTTP ${status} (is ${host} a Roku on the LAN?)`);
      const pick = (tag) => (text.match(new RegExp(`<${tag}>([^<]*)`)) || [])[1] || null;
      return {
        model: pick('model-name'),
        firmware: pick('software-version'),
        developerEnabled: pick('developer-enabled') === 'true',
        name: pick('user-device-name'),
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

    // Type text on an on-screen keyboard via Lit_ keypresses (one per character).
    async text(str, gapMs = 60) {
      for (const ch of String(str)) {
        await this.keypress(`Lit_${encodeURIComponent(ch)}`);
        await sleep(gapMs);
      }
    },

    // Capture a dev screenshot to a PNG/JPG buffer. Two-step, both Digest-authed on port 80:
    //   1) POST /plugin_inspect  mysubmit=Screenshot  → generates /pkgs/dev.{jpg,png}
    //   2) GET  that path                              → the image bytes
    async screenshot() {
      if (!password) throw new Error('screenshot requires the device dev --password');
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
      const m = html.match(/["']([^"']*\/pkgs\/dev\.(?:jpg|png))["']/i) || html.match(/(\/pkgs\/dev\.(?:jpg|png))/i);
      const imgPath = m ? m[1] : '/pkgs/dev.jpg';
      const img = await digestFetch(`${dev}${imgPath}`, imgPath, { user, password, method: 'GET' });
      if (img.status >= 400) throw new Error(`screenshot fetch failed (HTTP ${img.status})`);
      const buf = Buffer.from(await img.arrayBuffer());
      const ext = imgPath.toLowerCase().endsWith('.png') ? 'png' : 'jpg';
      return { buffer: buf, ext };
    },

    // Low-level escape hatches (used by sgnodes.js for the query endpoints).
    ecpGet,
    ecpPost,
    base,
  };
}

module.exports = { createDevice, buildDigestHeader, parseChallenge, multipart };
