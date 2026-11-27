<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { useData } from 'vitepress'
import { useVersions } from './useVersions'
import { pagePathOf, switchCandidates } from './versionContext'
const { data, current, site } = useVersions()
const open = ref(false)
const rel = ref('')
const { page } = useData()
const root = ref<HTMLElement | null>(null)
const btn = ref<HTMLButtonElement | null>(null)
const menuId = 'bt-vs-menu'

// Keep-page target; a page path with anything odd in it falls back to the version root.
function cleanRel(p: string): string {
  const r = p.replace(/^\/+/, '')
  return /\/\/|\\|:|\.\./.test(r) ? '' : r
}
function hrefFor(v: { path: string }) { return v.path + rel.value }

function toggle() {
  if (!open.value) rel.value = cleanRel(pagePathOf(window.location.pathname, site.value.base))
  open.value = !open.value
}
function close(refocus = false) {
  open.value = false
  if (refocus) nextTick(() => btn.value?.focus())
}

async function go(e: MouseEvent, v: { path: string }) {
  // Let the browser handle modified clicks (new tab etc.) with the real href.
  if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || e.button !== 0) return
  e.preventDefault()
  close()
  const hash = window.location.hash
  // A /full/ page maps to the plain page in a version that has no full tier.
  for (const cand of switchCandidates(rel.value)) {
    const same = v.path + cand
    try {
      const head = await fetch(same, { method: 'HEAD' })
      if (head.ok) { window.location.href = same + hash; return }
    } catch { /* try the next candidate */ }
  }
  window.location.href = v.path
}

const onDocClick = (e: MouseEvent) => { if (open.value && root.value && !root.value.contains(e.target as Node)) close() }
const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && open.value) { e.stopPropagation(); close(true) } }
onMounted(() => { document.addEventListener('click', onDocClick); document.addEventListener('keydown', onKey) })
onBeforeUnmount(() => { document.removeEventListener('click', onDocClick); document.removeEventListener('keydown', onKey) })
</script>

<template>
  <div v-if="data" ref="root" class="bt-vs">
    <button ref="btn" type="button" class="bt-vs-btn" data-testid="version-switcher"
      aria-haspopup="true" :aria-expanded="open" :aria-controls="menuId" @click="toggle">
      {{ page.isNotFound ? 'Versions' : (current?.label ?? 'Versions') }} <span aria-hidden="true">&#9662;</span>
    </button>
    <ul v-if="open" :id="menuId" class="bt-vs-menu" data-testid="version-menu">
      <li v-for="v in data.versions" :key="v.id">
        <a :href="hrefFor(v)" :aria-current="!page.isNotFound && current?.id === v.id ? 'page' : undefined"
          @click="go($event, v)">{{ v.label }}</a>
      </li>
      <li class="bt-vs-sep" data-testid="version-changelog">
        <a :href="site.base + 'changelog'">Changelog</a>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.bt-vs { position: relative; margin-left: 12px; margin-right: 12px; align-self: center; }
.bt-vs-btn { font-size: 14px; font-weight: 500; padding: 4px 10px; border: 1px solid var(--vp-c-divider); border-radius: 6px; color: var(--vp-c-text-1); }
.bt-vs-menu { position: absolute; left: 0; top: 34px; min-width: 190px; list-style: none; margin: 0; padding: 6px; background: var(--vp-c-bg-elv); border: 1px solid var(--vp-c-divider); border-radius: 8px; box-shadow: var(--vp-shadow-3); z-index: 100; }
.bt-vs-sep { margin-top: 4px; padding-top: 4px; border-top: 1px solid var(--vp-c-divider); }
.bt-vs-menu a { display: block; padding: 6px 10px; font-size: 14px; color: var(--vp-c-text-1); border-radius: 4px; }
.bt-vs-menu a[aria-current] { font-weight: 700; color: var(--vp-c-brand-1); }
.bt-vs-menu a:hover { background: var(--vp-c-default-soft); color: var(--vp-c-brand-1); }
</style>
