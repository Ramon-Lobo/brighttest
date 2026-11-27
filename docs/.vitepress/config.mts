import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { withMermaid } from 'vitepress-plugin-mermaid'

// Two-tier docs (ADR 0061): docs/lite/ pages are served at the usual URLs and the full page for the same path
// at /full/<path>, through VitePress rewrites. With no docs/lite/ everything below is empty and the site
// builds as a single tier.
const tiersMod = createRequire(import.meta.url)(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'docs-tiers.js'))
const tiers = tiersMod.tierMap(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'))
const hasTiers = tiers.tiered.length > 0 || tiers.liteOnly.length > 0
const tierRewrites: Record<string, string> = tiersMod.rewritesFor(tiers)
const tieredSet = new Set<string>(tiers.tiered)

// New / Updated badges (scripts/docs-badges.js). Never fails the build: any problem means no badges.
const here = path.dirname(fileURLToPath(import.meta.url))
const docsRoot = path.resolve(here, '..')

function badgeChannel(): 'next' | 'latest' | 'old' | 'dev' {
  const c = process.env.BRIGHTTEST_DOCS_CHANNEL
  if (c === 'next') return 'next'
  if (c === 'release') return process.env.BRIGHTTEST_DOCS_LATEST === '1' ? 'latest' : 'old'
  return 'dev'
}

function loadBadges() {
  const none = { badges: {} as Record<string, string>, since: '' }
  try {
    const req = createRequire(import.meta.url)
    const mod = req(path.resolve(docsRoot, '..', 'scripts', 'docs-badges.js'))
    const channel = badgeChannel()
    if (channel === 'old') return none
    let releasePages: unknown = null
    try { releasePages = JSON.parse(fs.readFileSync(path.join(here, 'release-pages.json'), 'utf8')) } catch {}
    const changelogText = fs.existsSync(path.join(docsRoot, 'changelog.md'))
      ? fs.readFileSync(path.join(docsRoot, 'changelog.md'), 'utf8') : ''
    const version = JSON.parse(fs.readFileSync(path.resolve(docsRoot, '..', 'package.json'), 'utf8')).version
    const info = mod.badgeInfo({ pages: mod.listPages(docsRoot, { srcExclude: ['lite/**'] }), releasePages, changelogText, channel, version })
    if (!info.baseline) {
      console.log(`docs badges: none (${info.reason})`)
      return none
    }
    const m = /^(\d+\.\d+)/.exec(info.baseline.version)
    return { badges: info.badges, since: m ? `v${m[1]}` : `v${info.baseline.version}`, mod }
  } catch (e) {
    console.log(`docs badges: none (${(e as Error).message})`)
    return none
  }
}

const bt = loadBadges() as { badges: Record<string, string>; since: string; mod?: any }
const labelSidebar = <T,>(items: T): T => {
  try {
    return bt.mod && Object.keys(bt.badges).length ? bt.mod.labelSidebar(items, bt.badges) : items
  } catch (e) {
    console.log(`docs badges: none (${(e as Error).message})`)
    return items
  }
}

// True when the changelog's Unreleased section has at least one entry (the /next/ banner links to it then).
function hasUnreleased(): boolean {
  try {
    const req = createRequire(import.meta.url)
    const mod = req(path.resolve(docsRoot, '..', 'scripts', 'docs-badges.js'))
    const f = path.join(docsRoot, 'changelog.md')
    if (!fs.existsSync(f)) return false
    return /^\s*[-*] /m.test(mod.changelogSection(fs.readFileSync(f, 'utf8'), null))
  } catch {
    return false
  }
}

// The full sidebar (today's sidebar), links without the /full prefix.
const FULL_SIDEBAR_UNPREFIXED = [
  {
    text: 'Introduction',
    items: [
      { text: 'Overview', link: '/' },
      { text: 'Motivation & decisions', link: '/motivation' },
      { text: 'Architecture', link: '/architecture' },
      { text: 'Design decisions', link: '/decisions-summary' },
      { text: 'Changelog', link: '/changelog' },
    ],
  },
  {
    text: 'Getting started',
    items: [
      { text: 'Quick start', link: '/guide/getting-started' },
      { text: 'CLI reference', link: '/guide/cli-reference' },
      { text: 'Example apps', link: '/guide/examples' },
      { text: 'Troubleshooting & how it works', link: '/guide/troubleshooting' },
      { text: 'Reporting issues', link: '/guide/reporting-issues' },
    ],
  },
  {
    text: 'Adopting an existing app',
    collapsed: false,
    items: [
      { text: 'Adopting brighttest', link: '/guide/adopting' },
      { text: 'Assess a project', link: '/guide/assess' },
      { text: 'Map the app', link: '/guide/feature-tree' },
      { text: 'Examples of mapping', link: '/guide/external-examples' },
      { text: 'Mapping results', link: '/guide/mapping-results' },
    ],
  },
  {
    text: 'Agents',
    collapsed: false,
    items: [
      { text: 'Agent skills', link: '/guide/agent-skills' },
      { text: 'Agent surface (MCP)', link: '/guide/mcp' },
    ],
  },
  {
    text: 'Network & fixtures',
    collapsed: false,
    items: [
      { text: 'Network recipe', link: '/guide/network-recipe' },
      { text: 'Network fault model', link: '/guide/net-faults' },
      { text: 'HTTP fixtures in specs', link: '/writing-tests/http-fixtures' },
      { text: 'roChannelStore fixtures', link: '/guide/store-fixtures' },
    ],
  },
  {
    text: 'Instrumentation & Studio',
    collapsed: false,
    items: [
      { text: 'Instrumented builds', link: '/guide/instrument' },
      { text: 'Studio', link: '/guide/studio' },
      { text: 'Builds', link: '/guide/builds' },
    ],
  },
  {
    text: 'CI & devices',
    collapsed: false,
    items: [
      { text: 'CI integration', link: '/guide/ci' },
      { text: 'Device shelf (CI)', link: '/guide/ci-device-shelf' },
      { text: 'Sharing a device (lease)', link: '/guide/device-lease' },
      { text: 'Several agents on one device', link: '/guide/multi-agent-device' },
      { text: 'Engines and patches', link: '/guide/engines' },
    ],
  },
  {
    text: 'Writing tests',
    collapsed: false,
    items: [
      { text: 'Start here', link: '/writing-tests/' },
      { text: '1. Your first test', link: '/writing-tests/first-test' },
      { text: '2. Anatomy of a test file', link: '/writing-tests/anatomy' },
      { text: '3. Assertions', link: '/writing-tests/assertions' },
      { text: '4. Organizing tests', link: '/writing-tests/organizing' },
      { text: '5. Parameterized tests', link: '/writing-tests/parameterized' },
      { text: '6. Setup & teardown', link: '/writing-tests/setup-teardown' },
      { text: '7. Mocks, stubs & spies', link: '/writing-tests/test-doubles' },
      { text: '8. SceneGraph & async tests', link: '/writing-tests/scenegraph-async' },
      { text: '9. Headless vs device', link: '/writing-tests/headless-vs-device' },
      { text: '10. Global context (seeding)', link: '/writing-tests/global-context' },
      { text: '11. Cookbook', link: '/writing-tests/cookbook' },
      { text: '12. Common mistakes', link: '/writing-tests/mistakes' },
      { text: 'Media state (headless)', link: '/writing-tests/media-state' },
      { text: 'State fixtures (headless)', link: '/writing-tests/state-fixtures' },
    ],
  },
  {
    text: 'End-to-end (on device)',
    collapsed: false,
    items: [
      { text: 'Overview', link: '/e2e/' },
      { text: 'Flow reference', link: '/e2e/flows' },
      { text: 'Authoring flows', link: '/e2e/authoring' },
      { text: 'App state', link: '/e2e/app-state' },
      { text: 'Scaling & CI', link: '/e2e/scaling' },
    ],
  },
  {
    text: 'Contributing',
    items: [
      { text: 'Contributing guide', link: '/contributing' },
      { text: 'Maintainer internals', link: '/maintainers' },
    ],
  },
]

const labeledFullSidebar = labelSidebar(FULL_SIDEBAR_UNPREFIXED)
// Tiered: the lite sidebar (a copy of the full one until docs/lite adds its own) at /, the full one at /full/.
const sidebarConfig: any = hasTiers
  ? {
      '/full/': tiersMod.prefixFull(labeledFullSidebar, tiers),
      '/': labeledFullSidebar,
    }
  : labeledFullSidebar

// VitePress site config for the brighttest docs. Mermaid diagrams are enabled via
// vitepress-plugin-mermaid (```mermaid fenced blocks render to SVG).
// A relative link in a full-tier page is resolved against the page's source directory and made absolute, so it
// keeps pointing at the same page whether that page is tiered (/full/x) or full-only (/x). The routed path
// (full/guide/a.md) would otherwise resolve ./changelog to a /full/ URL that does not exist.
function absoluteInSource(href: string, routedPath: string): string {
  if (!routedPath.startsWith('full/') || !href || href.startsWith('/') || href.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(href)) return href
  const m = /^([^#?]*)([?#].*)?$/.exec(href)
  if (!m || !m[1]) return href
  const dir = path.posix.dirname('/' + routedPath.slice('full/'.length))
  return path.posix.normalize(path.posix.join(dir, m[1])) + (m[2] || '')
}

export default withMermaid({
  title: 'brighttest',
  description:
    'Unified BrightScript test runner — write Rooibos specs once, run headless or on-device with coverage.',
  cleanUrls: true,
  // Two-tier docs: map form would treat page paths as path-to-regexp patterns, so use the function form.
  ...(hasTiers ? { rewrites: (id: string) => tierRewrites[id] } : {}),
  lastUpdated: true,

  // GitHub Pages serves a project site under /<repo>/, so assets must be prefixed with the repo name.
  // Set to '/brighttest/' assuming the repo is named `brighttest`. Change to match your repo name, or
  // to '/' if you deploy to a user/org site (<user>.github.io) or a custom domain.
  base: '/brighttest/',

  // The unreleased (main) build is published under /next/ and must not be indexed; releases are.
  // The docs site build sets BRIGHTTEST_DOCS_CHANNEL=next for that build only.
  transformHead({ pageData, siteConfig }) {
    if (process.env.BRIGHTTEST_DOCS_CHANNEL === 'next') return [['meta', { name: 'robots', content: 'noindex' }]]
    // pageData.filePath is the source file; relativePath is the routed path (they differ under rewrites).
    const filePath = (pageData as any).filePath || pageData.relativePath
    if (!siteConfig.pages.includes(filePath)) return []
    // Released docs also publish a plain-Markdown twin of every full page (see buildEnd below): a lite page
    // points at the full twin, a lite-only page has none.
    const twin = tiersMod.twinOf(filePath, tiers)
    if (!twin) return []
    const b = ('/' + (siteConfig.site.base || '/').replace(/^\/+|\/+$/g, '') + '/').replace(/^\/\/$/, '/')
    const head: any[] = [['link', { rel: 'alternate', type: 'text/markdown', href: b + twin }]]
    // Canonical link, citation meta tags and schema.org JSON-LD (scripts/docs-seo.js). Released docs only.
    try {
      const req = createRequire(import.meta.url)
      const repoRoot = path.resolve(docsRoot, '..')
      head.push(...req(path.resolve(repoRoot, 'scripts', 'docs-seo.js')).seoHead({
        repoRoot,
        srcDir: siteConfig.srcDir,
        relativePath: pageData.relativePath,
        filePath,
        base: siteConfig.site.base,
        origin: req(path.resolve(repoRoot, 'scripts', 'docs-agent-files.js')).siteOrigin(repoRoot),
        title: pageData.title,
        description: pageData.description,
        lastUpdated: pageData.lastUpdated,
        siteTitle: siteConfig.site.title,
        siteDescription: siteConfig.site.description,
      }))
    } catch (e) {
      console.log(`docs seo: none for ${pageData.relativePath} (${(e as Error).message})`)
    }
    return head
  },

  // Agent-readable files for released docs only (not /next/): llms.txt plus a .md twin per page.
  // Generated, never committed; a problem fails the build so the files cannot go stale silently.
  buildEnd(siteConfig) {
    if (process.env.BRIGHTTEST_DOCS_CHANNEL === 'next') return
    const req = createRequire(import.meta.url)
    const mod = req(path.resolve(docsRoot, '..', 'scripts', 'docs-agent-files.js'))
    const r = mod.generate({
      srcDir: siteConfig.srcDir,
      outDir: siteConfig.outDir,
      base: siteConfig.site.base,
      origin: mod.siteOrigin(path.resolve(docsRoot, '..')),
      pages: siteConfig.pages.filter((p: string) => !p.startsWith('lite/')),
      sidebar: labeledFullSidebar,
      tiered: tiers.tiered,
      title: siteConfig.site.title,
      description: siteConfig.site.description,
    })
    if (r.warnings.length) throw new Error('agent-readable docs: ' + r.warnings.join('; '))
    console.log(`agent-readable docs: llms.txt + ${r.files.length} .md pages`)
  },

  // Shiki has no 'brightscript' grammar; VB is the closest for keywords like function/sub/if/then/end.
  markdown: {
    languageAlias: { brightscript: 'vb' },
    config(md) {
      if (!hasTiers) return
      // [text](full:/guide/x) -> /full/guide/x (same tab); the dead-link check validates the target.
      // On a full-tier page, absolute links to tiered pages stay in /full/.
      md.core.ruler.push('bt-tier-links', (state) => {
        // env.relativePath is the routed path: full-tier pages are served under full/.
        const relPath = String((state.env as any)?.relativePath || '').replace(/\\/g, '/')
        const inFull = relPath.startsWith('full/')
        for (const blk of state.tokens) {
          if (blk.type !== 'inline' || !blk.children) continue
          for (const t of blk.children) {
            if (t.type !== 'link_open') continue
            const href = t.attrGet('href') || ''
            if (href.startsWith('full:')) t.attrSet('href', '/full/' + href.slice('full:'.length).replace(/^\/+/, ''))
            else if (inFull) t.attrSet('href', tiersMod.fullLink(absoluteInSource(href, relPath), tiers))
          }
        }
      })
    },
  },

  themeConfig: {
    btBadges: { pages: bt.badges, since: bt.since },
    btChangelog: { unreleased: hasUnreleased() },
    nav: [
      {
        text: 'Start',
        items: [
          { text: 'Quick start', link: '/guide/getting-started' },
          { text: 'CLI reference', link: '/guide/cli-reference' },
          { text: 'Example apps', link: '/guide/examples' },
          { text: 'Troubleshooting & how it works', link: '/guide/troubleshooting' },
          { text: 'Reporting issues', link: '/guide/reporting-issues' },
        ],
      },
      { text: 'Writing tests', link: '/writing-tests/' },
      {
        text: 'Adopting',
        items: [
          { text: 'Adopting brighttest', link: '/guide/adopting' },
          { text: 'Assess a project', link: '/guide/assess' },
          { text: 'Map the app', link: '/guide/feature-tree' },
          { text: 'Examples of mapping', link: '/guide/external-examples' },
          { text: 'Mapping results', link: '/guide/mapping-results' },
        ],
      },
      {
        text: 'Agents',
        items: [
          { text: 'Agent skills', link: '/guide/agent-skills' },
          { text: 'Agent surface (MCP)', link: '/guide/mcp' },
        ],
      },
      {
        text: 'Network',
        items: [
          { text: 'Network recipe', link: '/guide/network-recipe' },
          { text: 'Network fault model', link: '/guide/net-faults' },
          { text: 'HTTP fixtures in specs', link: '/writing-tests/http-fixtures' },
          { text: 'roChannelStore fixtures', link: '/guide/store-fixtures' },
        ],
      },
      {
        text: 'Instrument & Studio',
        items: [
          { text: 'Instrumented builds', link: '/guide/instrument' },
          { text: 'Studio', link: '/guide/studio' },
          { text: 'Builds', link: '/guide/builds' },
        ],
      },
      { text: 'E2E', link: '/e2e/' },
      { text: 'Changelog', link: '/changelog' },
      {
        text: 'CI',
        items: [
          { text: 'CI integration', link: '/guide/ci' },
          { text: 'Device shelf (CI)', link: '/guide/ci-device-shelf' },
          { text: 'Sharing a device (lease)', link: '/guide/device-lease' },
          { text: 'Engines and patches', link: '/guide/engines' },
        ],
      },
      ...(hasTiers ? [{ text: 'Full guide', link: '/full/' }] : []),
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/Ramon-Lobo/brighttest' },
    ],

    editLink: {
      pattern: 'https://github.com/Ramon-Lobo/brighttest/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },

    btTiers: hasTiers ? { tiered: tiers.tiered } : undefined,
    sidebar: sidebarConfig,

    outline: { level: [2, 3] },
    search: hasTiers
      ? {
          provider: 'local',
          options: {
            // Lite pages have every fact; do not index the /full/ copy of a page a second time.
            // env.relativePath is the source path here (not the routed one): skip the full-tier source of a tiered page.
            _render: (src: string, env: any, md: any) => (tieredSet.has(String(env?.relativePath || '')) ? '' : md.render(src, env)),
          },
        }
      : { provider: 'local' },
  },
})
