<script setup lang="ts">
import { computed } from 'vue'
import { useData } from 'vitepress'
import { stripFull } from './versionContext'

// "New" / "Updated" tag above the page title. The label is real text, never colour alone.
const { page, theme } = useData()

const kind = computed(() => {
  const cfg = (theme.value as any).btBadges
  if (!cfg || !cfg.pages) return ''
  // /full/<page> shows the same tag as <page> (two-tier docs).
  const rel = stripFull(page.value.relativePath).replace(/\.md$/, '')
  return cfg.pages[rel] || ''
})
const since = computed(() => (theme.value as any).btBadges?.since || '')
const text = computed(() => (kind.value === 'new' ? 'New' : kind.value === 'updated' ? 'Updated' : ''))
const title = computed(() => (since.value ? `${text.value} since ${since.value}` : text.value))
</script>

<template>
  <div v-if="kind" class="bt-page-badge" role="region" aria-label="Page status">
    <Badge :type="kind === 'new' ? 'tip' : 'info'" :text="text" :title="title" />
  </div>
</template>
