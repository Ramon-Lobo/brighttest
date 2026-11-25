'use strict'
// Nested Roku app folders: a folder below the root that holds a `manifest` file plus a `source/` or `src/` tree.
// Pure over a list of posix relative file paths (as lib/assess.js scan() returns them), so it needs no extra walk.

const MAX_LISTED = 5
// folder names come from the file system: keep control characters and escapes off the terminal
const clean = (s) => String(s).replace(/[\u0000-\u001f\u007f-\u009f]/g, '?')

function nestedManifests(rels) {
  const manifests = new Set(); const withTree = new Set()
  for (const r of rels) {
    const m = /^(.+)\/manifest$/.exec(r); if (m) manifests.add(m[1])
    const t = /^(.+)\/(?:source|src)\//.exec(r); if (t) withTree.add(t[1])
  }
  return [...manifests].filter((d) => withTree.has(d)).sort()
}

function listed(folders) {
  const more = folders.length > MAX_LISTED ? ` (and ${folders.length - MAX_LISTED} more)` : ''
  return `${folders.slice(0, MAX_LISTED).map(clean).join(', ')}${more}`
}

// one line, instruction first (consumers may cut it short), or '' when there are none
function nestedHint(folders) {
  if (!folders.length) return ''
  return `no manifest at the root; run from a nested app folder or set rootDir: ${listed(folders)}`
}

const nestedNextStep = (folders) => `run assess from a nested app folder: ${listed(folders)}`

module.exports = { nestedManifests, nestedHint, nestedNextStep, MAX_LISTED }
