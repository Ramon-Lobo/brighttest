<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount, nextTick } from 'vue'
import { useData } from 'vitepress'
import { useVersions } from './useVersions'
const { data, current } = useVersions()
const { page, theme } = useData()
const latest = computed(() => data.value?.versions.find((v) => v.id === data.value?.latest))
// Compare link: repo URL comes from the site's GitHub social link.
const compareUrl = computed(() => {
  const tag = latest.value?.tag
  const gh = (theme.value.socialLinks as { icon?: unknown; link?: string }[] | undefined)
    ?.find((l) => l.icon === 'github')?.link
  if (!tag || !gh || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(gh)) return null
  return `${gh}/compare/${encodeURIComponent(tag)}...main`
})
// Changes link: this build's own changelog when it has Unreleased entries, else the GitHub compare.
const changesUrl = computed(() => {
  const cfg = (theme.value as { btChangelog?: { unreleased?: boolean } }).btChangelog
  if (cfg?.unreleased && current.value) return `${current.value.path}changelog#unreleased`
  return compareUrl.value
})
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
    <a v-if="changesUrl" :href="changesUrl" rel="noopener">Changes since {{ latest?.tag }}</a>
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
/* Below 960px the banner scrolls with the page and the full-screen menu opens from the top of the
   page, so push the menu below the banner to keep the close button reachable. */
@media (max-width: 959px) {
  .VPNavScreen { top: calc(var(--vp-nav-height) + var(--bt-banner-height, 0px)) !important; }
}
</style>

<style scoped>
.bt-banner { box-sizing: border-box; padding: 8px 16px; text-align: center; font-size: 14px; border-bottom: 1px solid var(--vp-c-divider); }
.bt-next { background: linear-gradient(var(--vp-c-warning-soft), var(--vp-c-warning-soft)), var(--vp-c-bg); color: var(--vp-c-text-1); }
.bt-old { background: linear-gradient(var(--vp-c-default-soft), var(--vp-c-default-soft)), var(--vp-c-bg); }
.bt-banner a { margin-left: 8px; font-weight: 600; }
@media (min-width: 960px) {
  .bt-banner { position: fixed; top: 0; left: 0; right: 0; z-index: var(--vp-z-index-layout-top); }
}
</style>
