<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount, nextTick } from 'vue'
import { useData } from 'vitepress'
import { useVersions } from './useVersions'
const { data, current } = useVersions()
const { page } = useData()
const latest = computed(() => data.value?.versions.find((v) => v.id === data.value?.latest))
const kind = computed(() => {
  // A 404 page cannot know which version was requested, so it shows no banner.
  if (page.value.isNotFound || !current.value || !data.value) return null
  if (current.value.id === 'next') return 'next'
  if (current.value.id !== data.value.latest) return 'old'
  return null
})

// The default theme's fixed nav and sidebar (960px and wider) offset themselves by
// --vp-layout-top-height, so the banner publishes its measured height (it wraps on narrow pages)
// and the global style below applies it only at those widths.
const el = ref<HTMLElement | null>(null)
let ro: ResizeObserver | null = null
const setHeight = (px: number) => document.documentElement.style.setProperty('--bt-banner-height', `${px}px`)
watch(kind, async (k) => {
  ro?.disconnect()
  await nextTick()
  if (!k || !el.value) { document.documentElement.style.removeProperty('--bt-banner-height'); return }
  setHeight(el.value.offsetHeight)
  ro = new ResizeObserver(() => el.value && setHeight(el.value.offsetHeight))
  ro.observe(el.value)
})
onBeforeUnmount(() => ro?.disconnect())
</script>

<template>
  <div v-if="kind === 'next'" ref="el" class="bt-banner bt-next" data-testid="banner-next">
    Unreleased: these docs track <code>main</code>, ahead of the latest release
    <strong>{{ latest?.tag }}</strong>. Features here may not be in your installed version.
    <a :href="latest?.path">Docs for {{ latest?.tag }}</a>
  </div>
  <div v-else-if="kind === 'old'" ref="el" class="bt-banner bt-old" data-testid="banner-old">
    Docs for {{ current?.label }}. The latest release is {{ latest?.tag }}.
    <a :href="latest?.path">Go to latest</a>
  </div>
</template>

<style>
@media (min-width: 960px) {
  :root { --vp-layout-top-height: var(--bt-banner-height, 0px); }
}
</style>

<style scoped>
.bt-banner { padding: 8px 16px; text-align: center; font-size: 14px; border-bottom: 1px solid var(--vp-c-divider); }
.bt-next { background: var(--vp-c-warning-soft); color: var(--vp-c-text-1); }
.bt-old { background: var(--vp-c-default-soft); }
.bt-banner a { margin-left: 8px; font-weight: 600; }
</style>
