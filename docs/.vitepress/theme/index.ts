import { h } from 'vue'
import DefaultTheme from 'vitepress/theme'
import type { Theme } from 'vitepress'
import VersionSwitcher from './VersionSwitcher.vue'
import VersionBanner from './VersionBanner.vue'
import NotFoundFallback from './NotFoundFallback.vue'

export default {
  extends: DefaultTheme,
  Layout: () =>
    h(DefaultTheme.Layout, null, {
      'layout-top': () => h(VersionBanner),
      'nav-bar-content-before': () => h(VersionSwitcher),
      'not-found': () => h(NotFoundFallback),
    }),
} satisfies Theme
