// Build flow step lines from a live node. Shared by the inspector and the node context menu so both
// produce identical, ready-to-paste YAML carrying the node's real selector and current field values.
export const selectorFor = (n) => (n.id ? `{ id: ${n.id} }` : n.text ? `{ text: ${JSON.stringify(n.text)} }` : `{ subtype: ${n.subtype} }`);
export const innerSel = (n) => selectorFor(n).slice(2, -2);

export function assertion(kind, n, field) {
  const s = selectorFor(n);
  switch (kind) {
    case 'visible': return `- assertVisible: ${s}`;
    case 'gone': return `- assertGone: ${s}`;
    case 'focused': return `- assertFocused: ${s}`;
    case 'text': return `- assertText: { ${innerSel(n)}, equals: ${JSON.stringify(n.text ?? '')} }`;
    case 'field': return `- assertField: { ${innerSel(n)}, field: ${field}, equals: ${JSON.stringify(String(n.attrs?.[field] ?? ''))} }`;
    default: return `- assertVisible: ${s}`;
  }
}
export const focusStep = (n) => `- focus: ${selectorFor(n)}`;
export const pressStep = (key) => (key === 'Back' ? '- back' : key === 'Home' ? '- home' : `- press: ${key}`);
