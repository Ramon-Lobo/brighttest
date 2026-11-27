import { h, onMounted, watch, nextTick } from 'vue'
import { useRoute } from 'vitepress'
import DefaultTheme from 'vitepress/theme'
import type { Theme } from 'vitepress'
import VersionSwitcher from './VersionSwitcher.vue'
import VersionBanner from './VersionBanner.vue'
import NotFoundFallback from './NotFoundFallback.vue'
import PageBadge from './PageBadge.vue'
import TierLink from './TierLink.vue'
import './badges.css'
import './layout.css'

export default {
  extends: DefaultTheme,
  Layout: {
    setup() {
      // The default home and 404 layouts have no <main>. Mark one so each page has a main landmark (doc pages already do).
      const route = useRoute()
      const markHomeMain = () =>
        nextTick(() => {
          if (document.querySelector('main, [role="main"]')) return
          document.querySelector('.VPHome, #VPContent')?.setAttribute('role', 'main')
        })
      onMounted(markHomeMain)
      watch(() => route.path, markHomeMain)
      return () =>
        h(DefaultTheme.Layout, null, {
          'layout-top': () => h(VersionBanner),
          'nav-bar-content-before': () => h(VersionSwitcher),
          'doc-before': () => [h(PageBadge), h(TierLink)],
          'not-found': () => h(NotFoundFallback),
        })
    },
  },
} satisfies Theme
