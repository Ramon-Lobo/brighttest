import { ref, onMounted } from 'vue'
import { useData } from 'vitepress'
import { siteRootOf, segmentOf } from './versionContext'

export interface VersionEntry { id: string; label: string; path: string; alias?: string; tag?: string; ref?: string; sha?: string }
export interface VersionsFile { schema: number; latest: string; versions: VersionEntry[] }

export function useVersions() {
  const { site } = useData()
  const data = ref<VersionsFile | null>(null)
  const current = ref<VersionEntry | null>(null)
  onMounted(async () => {
    try {
      const base = site.value.base
      // Relative to the site root, NOT to this build's base, so every build reads the same file.
      const res = await fetch(`${siteRootOf(base)}versions.json`, { cache: 'no-cache' })
      if (!res.ok) return
      const json = (await res.json()) as VersionsFile
      if (json.schema !== 1) return
      data.value = json
      current.value = json.versions.find((v) => v.path === base || v.alias === base) ?? null
    } catch { /* dev server / offline: no switcher */ }
  })
  return { data, current, site, segmentOf }
}
