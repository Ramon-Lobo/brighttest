<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useData } from 'vitepress'
import { siteRootOf, pagePathOf, FULL_PREFIX, stripFull } from './versionContext'
const { site } = useData()
const siteRoot = siteRootOf(site.value.base)
const nextUrl = ref<string | null>(null)
const oneGuideUrl = ref<string | null>(null)
onMounted(async () => {
  const root = siteRootOf(site.value.base)
  const rel = pagePathOf(window.location.pathname, site.value.base)
  const url = `${root}next/${rel.replace(/^\/+/, '')}`
  // A /full/ page in a version without a full tier: offer the same page of its single guide.
  if (FULL_PREFIX.test(rel)) {
    const one = site.value.base + stripFull(rel)
    try {
      const r = await fetch(one, { method: 'HEAD' })
      if (r.ok) oneGuideUrl.value = one
    } catch { /* ignore */ }
  }
  try {
    const r = await fetch(url, { method: 'HEAD' })
    // A static host can answer 200 with the 404 page; only trust ok statuses.
    if (r.ok) nextUrl.value = url
  } catch { /* ignore */ }
})
</script>

<template>
  <div class="bt-nf-wrap">
    <p class="bt-nf-code">404</p>
    <h1 class="bt-nf-title">PAGE NOT FOUND</h1>
    <p class="bt-nf-quote">This page does not exist in this version of the docs.</p>
  <p v-if="oneGuideUrl" class="bt-nf" data-testid="nf-one-guide">
    This version has one guide: <a :href="oneGuideUrl">open it</a>.
  </p>
  <p v-if="nextUrl" class="bt-nf" data-testid="nf-next">
    This page is in the unreleased docs: <a :href="nextUrl">open the /next/ copy</a>.
  </p>
    <a class="bt-nf-home" :href="siteRoot">Take me home</a>
  </div>
</template>

<style scoped>
.bt-nf-wrap { padding: 48px 24px; text-align: center; }
.bt-nf-code { font-size: 64px; font-weight: 600; line-height: 1.2; margin: 0; }
.bt-nf-title { font-size: 20px; font-weight: 700; letter-spacing: 2px; margin: 8px 0; }
.bt-nf-home { display: inline-block; margin-top: 16px; font-weight: 500; }
.bt-nf a { color: var(--vp-c-brand-1); text-decoration: underline; text-underline-offset: 2px; }
.bt-nf { margin: 16px 0 0; padding: 10px 14px; border-radius: 8px; background: var(--vp-c-warning-soft); }
</style>
