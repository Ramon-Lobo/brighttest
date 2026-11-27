<script setup lang="ts">
import { computed } from 'vue'
import { useData, withBase } from 'vitepress'
import { tierLink } from './versionContext'

// Two-tier docs: "Full guide" link on a lite page, "Short version" link on a full page. Renders nothing when the
// build has no tiers (themeConfig.btTiers absent, as in released trees from before the lite tier) or the page
// has no other tier.
const { page, theme } = useData()
const link = computed(() => tierLink(page.value.relativePath, (theme.value as any).btTiers?.tiered))
const href = computed(() => (link.value ? withBase('/' + link.value.path) : ''))
</script>

<template>
  <p v-if="link" class="bt-tier-link" data-testid="tier-link">
    <template v-if="link.kind === 'to-full'">Short version. <a :href="href">Full guide</a></template>
    <template v-else>Full guide. <a :href="href">Short version</a></template>
  </p>
</template>

<style scoped>
.bt-tier-link { margin: 0 0 16px; padding: 8px 12px; border-radius: 8px; background: var(--vp-c-default-soft); font-size: 14px; }
.bt-tier-link a { font-weight: 600; color: var(--vp-c-brand-1); text-decoration: underline; text-underline-offset: 2px; }
</style>
