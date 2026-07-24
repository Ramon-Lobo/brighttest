// Flow vocabulary + a CodeMirror completion source. Completions are context-aware:
//   • at a list-item start (`- ` …) → step keywords; assert* insert a full assertion for the SELECTED node
//   • inside a selector map (`{ … }`) → selector keys
//   • after `field:` → the selected node's actual field names
// `getSelected()` returns the currently pinned node (or null), so assertions carry its real id/text/fields.

export const STEPS = [
  { label: 'launch', detail: 'start the app' },
  { label: 'press', detail: 'keypress (Up/Down/Left/Right/Select/Back…)' },
  { label: 'pressUntil', detail: 'repeat a key until a selector appears' },
  { label: 'focus', detail: 'D-pad path-find onto a node' },
  { label: 'text', detail: 'type into the focused field' },
  { label: 'wait', detail: 'pause N milliseconds' },
  { label: 'assertVisible', detail: 'node is present' },
  { label: 'assertGone', detail: 'node is absent' },
  { label: 'assertText', detail: "node's text equals/contains" },
  { label: 'assertField', detail: 'any field equals/contains' },
  { label: 'assertFocused', detail: 'node has focus' },
  { label: 'waitFor', detail: 'wait for a selector' },
  { label: 'runFlow', detail: 'run a reusable subflow' },
  { label: 'screenshot', detail: 'save a frame' },
  { label: 'back', detail: 'press Back' },
  { label: 'home', detail: 'press Home' },
];

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

// What a step keyword expands to. With a selected node, assertions carry its selector/values.
function apply(step, n) {
  switch (step) {
    case 'launch': return 'launch';
    case 'back': return 'back';
    case 'home': return 'home';
    case 'press': return 'press: Select';
    case 'wait': return 'wait: 500';
    case 'text': return 'text: ""';
    case 'screenshot': return 'screenshot: shot.png';
    case 'focus': return `focus: ${selectorFor(n)}`;
    case 'pressUntil': return `pressUntil: { key: Down, visible: ${selectorFor(n)}, max: 20 }`;
    case 'runFlow': return 'runFlow: { file: , env: {  } }';
    case 'waitFor': return `waitFor: ${selectorFor(n)}`;
    case 'assertVisible': return `assertVisible: ${selectorFor(n)}`;
    case 'assertGone': return `assertGone: ${selectorFor(n)}`;
    case 'assertFocused': return `assertFocused: ${selectorFor(n)}`;
    case 'assertText': return `assertText: { ${inner(n)}, equals: ${n && n.text != null ? JSON.stringify(n.text) : '""'} }`;
    case 'assertField': return `assertField: { ${inner(n)}, field: name, equals: "" }`;
    default: return step;
  }
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

    // inside a selector map `{ … <word>` → selector keys
    if (/:\s*\{[^}]*$/.test(before)) {
      const w = (/([\w]*)$/.exec(before) || ['', ''])[1];
      return { from: ctx.pos - w.length, options: SELECTOR_KEYS.map((k) => ({ label: k, type: 'property', apply: k + ': ' })), validFor: /^\w*$/ };
    }

    // list-item start `- <word>` → step keywords (assert* prioritized when a node is selected)
    m = /^(\s*-\s*)([\w]*)$/.exec(before);
    if (m || ctx.explicit) {
      const w = m ? m[2] : (/([\w]*)$/.exec(before) || ['', ''])[1];
      return {
        from: ctx.pos - w.length,
        options: STEPS.map((s) => ({
          label: s.label,
          type: s.label.startsWith('assert') ? 'function' : 'keyword',
          detail: s.detail,
          boost: n && s.label.startsWith('assert') ? 2 : 0,
          apply: apply(s.label, n),
        })),
        validFor: /^\w*$/,
      };
    }
    return null;
  };
}
