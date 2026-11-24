// Shared helpers: work out the site root and this build's version id from site.base.
// Root build base = /brighttest/, next = /brighttest/next/, minor = /brighttest/v0.7/
export const VERSION_SEGMENT = /(next|v\d+\.\d+)\/$/

export function siteRootOf(base: string): string {
  return base.replace(VERSION_SEGMENT, '')
}

export function segmentOf(base: string): string | null {
  const m = base.match(VERSION_SEGMENT)
  return m ? m[1] : null
}

// Strip site root and any version segment from a pathname: '/brighttest/next/guide/mcp' -> 'guide/mcp'
export function pagePathOf(pathname: string, base: string): string {
  const root = siteRootOf(base)
  let rel = pathname.startsWith(root) ? pathname.slice(root.length) : pathname.replace(/^\//, '')
  rel = rel.replace(/^(next|v\d+\.\d+)(\/|$)/, '')
  return rel
}
