import { ref, onMounted } from 'vue'
import { useData } from 'vitepress'
import { siteRootOf } from './versionContext'

export interface VersionEntry { id: string; label: string; path: string; alias?: string; tag?: string; ref?: string; sha?: string }
export interface VersionsFile { schema: number; latest: string; versions: VersionEntry[] }

const isStr = (x: unknown): x is string => typeof x === 'string' && x.length > 0

// A site-local directory URL: starts with the site root, ends with '/', and has nothing that could
// leave the site or change scheme.
function safePath(p: unknown, root: string): p is string {
  return isStr(p) && p.startsWith(root) && p.endsWith('/') &&
    !p.includes('//') && !p.includes('\\') && !p.includes(':') && !p.includes('..')
}

// Returns a cleaned copy, or null when anything is off (the whole file is dropped).
export function validateVersions(json: unknown, root: string): VersionsFile | null {
  const j = json as Partial<VersionsFile> | null
  if (!j || typeof j !== 'object' || j.schema !== 1 || !Array.isArray(j.versions)) return null
  const versions: VersionEntry[] = []
  for (const v of j.versions as unknown[]) {
    const e = v as Partial<VersionEntry> | null
    if (!e || typeof e !== 'object') return null
    if (!isStr(e.id) || !isStr(e.label) || !safePath(e.path, root)) return null
    if (e.alias !== undefined && !safePath(e.alias, root)) return null
    const tag = isStr(e.tag) && /^v?\d+\.\d+\.\d+[\w.-]*$/.test(e.tag) ? e.tag : undefined
    versions.push({ id: e.id, label: e.label, path: e.path, alias: e.alias, tag })
  }
  if (!isStr(j.latest) || !versions.some((v) => v.id === j.latest)) return null
  return { schema: 1, latest: j.latest, versions }
}

let shared: Promise<VersionsFile | null> | null = null
function load(base: string): Promise<VersionsFile | null> {
  if (!shared) {
    const root = siteRootOf(base)
    // Relative to the site root, NOT to this build's base, so every build reads the same file.
    shared = fetch(`${root}versions.json`, { cache: 'no-cache' })
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => validateVersions(json, root))
      .catch(() => null) // dev server / offline: no switcher
  }
  return shared
}

export function useVersions() {
  const { site } = useData()
  const data = ref<VersionsFile | null>(null)
  const current = ref<VersionEntry | null>(null)
  onMounted(async () => {
    const base = site.value.base
    const file = await load(base)
    if (!file) return
    data.value = file
    current.value = file.versions.find((v) => v.path === base || v.alias === base) ?? null
  })
  return { data, current, site }
}
