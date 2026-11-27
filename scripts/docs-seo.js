'use strict'
// Head tags for released docs pages: canonical link, citation meta tags and schema.org JSON-LD.
// Used by docs/.vitepress/config.mts (transformHead). Never used for the /next/ channel.
const fs = require('fs')
const path = require('path')
const { splitFrontmatter, firstParagraph, pageRoute } = require('./docs-agent-files')

function projectInfo(repoRoot) {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
  const repoUrl = String((pkg.repository && pkg.repository.url) || pkg.repository || '')
    .replace(/^git\+/, '').replace(/\.git$/, '')
  const author = typeof pkg.author === 'string' ? pkg.author.replace(/\s*[<(].*$/, '').trim() : (pkg.author && pkg.author.name) || ''
  return { name: pkg.name, license: pkg.license, author, repoUrl }
}

function normBase(base) {
  return ('/' + String(base || '/').replace(/^\/+|\/+$/g, '') + '/').replace(/^\/\/$/, '/')
}

// Absolute clean URL of a page: the base itself for the home page, no .html, no index suffix.
function pageUrl(origin, base, relativePath) {
  return origin.replace(/\/+$/, '') + normBase(base) + pageRoute(relativePath)
}

function plain(s) {
  return String(s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
}

function clip(s, max = 300) {
  if (s.length <= max) return s
  return s.slice(0, max).replace(/\s+\S*$/, '') + '...'
}

// JSON that is safe inside a <script> element: no "</script>", "<!--" or line-separator surprises.
function safeJson(obj) {
  return JSON.stringify(obj).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
}

// filePath is the source file when it differs from the routed relativePath (two-tier docs rewrites); the
// canonical URL always uses the routed relativePath.
// Returns VitePress head entries for one page, or [] when the page has nothing to describe.
function seoHead({ repoRoot, srcDir, relativePath, filePath, base, origin, title, description, lastUpdated, siteTitle, siteDescription }) {
  const info = projectInfo(repoRoot)
  const url = pageUrl(origin, base, relativePath)
  const isHome = relativePath === 'index.md'
  let desc = plain(description)
  if (!desc) {
    try {
      const src = fs.readFileSync(path.join(srcDir, filePath || relativePath), 'utf8')
      desc = clip(firstParagraph(splitFrontmatter(src).body))
    } catch { /* fall through to the site description */ }
  }
  if (!desc) desc = plain(siteDescription)
  const pageTitle = plain(title) || siteTitle
  const fullTitle = isHome || pageTitle === siteTitle ? siteTitle : `${pageTitle} | ${siteTitle}`
  const modified = Number.isFinite(lastUpdated) && lastUpdated > 0 ? new Date(lastUpdated).toISOString() : ''

  const head = [
    ['link', { rel: 'canonical', href: url }],
    ['meta', { name: 'author', content: info.author }],
    ['meta', { property: 'og:title', content: fullTitle }],
    ['meta', { property: 'og:description', content: desc }],
    ['meta', { property: 'og:type', content: isHome ? 'website' : 'article' }],
    ['meta', { property: 'og:url', content: url }],
    ['meta', { property: 'og:site_name', content: siteTitle }],
    ['meta', { name: 'twitter:card', content: 'summary' }],
  ]
  if (!description && desc) head.push(['meta', { name: 'description', content: desc }])
  if (modified) head.push(['meta', { property: 'article:modified_time', content: modified }])

  const person = info.author ? { '@type': 'Person', name: info.author } : undefined
  const article = {
    '@context': 'https://schema.org',
    '@type': 'TechArticle',
    headline: clip(pageTitle, 110),
    description: desc,
    url,
    mainEntityOfPage: { '@type': 'WebPage', '@id': url },
    ...(modified ? { dateModified: modified } : {}),
    ...(person ? { author: person, publisher: person } : {}),
  }
  head.push(['script', { type: 'application/ld+json' }, safeJson(article)])

  if (isHome) {
    const site = {
      '@context': 'https://schema.org',
      '@type': 'SoftwareSourceCode',
      name: info.name,
      description: plain(siteDescription),
      url,
      license: 'https://spdx.org/licenses/' + info.license + '.html',
      codeRepository: info.repoUrl,
      programmingLanguage: 'JavaScript',
      ...(person ? { author: person } : {}),
    }
    head.push(['script', { type: 'application/ld+json' }, safeJson(site)])
  }
  return head
}

module.exports = { seoHead, pageUrl, safeJson, projectInfo }
