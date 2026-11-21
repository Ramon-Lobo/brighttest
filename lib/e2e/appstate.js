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

module.exports = { STATE_NODE_ID, LAYOUT_NODE_ID, AGENT_NODE_ID, MAX_STATE_BYTES, extractAgentState, readAgentState, extractAppState, extractLayoutHints, readAppState };
