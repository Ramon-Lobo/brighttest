'use strict';
const fs = require('fs');
const selEngine = require('./select');
const { bestSelector, serializeInlineMap } = require('./record');

// Turn a live node into ready-to-paste flow assertions. Powers `e2e inspect <selector>`: an author points
// at a node they see on screen, gets its full field dump, and copies (or appends) an assertion built from
// the node's *actual* state. Pure — no device I/O — so it's unit-tested without hardware.

const KINDS = ['visible', 'text', 'focused', 'gone'];

// Choose a stable selector for `node`, unique within `all` when possible. Falls back id → text → subtype
// (via bestSelector); if that still matches several nodes, disambiguates with the node's `index` among them.
function suggestSelector(node, all) {
  const base = bestSelector(node) || { subtype: node.subtype };
  const hits = all.filter((n) => selEngine.matches(n, base));
  if (hits.length <= 1) return { selector: base, count: hits.length, index: null, ambiguous: false };
  const idx = hits.indexOf(node);
  return {
    selector: idx >= 0 ? { ...base, index: idx } : base,
    count: hits.length,
    index: idx >= 0 ? idx : null,
    ambiguous: true,
  };
}

// Build one assertion step line (no leading indent) of the given kind for `node`, using its suggested
// selector. `text` reads the node's current visible text as the expected value. Throws on an unusable kind.
function buildAssertion(kind, node, all) {
  const { selector } = suggestSelector(node, all);
  switch (kind) {
    case 'visible': return `- assertVisible: ${serializeInlineMap(selector)}`;
    case 'gone':    return `- assertGone: ${serializeInlineMap(selector)}`;
    case 'focused': return `- assertFocused: ${serializeInlineMap(selector)}`;
    case 'text':
      if (node.text == null || node.text === '') throw new Error('node has no text — use a different assertion kind');
      return `- assertText: ${serializeInlineMap({ ...selector, equals: node.text })}`;
    default:
      throw new Error(`unknown assertion kind "${kind}" (use ${KINDS.join(' | ')})`);
  }
}

// The snippets shown in the detail view: assertVisible always, then assertText / assertFocused when the
// node's state supports them. (assertGone is offered only on demand via --assert, since it asserts absence.)
function displayAssertions(node, all) {
  const kinds = ['visible'];
  if (node.text != null && node.text !== '') kinds.push('text');
  if (node.focused) kinds.push('focused');
  return kinds.map((k) => buildAssertion(k, node, all));
}

// Append an assertion step to a flow file, creating a minimal flow if it doesn't exist yet. Appends at
// end-of-file: flows put `steps:` last (steps run in order), so extending the file extends the journey.
// Returns { created }. Throws if the existing file has no `steps:` block to extend.
function appendAssertion(filePath, line, { appId = 'dev' } = {}) {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, `appId: ${appId}\nsteps:\n  ${line}\n`);
    return { created: true };
  }
  let content = fs.readFileSync(filePath, 'utf8');
  if (!/^\s*steps\s*:/m.test(content)) throw new Error(`${filePath} has no "steps:" block to append to`);
  if (!content.endsWith('\n')) content += '\n';
  fs.writeFileSync(filePath, content + `  ${line}\n`);
  return { created: false };
}

module.exports = { KINDS, suggestSelector, buildAssertion, displayAssertions, appendAssertion };
