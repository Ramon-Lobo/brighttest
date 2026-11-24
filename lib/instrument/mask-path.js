'use strict';

// Shared mask-path rules for state redaction (instrument hub, Studio, assertState). Node core only.
// A mask is a dotted path. `a.list[1]` is the same as `a.list.1`, `a.list[*]` the same as `a.list.*`, and `*`
// matches exactly one segment. Segments compare ignoring case. A key that literally contains brackets
// (`list[1]`) is still matched, so a bracketed pattern yields both readings.

// Compile mask strings once into arrays of lower-cased segments (`'*'` kept as the wildcard).
function compileMasks(paths) {
  const out = [];
  for (const raw of Array.isArray(paths) ? paths : []) {
    if (typeof raw !== 'string') continue;
    const lower = raw.toLowerCase();
    const split = (s) => s.replace(/^\./, '').split('.');
    out.push(split(lower.replace(/\[(\d+|\*)\]/g, '.$1')));
    if (/\[[^\]]*\]/.test(lower)) out.push(split(lower));
  }
  return out;
}

// True when every segment of `mask` (compiled) matches the same-position segment of `lsegs` (lower-cased), full length.
function maskMatches(mask, lsegs) {
  if (mask.length !== lsegs.length) return false;
  for (let i = 0; i < mask.length; i++) if (mask[i] !== '*' && mask[i] !== lsegs[i]) return false;
  return true;
}

// Compiled masks plus, for each mask starting with a `layers` segment, the same mask without it, so "layers.global.x"
// and "global.x" mean the same path against data that is already split per layer. The hub keeps its own both-ways check.
function withBareLayers(compiled) {
  const out = [];
  for (const m of compiled) {
    out.push(m);
    if (m[0] === 'layers' && m.length > 1) out.push(m.slice(1));
  }
  return out;
}

// Masks (compiled) made relative to `layer`: masks whose first segment is that layer (any case) lose it. Masks that do not
// name the layer are kept unchanged, as before.
function relativeToLayer(compiled, layer) {
  const l = layer === undefined || layer === null ? null : String(layer).toLowerCase();
  const out = [];
  for (const m of withBareLayers(compiled)) {
    out.push(m);
    if (l !== null && (m[0] === l || m[0] === '*') && m.length > 1) out.push(m.slice(1));
  }
  return out;
}

module.exports = { compileMasks, maskMatches, withBareLayers, relativeToLayer };
