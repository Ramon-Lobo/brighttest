// Flatten a state object into indented rows. Leaves carry a dotted `path` (for assertState and setState).
export function rowsOf(obj, prefix = '', depth = 0, out = []) {
  const entries = Array.isArray(obj)
    ? obj.map((v, i) => [String(i), v])
    : Object.entries(obj || {});
  for (const [k, v] of entries) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object') {
      out.push({ depth, key: k, branch: true, badge: Array.isArray(v) ? `[${v.length}]` : '{…}' });
      rowsOf(v, path, depth + 1, out);
    } else {
      out.push({ depth, key: k, branch: false, path, value: v, type: v === null ? 'null' : typeof v });
    }
  }
  return out;
}
