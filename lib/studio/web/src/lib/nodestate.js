// Pure helpers for the Node tab's State view (STUDIO-NS-T2): rows with editability, marker detection, refusal text,
// failure messages, duplicate-id check and the "+ assert" line. No DOM and no fetch, so they are unit tested.
import { selectorFor, innerSel } from './steps.js';

export const NO_ID_TEXT = 'The agent finds nodes by id. Give this node an id in the app, or pick an ancestor that has one.';
export const TOO_LARGE_TEXT = 'Over 64 KB at the current caps.';
export const NO_HUB_TEXT = 'No instrument hub is running in Studio. It starts while Studio holds the device lease and BRIGHTTEST_HUB_TOKEN is set. It does not start when Studio uses a device pool (deviceLease.pool): start Studio with --host <ip>.';
export const LOCKED_TEXT = 'Device is held by another session, so the live node state is unavailable.';
export const NOT_INSTRUMENTED_TEXT = 'The app has not connected to the hub yet (no agent hello), or the build is not instrumented: node state is unavailable. The Fields view still works.';

export const isNodeRef = (v) => !!v && typeof v === 'object' && !Array.isArray(v) && typeof v.$node === 'string';
export const isRedacted = (v) => typeof v === 'string' && /^<redacted:[^>]*>$/.test(v);
export const isMarker = (v) => typeof v === 'string' && (v.startsWith('$truncated:') || v.startsWith('$type:'));

// Flatten a read value into rows. A `{ $node }` object is one leaf (a link), not a branch. Leaves carry the dotted
// `path` relative to the layer (the path the server and the agent take), a `kind`, and whether the row can be edited.
export function rowsOfNode(obj, prefix = '', depth = 0, out = []) {
  const entries = Array.isArray(obj) ? obj.map((v, i) => [String(i), v]) : Object.entries(obj || {});
  for (const [k, v] of entries) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (isNodeRef(v)) {
      out.push({ depth, key: k, path, branch: false, kind: 'node', value: v, type: 'node', id: v.$node, subtype: typeof v.subtype === 'string' ? v.subtype : '', editable: false });
    } else if (v !== null && typeof v === 'object') {
      out.push({ depth, key: k, path, branch: true, badge: Array.isArray(v) ? `[${v.length}]` : '{…}' });
      rowsOfNode(v, path, depth + 1, out);
    } else {
      const type = v === null ? 'null' : typeof v;
      const kind = isMarker(v) ? 'marker' : isRedacted(v) ? 'redacted' : 'value';
      out.push({
        depth, key: k, path, branch: false, kind, value: v, type,
        load: typeof v === 'string' && v.startsWith('$truncated:depth'),
        editable: kind === 'value' && type !== 'null',
      });
    }
  }
  return out;
}

// Why a row cannot be edited (tooltip), or '' when it can.
export function readOnlyReason(row, { canEdit, why } = {}) {
  if (row.kind === 'node') return 'a node reference: open that node to edit its fields';
  if (row.kind === 'marker') return 'a truncation or type marker, not a real value';
  if (row.kind === 'redacted') return 'masked field: not a real value, cannot be edited';
  if (row.type === 'null') return 'the value is empty, so its type is unknown; edit it in the app';
  if (!canEdit) return why || 'read only';
  return '';
}

// The edit keeps the field's current type: a string field stays a string ("123" is not turned into 123).
export function parseEdit(text, type) {
  if (type === 'string') return { ok: true, value: text };
  if (type === 'number') { const n = Number(text); return text.trim() !== '' && Number.isFinite(n) ? { ok: true, value: n } : { ok: false, why: 'enter a number' }; }
  if (type === 'boolean') return text === 'true' || text === 'false' ? { ok: true, value: text === 'true' } : { ok: false, why: 'enter true or false' };
  try { return { ok: true, value: JSON.parse(text) }; } catch { return { ok: true, value: text }; }
}

const HINTS = {
  FIELD_NOT_FOUND: 'No such field on this node (and `m` never adds keys).',
  TYPE_MISMATCH: 'The field holds a different type than the value sent.',
  PATH_UNDER_NODE: 'The path crosses a node reference: edit the field on that node instead.',
  M_NOT_AVAILABLE: 'Built-in node or an excluded component: it has no `m`.',
  M_PATH_FORBIDDEN: 'That part of `m` is not writable or readable through the agent.',
  NODE_NOT_FOUND: 'The node left the scene.',
  REDACTED_VALUE: 'The value is a masked placeholder; enter the real value.',
  STATE_TOO_LARGE: TOO_LARGE_TEXT,
  BAD_PATH: 'The path is not valid for this layer.',
  BAD_COMMAND: 'The request was not accepted.',
};
export const refusalHint = (code) => HINTS[code] || '';

// "CODE: message" (the agent's error text on a failed command) to { code, message }.
export function splitError(text) {
  const m = /^([A-Z][A-Z0-9_]*): ?([\s\S]*)$/.exec(String(text || ''));
  return m ? { code: m[1], message: m[2] } : { code: '', message: String(text || '') };
}

// Chip text for a refusal: the code, the agent's message and a short hint.
export function refusalText(text, code) {
  const s = splitError(text);
  const c = code || s.code;
  const hint = refusalHint(c);
  return [c, s.message && s.message !== c ? s.message : '', hint].filter(Boolean).join(' - ');
}

// A failed read (api.stateNode body with status) to { kind, text, large?, readOnly }.
//   kind: 'locked' | 'nohub' | 'noagent' | 'large' | 'gone' | 'error'
export function readFailure(r) {
  const msg = (r && r.error) || 'request failed';
  if (!r) return { kind: 'error', text: 'request failed' };
  if (r.status === 423) return { kind: 'locked', text: LOCKED_TEXT };
  if (r.status === 503) return { kind: 'nohub', text: typeof r.error === 'string' && r.error.trim() ? r.error : NO_HUB_TEXT };
  if (r.code === 'STATE_NOT_INSTRUMENTED') return { kind: 'noagent', text: NOT_INSTRUMENTED_TEXT };
  if (r.code === 'STATE_TOO_LARGE') return { kind: 'large', text: TOO_LARGE_TEXT };
  if (r.code === 'NODE_NOT_FOUND') return { kind: 'gone', text: `${r.code}: ${msg}. ${HINTS.NODE_NOT_FOUND}` };
  if (r.code === 'ACK_TIMEOUT') return { kind: 'error', text: 'The app did not answer in time (ACK_TIMEOUT). Retrying while this view is open.' };
  const hint = refusalHint(r.code);
  return { kind: 'error', text: `${r.code || r.status}: ${msg}${hint ? ' - ' + hint : ''}` };
}

// How many tree nodes carry this id (the agent reads the first one it finds).
export const dupCount = (nodes, id) => (id ? (nodes || []).filter((n) => n.id === id).length : 0);
export const dupText = (n, id) => `${n} nodes have id ${id}; the agent reads the first one it finds, which may not be this one.`;

// The first tree node with this id (a `$node` link target), or null.
export const nodeByIdPath = (nodes, id) => ((nodes || []).find((n) => n.id === id) || {}).path || null;

// Immutable set of `value` at a dotted path in a read result (a loaded sub-path replaces its `$truncated` marker).
export function setAt(root, path, value) {
  if (!path) return value;
  const segs = path.split('.');
  const put = (cur, i) => {
    if (i === segs.length) return value;
    const base = Array.isArray(cur) ? cur.slice() : cur && typeof cur === 'object' ? { ...cur } : {};
    base[segs[i]] = put(base[segs[i]], i + 1);
    return base;
  };
  return put(root, 0);
}

// The nearest node reference at or above `path` (the target of a PATH_UNDER_NODE refusal's "go to node" link).
export function nodeRefOnPath(root, path) {
  let cur = root;
  for (const seg of String(path || '').split('.')) {
    if (isNodeRef(cur)) return cur.$node;
    if (!cur || typeof cur !== 'object') return null;
    cur = cur[seg];
  }
  return isNodeRef(cur) ? cur.$node : null;
}

// "+ assert" line for a leaf. Node layer: assertField (ECP string value), only when the field is one of the node's
// ECP attrs. `m` has no assertField; use assertStateLine for both layers.
export function assertLine(node, layer, row) {
  if (!node || layer !== 'node' || row.branch || row.kind !== 'value' || row.path.includes('.')) return null;
  const attrs = node.attrs || {};
  if (!Object.prototype.hasOwnProperty.call(attrs, row.path)) return null;
  return `- assertField: { ${innerSel(node)}, field: ${row.path}, equals: ${JSON.stringify(String(attrs[row.path]))} }`;
}

// "+ assert" line for a leaf (NS-T4): assertState read through the hub, for layer node and m, at any depth. Only plain
// values: a masked value, a truncation marker, a node reference and a branch have nothing stable to compare.
export function assertStateLine(id, layer, row) {
  if (!id || (layer !== 'node' && layer !== 'm') || !row || row.branch || row.kind !== 'value' || !row.path) return null;
  const v = row.type === 'string' ? JSON.stringify(row.value) : row.type === 'null' ? 'null' : String(row.value);
  return `- assertState: { layer: ${layer}, node: { id: ${JSON.stringify(id)} }, path: ${row.path}, equals: ${v} }`;
}

// Selector-free id used by the panel: the selected node's id, or the hand-typed one (simulator).
export const effectiveId = (node, typed) => (node ? node.id || '' : String(typed || '').trim());

export { selectorFor };
