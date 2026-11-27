'use strict';
const fs = require('fs');
const path = require('path');

// Network rule model for the instrument hub (design network-interception.md 4.3, D6, D7; NET-N-T4).
// Node core only. No I/O besides optional `file:` bodies (confined to a root) and HAR/rule file loading.
//
// Rule (flat, terse JSON; the same object BTNet_mock / BTNet_fault / a flow's mockHttp step passes):
//   match:     method (string | string[], default any), url (glob, required), reqHeaders {name: glob},
//              reqBody (string = contains | {contains, regex, json: {"$.a.b": value}}), times (positive int)
//   response:  status (default 200), headers {name: value}, body | json | file | bodyBase64, delayMs
//   fault:     fault: "timeout" | "reset" | {kind, status?, holdMs?, partialBytes?}  or  kind: "timeout|reset|status"
//   sequence:  responses: [ <response or fault>, ... ]   consumed one per match, the last one repeating
//   other:     id, passthrough: true (send this match upstream instead of mocking)
// URL glob: matched against scheme://host[:port]/path (a pattern starting with "/" matches the path only).
//   `*` stays within one path segment, `**` crosses segments, `\*` is a literal star. A "?query" part in the
//   pattern lists key=value-glob pairs that must all be present in the request (order-insensitive, extra
//   request keys are allowed). Without a "?query" the request's query is ignored.
// Order (D6): first match wins. Rules added at run time (add) are prepended, newest first, so they override
// config fixtures (addConfig), which keep declaration order. `times: N` stops a rule matching after N hits.

class NetRuleError extends Error {
  constructor(message) { super(message); this.name = 'NetRuleError'; this.code = 'NET_RULE'; }
}

const FAULT_KINDS = ['timeout', 'reset', 'status'];
const PLACEHOLDER_RE = /^<redacted:[^>]*>$/;

// ---------------------------------------------------------------------------------------------------------------
// Glob

// Worst case under the MCP caps (8 KB text, 64 KB: about 18 ms and 148 ms per rule; 100 rules per session).
// Linear-time glob matcher (no regex backtracking, so a hostile pattern cannot hang the process). `*` matches any run
// of characters except `/` (any run when anyChars), `**` any run; `\*` is a literal star; everything else, including
// `?`, is literal. Returns an object with `.test(string)`. Cost is O(pattern * text) with a bounded state set.
function globToRegex(g, anyChars) {
  const toks = []; // a char, or 1 = star (no slash), 2 = any run
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '\\' && g[i + 1] === '*') { toks.push('*'); i++; continue; }
    if (c === '*') {
      if (g[i + 1] === '*') { toks.push(2); while (g[i + 1] === '*') i++; } else toks.push(anyChars ? 2 : 1);
    } else toks.push(c);
  }
  // collapse runs of wildcards: any-run absorbs a neighbouring star
  const t = [];
  for (const k of toks) {
    const prev = t[t.length - 1];
    if (typeof k === 'number' && typeof prev === 'number') { if (k === 2) t[t.length - 1] = 2; continue; }
    t.push(k);
  }
  const m = t.length;
  const test = (str) => {
    let cur = new Uint8Array(m + 1); let nxt = new Uint8Array(m + 1);
    const close = (a) => { for (let j = 0; j < m; j++) if (a[j] && typeof t[j] === 'number') a[j + 1] = 1; };
    cur[0] = 1; close(cur);
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      nxt.fill(0);
      let any = false;
      for (let j = 0; j < m; j++) {
        if (!cur[j]) continue;
        const k = t[j];
        if (k === 2 || (k === 1 && ch !== '/')) { nxt[j] = 1; any = true; } else if (k === ch) { nxt[j + 1] = 1; any = true; }
      }
      if (!any) return false;
      close(nxt);
      const tmp = cur; cur = nxt; nxt = tmp;
    }
    return cur[m] === 1;
  };
  return { test };
}

function splitPattern(p) {
  let q = -1;
  for (let i = 0; i < p.length; i++) {
    if (p[i] === '\\') { i++; continue; }
    if (p[i] === '?') { q = i; break; }
  }
  return q < 0 ? [p, null] : [p.slice(0, q), p.slice(q + 1)];
}

function safeDecode(s) { try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch (e) { return s; } }

function compileUrlPattern(pattern) {
  if (typeof pattern !== 'string' || !pattern) throw new NetRuleError('rule.url must be a non-empty glob string');
  const [pathPart, queryPart] = splitPattern(pattern);
  const origin = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/]*/.exec(pathPart);
  const lowered = origin ? origin[0].toLowerCase() + pathPart.slice(origin[0].length) : pathPart;
  const pathOnly = lowered.startsWith('/');
  const re = globToRegex(lowered, false);
  const queryPreds = [];
  if (queryPart) {
    for (const pair of queryPart.split('&')) {
      if (!pair) continue;
      const eq = pair.indexOf('=');
      const k = safeDecode(eq < 0 ? pair : pair.slice(0, eq));
      const v = eq < 0 ? '*' : safeDecode(pair.slice(eq + 1));
      queryPreds.push({ key: k, re: globToRegex(v, true) });
    }
  }
  return (url) => {
    let u;
    try { u = new URL(url); } catch (e) { return false; }
    const target = pathOnly ? u.pathname : `${u.protocol}//${u.host}${u.pathname}`;
    if (!re.test(target)) return false;
    for (const pr of queryPreds) {
      const vals = u.searchParams.getAll(pr.key);
      if (!vals.some((v) => pr.re.test(v))) return false;
    }
    return true;
  };
}

function urlMatches(pattern, url) { return compileUrlPattern(pattern)(url); }

// ---------------------------------------------------------------------------------------------------------------
// JSON paths ($.a.b, $.a[0].b, $.a[*].b, $.a.*.b)

function parsePath(p) {
  if (typeof p !== 'string' || !p.startsWith('$')) throw new NetRuleError(`JSON path must start with $: ${String(p)}`);
  const segs = [];
  const re = /\.([^.[\]]+)|\[(\d+|\*)\]/g;
  let m; let last = 1;
  while ((m = re.exec(p)) !== null) {
    if (m.index !== last) throw new NetRuleError(`bad JSON path: ${p}`);
    segs.push(m[1] !== undefined ? m[1] : m[2]);
    last = re.lastIndex;
  }
  if (last !== p.length) throw new NetRuleError(`bad JSON path: ${p}`);
  return segs;
}

function jsonGet(value, segs) {
  let cur = [value];
  for (const s of segs) {
    const next = [];
    for (const c of cur) {
      if (Array.isArray(c)) {
        if (s === '*') next.push(...c); else if (/^\d+$/.test(s) && +s < c.length) next.push(c[+s]);
      } else if (c && typeof c === 'object') {
        if (s === '*') next.push(...Object.values(c)); else if (Object.prototype.hasOwnProperty.call(c, s)) next.push(c[s]);
      }
    }
    cur = next;
  }
  return cur;
}

// Replace every value the path selects; returns true when something changed.
function jsonSet(value, segs, fn) {
  if (segs.length === 0) return false;
  let changed = false;
  const walk = (node, i) => {
    const s = segs[i];
    const last = i === segs.length - 1;
    const keys = [];
    if (Array.isArray(node)) {
      if (s === '*') node.forEach((_, k) => keys.push(k)); else if (/^\d+$/.test(s) && +s < node.length) keys.push(+s);
    } else if (node && typeof node === 'object') {
      if (s === '*') keys.push(...Object.keys(node)); else if (Object.prototype.hasOwnProperty.call(node, s)) keys.push(s);
    }
    for (const k of keys) {
      if (last) { node[k] = fn(node[k], s === '*' ? String(k) : s); changed = true; } else walk(node[k], i + 1);
    }
  };
  walk(value, 0);
  return changed;
}

// ---------------------------------------------------------------------------------------------------------------
// Redaction (design 3 "Redaction", D8). Deterministic placeholders so replay matching stays stable.

const SENSITIVE_HEADER = [/^(authorization|proxy-authorization|cookie|set-cookie|x-api-key)$/i, /^x-roku-reserved-/i, /token|secret|key|session/i];
const DEFAULT_QUERY = ['token', 'access_token', 'sig'];

function placeholder(name) { return `<redacted:${String(name).toLowerCase()}>`; }

function makeRedactor(opts = {}) {
  const enabled = opts.enabled !== false;
  const extraHeaders = (opts.headers || []).map((h) => String(h).toLowerCase());
  const queryNames = DEFAULT_QUERY.concat(opts.query || []).map((q) => String(q).toLowerCase());
  const jsonPaths = (opts.jsonPaths || []).map(parsePath);
  const normKey = (k) => String(k).toLowerCase().replace(/[_-]/g, '');
  if (opts.bodyKeys !== undefined && (!Array.isArray(opts.bodyKeys) || !opts.bodyKeys.every((k) => typeof k === 'string'))) {
    throw new NetRuleError('redact.bodyKeys must be an array of strings');
  }
  const bodyKeys = new Set((opts.bodyKeys || []).map(normKey).filter(Boolean)); // opt-in: no default names; [] is off
  const noBom = (t) => (t.charCodeAt(0) === 0xFEFF ? t.slice(1) : t);
  const mark = (_, key) => placeholder(key);
  const warn = typeof opts.warn === 'function' ? opts.warn : null;
  let warned = false;

  const headerSensitive = (name) => extraHeaders.includes(String(name).toLowerCase()) || SENSITIVE_HEADER.some((r) => r.test(name));

  function headers(h) {
    const out = {};
    for (const [k, v] of Object.entries(h || {})) {
      if (enabled && headerSensitive(k)) out[k] = placeholder(k);
      else {
        out[k] = v;
        if (!enabled && warn && !warned && /^authorization$/i.test(k)) {
          warned = true;
          warn('brighttest net: redaction is OFF and an Authorization header would be written unredacted');
        }
      }
    }
    return out;
  }

  // `form`: the string is a form-encoded body, so field names are also checked against bodyKeys. A URL query is not.
  function queryString(qs, form) {
    if (!enabled || !qs) return qs;
    return qs.split('&').map((pair) => {
      const eq = pair.indexOf('=');
      if (eq < 0) return pair;
      const k = safeDecode(pair.slice(0, eq)).toLowerCase();
      return queryNames.includes(k) || (form === true && bodyKeys.has(normKey(k))) ? `${pair.slice(0, eq)}=${encodeURIComponent(placeholder(k))}` : pair;
    }).join('&');
  }

  function url(u) {
    if (!enabled || typeof u !== 'string') return u;
    const hash = u.indexOf('#');
    const base = hash < 0 ? u : u.slice(0, hash);
    const q = base.indexOf('?');
    if (q < 0) return u;
    return `${base.slice(0, q + 1)}${queryString(base.slice(q + 1))}${hash < 0 ? '' : u.slice(hash)}`;
  }

  // One walk for request and response bodies. Order: jsonPaths (at the root, or at every nested object when
  // `nested`), then bodyKeys by name anywhere, then JSON held in string values (an echoed body). Returns true when
  // something changed.
  function scrub(node, nested) {
    let changed = false;
    for (const segs of jsonPaths) if (jsonSet(node, segs, mark)) changed = true;
    // Iterative (explicit stack): a deeply nested body must not overflow the call stack.
    const walk = (root, rootIsRoot) => {
      let any = false;
      const stack = [[root, rootIsRoot]];
      while (stack.length) {
        const [cur, isRoot] = stack.pop();
        if (!isRoot && nested) for (const segs of jsonPaths) if (jsonSet(cur, segs, mark)) any = true;
        for (const k of Object.keys(cur)) {
          const v = cur[k];
          if (!Array.isArray(cur) && bodyKeys.size && bodyKeys.has(normKey(k)) && !(typeof v === 'string' && PLACEHOLDER_RE.test(v))) {
            cur[k] = placeholder(k); any = true; continue;
          }
          if (v && typeof v === 'object') stack.push([v, false]);
          else if (typeof v === 'string' && /^\s*[{[]/.test(v)) {
            let inner;
            try { inner = JSON.parse(noBom(v)); } catch (e) { continue; }
            if (inner && typeof inner === 'object' && walk(inner, false)) { cur[k] = JSON.stringify(inner); any = true; }
          }
        }
      }
      return any;
    };
    if (walk(node, true)) changed = true;
    return changed;
  }

  function jsonBody(text, contentType, nested) {
    if (!enabled || typeof text !== 'string' || !text) return text;
    if (/x-www-form-urlencoded/i.test(contentType)) return queryString(text, true);
    if (jsonPaths.length === 0 && bodyKeys.size === 0) return text;
    let parsed;
    try { parsed = JSON.parse(noBom(text)); } catch (e) { return text; }
    if (!parsed || typeof parsed !== 'object') return text;
    try {
      return scrub(parsed, nested) ? JSON.stringify(parsed) : text;
    } catch (e) {
      return placeholder('body'); // cannot be re-serialised (nesting too deep): mask it all rather than throw or leak
    }
  }

  // text: string. contentType: for form bodies and JSON detection.
  function body(text, contentType = '') { return jsonBody(text, contentType, false); }

  // Response bodies: same paths and marker, but an origin may echo the request inside a wrapper, so the paths are
  // also applied from every nested object and inside string values that are themselves JSON (an echoed body).
  // Non-JSON bodies are returned unchanged.
  function responseBody(text, contentType = '') { return jsonBody(text, contentType, true); }

  return { enabled, headers, url, queryString, body, responseBody };
}

// ---------------------------------------------------------------------------------------------------------------
// Rule normalization

function lowerKeys(o) {
  const out = {};
  for (const [k, v] of Object.entries(o || {})) out[String(k).toLowerCase()] = v;
  return out;
}

function normalizeFault(raw, where) {
  let f = raw;
  if (typeof f === 'string') f = { kind: f };
  if (!f || typeof f !== 'object' || !FAULT_KINDS.includes(f.kind)) {
    throw new NetRuleError(`${where}: fault kind must be one of ${FAULT_KINDS.join(', ')}`);
  }
  const out = { kind: f.kind };
  if (f.kind === 'status') {
    const s = f.status === undefined ? 503 : f.status;
    if (!Number.isInteger(s) || s < 100 || s > 599) throw new NetRuleError(`${where}: fault status must be an integer 100-599`);
    out.status = s;
  }
  if (f.holdMs !== undefined) {
    if (!Number.isFinite(f.holdMs) || f.holdMs < 0) throw new NetRuleError(`${where}: holdMs must be >= 0`);
    out.holdMs = f.holdMs;
  }
  if (f.partialBytes !== undefined) {
    if (!Number.isInteger(f.partialBytes) || f.partialBytes < 0) throw new NetRuleError(`${where}: partialBytes must be an integer >= 0`);
    out.partialBytes = f.partialBytes;
  }
  return out;
}

function normalizeResponse(raw, where) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new NetRuleError(`${where}: response must be an object`);
  const resp = {};
  let fault = raw.fault;
  if (fault === undefined && FAULT_KINDS.includes(raw.kind)) fault = { kind: raw.kind, status: raw.status, holdMs: raw.holdMs, partialBytes: raw.partialBytes };
  if (raw.delayMs !== undefined) {
    if (!Number.isFinite(raw.delayMs) || raw.delayMs < 0) throw new NetRuleError(`${where}: delayMs must be >= 0`);
    resp.delayMs = raw.delayMs;
  }
  if (fault !== undefined) {
    resp.fault = normalizeFault(fault, where);
    return resp;
  }
  const bodies = ['body', 'json', 'file', 'bodyBase64'].filter((k) => raw[k] !== undefined);
  if (bodies.length > 1) throw new NetRuleError(`${where}: use only one of body, json, file, bodyBase64`);
  const status = raw.status === undefined ? 200 : raw.status;
  if (!Number.isInteger(status) || status < 100 || status > 599) throw new NetRuleError(`${where}: status must be an integer 100-599`);
  resp.status = status;
  resp.headers = lowerKeys(raw.headers);
  if (raw.body !== undefined) resp.body = typeof raw.body === 'string' ? raw.body : JSON.stringify(raw.body);
  if (raw.json !== undefined) resp.json = raw.json;
  if (raw.file !== undefined) {
    if (typeof raw.file !== 'string' || !raw.file) throw new NetRuleError(`${where}: file must be a path string`);
    resp.file = raw.file;
  }
  if (raw.bodyBase64 !== undefined) resp.bodyBase64 = String(raw.bodyBase64);
  return resp;
}

function compileBodyPredicate(raw, where) {
  if (raw === undefined) return null;
  const spec = typeof raw === 'string' ? { contains: raw } : raw;
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new NetRuleError(`${where}: reqBody must be a string or an object`);
  const checks = [];
  if (spec.contains !== undefined) checks.push((t) => t.includes(String(spec.contains)));
  if (spec.regex !== undefined) {
    let re;
    try { re = new RegExp(String(spec.regex)); } catch (e) { throw new NetRuleError(`${where}: reqBody.regex is not a valid expression`); }
    checks.push((t) => re.test(t));
  }
  if (spec.json !== undefined) {
    const entries = Object.entries(spec.json).map(([p, v]) => [parsePath(p), v]);
    checks.push((t) => {
      let j; try { j = JSON.parse(t); } catch (e) { return false; }
      return entries.every(([segs, want]) => jsonGet(j, segs).some((got) => JSON.stringify(got) === JSON.stringify(want)));
    });
  }
  if (checks.length === 0) throw new NetRuleError(`${where}: reqBody needs contains, regex or json`);
  return (t) => checks.every((c) => c(t));
}

let anon = 0;
function normalizeRule(raw, { source = 'rule', index = 0 } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new NetRuleError('rule must be an object');
  const id = raw.id !== undefined ? String(raw.id) : `${source}-${++anon}`;
  const where = `rule ${id}`;
  let methods = null;
  if (raw.method !== undefined && raw.method !== '*') {
    const arr = Array.isArray(raw.method) ? raw.method : [raw.method];
    methods = arr.map((m) => String(m).toUpperCase());
    if (methods.length === 0 || methods.some((m) => !/^[A-Z]+$/.test(m))) throw new NetRuleError(`${where}: bad method`);
  }
  let times = null;
  if (raw.times !== undefined) {
    if (!Number.isInteger(raw.times) || raw.times < 1) throw new NetRuleError(`${where}: times must be a positive integer`);
    times = raw.times;
  }
  const urlOk = (() => { try { return compileUrlPattern(raw.url); } catch (e) { throw new NetRuleError(`${where}: ${e.message}`); } })();
  const headerPreds = Object.entries(raw.reqHeaders || {}).map(([k, v]) => [k.toLowerCase(), globToRegex(String(v), true)]);
  const bodyPred = compileBodyPredicate(raw.reqBody, where);
  let responses;
  if (raw.responses !== undefined) {
    if (!Array.isArray(raw.responses) || raw.responses.length === 0) throw new NetRuleError(`${where}: responses must be a non-empty array`);
    responses = raw.responses.map((r, i) => normalizeResponse(r, `${where} responses[${i}]`));
  } else if (raw.passthrough === true) {
    responses = [];
  } else {
    responses = [normalizeResponse(raw, where)];
  }
  return {
    id, source, index, url: raw.url, methods, times, responses, passthrough: raw.passthrough === true,
    hits: 0, urlOk, headerPreds, bodyPred,
  };
}

function matchRule(rule, req) {
  if (rule.methods && !rule.methods.includes(String(req.method || 'GET').toUpperCase())) return false;
  if (!rule.urlOk(req.url)) return false;
  if (rule.headerPreds.length) {
    const h = lowerKeys(req.headers);
    for (const [k, re] of rule.headerPreds) {
      const v = h[k];
      if (v === undefined || !re.test(Array.isArray(v) ? v.join(', ') : String(v))) return false;
    }
  }
  if (rule.bodyPred) {
    const t = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body || '');
    if (!rule.bodyPred(t)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------------------------------------------
// Rule set

function createRuleSet({ root = null } = {}) {
  const added = []; // newest first
  const config = [];

  function all() { return added.concat(config); }

  return {
    // Config fixtures: appended in declaration order, after run-time rules.
    addConfig(rules, { source = 'fixture' } = {}) {
      const arr = Array.isArray(rules) ? rules : [rules];
      const made = arr.map((r, i) => normalizeRule(r, { source, index: config.length + i }));
      config.push(...made);
      return made.map((r) => r.id);
    },
    // Run-time rules (BTNet_mock, flow steps): prepended so they override config fixtures. `scope` tags them
    // (suite/test id) so reset({scope}) drops only that scope's rules.
    add(raw, { scope = null } = {}) {
      const r = normalizeRule(raw, { source: 'rule' });
      r.scope = scope;
      added.unshift(r);
      return r.id;
    },
    // BTNet_reset: drop run-time rules (optionally only one scope). Config fixtures stay.
    reset({ scope } = {}) {
      for (let i = added.length - 1; i >= 0; i--) if (scope === undefined || added[i].scope === scope) added.splice(i, 1);
    },
    configCount() { return config.length; },
    list() { return all().map((r) => ({ id: r.id, source: r.source, url: r.url, methods: r.methods, times: r.times, hits: r.hits })); },
    // req: {method, url, headers, body}. Returns {rule, response, passthrough, n} or null. Advances counters.
    match(req) {
      for (const rule of all()) {
        if (rule.times !== null && rule.hits >= rule.times) continue;
        if (!matchRule(rule, req)) continue;
        rule.hits++;
        const n = rule.hits;
        const response = rule.responses.length ? rule.responses[Math.min(n, rule.responses.length) - 1] : null;
        return { rule: { id: rule.id, source: rule.source }, response, passthrough: rule.passthrough, n };
      }
      return null;
    },
    root,
  };
}

// Resolve a normalized response's body to a Buffer. `file:` is confined to `root` (symlinks resolved).
function resolveBody(resp, root) {
  if (resp.body !== undefined) return Buffer.from(resp.body, 'utf8');
  if (resp.json !== undefined) return Buffer.from(JSON.stringify(resp.json), 'utf8');
  if (resp.bodyBase64 !== undefined) return Buffer.from(resp.bodyBase64, 'base64');
  if (resp.file !== undefined) {
    if (!root) throw new NetRuleError('file: bodies need a project root');
    const base = fs.realpathSync(root);
    const abs = path.resolve(base, resp.file);
    let real;
    try { real = fs.realpathSync(abs); } catch (e) { throw new NetRuleError(`file not found: ${resp.file}`); }
    if (real !== base && !real.startsWith(base + path.sep)) throw new NetRuleError(`file is outside the project root: ${resp.file}`);
    return fs.readFileSync(real);
  }
  return Buffer.alloc(0);
}

function contentTypeFor(resp) {
  if (resp.headers && resp.headers['content-type']) return resp.headers['content-type'];
  if (resp.json !== undefined) return 'application/json';
  if (resp.file && /\.json$/i.test(resp.file)) return 'application/json';
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// HAR 1.2

function globEscape(s) { return s.replace(/\\/g, '\\\\').replace(/\*/g, '\\*').replace(/\?/g, '%3F'); }

function headersToList(h) {
  return Object.entries(h || {}).map(([name, value]) => ({ name, value: Array.isArray(value) ? value.join(', ') : String(value) }));
}

// Encode one body the way the HAR writer does (also used by Studio's network detail routes): { text, encoding? }.
// `red` is a makeRedactor result, or null for raw (no redaction, same text/base64 rule). side 'req' is always text
// (red.body); side 'res' is text for text-like types without NUL bytes, otherwise base64 (a JSON body is redacted
// before it is encoded).
function harBody(buf, contentType, red, side) {
  const b = buf || Buffer.alloc(0);
  const ct = String(contentType || '');
  if (side === 'req') return { text: red ? red.body(b.toString('utf8'), ct) : b.toString('utf8') };
  const isText = !b.length || /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded)|.*[+/](json|xml))/i.test(ct) || ct === '';
  if (isText && !b.includes(0)) return { text: red ? red.responseBody(b.toString('utf8'), ct) : b.toString('utf8') };
  let raw = b;
  if (red && !b.includes(0)) {
    const t = b.toString('utf8');
    const r = red.responseBody(t, '');
    if (r !== t) raw = Buffer.from(r, 'utf8');
  }
  return { text: raw.toString('base64'), encoding: 'base64' };
}

// entries: [{startedDateTime (ms), time, method, url, reqHeaders, reqBody (Buffer|null), status, statusText?,
//            resHeaders, resBody (Buffer|null), timings {blocked, wait, receive}}]
function buildHar(entries, { redact = {}, version = '0' } = {}) {
  const red = makeRedactor(redact);
  const out = entries.map((e) => {
    const reqHeaders = red.headers(e.reqHeaders);
    const resHeaders = red.headers(e.resHeaders);
    const reqType = (e.reqHeaders && (lowerKeys(e.reqHeaders)['content-type'])) || '';
    const resType = (e.resHeaders && (lowerKeys(e.resHeaders)['content-type'])) || '';
    const url = red.url(e.url);
    const u = (() => { try { return new URL(e.url); } catch (err) { return null; } })();
    const qs = u ? [...new URL(url).searchParams.entries()].map(([name, value]) => ({ name, value })) : [];
    const req = {
      method: e.method, url, httpVersion: 'HTTP/1.1', cookies: [], headers: headersToList(reqHeaders), queryString: qs,
      headersSize: -1, bodySize: e.reqBody ? e.reqBody.length : 0,
    };
    if (e.reqBody && e.reqBody.length) req.postData = { mimeType: String(reqType), ...harBody(e.reqBody, reqType, red, 'req') };
    const resBuf = e.resBody || Buffer.alloc(0);
    const content = { size: resBuf.length, mimeType: String(resType) };
    Object.assign(content, harBody(resBuf, resType, red, 'res'));
    const t = e.timings || {};
    return {
      startedDateTime: new Date(e.startedDateTime || Date.now()).toISOString(),
      time: e.time || 0,
      request: req,
      response: {
        status: e.status, statusText: e.statusText || '', httpVersion: 'HTTP/1.1', cookies: [], headers: headersToList(resHeaders),
        content, redirectURL: '', headersSize: -1, bodySize: resBuf.length,
      },
      cache: {},
      timings: { blocked: t.blocked || 0, send: 0, wait: t.wait || 0, receive: t.receive || 0 },
    };
  });
  return { log: { version: '1.2', creator: { name: 'brighttest', version: String(version) }, entries: out } };
}

function validateHar(har) {
  const errs = [];
  const log = har && har.log;
  if (!log || log.version !== '1.2') errs.push('log.version must be "1.2"');
  if (!log || !log.creator || !log.creator.name) errs.push('log.creator.name is required');
  if (!log || !Array.isArray(log.entries)) { errs.push('log.entries must be an array'); return errs; }
  log.entries.forEach((e, i) => {
    const p = `entries[${i}]`;
    if (!e.startedDateTime || Number.isNaN(Date.parse(e.startedDateTime))) errs.push(`${p}.startedDateTime invalid`);
    if (typeof e.time !== 'number') errs.push(`${p}.time must be a number`);
    if (!e.request || !e.request.method || !e.request.url || !Array.isArray(e.request.headers) || !Array.isArray(e.request.queryString)) errs.push(`${p}.request incomplete`);
    if (!e.response || typeof e.response.status !== 'number' || !e.response.content || typeof e.response.content.size !== 'number') errs.push(`${p}.response incomplete`);
    const t = e.timings;
    if (!t || typeof t.send !== 'number' || typeof t.wait !== 'number' || typeof t.receive !== 'number') errs.push(`${p}.timings needs send, wait, receive`);
  });
  return errs;
}

// HAR -> rule objects. Consecutive and repeated requests for the same method+url become one rule with a
// `responses` sequence (replay order = recorded order). Redacted query values become `*` so replay matches
// the real secret; redacted header values are never turned into predicates.
function rulesFromHar(har) {
  const errs = validateHar(har);
  if (errs.length) throw new NetRuleError(`not a valid HAR 1.2 file: ${errs[0]}`);
  const groups = new Map();
  const order = [];
  har.log.entries.forEach((e) => {
    let u;
    try { u = new URL(e.request.url); } catch (err) { throw new NetRuleError(`HAR entry has an invalid url: ${e.request.url}`); }
    const pairs = [...u.searchParams.entries()].map(([k, v]) => `${globEscape(encodeURIComponent(k))}=${PLACEHOLDER_RE.test(v) ? '*' : encodeURIComponent(v).replace(/\*/g, '%2A')}`);
    pairs.sort();
    const pattern = `${u.protocol}//${u.host}${globEscape(u.pathname)}${pairs.length ? `?${pairs.join('&')}` : ''}`;
    const key = `${e.request.method.toUpperCase()} ${pattern}`;
    let g = groups.get(key);
    if (!g) { g = { method: e.request.method.toUpperCase(), url: pattern, responses: [] }; groups.set(key, g); order.push(g); }
    const c = e.response.content || {};
    const resp = { status: e.response.status, headers: {} };
    for (const h of e.response.headers || []) {
      const n = String(h.name).toLowerCase();
      if (['content-length', 'content-encoding', 'transfer-encoding', 'connection'].includes(n)) continue;
      resp.headers[n] = PLACEHOLDER_RE.test(h.value) ? '' : h.value;
    }
    if (c.text !== undefined) { if (c.encoding === 'base64') resp.bodyBase64 = c.text; else resp.body = c.text; }
    g.responses.push(resp);
  });
  return order.map((g, i) => {
    const rule = { id: `har-${i + 1}`, method: g.method, url: g.url };
    if (g.responses.length === 1) Object.assign(rule, g.responses[0]); else rule.responses = g.responses;
    return rule;
  });
}

function rulesFromJson(obj) {
  const list = Array.isArray(obj) ? obj : obj && Array.isArray(obj.rules) ? obj.rules : null;
  if (!list) throw new NetRuleError('rules file must be an array of rules or {"rules": [...]}');
  return list;
}

// Load a .har or .rules.json fixture (decided by content, not extension).
function loadRulesFile(file) {
  let obj;
  try { obj = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new NetRuleError(`cannot read rules file ${file}: ${e.message}`); }
  return obj && obj.log ? rulesFromHar(obj) : rulesFromJson(obj);
}

module.exports = {
  NetRuleError, FAULT_KINDS, createRuleSet, resolveBody, contentTypeFor, urlMatches, compileUrlPattern,
  makeRedactor, buildHar, harBody, validateHar, rulesFromHar, rulesFromJson, loadRulesFile, placeholder, parsePath, jsonGet,
};
