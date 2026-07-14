'use strict';
const { flatten } = require('./sgnodes');

// Selector engine: match nodes in a parsed sgnodes tree. A selector is a plain object; any combination
// of these narrows the match, and all present keys must hold (AND):
//   { id }                     — the built-in SceneGraph id (dumped as name=); the stable, preferred hook
//   { subtype }                — node type, e.g. "Label", "RowList"
//   { text }                   — exact visible text
//   { uri }                    — exact uri (posters/images)
//   { textContains }           — substring of visible text (looser)
//   { visible: true|false }    — visibility filter (a node with no explicit flag is treated as visible)
//   { focusable: true }        — only focusable nodes
//   { focused: true }          — only the currently focused node
//   { index: N }               — pick the Nth match (0-based) after all other filters
//
// A dedicated `testId` is intentionally unsupported: probe 2 proved custom fields never surface in
// sgnodes, so `id` (→ name=) is the only reliable named hook. See design/e2e-lane.md.

const MATCH_KEYS = ['id', 'subtype', 'text', 'uri', 'textContains', 'visible', 'focusable', 'focused'];

// True if `node` satisfies every present criterion in `sel`.
function matches(node, sel) {
  if (sel.id !== undefined && node.id !== sel.id) return false;
  if (sel.subtype !== undefined && node.subtype !== sel.subtype) return false;
  if (sel.text !== undefined && node.text !== sel.text) return false;
  if (sel.textContains !== undefined && !(node.text || '').includes(sel.textContains)) return false;
  if (sel.uri !== undefined && node.uri !== sel.uri) return false;
  // A node with no explicit `visible` flag defaults to visible in SceneGraph.
  if (sel.visible === true && node.visible === false) return false;
  if (sel.visible === false && node.visible !== false) return false;
  if (sel.focusable === true && node.focusable !== true) return false;
  if (sel.focused === true && node.focused !== true) return false;
  return true;
}

// All nodes matching `sel`, in depth-first order. If `sel.index` is set, the result is narrowed to that
// single position (empty if out of range).
function matchAll(roots, sel) {
  if (!sel || typeof sel !== 'object') throw new Error('selector must be an object');
  if (!MATCH_KEYS.some((k) => sel[k] !== undefined)) {
    throw new Error(`selector needs at least one of: ${MATCH_KEYS.join(', ')} (got ${describe(sel)})`);
  }
  const all = flatten(roots).filter((n) => matches(n, sel));
  if (sel.index !== undefined) {
    const one = all[sel.index];
    return one ? [one] : [];
  }
  return all;
}

// The first node matching `sel`, or null.
function matchOne(roots, sel) {
  return matchAll(roots, sel)[0] || null;
}

// Human-readable selector for logs/errors, e.g. `{id: settingsTile}` or `{subtype: Label, text: "Play"}`.
function describe(sel) {
  if (!sel || typeof sel !== 'object') return String(sel);
  const parts = Object.entries(sel).map(([k, v]) => `${k}: ${typeof v === 'string' ? JSON.stringify(v) : v}`);
  return `{${parts.join(', ')}}`;
}

module.exports = { matches, matchAll, matchOne, describe, MATCH_KEYS };
