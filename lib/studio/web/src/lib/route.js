// Pure hash-route helpers for the Studio shell. The shell is a single page: the page id lives in studio.page and the
// URL hash mirrors it, so a direct link such as #/builds opens that page. No DOM, no framework.
export const DEFAULT_PAGE = 'inspect'

// '#/builds', '#builds', '#/builds/', '#/Builds?x=1' -> 'builds' when it is a known page id, else null.
export function pageFromHash(hash, ids) {
  const m = /^#\/?([A-Za-z0-9_-]+)\/?(?:[?#].*)?$/.exec(String(hash || ''))
  if (!m) return null
  const id = m[1].toLowerCase()
  return ids.includes(id) ? id : null
}

export const hashForPage = (id) => '#/' + id

// What to write to location.hash for the current page, or null to leave it alone (empty hash on the default page).
export function hashToWrite(page, currentHash) {
  if (!currentHash && page === DEFAULT_PAGE) return null
  const want = hashForPage(page)
  return currentHash === want ? null : want
}
