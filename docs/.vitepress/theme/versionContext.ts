// Shared helpers: work out the site root from site.base.
// Root build base = /brighttest/, next = /brighttest/next/, minor = /brighttest/v0.7/
export const VERSION_SEGMENT = /(next|v\d+\.\d+)\/$/

export function siteRootOf(base: string): string {
  return base.replace(VERSION_SEGMENT, '')
}

// Strip site root and any version segment from a pathname: '/brighttest/next/guide/mcp' -> 'guide/mcp'
export function pagePathOf(pathname: string, base: string): string {
  const root = siteRootOf(base)
  let rel = pathname.startsWith(root) ? pathname.slice(root.length) : pathname.replace(/^\/+/, '')
  rel = rel.replace(/^(next|v\d+\.\d+)(\/|$)/, '')
  return rel.replace(/^\/+/, '')
}

// Two-tier docs (ADR 0061). A version built before the lite tier existed has no /full/ pages, so a page path
// under full/ maps to the same path without the prefix there. Candidates are tried in order.
export const FULL_PREFIX = /^full(\/|$)/

export function stripFull(rel: string): string {
  return rel.replace(FULL_PREFIX, '')
}

export function switchCandidates(rel: string): string[] {
  const r = rel.replace(/^\/+/, '')
  return FULL_PREFIX.test(r) ? [r, stripFull(r)] : [r]
}

// Tier link for the current page, or null when the page has no other tier (or the build has no tiers).
// relativePath is the routed path ('guide/studio.md' lite, 'full/guide/studio.md' full); tiered lists source pages
// that have both tiers. hrefs are base-relative ('guide/studio', 'full/guide/studio', '' for the home page).
export function tierLink(
  relativePath: string,
  tiered: string[] | undefined,
): { kind: 'to-full' | 'to-lite'; path: string } | null {
  if (!tiered || !tiered.length) return null
  const isFull = FULL_PREFIX.test(relativePath)
  const src = stripFull(relativePath)
  if (!tiered.includes(src)) return null
  const route = src.replace(/\.md$/, '').replace(/(^|\/)index$/, '$1')
  return isFull ? { kind: 'to-lite', path: route } : { kind: 'to-full', path: 'full/' + route }
}
