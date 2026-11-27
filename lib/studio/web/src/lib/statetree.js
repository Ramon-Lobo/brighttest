// Shared state tree model (pure, unit tested): rows with branch paths, the collapse model, chunking, search and
// the bounded per-layer persistence. StateTree.svelte renders it; callers keep their own value cells.
import { isNodeRef, isRedacted, isMarker } from './nodestate.js';

export const AUTO_COLLAPSE = 20; // a branch with more children than this starts collapsed
export const CHUNK = 100;        // children rendered per "show more" step
export const STORAGE_KEY = 'bt.studio.statetree';
export const MAX_KEYS = 100;
export const MAX_PATHS = 500;

// Default row classification for a non-branch value (same facts rowsOfNode gives the node State view).
export function classifyDefault(v) {
  if (isNodeRef(v)) {
    return { branch: false, kind: 'node', value: v, type: 'node', id: v.$node, subtype: typeof v.subtype === 'string' ? v.subtype : '', editable: false };
  }
  const type = v === null ? 'null' : typeof v;
  const kind = isMarker(v) ? 'marker' : isRedacted(v) ? 'redacted' : 'value';
  return {
    branch: false, kind, value: v, type,
    load: typeof v === 'string' && v.startsWith('$truncated:depth'),
    editable: kind === 'value' && type !== 'null',
  };
}

// Flatten a value into DFS rows. Every row has path (also on branches), parent ('' at the top), depth, idx (position
// among its siblings) and end (index of the first row after its subtree). Branches add count, kind (array/object)
// and badge. `classify(v, key, path)` may return the row fields for a non-branch value. `rows.rootCount` is the
// number of top-level rows.
export function treeRows(value, { classify = classifyDefault } = {}) {
  const out = [];
  const walk = (obj, prefix, depth) => {
    const entries = Array.isArray(obj) ? obj.map((v, i) => [String(i), v]) : Object.entries(obj || {});
    let idx = 0;
    for (const [key, v] of entries) {
      const path = prefix ? `${prefix}.${key}` : key;
      const base = { key, path, parent: prefix, depth, idx: idx++ };
      if (v !== null && typeof v === 'object' && !isNodeRef(v)) {
        const arr = Array.isArray(v);
        const count = arr ? v.length : Object.keys(v).length;
        const row = { ...base, branch: true, kind: arr ? 'array' : 'object', count, badge: arr ? `[${count}]` : `{${count} keys}`, end: 0 };
        out.push(row);
        walk(v, path, depth + 1);
        row.end = out.length;
      } else {
        out.push({ ...base, ...classify(v, key, path), end: out.length + 1 });
      }
    }
    return idx;
  };
  out.rootCount = walk(value, '', 0);
  return out;
}

// Collapse model: paths the user collapsed, paths the user expanded (these override the auto-collapse default).
export const newModel = () => ({ collapsed: new Set(), expanded: new Set() });

export function isCollapsed(row, model) {
  if (!row.branch) return false;
  if (model.expanded.has(row.path)) return false;
  if (model.collapsed.has(row.path)) return true;
  return row.count > AUTO_COLLAPSE;
}

export function setCollapsed(model, row, collapsed) {
  model.collapsed.delete(row.path);
  model.expanded.delete(row.path);
  (collapsed ? model.collapsed : model.expanded).add(row.path);
}

export const toggle = (model, row) => setCollapsed(model, row, !isCollapsed(row, model));

export function collapseAll(rows, model) {
  model.expanded.clear();
  model.collapsed.clear();
  for (const r of rows) if (r.branch) model.collapsed.add(r.path);
}

export function expandAll(rows, model) {
  model.expanded.clear();
  model.collapsed.clear();
  for (const r of rows) if (r.branch) model.expanded.add(r.path);
}

// Rows to render. `more` maps a parent path to how many of its children are shown (default CHUNK). A chunk edge
// emits one `{ more: true, parent, remaining, depth, path }` row. `keep` (a Set of paths, filter mode) hides
// every other row.
export function visible(rows, model, { more = {}, keep = null } = {}) {
  const out = [];
  const total = new Map([['', rows.rootCount ?? rows.filter((r) => r.parent === '').length]]);
  for (const r of rows) if (r.branch) total.set(r.path, r.count);
  let i = 0;
  while (i < rows.length) {
    const r = rows[i];
    const limit = more[r.parent] ?? CHUNK;
    if (r.idx >= limit) {
      if (r.idx === limit && !keep) {
        out.push({ more: true, parent: r.parent, remaining: total.get(r.parent) - limit, depth: r.depth, path: `${r.parent}#more` });
      }
      i = r.end;
      continue;
    }
    if (keep && !keep.has(r.path)) { i = r.end; continue; } // a hidden branch has no kept descendant: ancestors are kept
    out.push(r);
    i = r.branch && isCollapsed(r, model) ? r.end : i + 1;
  }
  return out;
}

// Show the next chunk of a parent's children.
export const showMore = (more, parent) => ({ ...more, [parent]: (more[parent] ?? CHUNK) + CHUNK });

// Expand every ancestor of `path` (remembered like a manual expand) and make its chunk visible.
export function reveal(rows, model, more, path) {
  const byPath = new Map(rows.map((r) => [r.path, r]));
  let next = more;
  for (let r = byPath.get(path); r; r = byPath.get(r.parent)) {
    if (r.path !== path) setCollapsed(model, r, false);
    if ((next[r.parent] ?? CHUNK) <= r.idx) next = { ...next, [r.parent]: r.idx + 1 };
  }
  return next;
}

// Search -------------------------------------------------------------------------------------------------------

// A value as shown: strings without quotes, numbers, booleans, null. Node links show their id.
export function displayValue(row) {
  if (row.branch) return '';
  const v = row.value;
  if (row.kind === 'node') return String(row.id ?? '');
  return v === null ? 'null' : String(v);
}

// match(rows, query, { caseSensitive, mode }) -> { matches: [path...], ancestors: Set, keep: Set|null }.
// A row matches on its key, dotted path or displayed value. `keep` (filter mode) is matches plus ancestors.
export function match(rows, query, { caseSensitive = false, mode = 'highlight' } = {}) {
  const q = String(query ?? '');
  const empty = { matches: [], ancestors: new Set(), keep: null };
  if (!q) return empty;
  const norm = caseSensitive ? (s) => s : (s) => s.toLowerCase();
  const needle = norm(q);
  const matches = [];
  const hit = new Set();
  for (const r of rows) {
    if (norm(r.key).includes(needle) || norm(r.path).includes(needle) || norm(displayValue(r)).includes(needle)) {
      matches.push(r.path);
      hit.add(r.path);
    }
  }
  const byPath = new Map(rows.map((r) => [r.path, r]));
  const ancestors = new Set();
  for (const p of matches) {
    for (let r = byPath.get(byPath.get(p).parent); r && !ancestors.has(r.path); r = byPath.get(r.parent)) ancestors.add(r.path);
  }
  return { matches, ancestors, keep: mode === 'filter' ? new Set([...hit, ...ancestors]) : null };
}

// Current match index, kept by path across refreshes: same path if still a match, else the old index clamped.
export function currentIndex(matches, prevPath, prevIndex = 0) {
  if (!matches.length) return -1;
  const at = prevPath == null ? -1 : matches.indexOf(prevPath);
  if (at >= 0) return at;
  return Math.max(0, Math.min(prevIndex, matches.length - 1));
}

export const stepIndex = (n, index, dir) => (n ? (((index + dir) % n) + n) % n : -1);

// Several trees (layers) behind one search bar. `order` is the layer keys in display order, `byKey` maps a key to that
// tree's matches. Result: [{ key, path }...] in display order, so next/prev walks layer after layer.
export const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

export function combineMatches(order, byKey) {
  const out = [];
  for (const key of order) for (const path of byKey[key] || []) out.push({ key, path });
  return out;
}

// Index of the current match across layers: the same { key, path } if it is still a match, else the old index clamped.
export function locateCurrent(all, cur, prevIndex = 0) {
  if (!all.length) return -1;
  if (cur) {
    const at = all.findIndex((m) => m.key === cur.key && m.path === cur.path);
    if (at >= 0) return at;
  }
  return Math.max(0, Math.min(prevIndex, all.length - 1));
}

// Split text into { text, mark } segments for <mark> rendering (text only, never HTML).
export function highlight(text, query, caseSensitive = false) {
  const s = String(text ?? '');
  const q = String(query ?? '');
  if (!q) return [{ text: s, mark: false }];
  const hay = caseSensitive ? s : s.toLowerCase();
  const needle = caseSensitive ? q : q.toLowerCase();
  const out = [];
  let at = 0;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, at)) {
    if (i > at) out.push({ text: s.slice(at, i), mark: false });
    out.push({ text: s.slice(i, i + q.length), mark: true });
    at = i + q.length;
  }
  if (at < s.length) out.push({ text: s.slice(at), mark: false });
  return out.length ? out : [{ text: s, mark: false }];
}

// Persistence: { v:1, keys: { "<storageKey>": { c, e, t } } }, <= 100 keys (LRU), <= 500 paths per list ----------

export function loadStore(storage) {
  try {
    const v = JSON.parse(storage.getItem(STORAGE_KEY));
    if (v && v.v === 1 && v.keys && typeof v.keys === 'object') return v;
  } catch { /* unreadable: start empty */ }
  return { v: 1, keys: {} };
}

export function restoreModel(store, key) {
  const m = newModel();
  const e = store.keys[key];
  if (e) {
    for (const p of e.c || []) if (typeof p === 'string') m.collapsed.add(p);
    for (const p of e.e || []) if (typeof p === 'string') m.expanded.add(p);
  }
  return m;
}

// Returns a new store with `model` saved under `key`. Paths absent from `rows` are dropped; the newest paths win
// at the cap; the least recently used keys fall off.
export function remember(store, key, model, rows, now = Date.now()) {
  const exists = rows ? new Set(rows.map((r) => r.path)) : null;
  const pack = (set) => [...set].filter((p) => !exists || exists.has(p)).slice(-MAX_PATHS);
  const keys = { ...store.keys, [key]: { c: pack(model.collapsed), e: pack(model.expanded), t: now } };
  const names = Object.keys(keys);
  if (names.length > MAX_KEYS) {
    names.sort((a, b) => (keys[a].t || 0) - (keys[b].t || 0));
    for (const n of names.slice(0, names.length - MAX_KEYS)) delete keys[n];
  }
  return { v: 1, keys };
}

export function saveStore(storage, store) {
  try { storage.setItem(STORAGE_KEY, JSON.stringify(store)); } catch { /* quota or private mode: not remembered */ }
}

// Debounced writer (500 ms). `timers` is injectable for tests.
export function createPersister(storage, { delay = 500, timers = { set: (f, ms) => setTimeout(f, ms), clear: (t) => clearTimeout(t) } } = {}) {
  let store = loadStore(storage);
  let timer = null;
  const flush = () => { if (timer) { timers.clear(timer); timer = null; } saveStore(storage, store); };
  return {
    get: (key) => restoreModel(store, key),
    save(key, model, rows) {
      store = remember(store, key, model, rows);
      if (timer) timers.clear(timer);
      timer = timers.set(flush, delay);
    },
    flush,
  };
}
