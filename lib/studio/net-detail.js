'use strict';
const zlib = require('zlib');
const netRules = require('../instrument/net-rules');

// Studio network details (STUDIO-NETD-T1; design studio-ux-panels.md 5.4, ADR 0051). Pure helpers for
// GET /api/net/entry and GET /api/net/body: one proxy entry (proxy.entry(id)) -> the JSON the details view shows, or
// the bytes of one body. Bodies go through netRules.harBody, the same encoder the HAR writer uses, so in redacted mode
// the text and encoding equal the HAR entry's.
const NET_DETAIL_BODY_MAX = 1024 * 1024;       // served per body in /api/net/entry (after redaction)
const NET_DETAIL_DECODE_MAX = 8 * 1024 * 1024; // gzip/deflate/br output cap
const NET_DOWNLOAD_MAX = 32 * 1024 * 1024;     // /api/net/body (the proxy capture cap)

const headerOf = (h, name) => { for (const k of Object.keys(h || {})) if (k.toLowerCase() === name) return String(h[k]); return ''; };

// Cut a string to at most `max` UTF-8 bytes on a character boundary (base64 text: a multiple of 4 characters).
function cutText(text, max, base64) {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= max) return { text, shown: buf.length, truncated: false };
  if (base64) { const n = max - (max % 4); return { text: text.slice(0, n), shown: n, truncated: true }; }
  let n = max;
  while (n > 0 && (buf[n] & 0xc0) === 0x80) n--;
  return { text: buf.subarray(0, n).toString('utf8'), shown: n, truncated: true };
}

// Decode a content-encoded body for display. Returns { buf, from } ; from null when not encoded or not decodable.
function decodeBody(buf, encoding) {
  const enc = String(encoding || '').trim().toLowerCase();
  const opts = { maxOutputLength: NET_DETAIL_DECODE_MAX };
  try {
    if (enc === 'gzip' || enc === 'x-gzip') return { buf: zlib.gunzipSync(buf, opts), from: 'gzip' };
    if (enc === 'deflate') return { buf: zlib.inflateSync(buf, opts), from: 'deflate' };
    if (enc === 'br') return { buf: zlib.brotliDecompressSync(buf, opts), from: 'br' };
  } catch { /* not decodable or over the cap: show the stored bytes */ }
  return { buf, from: null };
}

function bodyView(buf, contentType, red, side, { decodeFrom = '', captureTruncated = false } = {}) {
  if (!buf || !buf.length) return { kind: 'empty', bytes: 0 };
  let shownBuf = buf; let decodedFrom = null;
  if (side === 'res' && decodeFrom) { const d = decodeBody(buf, decodeFrom); shownBuf = d.buf; decodedFrom = d.from; }
  const enc = netRules.harBody(shownBuf, contentType, red, side);
  const base64 = enc.encoding === 'base64';
  const cut = cutText(enc.text, NET_DETAIL_BODY_MAX, base64);
  let kind = base64 ? 'binary' : 'text';
  if (!base64 && /(^|[/+])json\b/i.test(String(contentType || ''))) kind = 'json';
  return {
    kind, text: cut.text, ...(base64 ? { encoding: 'base64' } : {}), bytes: buf.length, shownBytes: cut.shown, truncated: cut.truncated,
    captureTruncated: !!captureTruncated, decodedFrom,
  };
}

// e = proxy.entry(id); red = redactor (ignored when raw).
function entryDetail(e, red, raw) {
  const r = raw ? null : red;
  const reqType = headerOf(e.reqHeaders, 'content-type');
  const resType = headerOf(e.resHeaders, 'content-type');
  const t = e.timings || {};
  let request;
  if (e.reqBodyTooLarge) request = { kind: 'none', reason: 'too-large' };
  else request = bodyView(e.reqBody, reqType, r, 'req');
  let response;
  if (!e.hasResponse) response = { kind: 'none', reason: e.status === null && !e.error ? 'pending' : 'no-response' };
  else if (!e.resBody && e.resBytes > 0) response = { kind: 'none', reason: 'not-captured', bytes: e.resBytes };
  else response = bodyView(e.resBody, resType, r, 'res', { decodeFrom: headerOf(e.resHeaders, 'content-encoding'), captureTruncated: e.resTruncated });
  return {
    id: e.id, method: e.method, url: r ? r.url(e.url) : e.url, raw: !!raw, redacted: !raw, inHar: !e.synthetic && e.hasResponse, synthetic: e.synthetic,
    status: e.status, statusText: e.statusText, source: e.source, rule: e.rule, error: e.error,
    timings: { wait: t.wait || 0, receive: t.receive || 0, total: e.time || 0 },
    request: { headers: r ? r.headers(e.reqHeaders) : e.reqHeaders, contentType: reqType, body: request },
    response: { headers: e.resHeaders ? (r ? r.headers(e.resHeaders) : e.resHeaders) : {}, contentType: resType, body: response },
  };
}

// Bytes of one whole body for download. Returns { buf, contentType, name } or { error, status }.
function bodyDownload(e, side, red, raw) {
  const isReq = side === 'req';
  const buf = isReq ? e.reqBody : e.resBody;
  if (!buf || !buf.length) return { status: 404, error: `no ${isReq ? 'request' : 'response'} body for ${e.id}` };
  if (buf.length > NET_DOWNLOAD_MAX) return { status: 413, error: `body is ${buf.length} bytes (limit ${NET_DOWNLOAD_MAX})` };
  const ct = headerOf(isReq ? e.reqHeaders : e.resHeaders, 'content-type');
  let out = buf; let textual = false;
  if (!raw) {
    const enc = netRules.harBody(buf, ct, red, side);
    out = enc.encoding === 'base64' ? Buffer.from(enc.text, 'base64') : Buffer.from(enc.text, 'utf8');
    textual = enc.encoding !== 'base64';
  } else textual = !buf.includes(0);
  const json = textual && /(^|[/+])json\b/i.test(ct);
  return {
    buf: out, contentType: textual ? (json ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8') : 'application/octet-stream',
    name: `${e.id}-${isReq ? 'request' : 'response'}.${json ? 'json' : textual ? 'txt' : 'bin'}`,
  };
}

module.exports = { entryDetail, bodyDownload, bodyView, cutText, decodeBody, NET_DETAIL_BODY_MAX, NET_DETAIL_DECODE_MAX, NET_DOWNLOAD_MAX };
