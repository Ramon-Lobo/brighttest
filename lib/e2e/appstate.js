'use strict';

// Reads an app's self-published state snapshot. Roku's ECP can't see m.global, custom interface fields,
// or component locals — but a node's `text` attribute IS serialized in /query/sgnodes/all. So an app that
// wants its state inspectable mirrors a JSON snapshot into a hidden Label with the well-known id
// "__bt_state" (see BTState_publish in the streaming sample). Here we find that node and parse it back.

const sg = require('./sgnodes');

const STATE_NODE_ID = '__bt_state';
const LAYOUT_NODE_ID = '__bt_layout';

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

// Fetch the live tree and extract app state in one call.
async function readAppState(device, opts) {
  const tree = await sg.fetchTree(device, opts);
  return extractAppState(tree.roots);
}

module.exports = { STATE_NODE_ID, LAYOUT_NODE_ID, extractAppState, extractLayoutHints, readAppState };
