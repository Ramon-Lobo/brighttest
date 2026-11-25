import { h } from 'vue'
import DefaultTheme from 'vitepress/theme'
import type { Theme } from 'vitepress'
import VersionSwitcher from './VersionSwitcher.vue'
import VersionBanner from './VersionBanner.vue'
import NotFoundFallback from './NotFoundFallback.vue'
import PageBadge from './PageBadge.vue'
import './badges.css'

export default {
  extends: DefaultTheme,
  Layout: () =>
    h(DefaultTheme.Layout, null, {
      'layout-top': () => h(VersionBanner),
      'nav-bar-content-before': () => h(VersionSwitcher),
      'doc-before': () => h(PageBadge),
      'not-found': () => h(NotFoundFallback),
    }),
} satisfies Theme
