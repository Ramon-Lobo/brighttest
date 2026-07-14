'use strict';
const fs = require('fs');
const path = require('path');

// Build-time id auto-injection. Probe 2 proved the only reliable selector hook is a node's built-in
// `id` (dumped as name=). Hand-annotating every node is tedious, so this stamps a stable, readable `id`
// onto every SceneGraph node in a component's <children> that lacks one — turning an un-annotated app
// into a fully selectable one for an E2E build. Two ways to use it:
//   • as a BrighterScript plugin (module.exports = factory) added to a bsconfig's `plugins`, OR
//   • as a source transform (`stampProject`) / CLI (`brighttest e2e stamp`) that writes stamped copies.
// It never touches nodes that already have an id, so hand-picked ids win and re-running is idempotent.

const DEFAULT_PREFIX = 'e2e_';

// Stamp id= onto id-less node elements inside a component's <children> block. Pure: returns
// { xml, count }. Ids are `<prefix><Subtype>_<n>` with a per-subtype counter, so they're readable and
// stable as long as the node order within a type doesn't change.
function stampComponentXml(xml, { prefix = DEFAULT_PREFIX } = {}) {
  const openMatch = xml.match(/<children\b[^>]*>/);
  if (!openMatch) return { xml, count: 0 };
  const contentStart = openMatch.index + openMatch[0].length;
  const closeIdx = xml.indexOf('</children>', contentStart);
  if (closeIdx < 0) return { xml, count: 0 };

  const before = xml.slice(0, contentStart);
  const region = xml.slice(contentStart, closeIdx);
  const after = xml.slice(closeIdx);

  const counters = {};
  let count = 0;
  // Match node START tags only (a close tag `</X>` has '/' right after '<', excluded by the char class).
  const stamped = region.replace(
    /<([A-Za-z_][\w.:-]*)((?:\s+[\w:.-]+\s*=\s*"[^"]*")*)(\s*\/?)>/g,
    (m, tag, attrs, tail) => {
      if (/\bid\s*=/.test(attrs)) return m; // already has an id — leave it
      counters[tag] = (counters[tag] || 0) + 1;
      count++;
      return `<${tag} id="${prefix}${tag}_${counters[tag]}"${attrs}${tail}>`;
    }
  );
  return { xml: before + stamped + after, count };
}

// A component file is one that declares a <component>. (Non-component XML — e.g. manifest-ish — is left
// alone.)
function isComponentXml(source) {
  return /<component\b/.test(source);
}

// BrighterScript plugin factory. Add the module path to a bsconfig's `plugins` and it rewrites each
// component's XML source before parse, so the compiled output carries the injected ids.
function plugin(pluginOpts = {}) {
  return {
    name: 'brighttest-e2e-id-injector',
    beforeFileParse(source) {
      if (!/\.xml$/i.test(source.srcPath || source.pathAbsolute || '')) return;
      if (!isComponentXml(source.source)) return;
      source.source = stampComponentXml(source.source, pluginOpts).xml;
    },
  };
}

// Source-transform path: copy `srcDir` → `outDir`, stamping component XML on the way. Returns
// { files, nodes } totals. Used by the `e2e stamp` CLI for teams that prefer a stamped build artifact
// over a bsc plugin.
function stampProject(srcDir, outDir, opts = {}) {
  let files = 0, nodes = 0;
  const skip = new Set(['node_modules', '.git', '.brighttest', 'out']);
  (function walk(rel) {
    const abs = path.join(srcDir, rel);
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const childRel = path.join(rel, entry.name);
      if (entry.isDirectory()) { if (!skip.has(entry.name)) walk(childRel); continue; }
      const src = path.join(srcDir, childRel);
      const dest = path.join(outDir, childRel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (/\.xml$/i.test(entry.name)) {
        const raw = fs.readFileSync(src, 'utf8');
        if (isComponentXml(raw)) {
          const { xml, count } = stampComponentXml(raw, opts);
          fs.writeFileSync(dest, xml);
          files++; nodes += count;
          continue;
        }
      }
      fs.copyFileSync(src, dest);
    }
  })('');
  return { files, nodes };
}

module.exports = plugin;              // bsc plugin factory (default export)
module.exports.default = plugin;
module.exports.stampComponentXml = stampComponentXml;
module.exports.stampProject = stampProject;
module.exports.isComponentXml = isComponentXml;
module.exports.DEFAULT_PREFIX = DEFAULT_PREFIX;
