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
async function fetchTree(device, { retries = 8, backoffMs = 400 } = {}) {
  let last = '';
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
      if (isRpcTimeout(parsed.error)) { await sleep(backoffMs * (attempt + 1)); continue; }
      const e = new Error(`sgnodes FAILED: ${parsed.error}`);
      e.code = 'SGNODES_FAILED';
      throw e;
    }
    if (isRpcTimeout(text) && !parsed.roots.length) { await sleep(backoffMs * (attempt + 1)); continue; }
    return parsed;
  }
  const e = new Error(`sgnodes timed out after ${retries + 1} attempts (render thread busy?).`);
  e.code = 'RPC_TIMEOUT';
  e.lastResponse = last.slice(0, 300);
  throw e;
}

// Poll until the UI settles: two consecutive trees with the same focus signature (or a hard timeout).
// Returns the last parsed tree. Screens transition over several frames, so we never assert on the first
// read after an action.
async function waitForSettle(device, { timeoutMs = 4000, intervalMs = 250, stableReads = 2 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let prevSig = null;
  let stable = 0;
  let tree = await fetchTree(device);
  while (Date.now() < deadline) {
    const sig = focusSignature(tree.roots);
    if (sig === prevSig) { if (++stable >= stableReads) return tree; }
    else { stable = 1; prevSig = sig; }
    await sleep(intervalMs);
    tree = await fetchTree(device);
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

module.exports = {
  parseTree, parseXmlElements, parseAttrs, parseTuple, decodeEntities,
  flatten, focusSignature, fetchTree, waitForSettle, nodeById,
};
