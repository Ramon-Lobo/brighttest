// Flow vocabulary + a CodeMirror completion source. The step list comes from the server (GET /api/steps, the one
// step catalog in lib/e2e/step-catalog.js); nothing here lists steps by hand. Completions are context-aware:
//   • at a list-item start (`- ` …) → step keywords, inserting the catalog snippet (assert* use the SELECTED node)
//   • inside a step's map (`{ … }`) → that step's keys; inside a nested selector map → selector keys
//   • after `key:` where the step declares enum values (e.g. `layer:`) → those values
//   • after `field:` → the selected node's actual field names
// `getSelected()` returns the currently pinned node (or null), so assertions carry its real id/text/fields.

let catalog = [];
// Called once the editor has fetched the catalog.
export function setSteps(list) { catalog = Array.isArray(list) ? list : []; }
export function getSteps() { return catalog; }

export const SELECTOR_KEYS = ['id', 'subtype', 'text', 'textContains', 'uri', 'focused', 'focusable', 'visible', 'index'];
const COMMON_FIELDS = ['name', 'text', 'uri', 'opacity', 'visible', 'color', 'width', 'height', 'translation', 'bounds'];

// Best selector string for a node: id → text → subtype.
function selectorFor(n) {
  if (!n) return '{ id:  }';
  if (n.id) return `{ id: ${n.id} }`;
  if (n.text) return `{ text: ${JSON.stringify(n.text)} }`;
  return `{ subtype: ${n.subtype} }`;
}
function inner(n) { return selectorFor(n).slice(2, -2); }

// Fill the snippet placeholders: {{sel}} {{inner}} {{text}} {{id}}. With no selected node they become empty values.
export function applySnippet(snippet, n) {
  return snippet
    .replace(/\{\{sel\}\}/g, () => selectorFor(n))
    .replace(/\{\{inner\}\}/g, () => inner(n))
    .replace(/\{\{text\}\}/g, () => (n && n.text != null ? String(n.text).replace(/["\\]/g, '') : ''))
    .replace(/\{\{id\}\}/g, () => (n && n.id) || '');
}

export function flowCompletions(getSelected) {
  return (ctx) => {
    const line = ctx.state.doc.lineAt(ctx.pos);
    const before = line.text.slice(0, ctx.pos - line.from);
    const n = getSelected ? getSelected() : null;

    // after `field:` → the node's real field names (or common ones)
    let m = /field:\s*([\w-]*)$/.exec(before);
    if (m) {
      const fields = n && n.attrs ? Object.keys(n.attrs) : COMMON_FIELDS;
      return { from: ctx.pos - m[1].length, options: fields.map((f) => ({ label: f, type: 'property' })), validFor: /^[\w-]*$/ };
    }

    // after `key:` where the step declares enum values (setState layer, assertMedia state, ack ...)
    const step = (/^\s*-\s*(\w+):/.exec(before) || [])[1];
    const entry = catalog.find((e) => e.key === step);
    m = /(\w+):\s*([\w-]*)$/.exec(before);
    if (m && entry && entry.enums && entry.enums[m[1]] && /\{[^}]*$/.test(before)) {
      return { from: ctx.pos - m[2].length, options: entry.enums[m[1]].map((v) => ({ label: v, type: 'enum' })), validFor: /^[\w-]*$/ };
    }

    // inside a map `{ … <word>` → this step's keys (selector keys inside a nested selector map)
    if (/:\s*\{[^}]*$/.test(before)) {
      const w = (/([\w]*)$/.exec(before) || ['', ''])[1];
      const depth = (before.match(/\{/g) || []).length - (before.match(/\}/g) || []).length;
      const keys = depth <= 1 && entry && entry.keys && entry.keys.length ? entry.keys : SELECTOR_KEYS;
      return { from: ctx.pos - w.length, options: keys.map((k) => ({ label: k, type: 'property', apply: k + ': ' })), validFor: /^\w*$/ };
    }

    // list-item start `- <word>` → step keywords (assert* prioritized when a node is selected)
    m = /^(\s*-\s*)([\w]*)$/.exec(before);
    if (m || ctx.explicit) {
      const w = m ? m[2] : (/([\w]*)$/.exec(before) || ['', ''])[1];
      return {
        from: ctx.pos - w.length,
        options: catalog.map((s) => ({
          label: s.key,
          type: s.group === 'assert' ? 'function' : 'keyword',
          detail: s.detail,
          boost: n && s.group === 'assert' ? 2 : 0,
          apply: applySnippet(s.snippet, n),
        })),
        validFor: /^\w*$/,
      };
    }
    return null;
  };
}
