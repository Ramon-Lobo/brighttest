'use strict';

// Reads an app's self-published state snapshot. Roku's ECP can't see m.global, custom interface fields,
// or component locals — but a node's `text` attribute IS serialized in /query/sgnodes/all. So an app that
// wants its state inspectable mirrors a JSON snapshot into a hidden Label with the well-known id
// "__bt_state" (see BTState_publish in the streaming sample). Here we find that node and parse it back.

const sg = require('./sgnodes');

const STATE_NODE_ID = '__bt_state';
const LAYOUT_NODE_ID = '__bt_layout';
const AGENT_NODE_ID = '__bt_agent';

// Largest published text the reader accepts: a hidden Label's text read back intact up to 256 KB on
// firmware 16.0.4 (measured; larger sizes untested). A bigger payload is an error with a typed code
// (STATE_TOO_LARGE), never silently truncated.
const MAX_STATE_BYTES = 256 * 1024;

function stateError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

// Find a publish node (a hidden Label whose text is JSON) and parse it.
function extractPublished(roots, nodeId) {
  const node = sg.flatten(roots || []).find((n) => n.id === nodeId);
  if (!node) return { present: false, state: null, error: null, raw: null };
  const raw = node.text != null ? node.text : node.attrs && node.attrs.text;
  if (raw == null || raw === '') return { present: true, state: null, error: 'empty', raw: null };
  try {
    return { present: true, state: JSON.parse(raw), error: null, raw };
  } catch (e) {
    return { present: true, state: null, error: `invalid JSON (${e.message})`, raw };
  }
}

// Find the __bt_state node in a parsed tree and parse its JSON text.
// Returns { present, state, error, raw }: present=false when the app doesn't publish state at all.
function extractAppState(roots) {
  return extractPublished(roots, STATE_NODE_ID);
}

// Grid layout hints from __bt_layout (see BTLayout_publish): { "<gridId>": { itemSize, itemSpacing,
// numColumns, … } }. Roku's ECP omits every ArrayGrid layout field, so the studio can only ESTIMATE grid
// item positions from the rendered run; an app that publishes these makes them exact. Returns null when
// absent or unreadable — callers fall back to estimation, never fail.
function extractLayoutHints(roots) {
  const res = extractPublished(roots, LAYOUT_NODE_ID);
  return res.present && res.state && typeof res.state === 'object' ? res.state : null;
}

// Parse the agent node (__bt_agent, STA-S-T1). The document is {v, seq, snapshot: {layers: {global, scene,
// focus}}, truncated, ...}. Returns { present, layers, doc, seq, truncated, error }; layers is {} when absent.
// Throws STATE_TOO_LARGE when the published text exceeds MAX_STATE_BYTES.
function extractAgentState(roots, { maxBytes = MAX_STATE_BYTES } = {}) {
  const res = extractPublished(roots, AGENT_NODE_ID);
  const none = { present: res.present, layers: {}, doc: null, seq: null, truncated: [], error: res.error };
  if (!res.present || res.raw == null) return none;
  const size = Buffer.byteLength(res.raw, 'utf8');
  if (size > maxBytes) {
    throw stateError('STATE_TOO_LARGE', `app state is ${size} bytes, over the ${maxBytes}-byte read limit (256 KB); shrink what the agent publishes (instrument.publish.maxBytes / redact)`);
  }
  const doc = res.state;
  const layers = doc && doc.snapshot && typeof doc.snapshot.layers === 'object' && doc.snapshot.layers ? doc.snapshot.layers : null;
  if (!layers) return { ...none, error: 'agent document has no snapshot.layers' };
  return { present: true, layers, doc, seq: doc.seq == null ? null : doc.seq, truncated: Array.isArray(doc.truncated) ? doc.truncated : [], error: null };
}

// Read the agent state through the node-id fast path (nodes?node-id=__bt_agent), falling back to the full
// tree when the fast path misses (fetchTreeFor). Returns the extractAgentState result plus fastPath.
async function readAgentState(device, opts, extractOpts) {
  const tree = await sg.fetchTreeFor(device, { id: AGENT_NODE_ID }, opts);
  return { ...extractAgentState(tree.roots, extractOpts), fastPath: !!tree.fastPath };
}

// Fetch the live tree and extract app state in one call.
async function readAppState(device, opts) {
  const tree = await sg.fetchTree(device, opts);
  return extractAppState(tree.roots);
}

// Pick the own key of `obj` matching `seg`: exact case wins, otherwise the first key equal ignoring case
// (the agent's wire keys are lowercased, authors write the name as it appears in code). Arrays index by number.
function resolveKey(obj, seg) {
  if (Array.isArray(obj)) return Object.prototype.hasOwnProperty.call(obj, seg) ? seg : undefined;
  if (Object.prototype.hasOwnProperty.call(obj, seg)) return seg;
  const lower = String(seg).toLowerCase();
  return Object.keys(obj).find((k) => k.toLowerCase() === lower);
}

// Walk a dot-separated path into parsed JSON with case-insensitive segments (exact case wins).
// Returns { value, keys }: value is undefined when a segment is missing, and keys then lists the keys
// available at the object where the walk stopped (names only, never values) for the error message.
function getPathCI(obj, dotted) {
  let cur = obj;
  for (const seg of String(dotted).split('.')) {
    if (cur == null || typeof cur !== 'object') return { value: undefined, keys: null };
    const k = resolveKey(cur, seg);
    if (k === undefined) return { value: undefined, keys: Array.isArray(cur) ? null : Object.keys(cur) };
    cur = cur[k];
  }
  return { value: cur, keys: null };
}

// ---- assertState failure-message redaction ---------------------------------------------------------------------
// Off by default (a person at the keyboard sees real values). On when the run says so, in this order of
// precedence: runner option `redactState` (the CLI flag), env BRIGHTTEST_REDACT_STATE, the flow's
// `config: { redactState }`, then brighttest.json `redactState`. When on, an app value whose path has a
// sensitive key segment or sits under a mask from instrument.state.redact.paths is replaced by
// "<redacted:key>" in the failure message and the step detail; a value that only contains such keys is
// scrubbed inside. Key and mask matching ignores case. Kept local to this file: it does not use events.redact.
const SENSITIVE_SEG = /token|secret|password|passwd|session|auth|cookie|apikey|api_key/i;
// This is a safety switch, so only a recognised false turns it off; any other non-empty value turns it on.
function isFalse(v) { return v === false || v === 0 || (typeof v === 'string' && /^(0|false|no|off)$/i.test(v.trim())); }
function isSet(v) { return !(v === undefined || v === null || (typeof v === 'string' && v.trim() === '')); }
function redactStateOn(ctx = {}, env = process.env) {
  if (ctx.redactState === true) return true; // resolved for the parent flow and carried into subflows
  const cands = [ctx.opts && ctx.opts.redactState, env && env.BRIGHTTEST_REDACT_STATE,
    ctx.flow && ctx.flow.config && ctx.flow.config.redactState, ctx.cfg && ctx.cfg.redactState];
  for (const v of cands) { if (!isSet(v)) continue; return !isFalse(v); }
  return false;
}
function stateMasks(cfg) {
  const r = cfg && cfg.instrument && cfg.instrument.state && cfg.instrument.state.redact;
  return r && Array.isArray(r.paths) ? r.paths.filter((v) => typeof v === 'string') : [];
}
const lc = (x) => String(x).toLowerCase();
const segMatch = (pat, seg) => pat === '*' || lc(pat) === lc(seg);
const mark = (key) => JSON.stringify(`<redacted:${key}>`);
// Deep copy of `v` with sensitive keys and `rel` masks (dotted, relative to v, `*` = one segment) replaced.
function scrub(v, rel, segs = []) {
  if (Array.isArray(v)) return v.map((x, i) => scrub(x, rel, segs.concat(String(i))));
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      const here = segs.concat(k);
      const masked = SENSITIVE_SEG.test(k) || rel.some((m) => { const ms = m.split('.'); return ms.length === here.length && ms.every((q, i) => segMatch(q, here[i])); });
      out[k] = masked ? `<redacted:${k}>` : scrub(x, rel, here);
    }
    return out;
  }
  return v;
}
// `shown(layer, path, value)` returns a JSON string of `value` that is safe to print: a placeholder for a masked
// path, the value scrubbed by key otherwise.
function makeShown(on, masks = []) {
  if (!on) return (layer, p, v) => JSON.stringify(v);
  return (layer, p, v) => {
    const segs = (layer !== undefined ? [layer] : []).concat(String(p).split('.'));
    const last = segs[segs.length - 1];
    const rel = [];
    for (const m of masks) {
      const ms = m.split('.');
      const n = Math.min(ms.length, segs.length);
      if (!ms.slice(0, n).every((x, i) => segMatch(x, segs[i]))) continue;
      if (ms.length <= segs.length) return mark(last);
      rel.push(ms.slice(segs.length).join('.'));
    }
    if (segs.some((x) => SENSITIVE_SEG.test(x))) return mark(last);
    return JSON.stringify(scrub(v, rel));
  };
}

module.exports = { redactStateOn, stateMasks, makeShown, resolveKey, getPathCI, STATE_NODE_ID, LAYOUT_NODE_ID, AGENT_NODE_ID, MAX_STATE_BYTES, extractAgentState, readAgentState, extractAppState, extractLayoutHints, readAppState };
