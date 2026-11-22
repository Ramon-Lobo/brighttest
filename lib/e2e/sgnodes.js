'use strict';

// Reads the live SceneGraph tree over ECP and turns it into a lightweight JS tree the selector engine
// and focus navigator can work with. sgnodes is an RPC on the app's render thread: it fails while a
// channel isn't running, is refused in Limited mode, and times out when the thread is busy — so every
// read retries with backoff, and callers settle-wait after actions. Pure string parsing (no XML dep),
// because Roku's sgnodes output is simple, well-formed, and element/attribute-only.
//
// Shape of the response (query/sgnodes/all):
//   <sgnodes> … <All_Nodes node-count="N"> <Default …/> <Scene …> <Label name="foo" …/> … </Scene>
//   </All_Nodes> <status>OK</status> </sgnodes>
// A node's SceneGraph `id` is serialized as the `name=` attribute (confirmed by probe 2 in FINDINGS.md).

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function decodeEntities(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// "{0, 0, 1920, 1080}" → {x,y,w,h}; "{100, 200}" → {x,y}. Returns null if not the expected shape.
function parseTuple(v) {
  const m = String(v).match(/-?\d+(?:\.\d+)?/g);
  if (!m) return null;
  const n = m.map(Number);
  if (n.length >= 4) return { x: n[0], y: n[1], w: n[2], h: n[3] };
  if (n.length >= 2) return { x: n[0], y: n[1] };
  return null;
}

// Parse a node element's raw attribute string into a map (entity-decoded).
function parseAttrs(raw) {
  const attrs = {};
  for (const m of String(raw).matchAll(/([\w.:-]+)\s*=\s*"([^"]*)"/g)) {
    attrs[m[1]] = decodeEntities(m[2]);
  }
  return attrs;
}

// Map a raw element {tag, attrs, children} to the node shape the rest of the lane consumes.
function toNode(el) {
  const a = el.attrs;
  return {
    subtype: el.tag,
    id: a.name || null, // SceneGraph id ⇒ dumped as name=
    text: a.text !== undefined ? a.text : null,
    uri: a.uri !== undefined ? a.uri : null,
    bounds: a.bounds ? parseTuple(a.bounds) : null,
    translation: a.translation ? parseTuple(a.translation) : null,
    visible: a.visible === undefined ? null : a.visible === 'true',
    focusable: a.focusable === undefined ? null : a.focusable === 'true',
    focused: a.focused === 'true',
    opacity: a.opacity !== undefined ? Number(a.opacity) : null,
    attrs: a,
    children: (el.children || []).map(toNode),
  };
}

// Generic, tolerant parser for Roku's sgnodes XML → a stack-built element tree. Ignores the XML prolog,
// comments, and text content (node elements carry only attributes). Returns the root <sgnodes> element.
function parseXmlElements(xml) {
  const root = { tag: '#root', attrs: {}, children: [] };
  const stack = [root];
  // Matches: <?xml …?>, <!-- … -->, and open/close/self-closing tags with a quoted-attr body.
  const tagRe = /<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<(\/)?([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*"[^"]*")*)\s*(\/?)>/g;
  let m;
  while ((m = tagRe.exec(xml))) {
    const [full, closing, tag, attrRaw, selfClose] = m;
    if (full.startsWith('<?') || full.startsWith('<!--')) continue;
    if (closing) {
      // Pop to the matching open tag (tolerate minor mismatches without throwing).
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag === tag) { stack.length = i; break; }
      }
      continue;
    }
    const el = { tag, attrs: parseAttrs(attrRaw), children: [] };
    stack[stack.length - 1].children.push(el);
    if (!selfClose) stack.push(el);
  }
  return root.children.find((c) => c.tag === 'sgnodes') || root;
}

// Parse a full sgnodes response into { status, error, roots }. `roots` are the real SceneGraph nodes
// (the `<Default>` placeholder row Roku emits is dropped).
function parseTree(xml) {
  const text = String(xml || '');
  const statusMatch = text.match(/<status>([^<]*)<\/status>/);
  const status = statusMatch ? statusMatch[1].trim() : null;
  if (status === 'FAILED') {
    const err = (text.match(/<error>([^<]*)<\/error>/) || [])[1] || 'unknown';
    return { status, error: err, roots: [] };
  }
  const sg = parseXmlElements(text);
  const container = (sg.children || []).find((c) => c.tag === 'All_Nodes' || c.tag === 'Nodes_Nodes');
  const rawRoots = container ? container.children : [];
  const roots = rawRoots.filter((el) => el.tag !== 'Default').map(toNode);
  return { status: status || 'OK', error: null, roots };
}

// ---- app-ui fallback tree source (ROB-10) --------------------------------------------------------
// GET /query/app-ui answers from a different path than sgnodes and keeps working while sgnodes RPCs fail.
// Differences the parser must handle: the tree sits under <app-ui><topscreen><screen>…, attribute values
// can contain a raw `>` (e.g. text="a > b"), and the response carries no parent information. Nodes built
// from it have NO `parent` field, and the tree result is flagged { source: 'app-ui', parentLinks: false }.
const TREE_SOURCE_SGNODES = 'sgnodes';
const TREE_SOURCE_APP_UI = 'app-ui';
// Consecutive failed sgnodes reads before the app-ui source is tried (named, not derived from `retries`).
const APP_UI_FALLBACK_AFTER = 3;

// Quote-aware scanner: unlike parseXmlElements' regex, a `>` inside "…" does not end the tag.
function parseAppUiElements(xml) {
  const root = { tag: '#root', attrs: {}, children: [] };
  const stack = [root];
  const s = String(xml || '');
  let i = 0;
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    if (lt < 0) break;
    if (s.startsWith('<?', lt)) { const e = s.indexOf('?>', lt); i = e < 0 ? s.length : e + 2; continue; }
    if (s.startsWith('<!--', lt)) { const e = s.indexOf('-->', lt); i = e < 0 ? s.length : e + 3; continue; }
    // find the tag end, skipping quoted attribute values
    let j = lt + 1;
    let q = false;
    while (j < s.length && (q || s[j] !== '>')) { if (s[j] === '"') q = !q; j++; }
    if (j >= s.length) break;
    const body = s.slice(lt + 1, j);
    i = j + 1;
    const m = body.match(/^(\/)?([A-Za-z_][\w.:-]*)([\s\S]*?)(\/?)$/);
    if (!m) continue;
    const [, closing, tag, attrRaw, selfClose] = m;
    if (closing) {
      for (let k = stack.length - 1; k > 0; k--) { if (stack[k].tag === tag) { stack.length = k; break; } }
      continue;
    }
    const el = { tag, attrs: parseAttrs(attrRaw), children: [] };
    stack[stack.length - 1].children.push(el);
    if (!selfClose) stack.push(el);
  }
  return root.children.find((c) => c.tag === 'app-ui') || root;
}

// Parse a /query/app-ui response into { status, error, roots, source, parentLinks }. Roots are the
// children of <screen> (the running scene); <plugin> and status rows are not nodes.
function parseAppUi(xml) {
  const text = String(xml || '');
  const statusMatch = text.match(/<status>([^<]*)<\/status>/);
  const status = statusMatch ? statusMatch[1].trim() : null;
  const base = { source: TREE_SOURCE_APP_UI, parentLinks: false };
  if (status === 'FAILED') {
    return { ...base, status, error: (text.match(/<error>([^<]*)<\/error>/) || [])[1] || 'unknown', roots: [] };
  }
  const ui = parseAppUiElements(text);
  const top = (ui.children || []).find((c) => c.tag === 'topscreen');
  const screens = top ? top.children.filter((c) => c.tag === 'screen') : [];
  const roots = screens.flatMap((sc) => sc.children).map(toNode);
  return { ...base, status: status || 'OK', error: null, roots };
}

// Selectors/operations that walk to a node's parent must call this first: an app-ui tree has no parent
// links, so they fail with a typed error (code TREE_NO_PARENT_LINKS) instead of silently matching nothing.
function requireParentLinks(tree) {
  if (tree && tree.parentLinks === false) {
    const e = new Error('this tree came from the app-ui fallback source, which has no parent links; ' +
      'parent-based selectors need sgnodes.');
    e.code = 'TREE_NO_PARENT_LINKS';
    throw e;
  }
}

// One app-ui read; returns the parsed tree, or null if it failed (callers keep their sgnodes error).
async function tryAppUi(device) {
  try {
    const { text } = await device.ecpGet('/query/app-ui');
    const parsed = parseAppUi(text);
    return parsed.status === 'FAILED' || !parsed.roots.length ? null : parsed;
  } catch { return null; }
}

// Flatten a parsed tree (depth-first) into a node array — handy for selectors and counts.
function flatten(roots) {
  const out = [];
  (function walk(nodes) {
    for (const n of nodes) { out.push(n); if (n.children.length) walk(n.children); }
  })(roots);
  return out;
}

// A signature of "what's focused" (id/subtype/bounds of focused nodes) to detect settle between reads.
function focusSignature(roots) {
  return flatten(roots)
    .filter((n) => n.focused)
    .map((n) => `${n.subtype}#${n.id || ''}@${n.bounds ? `${n.bounds.x},${n.bounds.y}` : ''}`)
    .join('|');
}

function isRpcTimeout(text) {
  return /Plugin RPC event timed out|command exception/i.test(text);
}

// Fetch + parse sgnodes/all, retrying transient render-thread RPC timeouts with linear backoff. Throws
// typed errors (err.code) for the two non-transient failures a caller should handle differently.
//
// Large-tree policy (ROB-11): a full-tree read of a >LARGE_TREE_NODES tree costs seconds on the render
// thread (6k nodes ≈ 3.5 s), so back-to-back full reads of such a tree are spaced at least
// LARGE_TREE_MIN_INTERVAL_MS apart per device. By default the read waits out the remainder (e2e polls
// stay correct, just slower); with `serveCached: true` (Studio mirror) the last tree is returned instead.
// Trees at or below the threshold are never limited. Selectors with an id avoid full reads entirely
// (see fetchTreeFor).
const LARGE_TREE_NODES = 3000;
const LARGE_TREE_MIN_INTERVAL_MS = 2000;
const treeState = new WeakMap(); // device -> { start, count, tree }

async function fetchTree(device, opts = {}) {
  const { serveCached = false, minIntervalMs = LARGE_TREE_MIN_INTERVAL_MS, largeNodes = LARGE_TREE_NODES,
    now = Date.now, sleepFn = sleep } = opts;
  const st = device && typeof device === 'object' ? treeState.get(device) : null;
  if (st && st.count > largeNodes) {
    const wait = st.start + minIntervalMs - now();
    if (wait > 0) {
      if (serveCached && st.tree) return st.tree;
      await sleepFn(wait);
    }
  }
  const start = now();
  const tree = await fetchTreeUncached(device, opts);
  if (device && typeof device === 'object') {
    const count = flatten(tree.roots).length;
    treeState.set(device, { start, count, tree: count > largeNodes ? tree : null });
  }
  return tree;
}

async function fetchTreeUncached(device, { retries = 8, backoffMs = 400, fallbackAfter = APP_UI_FALLBACK_AFTER } = {}) {
  let last = '';
  let failures = 0; // consecutive failed sgnodes reads; a success returns, so it never needs resetting
  // After `fallbackAfter` failures, try app-ui; null means it failed too and the sgnodes error stands.
  const fail = async () => (++failures >= fallbackAfter ? tryAppUi(device) : null);
  for (let attempt = 0; attempt <= retries; attempt++) {
    const { text } = await device.ecpGet('/query/sgnodes/all');
    last = text;
    if (/not allowed in Limited mode/i.test(text)) {
      const e = new Error(
        'sgnodes refused: ECP is in Limited mode. Set the device to Permissive: ' +
        'Settings → System → Advanced → Control by mobile apps → Network access → Permissive.'
      );
      e.code = 'LIMITED_MODE';
      throw e;
    }
    const parsed = parseTree(text);
    if (parsed.status === 'FAILED') {
      // "not running" (no channel up) and "not ready" (channel still launching) are both cases the
      // caller waits out — waitForChannel() polls on this code right after launch.
      if (/Channel not (running|ready)/i.test(parsed.error)) {
        const e = new Error(`sgnodes: ${parsed.error} — launch the channel first.`);
        e.code = 'CHANNEL_NOT_RUNNING';
        throw e;
      }
      const fb = await fail();
      if (fb) return fb;
      if (isRpcTimeout(parsed.error) || (failures < fallbackAfter && attempt < retries)) { await sleep(backoffMs * (attempt + 1)); continue; }
      const e = new Error(`sgnodes FAILED: ${parsed.error}`);
      e.code = 'SGNODES_FAILED';
      throw e;
    }
    if (isRpcTimeout(text) && !parsed.roots.length) {
      const fb = await fail();
      if (fb) return fb;
      await sleep(backoffMs * (attempt + 1));
      continue;
    }
    return { ...parsed, source: TREE_SOURCE_SGNODES, parentLinks: true };
  }
  const e = new Error(`sgnodes timed out after ${retries + 1} attempts (render thread busy?).`);
  e.code = 'RPC_TIMEOUT';
  e.lastResponse = last.slice(0, 300);
  throw e;
}

// Poll until the UI settles: two consecutive trees with the same focus signature (or a hard timeout).
// Returns the last parsed tree. Screens transition over several frames, so we never assert on the first
// read after an action.
async function waitForSettle(device, { timeoutMs = 4000, intervalMs = 250, stableReads = 2, probe = null } = {}) {
  // `probe` (optional async fn) runs when a read fails and between reads; it throws to abort (APP_CRASHED).
  const read = async () => {
    try { return await fetchTree(device); }
    catch (e) { if (probe) await probe(); throw e; }
  };
  const deadline = Date.now() + timeoutMs;
  let prevSig = null;
  let stable = 0;
  let tree = await read();
  while (Date.now() < deadline) {
    const sig = focusSignature(tree.roots);
    if (sig === prevSig) { if (++stable >= stableReads) return tree; }
    else { stable = 1; prevSig = sig; }
    if (probe) await probe();
    await sleep(intervalMs);
    tree = await read();
  }
  return tree;
}

// Fast-path lookup by built-in id via query/sgnodes/nodes?node-id=. Returns the first matching node
// (parsed) or null. Falls back to a full-tree match at the call site if this misses.
async function nodeById(device, id) {
  const { text } = await device.ecpGet(`/query/sgnodes/nodes?node-id=${encodeURIComponent(id)}`);
  if (/not allowed in Limited mode/i.test(text)) {
    const e = new Error('sgnodes refused: ECP is in Limited mode (set Network access → Permissive).');
    e.code = 'LIMITED_MODE';
    throw e;
  }
  const parsed = parseTree(text);
  return parsed.roots[0] || null;
}

// Selector-aware read. With an `id` (and no key that needs the whole tree: focused, index) the read uses
// query/sgnodes/nodes?node-id=<id> and never touches the full tree. A miss or an sgnodes failure falls
// back to fetchTree. Returns a tree-shaped { status, roots, fastPath }; matchOne on it behaves as on a full tree.
async function fetchTreeFor(device, sel, opts = {}) {
  const fast = sel && typeof sel === 'object' && typeof sel.id === 'string' && sel.id !== '' &&
    sel.focused === undefined && sel.index === undefined;
  if (fast) {
    try {
      const { text } = await device.ecpGet(`/query/sgnodes/nodes?node-id=${encodeURIComponent(sel.id)}`);
      if (/not allowed in Limited mode/i.test(text)) {
        const e = new Error('sgnodes refused: ECP is in Limited mode (set Network access → Permissive).');
        e.code = 'LIMITED_MODE';
        throw e;
      }
      const parsed = parseTree(text);
      if (parsed.status !== 'FAILED' && flatten(parsed.roots).some((n) => n.id === sel.id)) {
        return { status: parsed.status, error: null, roots: parsed.roots, fastPath: true, source: TREE_SOURCE_SGNODES, parentLinks: true };
      }
    } catch (e) { if (e.code === 'LIMITED_MODE') throw e; }
  }
  return fetchTree(device, opts);
}

module.exports = {
  LARGE_TREE_NODES, LARGE_TREE_MIN_INTERVAL_MS, APP_UI_FALLBACK_AFTER, TREE_SOURCE_SGNODES, TREE_SOURCE_APP_UI,
  fetchTreeFor, parseAppUi, parseAppUiElements, requireParentLinks,
  parseTree, parseXmlElements, parseAttrs, parseTuple, decodeEntities,
  flatten, focusSignature, fetchTree, waitForSettle, nodeById,
};
