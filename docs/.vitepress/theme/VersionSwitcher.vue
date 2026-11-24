<script setup lang="ts">
import { ref } from 'vue'
import { useData } from 'vitepress'
import { useVersions } from './useVersions'
import { pagePathOf } from './versionContext'
const { data, current, site } = useVersions()
const open = ref(false)
const { page } = useData()
// The root 404 page cannot know which version path was requested, so it shows a neutral label.

async function go(target: { path: string }) {
  open.value = false
  const rel = pagePathOf(window.location.pathname, site.value.base)
  const same = target.path + rel
  try {
    const head = await fetch(same, { method: 'HEAD' })
    if (head.ok) { window.location.href = same; return }
  } catch { /* fall through */ }
  window.location.href = target.path
}
</script>

<template>
  <div v-if="data" class="bt-vs">
    <button class="bt-vs-btn" data-testid="version-switcher" @click="open = !open">
      {{ page.isNotFound ? 'Versions' : (current?.label ?? 'Versions') }} <span aria-hidden="true">&#9662;</span>
    </button>
    <ul v-if="open" class="bt-vs-menu" data-testid="version-menu">
      <li v-for="v in data.versions" :key="v.id">
        <a href="#" @click.prevent="go(v)">{{ v.label }}</a>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.bt-vs { position: relative; margin-left: 12px; margin-right: 12px; align-self: center; }
.bt-vs-btn { font-size: 14px; font-weight: 500; padding: 4px 10px; border: 1px solid var(--vp-c-divider); border-radius: 6px; color: var(--vp-c-text-1); }
.bt-vs-menu { position: absolute; left: 0; top: 34px; min-width: 190px; list-style: none; margin: 0; padding: 6px; background: var(--vp-c-bg-elv); border: 1px solid var(--vp-c-divider); border-radius: 8px; box-shadow: var(--vp-shadow-3); z-index: 100; }
.bt-vs-menu a { display: block; padding: 6px 10px; font-size: 14px; color: var(--vp-c-text-1); border-radius: 4px; }
.bt-vs-menu a:hover { background: var(--vp-c-default-soft); color: var(--vp-c-brand-1); }
</style>
