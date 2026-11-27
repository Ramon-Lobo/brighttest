// Pure helpers for the Network details pane (STUDIO-NETD-T2; design studio-ux-panels.md 5.1-5.3). No DOM.

export const SIDE_MIN_WIDTH = 720      // panel width from which the split is side by side
export const RENDER_MAX = 256 * 1024   // text rendered at once
export const PRETTY_MAX = 2 * 1024 * 1024
export const HEX_BYTES = 512
export const NET_KEY = 'bt.studio.net'
export const DETAIL_MIN_SIDE = 280     // px
export const DETAIL_MIN_STACKED = 160  // px
export const LIST_MIN_PX = 160

// side by side when wide, stacked below; `pref` ('side' | 'stacked' | null) overrides.
export function pickOrient(width, pref) {
  if (pref === 'side' || pref === 'stacked') return pref
  return width >= SIDE_MIN_WIDTH ? 'side' : 'stacked'
}

// Remembered split: { v: 1, orient: 'side'|'stacked'|null, size: percent of the list }.
export function readPrefs(text) {
  try {
    const o = JSON.parse(text)
    if (!o || o.v !== 1) throw new Error('v')
    return { orient: o.orient === 'side' || o.orient === 'stacked' ? o.orient : null, size: Number.isFinite(o.size) ? Math.min(90, Math.max(10, o.size)) : 50 }
  } catch { return { orient: null, size: 50 } }
}
export function writePrefs(p) { return JSON.stringify({ v: 1, orient: p.orient || null, size: Math.round(p.size * 10) / 10 }) }

export function formatBytes(n) {
  if (n == null || !Number.isFinite(n)) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

// Next/previous row id for Up/Down in the list. Moving off either end stays put; nothing selected picks the first (Down)
// or the last (Up).
export function stepSelection(ids, current, dir) {
  if (!ids.length) return null
  const i = ids.indexOf(current)
  if (i < 0) return dir > 0 ? ids[0] : ids[ids.length - 1]
  return ids[Math.min(ids.length - 1, Math.max(0, i + dir))]
}

// HAR membership line for the General block (null when the entry is in the export).
export function notInHarText(d) {
  if (!d) return null
  if (d.inHar) return null
  if (d.status == null && !d.error && !d.synthetic) return 'pending'
  return 'Not in HAR export: brighttest answered this request itself'
}

export function redactionText(d) { return d && d.raw ? 'raw: secrets shown' : 'redacted' }

export function statusLine(d) {
  if (!d) return ''
  if (d.status == null) return d.error ? `error: ${d.error}` : 'pending'
  return `${d.status}${d.statusText ? ' ' + d.statusText : ''}`
}

// Rows of the General block as [label, value] pairs, empty values dropped.
export function generalRows(d, row) {
  if (!d) return []
  const t = d.timings || {}
  const reqB = d.request && d.request.body ? d.request.body.bytes : null
  const resB = d.response && d.response.body ? d.response.body.bytes : null
  const pairs = [
    ['Method', d.method], ['URL', d.url], ['Status', statusLine(d)], ['Source', d.source], ['Rule', d.rule],
    ['Error', d.error], ['Wait', t.wait != null ? `${t.wait} ms` : ''], ['Receive', t.receive != null ? `${t.receive} ms` : ''],
    ['Total', t.total != null ? `${t.total} ms` : ''], ['Request size', reqB != null ? formatBytes(reqB) : ''],
    ['Response size', resB != null ? formatBytes(resB) : (row && row.bytes != null ? formatBytes(row.bytes) : '')],
  ]
  return pairs.filter(([, v]) => v !== '' && v != null)
}

export function headersText(h) { return Object.entries(h || {}).map(([k, v]) => `${k}: ${v}`).join('\n') }

// ---- body text -------------------------------------------------------------------------------------------------

// Decode a base64 string to a Uint8Array (browser atob; Node has it too).
export function b64bytes(b64) {
  const s = atob(String(b64 || ''))
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

// Hex dump of the first `max` bytes of a base64 body: 16 bytes a line, offset, hex, ASCII.
export function hexDump(b64, max = HEX_BYTES) {
  const b = b64bytes(b64.slice(0, Math.ceil((max * 4) / 3) + 4)).subarray(0, max)
  const lines = []
  for (let i = 0; i < b.length; i += 16) {
    const c = Array.from(b.subarray(i, i + 16))
    const hex = c.map((x) => x.toString(16).padStart(2, '0')).join(' ').padEnd(47, ' ')
    const asc = c.map((x) => (x >= 32 && x < 127 ? String.fromCharCode(x) : '.')).join('')
    lines.push(`${i.toString(16).padStart(6, '0')}  ${hex}  ${asc}`)
  }
  return lines.join('\n')
}

// Parsed JSON for Pretty, or null when the text is not JSON (or too big to parse).
export function tryParseJson(text) {
  if (typeof text !== 'string' || text.length > PRETTY_MAX) return { ok: false }
  try { return { ok: true, value: JSON.parse(text) } } catch { return { ok: false } }
}

// The text a body shows in a mode. `view` is the server's body view ({kind, text, ...}). Returns { text, pretty }
// where pretty says the Pretty form was produced (so the viewer can colour it and offer the toggle).
export function bodyText(view, mode) {
  if (!view || view.text == null || view.encoding === 'base64') return { text: '', pretty: false, canPretty: false }
  const canPretty = view.kind === 'json' && !view.truncated && view.text.length <= PRETTY_MAX && tryParseJson(view.text).ok
  if (mode === 'pretty' && canPretty) return { text: JSON.stringify(tryParseJson(view.text).value, null, 2), pretty: true, canPretty }
  return { text: view.text, pretty: false, canPretty }
}

// Cut for rendering: at most RENDER_MAX characters unless `all`.
export function renderSlice(text, all) {
  if (all || text.length <= RENDER_MAX) return { text, cut: false }
  return { text: text.slice(0, RENDER_MAX), cut: true }
}

// The notice(s) for a body view, [] when nothing was cut or missing.
export function bodyNotices(view) {
  if (!view) return []
  const out = []
  if (view.kind === 'none') {
    if (view.reason === 'too-large') out.push('Request body over 16 MB: not captured')
    else if (view.reason === 'pending') out.push('No response yet')
    else if (view.reason === 'not-captured') out.push(`Response body not captured (${formatBytes(view.bytes)})`)
    else out.push('No body captured')
  }
  if (view.truncated) out.push(`Showing ${formatBytes(view.shownBytes)} of ${formatBytes(view.bytes)} (download for all)`)
  if (view.captureTruncated) out.push('Capture stopped at 32 MB (the app received more)')
  if (view.decodedFrom) out.push(`decoded from ${view.decodedFrom}`)
  return out
}

// ---- search ---------------------------------------------------------------------------------------------------

// Start offsets of every match of `q` in `text` (plain text). Case-insensitive unless `caseSensitive`. Capped.
export function findMatches(text, q, caseSensitive = false, cap = 5000) {
  if (!q) return []
  const hay = caseSensitive ? text : text.toLowerCase()
  const needle = caseSensitive ? q : q.toLowerCase()
  const out = []
  let i = hay.indexOf(needle)
  while (i >= 0 && out.length < cap) { out.push(i); i = hay.indexOf(needle, i + needle.length) }
  return out
}

// Split text into [{ text, hit, cur }] segments around the matches; `cur` marks the current match index.
export function segments(text, starts, qlen, current = -1) {
  if (!starts.length) return [{ text, hit: false, cur: false }]
  const out = []
  let at = 0
  starts.forEach((s, n) => {
    if (s > at) out.push({ text: text.slice(at, s), hit: false, cur: false })
    out.push({ text: text.slice(s, s + qlen), hit: true, cur: n === current })
    at = s + qlen
  })
  if (at < text.length) out.push({ text: text.slice(at), hit: false, cur: false })
  return out
}

export function nextIndex(i, n, dir) {
  if (!n) return -1
  return (((i < 0 ? (dir > 0 ? -1 : 0) : i) + dir) % n + n) % n
}

// Light JSON colouring for pretty text: [{ text, cls }] tokens (key, str, num, lit, plain).
export function jsonTokens(text) {
  const out = []
  const re = /("(?:\\.|[^"\\])*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b/g
  let at = 0
  let m
  while ((m = re.exec(text))) {
    if (m.index > at) out.push({ text: text.slice(at, m.index), cls: 'plain' })
    if (m[1] !== undefined) {
      out.push({ text: m[1], cls: m[2] ? 'key' : 'str' })
      if (m[2]) out.push({ text: m[2], cls: 'plain' })
    } else if (m[3] !== undefined) out.push({ text: m[3], cls: 'num' })
    else out.push({ text: m[4], cls: 'lit' })
    at = m.index + m[0].length
  }
  if (at < text.length) out.push({ text: text.slice(at), cls: 'plain' })
  return out
}

// Query parameters of a URL as [[k, v]]; form bodies the same way.
export function queryPairs(url) {
  try { return [...new URL(url).searchParams.entries()] } catch { return [] }
}
export function formPairs(text, contentType) {
  if (!/x-www-form-urlencoded/i.test(String(contentType || '')) || !text) return []
  try { return [...new URLSearchParams(text).entries()] } catch { return [] }
}

// ---- Copy as cURL and image preview -------------------------------------------------------------------------------

export const CURL_PLACEHOLDER = '<redacted>'
export const IMAGE_MAX = 512 * 1024    // largest image (bytes) previewed inline; bigger ones keep the binary view
const SECRET_HEADERS = /^(authorization|proxy-authorization|cookie|x-api-key|x-auth-token)$/i
const SKIP_HEADERS = /^(host|content-length|connection|accept-encoding|transfer-encoding)$/i
const IMAGE_TYPES = /^image\/(png|jpe?g|gif|webp|bmp|avif)$/i

// Shell single-quote: wrap in '...' and write each embedded ' as '\''.
export function curlQuote(s) { return `'${String(s).replace(/'/g, `'\\''`)}'` }

// A shell command for the call in entry detail `d` (the /api/net/entry shape). Redacted unless the entry itself was
// fetched raw (the show-secrets setting): then Authorization, Cookie and the like become a placeholder, on top of
// what the server already redacted in the URL, headers and body. A body that is binary, cut or not captured is
// left out and said so in a trailing comment.
export function buildCurl(d) {
  if (!d || !d.request) return ''
  const raw = !!d.raw
  const parts = ['curl']
  const method = String(d.method || 'GET').toUpperCase()
  if (method === 'HEAD') parts.push('-I'); else if (method !== 'GET') parts.push('-X', method)
  parts.push(curlQuote(d.url))
  for (const [k, v] of Object.entries(d.request.headers || {})) {
    if (SKIP_HEADERS.test(k)) continue
    parts.push('-H', curlQuote(`${k}: ${!raw && SECRET_HEADERS.test(k) ? CURL_PLACEHOLDER : v}`))
  }
  const b = d.request.body
  let note = ''
  if (b && b.kind !== 'empty' && b.kind !== 'none') {
    if (b.encoding === 'base64') note = 'binary request body not included'
    else if (b.truncated) note = 'request body was cut and is not included'
    else if (b.text) parts.push('--data-raw', curlQuote(b.text))
  } else if (b && b.kind === 'none') note = 'request body not captured'
  return parts.join(' ') + (note ? `\n# ${note}` : '')
}

// data: URL for an image response small enough to preview, else null (the binary view shows).
export function imagePreview(view, contentType) {
  const type = String(contentType || '').split(';')[0].trim().toLowerCase()
  if (!view || view.kind !== 'binary' || view.encoding !== 'base64' || view.truncated || !IMAGE_TYPES.test(type)) return null
  if (!(view.bytes <= IMAGE_MAX) || typeof view.text !== 'string') return null
  return `data:${type};base64,${view.text}`
}

// Tree rows leaf classifier for a JSON body: plain values only (never node links or markers).
export function jsonLeaf(v) { return { branch: false, kind: 'value', value: v, type: v === null ? 'null' : typeof v, editable: false } }

// The value to show as a tree, or null when the text is not a JSON object or array.
export function jsonTreeValue(view) {
  if (!view || view.kind !== 'json' || view.truncated || typeof view.text !== 'string') return null
  const p = tryParseJson(view.text)
  return p.ok && p.value !== null && typeof p.value === 'object' ? p.value : null
}
