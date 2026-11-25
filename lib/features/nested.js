'use strict'
// Nested Roku app folders: a folder below the root that holds a `manifest` file plus a `source/` or `src/` tree.
// Pure over a list of posix relative file paths (as lib/assess.js scan() returns them), so it needs no extra walk.

const MAX_LISTED = 20

function nestedManifests(rels) {
  const dirs = new Set()
  for (const r of rels) { const m = /^(.+)\/manifest$/.exec(r); if (m) dirs.add(m[1]) }
  const found = []
  for (const d of [...dirs].sort()) {
    if (rels.some((r) => r.startsWith(`${d}/source/`) || r.startsWith(`${d}/src/`))) found.push(d)
  }
  return found
}

// one line naming the folders, or '' when there are none
function nestedHint(folders) {
  if (!folders.length) return ''
  const shown = folders.slice(0, MAX_LISTED).join(', ')
  const more = folders.length > MAX_LISTED ? ` (and ${folders.length - MAX_LISTED} more)` : ''
  return `no manifest at the root, but nested app folders were found: ${shown}${more}; run again with the folder as the project root (or set rootDir in brighttest.json)`
}

module.exports = { nestedManifests, nestedHint }
