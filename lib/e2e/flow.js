'use strict';
const fs = require('fs');
const path = require('path');

// YAML front-end for the e2e lane: parses a *.e2e.yaml flow file into the shared step model the runner
// executes. This is NOT a general YAML parser — it deliberately supports only the small, documented flow
// subset (a top-level map with appId/config/steps; steps is a block sequence of one-line items; values
// are scalars or inline flow maps like `{ id: foo, count: 2 }`, which may nest). Anything outside the
// subset raises a clear, line-referenced error rather than being silently misparsed. Zero-dependency,
// matching brighttest's ethos; swap in the `yaml` package here later if a fuller grammar is ever needed.
//
// Step model (what the runner consumes): each step is { op, line, ...args }, e.g.
//   { op: 'launch', line, params }         { op: 'press', line, key, count }
//   { op: 'assertVisible', line, selector } { op: 'assertText', line, selector, equals|contains }

const FlowError = class extends Error {};
// A DSL validation error (key names, requires:, holdKey): the run stops on these before any device call.
const dslError = (msg) => Object.assign(new FlowError(msg), { validation: true });

// Each launch param value must be a string, number or boolean; objects, arrays and null would reach the
// device as "[object Object]" or similar. `where` names the flow line or step for the error text.
function checkLaunchParams(params, where) {
  for (const [k, v] of Object.entries(params || {})) {
    const t = typeof v;
    if (t === 'string' || t === 'number' || t === 'boolean') continue;
    const got = v === null ? 'null' : Array.isArray(v) ? 'array' : t;
    throw new FlowError(`${where}: launch param "${k}" must be a string, number or boolean (got ${got}); launch params take scalar values, one key each, directly under launch (<name>: <value>)`);
  }
}
const netSteps = require('./net-steps'); // NET-N-T9 network steps

// ---- key names and requirements (ROB-09) ---------------------------------------------------------

// The ECP key names a flow may press. `Lit_<char>` (one literal character) is also accepted. Matching is exact
// and case-sensitive, as on the device. Validated at parse time (so `e2e lint` and `e2e run` both catch a typo
// before any device call).
const VALID_KEYS = Object.freeze([
  'Home', 'Rev', 'Fwd', 'Play', 'Select', 'Left', 'Right', 'Down', 'Up', 'Back', 'InstantReplay', 'Info',
  'Backspace', 'Search', 'Enter', 'FindRemote', 'VolumeDown', 'VolumeMute', 'VolumeUp', 'PowerOff',
  'ChannelUp', 'ChannelDown', 'InputTuner', 'InputHDMI1', 'InputHDMI2', 'InputHDMI3', 'InputHDMI4', 'InputAV1',
]);

function checkKey(key, line, op) {
  const k = String(key);
  if (VALID_KEYS.includes(k) || /^Lit_.$/u.test(k)) return k;
  throw dslError(`line ${line}: ${op}: unknown key "${k}"; valid keys: ${VALID_KEYS.join(', ')}, or Lit_<char> for one literal character`);
}

const REQUIRES_KEYS = ['firmware', 'videoMode', 'deviceClass'];
const DEVICE_CLASSES = ['tv', 'box', 'stick'];
const VERSION_EXPR = /^\s*(>=|<=|==|=|>|<)?\s*(\d+(?:\.\d+)*)\s*$/;

// `requires:` map -> { firmware?: {op, version}, videoMode?: string, deviceClass?: string }.
function normalizeRequires(arg, line, op) {
  if (!arg || typeof arg !== 'object' || Array.isArray(arg)) {
    throw dslError(`line ${line}: ${op} needs a map, e.g. requires: { firmware: ">=12.5", videoMode: 1080p, deviceClass: box }`);
  }
  const out = {};
  for (const [k, v] of Object.entries(arg)) {
    if (!REQUIRES_KEYS.includes(k)) throw dslError(`line ${line}: ${op}: unknown requirement "${k}"; valid: ${REQUIRES_KEYS.join(', ')}`);
    if (v === null || v === undefined || v === '' || typeof v === 'object') throw dslError(`line ${line}: ${op}: ${k} needs a value`);
    if (k === 'firmware') {
      if (typeof v !== 'string') throw dslError(`line ${line}: ${op}: firmware must be a quoted string (a bare number like 12.10 is read as 12.1); quote the version, e.g. ">=12.10"`);
      const m = VERSION_EXPR.exec(String(v));
      if (!m) throw dslError(`line ${line}: ${op}: firmware must be a version with an optional operator, e.g. ">=12.5" (got ${JSON.stringify(String(v))})`);
      out.firmware = { op: m[1] || '>=', version: m[2] };
    } else if (k === 'deviceClass') {
      const d = String(v).toLowerCase();
      if (!DEVICE_CLASSES.includes(d)) throw dslError(`line ${line}: ${op}: deviceClass must be one of ${DEVICE_CLASSES.join(', ')} (got ${JSON.stringify(String(v))})`);
      out.deviceClass = d;
    } else {
      out.videoMode = String(v);
    }
  }
  if (!Object.keys(out).length) throw dslError(`line ${line}: ${op} is empty; give at least one of ${REQUIRES_KEYS.join(', ')}`);
  return out;
}

// Compare dotted numeric versions: -1, 0, 1.
function compareVersions(a, b) {
  const x = String(a).split('.').map(Number); const y = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

// Check a normalized requires map against the device info record ({ firmware, videoMode, isTv, isStick }; the
// record `device.deviceInfo()` already returns, no new probe). Returns null when met, else a reason string.
// A value the device did not report counts as unmet (the reason says so).
function checkRequires(requires, info) {
  const i = info || {};
  if (requires.firmware) {
    const { op, version } = requires.firmware;
    const have = i.firmware && /^\d+(?:\.\d+)*/.exec(String(i.firmware));
    if (!have) return `requires firmware ${op}${version}, but the device did not report a firmware version`;
    const c = compareVersions(have[0], version);
    const ok = { '>=': c >= 0, '>': c > 0, '<=': c <= 0, '<': c < 0, '=': c === 0, '==': c === 0 }[op];
    if (!ok) return `requires firmware ${op}${version}, device has ${have[0]}`;
  }
  if (requires.videoMode) {
    if (!i.videoMode) return `requires videoMode ${requires.videoMode}, but the device did not report a video mode`;
    if (String(i.videoMode).toLowerCase() !== requires.videoMode.toLowerCase()) return `requires videoMode ${requires.videoMode}, device reports ${i.videoMode}`;
  }
  if (requires.deviceClass) {
    if (i.isTv == null && i.isStick == null) return `requires deviceClass ${requires.deviceClass}, but the device did not report its class`;
    const have = i.isTv ? 'tv' : i.isStick ? 'stick' : 'box';
    if (have !== requires.deviceClass) return `requires deviceClass ${requires.deviceClass}, device is a ${have}`;
  }
  return null;
}

const HOLD_MAX_MS = 30000;

// ---- scalar / inline-flow parsing --------------------------------------------------------------

// Parse a scalar token: quoted string, integer, float, boolean, null, or a bare string.
function parseScalar(tok) {
  const s = tok.trim();
  if (s === '') return '';
  if ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'"))) return s.slice(1, -1);
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d*\.\d+$/.test(s)) return parseFloat(s);
  return s;
}

// Recursive parser for an inline flow value starting at `str[pos]`: scalar, `{ … }` map, or `[ … ]`
// list. Returns [value, nextPos]. Used for the RHS of a step key (e.g. `{ id: foo, count: 2 }`).
function parseFlow(str, pos, line) {
  pos = skipWs(str, pos);
  const ch = str[pos];
  if (ch === '{') return parseFlowMap(str, pos, line);
  if (ch === '[') return parseFlowList(str, pos, line);
  if (ch === '"' || ch === "'") {
    const end = str.indexOf(ch, pos + 1);
    if (end < 0) throw new FlowError(`line ${line}: unterminated string ${ch}…`);
    return [str.slice(pos + 1, end), end + 1];
  }
  // bare scalar: read until a delimiter
  let end = pos;
  while (end < str.length && !',}]'.includes(str[end])) end++;
  return [parseScalar(str.slice(pos, end)), end];
}

function skipWs(str, pos) { while (pos < str.length && /\s/.test(str[pos])) pos++; return pos; }

function parseFlowMap(str, pos, line) {
  const out = {};
  pos++; // consume '{'
  pos = skipWs(str, pos);
  if (str[pos] === '}') return [out, pos + 1];
  while (pos < str.length) {
    pos = skipWs(str, pos);
    // key (bare or quoted) up to ':'
    let key;
    if (str[pos] === '"' || str[pos] === "'") {
      const q = str[pos]; const end = str.indexOf(q, pos + 1);
      key = str.slice(pos + 1, end); pos = end + 1;
    } else {
      let end = pos; while (end < str.length && str[end] !== ':') end++;
      key = str.slice(pos, end).trim(); pos = end;
    }
    if (str[pos] !== ':') throw new FlowError(`line ${line}: expected ':' after key "${key}" in { … }`);
    pos++;
    const [val, next] = parseFlow(str, pos, line);
    out[key] = val; pos = skipWs(str, next);
    if (str[pos] === ',') { pos++; continue; }
    if (str[pos] === '}') return [out, pos + 1];
    throw new FlowError(`line ${line}: expected ',' or '}' in flow map, got '${str[pos] || 'EOF'}'`);
  }
  throw new FlowError(`line ${line}: unterminated flow map { …`);
}

function parseFlowList(str, pos, line) {
  const out = [];
  pos++; // consume '['
  pos = skipWs(str, pos);
  if (str[pos] === ']') return [out, pos + 1];
  while (pos < str.length) {
    const [val, next] = parseFlow(str, pos, line);
    out.push(val); pos = skipWs(str, next);
    if (str[pos] === ',') { pos++; pos = skipWs(str, pos); continue; }
    if (str[pos] === ']') return [out, pos + 1];
    throw new FlowError(`line ${line}: expected ',' or ']' in flow list`);
  }
  throw new FlowError(`line ${line}: unterminated flow list [ …`);
}

// Parse the RHS of `key:` — either an inline flow value or a bare scalar (whole remainder).
function parseRhs(rest, line) {
  const s = rest.trim();
  if (s[0] === '{' || s[0] === '[') {
    const [val, next] = parseFlow(s, 0, line);
    if (skipWs(s, next) !== s.length) throw new FlowError(`line ${line}: trailing text after flow value`);
    return val;
  }
  return parseScalar(s);
}

// ---- line scanning + block structure -----------------------------------------------------------

// Strip a trailing/whole-line `#` comment, honoring quotes so `text: "a # b"` is preserved.
function stripComment(line) {
  let inQ = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) { if (c === inQ) inQ = null; }
    else if (c === '"' || c === "'") inQ = c;
    else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

// → [{ n, indent, text }] for non-blank lines (n is the 1-based source line number). Tabs are rejected.
function scanLines(src) {
  const out = [];
  const raw = String(src).split(/\r\n|\r|\n/);
  for (let i = 0; i < raw.length; i++) {
    if (raw[i].includes('\t')) throw new FlowError(`line ${i + 1}: tabs are not allowed for indentation`);
    const noComment = stripComment(raw[i]);
    const text = noComment.trim();
    if (text === '') continue;
    out.push({ n: i + 1, indent: noComment.length - noComment.trimStart().length, text });
  }
  return out;
}

// Parse a mapping block: consecutive lines at exactly `indent`. `key: rest` where rest may be empty
// (→ a nested block at deeper indent) or an inline value. Returns { map, next } (next = index after it).
function parseMapBlock(lines, start, indent) {
  const map = {};
  let i = start;
  while (i < lines.length && lines[i].indent === indent) {
    const { text, n } = lines[i];
    const colon = findKeyColon(text);
    if (colon < 0) throw new FlowError(`line ${n}: expected "key: value" (got "${text}")`);
    const key = text.slice(0, colon).trim();
    const rest = text.slice(colon + 1).trim();
    if (rest === '') {
      // nested block: a sequence or a map at a deeper indent
      const childIndent = i + 1 < lines.length ? lines[i + 1].indent : indent;
      if (i + 1 < lines.length && lines[i + 1].indent > indent) {
        if (lines[i + 1].text.startsWith('- ') || lines[i + 1].text === '-') {
          const { seq, next } = parseSeqBlock(lines, i + 1, childIndent);
          map[key] = seq; i = next;
        } else {
          const { map: child, next } = parseMapBlock(lines, i + 1, childIndent);
          map[key] = child; i = next;
        }
      } else { map[key] = null; i++; }
    } else {
      map[key] = { __scalar: parseRhs(rest, n), __line: n };
      i++;
    }
  }
  return { map, next: i };
}

// Parse a block sequence: consecutive `- …` lines at `indent`. Each item keeps its source line via a
// non-enumerable __line so the normalizer can produce line-referenced errors.
function parseSeqBlock(lines, start, indent) {
  const seq = [];
  let i = start;
  while (i < lines.length && lines[i].indent === indent && (lines[i].text === '-' || lines[i].text.startsWith('- '))) {
    const { text, n } = lines[i];
    const item = text === '-' ? '' : text.slice(2).trim();
    const colon = findKeyColon(item);
    let value;
    if (colon < 0) {
      value = { bare: parseScalar(item) }; // e.g. `- launch`
    } else {
      const key = item.slice(0, colon).trim();
      const rest = item.slice(colon + 1).trim();
      value = { key, arg: rest === '' ? null : parseRhs(rest, n) };
    }
    Object.defineProperty(value, '__line', { value: n, enumerable: false });
    seq.push(value);
    i++;
  }
  return { seq, next: i };
}

// Index of the `key:` colon at the top level of a line (ignores ':' inside quotes or an inline map).
function findKeyColon(text) {
  let inQ = null, depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) { if (c === inQ) inQ = null; continue; }
    if (c === '"' || c === "'") inQ = c;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
    else if (c === ':' && depth === 0 && (i + 1 >= text.length || /\s/.test(text[i + 1]))) return i;
  }
  return -1;
}

// ---- step model normalization ------------------------------------------------------------------

const SELECTOR_KEYS = ['id', 'subtype', 'text', 'uri', 'textContains', 'visible', 'focusable', 'focused', 'index'];
const BARE_OPS = { launch: 'launch', back: 'back', home: 'home' };

function asSelector(arg, line, op) {
  if (arg && typeof arg === 'object' && !Array.isArray(arg)) return arg;
  throw new FlowError(`line ${line}: ${op} needs a selector map, e.g. { id: homeScreen }`);
}

// Turn one raw sequence item into a normalized step, or throw a line-referenced FlowError.
function normalizeStep(item) {
  const line = item.__line;
  if ('bare' in item) {
    const name = item.bare;
    if (BARE_OPS[name]) return { op: BARE_OPS[name], line };
    if (name === 'assertPlaying') return { op: 'assertMedia', line, state: 'play' };
    if (netSteps.NET_OPS.has(name)) return netSteps.normalizeStep(name, null, line, FlowError);
    throw new FlowError(`line ${line}: unknown step "${name}" (bare steps: launch, back, home, assertPlaying)`);
  }
  const { key, arg } = item;
  switch (key) {
    case 'launch': {
      const params = arg && typeof arg === 'object' ? arg : {};
      checkLaunchParams(params, `line ${line}`);
      return { op: 'launch', line, params };
    }
    case 'press': {
      if (arg && typeof arg === 'object') {
        if (!arg.key) throw new FlowError(`line ${line}: press: { key, count } needs a key`);
        return { op: 'press', line, key: checkKey(arg.key, line, 'press'), count: arg.count ? Number(arg.count) : 1 };
      }
      if (!arg) throw new FlowError(`line ${line}: press needs a key, e.g. press: Select`);
      return { op: 'press', line, key: checkKey(arg, line, 'press'), count: 1 };
    }
    case 'holdKey': {
      // Hold a key down for a fixed time: keydown, wait ms, keyup (the keyup is always attempted).
      if (!arg || typeof arg !== 'object' || Array.isArray(arg)) throw dslError(`line ${line}: holdKey needs a map, e.g. holdKey: { key: Right, ms: 500 }`);
      const a = arg;
      if (!a.key) throw dslError(`line ${line}: holdKey needs { key, ms }, e.g. holdKey: { key: Right, ms: 500 }`);
      const ms = Number(a.ms);
      if (a.ms === undefined || !Number.isFinite(ms) || ms <= 0 || ms > HOLD_MAX_MS) {
        throw dslError(`line ${line}: holdKey ms must be a number of milliseconds from 1 to ${HOLD_MAX_MS} (got ${JSON.stringify(a.ms)})`);
      }
      return { op: 'holdKey', line, key: checkKey(a.key, line, 'holdKey'), ms };
    }
    case 'requires':
      // A gate step: when unmet, the rest of the flow is skipped (not failed).
      return { op: 'requires', line, requires: normalizeRequires(arg, line, 'requires') };
    case 'pressUntil': {
      const a = asSelector(arg, line, 'pressUntil');
      const sel = a.visible || a.selector;
      if (!a.key || !sel) throw new FlowError(`line ${line}: pressUntil needs { key, visible|selector, max? }`);
      return { op: 'pressUntil', line, key: checkKey(a.key, line, 'pressUntil'), selector: sel, max: a.max ? Number(a.max) : 20 };
    }
    case 'text':
      if (arg === null || arg === undefined) throw new FlowError(`line ${line}: text needs a value`);
      return { op: 'text', line, value: String(arg) };
    case 'runFlow': {
      // Run another flow inline (a reusable subflow), optionally passing env vars substituted as ${name}:
      //   runFlow: { file: login.e2e.yaml, env: { user: demo } }
      const a = asSelector(arg, line, 'runFlow');
      if (!a.file) throw new FlowError(`line ${line}: runFlow needs { file: <path.e2e.yaml>, env?: {…} }`);
      const env = a.env && typeof a.env === 'object' && !Array.isArray(a.env) ? a.env : {};
      return { op: 'runFlow', line, file: String(a.file), env };
    }
    case 'focus': {
      const a = asSelector(arg, line, 'focus');
      const selector = {};
      for (const k of SELECTOR_KEYS) if (a[k] !== undefined) selector[k] = a[k];
      if (!Object.keys(selector).length) throw new FlowError(`line ${line}: focus needs a selector (e.g. id:)`);
      return { op: 'focus', line, selector, maxPresses: a.maxPresses ? Number(a.maxPresses) : undefined };
    }
    case 'assertVisible': return { op: 'assertVisible', line, selector: asSelector(arg, line, 'assertVisible') };
    case 'assertGone': return { op: 'assertGone', line, selector: asSelector(arg, line, 'assertGone') };
    case 'assertFocused': return { op: 'assertFocused', line, selector: asSelector(arg, line, 'assertFocused') };
    case 'assertText': {
      const a = asSelector(arg, line, 'assertText');
      const selector = {};
      for (const k of SELECTOR_KEYS) if (a[k] !== undefined) selector[k] = a[k];
      if (a.equals === undefined && a.contains === undefined) {
        throw new FlowError(`line ${line}: assertText needs equals: or contains:`);
      }
      if (!Object.keys(selector).length) throw new FlowError(`line ${line}: assertText needs a selector (e.g. id:)`);
      return { op: 'assertText', line, selector, equals: a.equals, contains: a.contains };
    }
    case 'assertField': {
      // Assert ANY field a node exposes (exactly the fields `e2e inspect` prints), by raw name:
      //   assertField: { id: hero, field: uri, equals: "pkg:/images/hero.png" }
      //   assertField: { id: title, field: opacity, contains: "0.5" }
      // The built-in id surfaces as the `name` field. Values compare as strings (see the runner).
      const a = asSelector(arg, line, 'assertField');
      const selector = {};
      for (const k of SELECTOR_KEYS) if (a[k] !== undefined) selector[k] = a[k];
      if (!a.field) throw new FlowError(`line ${line}: assertField needs field: <name> (any field shown by e2e inspect)`);
      if (a.equals === undefined && a.contains === undefined) {
        throw new FlowError(`line ${line}: assertField needs equals: or contains:`);
      }
      if (!Object.keys(selector).length) throw new FlowError(`line ${line}: assertField needs a selector (e.g. id:)`);
      return { op: 'assertField', line, selector, field: String(a.field), equals: a.equals, contains: a.contains };
    }
    case 'waitFor': {
      const a = asSelector(arg, line, 'waitFor');
      const selector = a.selector || {};
      for (const k of SELECTOR_KEYS) if (a[k] !== undefined) selector[k] = a[k];
      if (!Object.keys(selector).length) throw new FlowError(`line ${line}: waitFor needs a selector`);
      return { op: 'waitFor', line, selector, timeout: a.timeout ? Number(a.timeout) : undefined };
    }
    case 'wait': {
      // A fixed pause in MILLISECONDS (unlike the second-based `timeout`/`waitFor`). `wait: 500` or
      // `wait: { ms: 500 }`. For "pause until something appears", use `waitFor`/`assertVisible` instead.
      const raw = arg && typeof arg === 'object' && !Array.isArray(arg) ? arg.ms : arg;
      if (raw === null || raw === undefined) throw new FlowError(`line ${line}: wait needs a duration in ms, e.g. wait: 500`);
      const ms = Number(raw);
      if (!Number.isFinite(ms) || ms < 0) throw new FlowError(`line ${line}: wait must be a non-negative number of milliseconds (got ${JSON.stringify(raw)})`);
      return { op: 'wait', line, ms };
    }
    case 'assertPlaying': {
      const a = arg && typeof arg === 'object' && !Array.isArray(arg) ? arg : {};
      return { op: 'assertMedia', line, state: 'play', timeout: a.timeout ? Number(a.timeout) : undefined };
    }
    case 'assertMedia': {
      // Assert the ECP media-player state (play | pause | buffer | finished | …) — no sgnodes, so it's
      // reliable during fullscreen video. `assertPlaying` is the shorthand for state: play.
      const a = asSelector(arg, line, 'assertMedia');
      if (!a.state) throw new FlowError(`line ${line}: assertMedia needs { state: play|pause|buffer|… }`);
      return { op: 'assertMedia', line, state: String(a.state), timeout: a.timeout ? Number(a.timeout) : undefined };
    }
    case 'assertState': {
      // Assert a value in the app's self-published state snapshot (the __bt_state mirror `e2e inspect`
      // shows). `path` is dot-separated, array indices included:
      //   assertState: { path: current, equals: PlayerPanel }
      //   assertState: { path: global.channel, equals: "Open Cinema" }
      //   assertState: { path: watchlist.0.id, contains: steel }
      //   assertState: { layer: global, path: channel, deepEquals: { a: 1 } }   # structural equality
      //   assertState: { layer: scene, path: lastverb, exists: true }            # exists: false = absent
      const a = asSelector(arg, line, 'assertState');
      if (!a.path) throw new FlowError(`line ${line}: assertState needs path: <dotted.path> into the app's published state`);
      if (a.equals === undefined && a.contains === undefined && a.deepEquals === undefined && a.exists === undefined) {
        throw new FlowError(`line ${line}: assertState needs equals: or contains: (or deepEquals:, exists:)`);
      }
      if (a.exists !== undefined && typeof a.exists !== 'boolean') throw new FlowError(`line ${line}: assertState exists: must be true or false`);
      return { op: 'assertState', line, path: String(a.path), layer: a.layer === undefined ? undefined : String(a.layer),
        equals: a.equals, contains: a.contains, deepEquals: a.deepEquals, exists: a.exists, timeout: a.timeout ? Number(a.timeout) : undefined };
    }
    case 'assertLog':
    case 'expectNoLog': {
      // 8085 console lines: `assertLog: "text"` (or "/regex/"), or { pattern, timeout } (seconds, assertLog only).
      const a = arg && typeof arg === 'object' && !Array.isArray(arg) ? arg : { pattern: arg };
      if (a.pattern === null || a.pattern === undefined || a.pattern === '') throw new FlowError(`line ${line}: ${key} needs a pattern, e.g. ${key}: "text"`);
      return { op: key, line, pattern: String(a.pattern), timeout: a.timeout ? Number(a.timeout) : undefined };
    }
    case 'screenshot':
      if (!arg) throw new FlowError(`line ${line}: screenshot needs a name, e.g. screenshot: home.png`);
      return { op: 'screenshot', line, name: String(arg) };
    default:
      if (netSteps.NET_OPS.has(key)) return netSteps.normalizeStep(key, arg, line, FlowError);
      throw new FlowError(`line ${line}: unknown step "${key}"`);
  }
}

// ---- public API ---------------------------------------------------------------------------------

// Parse flow source text → { appId, config, steps: [normalized] }. Throws FlowError with a line number.
function parseFlow_(src) {
  const lines = scanLines(src);
  if (!lines.length) throw new FlowError('empty flow file');
  if (lines[0].indent !== 0) throw new FlowError(`line ${lines[0].n}: top level must not be indented`);
  const { map } = parseMapBlock(lines, 0, 0);

  const appId = unwrap(map.appId) || 'dev';
  const config = plainMap(map.config);
  if (config.net !== undefined) config.net = netSteps.validateConfig(config.net, FlowError);
  const stepsRaw = map.steps;
  if (!Array.isArray(stepsRaw)) throw new FlowError('flow must have a `steps:` sequence');
  let requires = null;
  if (map.requires !== undefined) {
    const raw = map.requires && '__scalar' in map.requires ? map.requires.__scalar : plainMap(map.requires);
    const at = (lines.find((l) => l.indent === 0 && /^requires\s*:/.test(l.text)) || {}).n || 1;
    requires = normalizeRequires(raw, at, 'requires');
  }
  if (config.noSystemDialog !== undefined && typeof config.noSystemDialog !== 'boolean') {
    throw dslError('config.noSystemDialog must be true or false');
  }
  const steps = stepsRaw.map(normalizeStep);
  if (!steps.length) throw new FlowError('`steps:` is empty');
  return { appId, config, steps, requires };
}

// unwrap a scalar leaf ({__scalar} wrapper) to its value.
function unwrap(v) { return v && typeof v === 'object' && '__scalar' in v ? v.__scalar : v; }

// Convert a parsed config subtree (nested map of {__scalar} leaves or an inline object) to a plain map.
function plainMap(v) {
  if (v == null) return {};
  if ('__scalar' in v) return typeof v.__scalar === 'object' ? v.__scalar : {};
  const out = {};
  for (const [k, val] of Object.entries(v)) out[k] = unwrap(val);
  return out;
}

// Load + parse a flow file from disk. Adds the file path to any error for context.
function loadFlow(file) {
  let src;
  try { src = fs.readFileSync(file, 'utf8'); } catch (e) { throw new FlowError(`cannot read flow ${file}: ${e.message}`); }
  try {
    const flow = parseFlow_(src);
    flow.file = file;
    flow.name = path.basename(file).replace(/\.e2e\.ya?ml$/i, '').replace(/\.ya?ml$/i, '');
    return flow;
  } catch (e) {
    if (e instanceof FlowError) throw Object.assign(new FlowError(`${path.basename(file)}: ${e.message}`), { validation: !!e.validation });
    throw e;
  }
}

// Expand CLI flow arguments (files or directories) into a flat list of *.e2e.yaml files.
function collectFlowFiles(inputs) {
  const files = [];
  for (const input of inputs) {
    let st;
    try { st = fs.statSync(input); } catch (e) { throw new FlowError(`no such flow path: ${input}`); }
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(input).sort()) {
        if (/\.e2e\.ya?ml$/i.test(name)) files.push(path.join(input, name));
      }
    } else {
      files.push(input);
    }
  }
  return files;
}

module.exports = { parseFlow: parseFlow_, loadFlow, collectFlowFiles, normalizeStep, checkLaunchParams, checkRequires, VALID_KEYS, FlowError };
