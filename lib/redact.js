'use strict';
// Shared, pure redactor for text that leaves the machine (issue reports; design: issue-reporting-skill 4.2, 6; ADR 0054).
// Rule-based detectors with stable numbered placeholders, a verify pass that re-detects (reporting kind and line only,
// never the value), and a fingerprint. No I/O, no network; Node core only. Contexts come from lib/redact-sources.js.
//
// Guarantees: idempotent (redact(redact(x)) === redact(x)); line count preserved; the original-to-placeholder mapping
// lives in a per-call state object and is never returned or written.
const crypto = require('crypto');
const { redactPathsWith } = require('./assess');
const { stripHostPasswords } = require('./device-lease');

// Same shapes as lib/e2e/appstate.js SENSITIVE_SEG and lib/instrument/net-rules.js SENSITIVE_HEADER.
const SENSITIVE_SEG = /token|secret|password|passwd|session|auth|cookie|apikey|api_key|credential/i;
const SENSITIVE_QUERY = /^(sig|signature|key|code)$/i;
const HEADER_NAMES = 'Set-Cookie|Proxy-Authorization|Authorization|Cookie|X-Api-Key|x-roku-reserved-[\\w-]*';

// Hosts that stay readable in an issue. A subdomain of a kept host is kept too.
const KEEP_HOSTS = ['localhost', 'github.com', 'raw.githubusercontent.com', 'npmjs.com', 'registry.npmjs.org', 'developer.roku.com', 'sdkdocs-archive.roku.com', 'nodejs.org'];
const KEEP_IPV4 = new Set(['127.0.0.1', '0.0.0.0', '255.255.255.255']);
const FILE_EXTS = new Set(['brs', 'brsm', 'xml', 'js', 'mjs', 'cjs', 'json', 'ts', 'md', 'txt', 'log', 'svelte', 'png', 'jpg', 'zip', 'yml', 'yaml', 'bs', 'html', 'css', 'map', 'sh', 'env', 'toml', 'lock']);
const BUNDLE_TLDS = 'com|net|org|io|tv|co|uk|de|fr|es|it|nl|br|ca|au|jp';

// Common or short words that must never become deny terms (a deny term masks every occurrence).
const STOP_WORDS = new Set(['app', 'apps', 'test', 'tests', 'roku', 'main', 'source', 'src', 'channel', 'brighttest', 'example', 'sample', 'demo', 'user', 'users', 'admin', 'root', 'home', 'project', 'localhost', 'host', 'local', 'node', 'npm', 'git', 'github', 'master', 'build', 'dist', 'lib', 'bin', 'docs', 'title', 'name', 'version', 'true', 'false', 'null', 'undefined', 'unknown', 'default', 'screen', 'video', 'player', 'tv', 'dev', 'prod', 'staging', 'beta', 'alpha', 'release', 'debug']);

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const safeName = (s) => String(s).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 64) || 'x';
const normTerm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '');

// ---- literal variants (case kept, URL-encoded, base64 at the three alignments) -----------------
function b64Variants(str) {
  const buf = Buffer.from(String(str), 'utf8');
  const out = [];
  for (let off = 0; off < 3; off++) {
    const enc = Buffer.concat([Buffer.alloc(off), buf]).toString('base64').replace(/=+$/, '');
    const start = [0, 2, 3][off];
    const rem = (off + buf.length) % 3;
    const v = enc.slice(start, rem ? enc.length - 1 : enc.length);
    if (v.length >= 8) out.push(v);
  }
  return out;
}
function literalVariants(value) {
  const v = String(value);
  const set = new Set([v]);
  try { const u = encodeURIComponent(v); if (u !== v) set.add(u); } catch { /* lone surrogate */ }
  for (const b of b64Variants(v)) set.add(b);
  return [...set].sort((a, b) => b.length - a.length);
}
// RegExps for a value: the literal and URL-encoded forms exactly, base64 forms with the trailing partial character and
// padding (which also carry bits of the value) swallowed. caseless: match the literal and encoded forms ignoring case.
function variantRegexes(value, caseless) {
  const v = String(value);
  const out = [];
  const plain = new Set([v]);
  try { const u = encodeURIComponent(v); if (u !== v) plain.add(u); } catch { /* lone surrogate */ }
  for (const p of [...plain].sort((a, b) => b.length - a.length)) out.push(new RegExp(esc(p), caseless ? 'gi' : 'g'));
  for (const b of b64Variants(v)) out.push(new RegExp(`${esc(b)}[A-Za-z0-9+/]?={0,2}`, 'g'));
  return out;
}

// ---- per-call state: the placeholder allocator -------------------------------------------------
function newState() { return { maps: new Map() }; }
function alloc(state, kind, key) {
  let m = state.maps.get(kind);
  if (!m) { m = new Map(); state.maps.set(kind, m); }
  if (!m.has(key)) m.set(key, m.size + 1);
  return m.get(key);
}

// ---- context -----------------------------------------------------------------------------------
// knownSecrets: [{ name, value, as? }]  as 'ip' | 'host' allocates <ip-N> / <host-N> instead of <secret:NAME>
// denyTerms: string[]  (stop words and terms under 3 characters are dropped; the dropped ones are in ctx.skipped)
// projectRoots: absolute project roots; homeDirs: absolute home directories (literal, any separator style)
// disable: detector kinds to switch off (test only: proves the survivor guard bites)
function createContext(opts = {}) {
  const skipped = [];
  const terms = [];
  const seen = new Set();
  for (const t of opts.denyTerms || []) {
    const raw = String(t || '').trim();
    const n = normTerm(raw);
    if (!n) continue;
    if (n.length < 3 || STOP_WORDS.has(n)) { skipped.push(raw.length > 3 ? `${raw[0]}…` : '…'); continue; }
    if (seen.has(n)) continue;
    seen.add(n);
    terms.push(raw);
  }
  const known = [];
  for (const k of opts.knownSecrets || []) {
    if (!k || k.value == null || String(k.value).length < 3) continue;
    known.push({ name: safeName(k.name || 'secret'), value: String(k.value), as: k.as || null });
  }
  return {
    knownSecrets: known,
    denyTerms: terms,
    skipped,
    projectRoots: (opts.projectRoots || []).filter(Boolean),
    homeDirs: (opts.homeDirs || []).filter(Boolean),
    keepHosts: [...KEEP_HOSTS, ...(opts.keepHosts || [])].map((h) => String(h).toLowerCase()),
    ci: opts.ci != null ? !!opts.ci : process.platform === 'win32',
    disable: new Set(opts.disable || []),
    _compiled: null,
  };
}
function compile(ctx) {
  if (ctx._compiled) return ctx._compiled;
  const knownRes = [];
  for (const k of ctx.knownSecrets) for (const re of variantRegexes(k.value, false)) knownRes.push({ k, re });
  knownRes.sort((a, b) => b.re.source.length - a.re.source.length);
  const denyRes = ctx.denyTerms.map((t) => {
    const words = String(t).split(/[^A-Za-z0-9]+/).filter(Boolean);
    const sep = '[\\s._-]*';
    const body = words.map(esc).join(sep);
    const n = normTerm(t);
    // Long terms match as substrings (ExamplecorpTV, examplecorp_prod); short ones need non-alphanumeric edges.
    const wrap = n.length >= 6 ? body : `(?<![A-Za-z0-9])${body}(?![A-Za-z0-9])`;
    const res = [new RegExp(wrap, 'gi')];
    // URL-encoded and base64 forms of the plain term (and of the words joined with a space or nothing).
    const seenRe = new Set([t, words.join(' '), words.join('')].map(esc)); // plain forms are covered (with edges) by `wrap`
    for (const form of [t, words.join(' '), words.join('')]) {
      for (const re of variantRegexes(form, true)) if (!seenRe.has(re.source)) { seenRe.add(re.source); res.push(re); }
    }
    return { n, res };
  });
  const rootRes = [];
  for (const r of ctx.projectRoots) {
    const norm = String(r).replace(/\\/g, '/').replace(/\/+$/, '');
    if (norm.length < 2) continue;
    const pat = norm.split('/').map(esc).join('[\\\\/]');
    rootRes.push(new RegExp(`(?<![\\w.:])${pat}${PATH_REST}`, ctx.ci ? 'gi' : 'g'));
  }
  const homeRes = [];
  for (const h of ctx.homeDirs) {
    const norm = String(h).replace(/\\/g, '/').replace(/\/+$/, '');
    if (norm.length < 2) continue;
    homeRes.push(new RegExp(`(?<![\\w.:])${norm.split('/').map(esc).join('[\\\\/]')}${PATH_REST}`, ctx.ci ? 'gi' : 'g'));
  }
  ctx._compiled = { knownRes, denyRes, rootRes, homeRes };
  return ctx._compiled;
}

// ---- detectors ---------------------------------------------------------------------------------
// A path tail: folders may contain spaces (as in lib/assess.js PATH_RE), the last segment may not; ':' ends it so that
// file:line references keep their relative path.
const PATH_REST = '((?:[\\\\/][^\\\\/:\'"`()<>\\r\\n]+(?=[\\\\/]))*(?:[\\\\/][^\\s\\\\/:\'"`()<>]+)?)';
const lastSeg = (rest) => { const p = String(rest).replace(/\\/g, '/').split('/').filter(Boolean); return p.length ? p[p.length - 1] : ''; };
const isPlaceholderStart = (v) => /^(<|\*\*\*)/.test(v);

function preserveLines(block, replacement) {
  const n = (block.match(/\n/g) || []).length;
  return replacement + '\n'.repeat(n);
}

const PACKAGE_SPEC = /(?<![\w@.\/-])@[a-z0-9][a-z0-9_-]{0,213}\/[a-z0-9][a-z0-9._-]{0,213}(?![\w-])/g;

const DETECTORS = [
  { kind: 'known-secret', run(text, st, ctx) {
    const { knownRes } = compile(ctx);
    let out = text;
    for (const { k, re } of knownRes) {
      re.lastIndex = 0;
      out = out.replace(re, (m) => {
        if (k.as === 'ip') return `<ip-${alloc(st, 'ip', k.value)}>`;
        if (k.as === 'host') return `<host-${alloc(st, 'host', k.value.toLowerCase())}>`;
        return `<secret:${k.name}>`;
      });
    }
    return out;
  } },
  { kind: 'private-key', run(text) {
    return text
      .replace(/-----BEGIN ([A-Z ]*)PRIVATE KEY-----[\s\S]*?-----END \1PRIVATE KEY-----/g, (m) => preserveLines(m, '<private-key>'))
      .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*$/g, (m) => preserveLines(m, '<private-key>'));
  } },
  { kind: 'auth-header', run(text) {
    const val = (v) => (v.trim() === '<redacted:header>' ? v : '<redacted:header>');
    return text
      .replace(new RegExp(`("name"\\s*:\\s*"(?:${HEADER_NAMES})"\\s*,\\s*"value"\\s*:\\s*")([^"\\r\\n]*)(")`, 'gi'), (m, a, v, c) => a + val(v) + c)
      .replace(new RegExp(`((?<![\\w-])(?:${HEADER_NAMES})["']?[ \\t]*:[ \\t]*["']?)([^"'\\r\\n]*)`, 'gi'), (m, a, v) => (v === '' ? m : a + val(v)));
  } },
  { kind: 'cli-secret', run(text) {
    return text
      .replace(/(--pass(?:word)?[ \t]+)(?!\*\*\*)(\S+)/g, '$1***')
      .replace(/(--pass(?:word)?=)(?!\*\*\*)(\S+)/g, '$1***')
      .replace(/(--host[ =])(\S+)/g, (m, a, v) => a + stripHostPasswords(v))
      .replace(/(\bBRIGHTTEST_LEASE=)(?!\*\*\*)(\S+)/g, '$1***')
      .replace(/(\s-u[ \t]+)(?!\*\*\*)([^\s:]+:\S+)/g, '$1***');
  } },
  { kind: 'kv-secret', run(text) {
    const keyRe = (k) => SENSITIVE_SEG.test(k);
    return text
      // "key": "value" and "key": value (JSON)
      .replace(/("([\w.-]+)"\s*:\s*)("([^"\r\n]*)"|[^\s,}\]"<]+)/g, (m, pre, key, val, inner) => {
        if (!keyRe(key)) return m;
        const v = inner !== undefined ? inner : val;
        if (isPlaceholderStart(v)) return m;
        return `${pre}${inner !== undefined ? '"' : ''}<redacted:${safeName(key)}>${inner !== undefined ? '"' : ''}`;
      })
      // key: value and key=value (logs, .env, query strings, argv)
      .replace(/(?<![\w.<-])([\w.-]+)(["']?)([ \t]*[:=][ \t]*)(["']?)([^\s"',;&<>}]+)/g, (m, key, q1, mid, q2, v) => {
        if (!/[A-Za-z]/.test(key) || !keyRe(key) || isPlaceholderStart(v) || /^https?:\/\//i.test(v) && key.toLowerCase() === 'url') return m;
        return `${key}${q1}${mid}${q2}<redacted:${safeName(key)}>`;
      })
      // <key>value</key>
      .replace(/<([\w.-]+)>([^<\r\n]+)<\/\1>/g, (m, key, v) => (keyRe(key) && !isPlaceholderStart(v.trim()) ? `<${key}><redacted:${safeName(key)}></${key}>` : m));
  } },
  { kind: 'jwt', run(text) { return text.replace(/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g, '<token>'); } },
  { kind: 'bearer', run(text) { return text.replace(/\bBearer\s+(?!<)[A-Za-z0-9._~+/=-]{6,}/g, 'Bearer <token>'); } },
  { kind: 'hex32', run(text) { return text.replace(/(?<![0-9a-zA-Z])[0-9a-fA-F]{32}(?![0-9a-zA-Z])/g, '<hex32>'); } },
  { kind: 'high-entropy', run(text) {
    return text.replace(/(?<![A-Za-z0-9+/_=-])[A-Za-z0-9+/_-]{32,}={0,2}(?![A-Za-z0-9+/_=-])/g, (m) => {
      const body = m.replace(/=+$/, '');
      const classes = [/[a-z]/, /[A-Z]/, /[0-9]/].filter((r) => r.test(body)).length;
      if (classes < 3 || (body.match(/\//g) || []).length >= 3) return m;
      return entropy(body) >= 4.2 ? '<token>' : m;
    });
  } },
  { kind: 'url-userinfo', run(text) {
    return text
      .replace(/(\b[a-z][a-z0-9+.-]{0,31}:\/\/)(?!<)[^/\s:@]+:[^/\s@]*@/gi, '$1<user>@')
      .replace(/(\b[a-z][a-z0-9+.-]{0,31}:\/\/)(?!<)[^/\s:@]+@/gi, '$1<user>@');
  } },
  { kind: 'url-query', run(text) {
    return text.replace(/([?&])([A-Za-z0-9_.-]+)=([^&\s#"'<>]*)/g, (m, sep, name, v) => {
      if (!(SENSITIVE_SEG.test(name) || SENSITIVE_QUERY.test(name))) return m;
      if (v === '' || v.startsWith('<')) return m;
      return `${sep}${name}=<redacted>`;
    });
  } },
  { kind: 'email', run(text) {
    return text.replace(/(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g, '<email>');
  } },
  { kind: 'device-id', run(text) {
    const KEYS = 'serial-number|device-id|advertising-id|keyed-developer-id|wifi-mac|ethernet-mac|udn|vendor-uuid';
    const ph = (k) => (/^serial/i.test(k) ? '<serial>' : /mac$/i.test(k) ? '<mac>' : '<device-id>');
    return text
      .replace(new RegExp(`<(${KEYS})>([^<\\r\\n]+)</\\1>`, 'gi'), (m, k, v) => `<${k}>${ph(k)}</${k}>`)
      .replace(new RegExp(`((?<![\\w-])(${KEYS})["']?[ \\t]*[:=][ \\t]*["']?)([^\\s"',}<]+)`, 'gi'), (m, a, k) => a + ph(k))
      // free-form: "serial: v", "Serial Number: v", "serial_no=v", "serialnumber v" (value needs 6+ chars with a digit, so prose stays)
      .replace(/((?<![\w-])serial(?:[ _-]?(?:number|no\.?))?["']?(?:[ \t]*[:=][ \t]*|[ \t]+)["']?)(?=[A-Za-z0-9-]*\d)[A-Za-z0-9-]{6,}(?![\w-])/gi, '$1<serial>')
      .replace(/(?<![0-9A-Fa-f:-])(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}(?![0-9A-Fa-f:-])/g, '<mac>');
  } },
  { kind: 'ipv4', run(text, st) {
    return text.replace(/(?<![\w.@-])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\w-]|\.\d)/g, (m, a, b, c, d, off, whole) => {
      if ([a, b, c, d].some((o) => Number(o) > 255)) return m;
      if (KEEP_IPV4.has(m)) return m;
      if (/(?:version|firmware|ver|build|release|software|v)[\s:="']*$/i.test(whole.slice(Math.max(0, off - 16), off))) return m;
      return `<ip-${alloc(st, 'ip', m)}>`;
    });
  } },
  { kind: 'ipv6', run(text, st) {
    const H = '[0-9A-Fa-f]{1,4}';
    const re = new RegExp(`(?<![\\w:.])(?:(?:${H}:){7}${H}|(?:${H}:){1,7}:(?:${H}(?::${H}){0,6})?|::(?:${H}(?::${H}){0,6}))(?![\\w:])`, 'g');
    return text.replace(re, (m) => (m === '::1' || m === '::' ? m : `<ip6-${alloc(st, 'ip6', m.toLowerCase())}>`));
  } },
  { kind: 'host', run(text, st, ctx) {
    const keep = (h) => { const l = h.toLowerCase(); return KEEP_IPV4.has(l) || ctx.keepHosts.some((k) => l === k || l.endsWith('.' + k)); };
    const ph = (h) => `<host-${alloc(st, 'host', h.toLowerCase())}>`;
    return text
      .replace(/(\b[a-z][a-z0-9+.-]{0,31}:\/\/(?:<user>@)?)([^\s/:@?#"'<>\\]+)/gi, (m, pre, h) => (keep(h) ? m : pre + ph(h)))
      .replace(/(?<![\w.@/:<-])((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}):(\d{2,5})(?![\w])/g, (m, h, port) => {
        const tld = h.split('.').pop().toLowerCase();
        if (FILE_EXTS.has(tld) || keep(h)) return m;
        return `${ph(h)}:${port}`;
      })
      .replace(/(?<![\w.@/<-])((?:[A-Za-z0-9-]+\.)*[A-Za-z0-9-]+\.local)(?![\w-])/gi, (m, h) => ph(h));
  } },
  { kind: 'bundle-id', run(text) {
    return text.replace(new RegExp(`(?<![\\w.@/<>-])(?:${BUNDLE_TLDS})\\.[A-Za-z][\\w-]*(?:\\.[A-Za-z][\\w-]*)+(?![\\w-])`, 'g'), (m) => (FILE_EXTS.has(m.split('.').pop().toLowerCase()) ? m : '<bundle-id>'));
  } },
  { kind: 'path', run(text, st, ctx) {
    const { rootRes, homeRes } = compile(ctx);
    let out = text;
    // project-relative first, so a project under the home directory keeps its folders
    for (const re of rootRes) out = out.replace(re, (m, rest) => `<project>${String(rest).replace(/\\/g, '/')}`);
    for (const re of homeRes) out = out.replace(re, (m, rest) => (lastSeg(rest) ? `<~>/${lastSeg(rest)}` : '<~>'));
    // any other home directory: /Users/<n>, /home/<n>, /root, C:\Users\<n>, ~/...
    out = out.replace(new RegExp(`(?<![\\w.<>-])[A-Za-z]:[\\\\/]Users[\\\\/][^\\\\/:'"<>\\r\\n]+${PATH_REST}`, 'g'), (m, rest) => (lastSeg(rest) ? `<~>/${lastSeg(rest)}` : '<~>'));
    out = out.replace(new RegExp(`(?<![\\w.<>-])[\\\\/](?:Users|home)[\\\\/][^\\\\/\\s:'"<>]+${PATH_REST}`, 'g'), (m, rest) => (lastSeg(rest) ? `<~>/${lastSeg(rest)}` : '<~>'));
    out = out.replace(new RegExp(`(?<![\\w.<>-])/root(?=[\\\\/])${PATH_REST}`, 'g'), (m, rest) => (lastSeg(rest) ? `<~>/${lastSeg(rest)}` : '<~>'));
    out = out.replace(new RegExp(`(?<![\\w.<>-])~(?=[\\\\/])${PATH_REST}`, 'g'), (m, rest) => (lastSeg(rest) ? `<~>/${lastSeg(rest)}` : '<~>'));
    out = redactPathsWith(out, [], ctx.ci);
    return out.replace(/<~>/g, '~');
  } },
  { kind: 'deny-term', run(text, st, ctx) {
    const { denyRes } = compile(ctx);
    const mask = (seg) => {
      let out = seg;
      for (const { n, res } of denyRes) for (const re of res) { re.lastIndex = 0; out = out.replace(re, () => `<name-${alloc(st, 'name', n)}>`); }
      return out;
    };
    if (!denyRes.length) return text;
    // An npm package spec (@scope/name, scope without dots) is a public name, not an identity: keep it as written. Hosts,
    // tokens, emails and paths inside it were already handled by the detectors above.
    let out = '', last = 0;
    for (const m of text.matchAll(PACKAGE_SPEC)) {
      out += mask(text.slice(last, m.index)) + m[0];
      last = m.index + m[0].length;
    }
    return out + mask(text.slice(last));
  } },
];
const DETECTOR_KINDS = DETECTORS.map((d) => d.kind);

function entropy(s) {
  const f = new Map();
  for (const ch of s) f.set(ch, (f.get(ch) || 0) + 1);
  let h = 0;
  for (const n of f.values()) { const p = n / s.length; h -= p * Math.log2(p); }
  return h;
}

// ---- public API --------------------------------------------------------------------------------
function applyAll(text, st, ctx) {
  let out = String(text == null ? '' : text);
  for (const d of DETECTORS) if (!ctx.disable.has(d.kind)) out = d.run(out, st, ctx);
  return out;
}

// inputs: string[] or [{ name, text }]. One state across all inputs, so the same value gets the same placeholder in
// every file. Returns outputs in order (same shape as the inputs: strings, or { name, text }).
function redact(inputs, ctx) {
  const st = newState();
  const list = Array.isArray(inputs) ? inputs : [inputs];
  const outputs = list.map((i) => (i && typeof i === 'object' ? { ...i, text: applyAll(i.text, st, ctx) } : applyAll(i, st, ctx)));
  return Array.isArray(inputs) ? outputs : outputs[0];
}

// verify: re-detect with a fresh state and every detector (the context's disable list is ignored on purpose). A
// detector that would still change a line is a leak: { kind, line (1-based), name? }. Never returns the value.
function verify(text, ctx) {
  const src = String(text == null ? '' : text);
  const lines = src.split('\n');
  const leaks = [];
  const seen = new Set();
  const full = { ...ctx, disable: new Set(), _compiled: ctx._compiled };
  for (const d of DETECTORS) {
    const out = d.run(src, newState(), full);
    if (out === src) continue;
    const outLines = out.split('\n');
    const same = outLines.length === lines.length;
    for (let i = 0; i < lines.length; i++) {
      if (same && outLines[i] === lines[i]) continue;
      const key = `${d.kind}:${i + 1}`;
      if (!seen.has(key)) { seen.add(key); leaks.push({ kind: d.kind, line: i + 1 }); }
    }
  }
  return leaks.sort((a, b) => a.line - b.line);
}

// fingerprint: bt-<8 hex> of the area plus a normalised first line (digits, quoted strings, paths, placeholders collapsed).
function normalizeLine(line) {
  return String(line || '').split('\n')[0]
    .replace(/<[^<>\s]+>/g, '<>')
    .replace(/(["'`])(?:(?!\1).)*\1/g, '"S"')
    .replace(/(?:[A-Za-z]:)?[\\/][\w.\\/ -]*[\w.]/g, 'P')
    .replace(/\d+/g, 'N')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}
function fingerprint(area, line) {
  const h = crypto.createHash('sha256').update(`${String(area || '').trim().toLowerCase()}\n${normalizeLine(line)}`).digest('hex');
  return `bt-${h.slice(0, 8)}`;
}

module.exports = { createContext, redact, verify, fingerprint, normalizeLine, DETECTOR_KINDS, STOP_WORDS, KEEP_HOSTS, SENSITIVE_SEG, literalVariants };
