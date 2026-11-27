'use strict';
const fs = require('fs');
const path = require('path');

// Reader for `bt-linemap.json` (written by `instrument build` with `instrument.lineMap`; schema in plugin.js):
// { schema: 1, files: { "<pkgPath without pkg:/>": [[stagedLine, sourceLine], ...] } }.
// Pure helpers plus one small file loader. Used by the e2e failure bundle to translate crash backtrace frames.

const MAP_NAME = 'bt-linemap.json';

// Where the run's linemap lives, from the resolved config: `instrument.lineMap` as a string is a path (relative to
// rootDir, like the build resolves it); `true` is bt-linemap.json beside the default instrument package
// (<stagingDir>/instrument). Returns null when the option is off or unset.
function resolveLineMapPath(cfg) {
  const v = cfg && cfg.instrument && cfg.instrument.lineMap;
  const root = path.resolve((cfg && cfg.rootDir) || '.');
  if (typeof v === 'string' && v) return path.resolve(root, v);
  if (v === true) return path.join(path.resolve(root, (cfg && cfg.stagingDir) || '.brighttest'), 'instrument', MAP_NAME);
  return null;
}

// Validate a parsed map; returns the normalized { files: Map<lowercased key, Map<staged, source>> } or throws.
function normalize(json) {
  if (!json || typeof json !== 'object' || json.schema !== 1 || !json.files || typeof json.files !== 'object' || Array.isArray(json.files)) {
    throw new Error('not a schema 1 line map');
  }
  const files = new Map();
  for (const [k, entries] of Object.entries(json.files)) {
    if (!Array.isArray(entries)) throw new Error(`entries of ${k} are not a list`);
    const m = new Map();
    for (const e of entries) {
      if (!Array.isArray(e) || !Number.isInteger(e[0]) || !Number.isInteger(e[1])) throw new Error(`bad entry in ${k}`);
      m.set(e[0], e[1]);
    }
    files.set(k.replace(/\\/g, '/').toLowerCase(), m);
  }
  return { files };
}

// Load a linemap file. Returns { map } or { note } (one line saying why there is none). Never throws.
function loadLineMap(file) {
  if (!file) return { note: 'source lines not mapped: instrument.lineMap is off' };
  let text;
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > 64 * 1024 * 1024) throw new Error('not a regular file of sane size');
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return { note: `source lines not mapped: no line map at ${file} (build with instrument.lineMap: true)` };
  }
  try { return { map: normalize(JSON.parse(text)) }; } catch (e) {
    return { note: `source lines not mapped: line map ${file} is unreadable (${e.message}); ignored` };
  }
}

const keyOf = (file) => String(file || '').replace(/\\/g, '/').replace(/^pkg:\/*/i, '').toLowerCase();

// Source line of a staged package line, or null (file not mapped, or no entry for that line).
function lookup(map, file, line) {
  if (!map || !Number.isInteger(line)) return null;
  const m = map.files.get(keyOf(file));
  const v = m && m.get(line);
  return v === undefined ? null : v;
}

// Add `sourceLine` to every mapped frame (package `line` is kept). Unmapped frames are returned unchanged.
// Returns { backtrace, mapped } where mapped is the number of frames that got a source line.
function translateBacktrace(bt, map) {
  if (!bt || !map) return { backtrace: bt, mapped: 0 };
  let mapped = 0;
  const frames = (bt.frames || []).map((f) => {
    const s = lookup(map, f.file, f.line);
    if (s === null) return f;
    mapped++;
    return { ...f, sourceLine: s };
  });
  const out = { ...bt, frames };
  const top = lookup(map, bt.file, bt.line);
  if (top !== null) {
    out.sourceLine = top;
    out.summary = `${bt.summary} (source line ${top})`;
    if (bt.location) out.sourceLocation = bt.location.replace(/\(\d+\)$/, `(${top})`);
  }
  return { backtrace: out, mapped };
}

module.exports = { MAP_NAME, resolveLineMapPath, loadLineMap, lookup, translateBacktrace };
