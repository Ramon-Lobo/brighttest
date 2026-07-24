// Client-side selector matcher — mirrors the studio server's selector engine (id/subtype/text/textContains/
// focused/visible). Positional `index` is intentionally not applied here: highlighting is per-node, so the
// playground guides toward selectors that are unique on their own.
export function matchesSel(n, sel) {
  if (!sel || typeof sel !== 'object') return false;
  const keys = Object.keys(sel).filter((k) => sel[k] !== undefined && sel[k] !== '');
  if (!keys.length) return false;
  if (sel.id !== undefined && n.id !== sel.id) return false;
  if (sel.subtype !== undefined && n.subtype !== sel.subtype) return false;
  if (sel.text !== undefined && n.text !== sel.text) return false;
  if (sel.textContains !== undefined && !(n.text || '').includes(sel.textContains)) return false;
  if (sel.focused !== undefined && n.focused !== (sel.focused === true || sel.focused === 'true')) return false;
  if (sel.visible === 'false' && n.visible !== false) return false;
  return true;
}

// Parse a loose "key: value, key: value" selector string into an object (quotes optional).
export function parseSel(str) {
  const o = {};
  for (const part of String(str).split(',')) {
    const i = part.indexOf(':');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    let v = part.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (k) o[k] = v;
  }
  return o;
}
