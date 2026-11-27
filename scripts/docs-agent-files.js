'use strict'

// Agent-readable copies of the docs site, generated at docs build time (never committed):
//   - a plain-Markdown twin of every page at <outDir>/<page>.md (same URL plus ".md"), and
//   - <outDir>/llms.txt, an index in the llmstxt.org shape (title, summary, links grouped by sidebar section).
// Called from docs/.vitepress/config.mts (buildEnd). Pure Node, no dependencies, Windows-safe paths.
// The twins are cleaned of VitePress-only syntax (frontmatter, containers, code-group labels, includes, badges,
// the table-of-contents token, HTML comments, script/style blocks) so a reader sees plain Markdown.

const fs = require('node:fs')
const path = require('node:path')

const posix = (p) => p.split(path.sep).join('/')

// ---- fence-aware line walking ------------------------------------------------------------------------------

// Calls fn(line, inFence) for each line and collects the returned lines (fn returns string | string[] | null).
function mapLines(text, fn) {
  const out = []
  let fence = null // { ch, len }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(`{3,}|~{3,})(.*)$/.exec(line)
    if (fence) {
      const close = m && m[1][0] === fence.ch && m[1].length >= fence.len && !m[2].trim()
      const r = fn(line, true)
      if (r != null) out.push(...[].concat(r))
      if (close) fence = null
    } else if (m) {
      fence = { ch: m[1][0], len: m[1].length }
      const r = fn(line, 'open')
      if (r != null) out.push(...[].concat(r))
    } else {
      const r = fn(line, false)
      if (r != null) out.push(...[].concat(r))
    }
  }
  return out
}

function splitFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!m) return { data: {}, body: text }
  return { data: parseSimpleYaml(m[1]), body: text.slice(m[0].length) }
}

// Minimal YAML reader for the shapes our docs use: top-level scalars, `hero:` mapping, `features:` list of mappings.
function parseSimpleYaml(src) {
  const data = {}
  const lines = src.split(/\r?\n/)
  let cur = null // { key, kind }
  let item = null
  const unq = (v) => v.trim().replace(/^(['"])(.*)\1$/, '$2')
  for (const raw of lines) {
    if (!raw.trim() || /^\s*#/.test(raw)) continue
    const indent = /^ */.exec(raw)[0].length
    const t = raw.trim()
    if (indent === 0) {
      const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(t)
      if (!m) continue
      if (m[2]) { data[m[1]] = unq(m[2]); cur = null } else { data[m[1]] = null; cur = { key: m[1] }; item = null }
    } else if (cur) {
      if (t.startsWith('- ')) {
        const holder = cur.sub ? data[cur.key] : data
        const k = cur.sub || cur.key
        if (!Array.isArray(holder[k])) holder[k] = []
        item = {}
        holder[k].push(item)
        const m = /^- ([A-Za-z0-9_-]+):\s*(.*)$/.exec(t)
        if (m) item[m[1]] = unq(m[2])
      } else {
        const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(t)
        if (!m) continue
        if (item && indent >= 4) {
          if (m[2]) item[m[1]] = unq(m[2])
        } else {
          if (data[cur.key] === null) data[cur.key] = {}
          if (m[2]) { data[cur.key][m[1]] = unq(m[2]); cur.sub = null } else { data[cur.key][m[1]] = null; cur.sub = m[1] }
          item = null
        }
      }
    }
  }
  return data
}

const decodeEntities = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")

// ---- cleaning ------------------------------------------------------------------------------------------------

const CONTAINER_LABEL = { tip: 'Tip', warning: 'Warning', danger: 'Danger', info: 'Note', details: 'Details', important: 'Important', caution: 'Caution', note: 'Note' }

function resolveIncludes(body, file, seen = new Set()) {
  return mapLines(body, (line, inFence) => {
    if (inFence) return line
    const m = /^\s*<!--\s*@include:\s*([^\s>]+?)\s*-->\s*$/.exec(line)
    if (!m) return line
    const target = path.resolve(path.dirname(file), m[1].replace(/#.*$/, '').replace(/\{[^}]*\}$/, ''))
    if (seen.has(target) || !fs.existsSync(target)) throw new Error(`docs-agent-files: cannot include ${m[1]} from ${file}`)
    const inner = splitFrontmatter(fs.readFileSync(target, 'utf8')).body
    return resolveIncludes(inner, target, new Set([...seen, target])).split('\n')
  }).join('\n')
}

// Body-only cleanup: no link rewriting, no frontmatter.
function cleanBody(body) {
  const stack = [] // open containers, each { prefix }
  let skipBlock = null // 'script' | 'style'
  const lines = mapLines(body, (line, inFence) => {
    const prefix = stack.length ? '> ' : ''
    if (inFence === true) return prefix + line
    if (inFence === 'open') {
      // "```js{1,3} [label]" -> "```js"; a code-group label becomes a bold line above the fence.
      const m = /^(\s*)(`{3,}|~{3,})([^\s{[]*)(.*)$/.exec(line)
      const label = /\[([^\]]+)\]/.exec(m[4])
      const head = `${m[1]}${m[2]}${m[3]}`
      return label && stack.some((c) => c.group) ? [`${prefix}**${label[1]}**`, '', prefix + head] : prefix + head
    }
    if (skipBlock) {
      if (new RegExp(`</${skipBlock}>`, 'i').test(line)) skipBlock = null
      return null
    }
    let m = /^\s*<(script|style)\b[^>]*>/i.exec(line)
    if (m) {
      if (!new RegExp(`</${m[1]}>`, 'i').test(line)) skipBlock = m[1].toLowerCase()
      return null
    }
    m = /^:::\s*([A-Za-z-]+)\s*(.*)$/.exec(line)
    if (m) {
      const kind = m[1].toLowerCase()
      if (kind === 'code-group') { stack.push({ group: true, quiet: true }); return null }
      const label = CONTAINER_LABEL[kind] || kind
      const title = m[2].trim()
      stack.push({})
      return [`> **${label}${title ? ': ' + title : ''}**`, '>']
    }
    if (/^:::\s*$/.test(line)) {
      const c = stack.pop()
      return c && c.quiet ? null : ''
    }
    if (/^\s*\[\[toc\]\]\s*$/i.test(line)) return null
    if (/^\s*<!--.*-->\s*$/.test(line)) return null
    let l = line
    l = l.replace(/<Badge\b[^>]*\btext="([^"]*)"[^>]*\/?>(\s*<\/Badge>)?/g, '($1)')
    l = l.replace(/^(#{1,6}\s.*?)\s*\{#[\w-]+\}\s*$/, '$1')
    return prefix + l
  })
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n'
}

// Rewrites link destinations outside code. resolve(url) returns the replacement or null to leave it.
function rewriteLinks(body, resolve) {
  const fix = (url) => {
    const r = resolve(url)
    return r == null ? url : r
  }
  return mapLines(body, (line, inFence) => {
    if (inFence) return line
    // Protect inline code spans, then rewrite [text](url "title"), ![alt](url), and "[ref]: url" definitions.
    const spans = []
    let l = line.replace(/(`+)[^`]*?\1/g, (s) => { spans.push(s); return `\u0000${spans.length - 1}\u0000` })
    l = l.replace(/(\]\()(<[^>]+>|[^)\s]+)((?:\s+"[^"]*")?\))/g, (_, a, u, c) => a + fix(u.replace(/^<|>$/g, '')) + c)
    l = l.replace(/^(\s*\[[^\]]+\]:\s*)(\S+)/, (_, a, u) => a + fix(u))
    return l.replace(/\u0000(\d+)\u0000/g, (_, i) => spans[Number(i)])
  }).join('\n')
}

// ---- page model ------------------------------------------------------------------------------------------------

// Source-relative path "guide/studio.md" -> site path "guide/studio" ('' for the root, "writing-tests/" for an index).
function pageRoute(rel) {
  if (rel === 'index.md') return ''
  if (rel.endsWith('/index.md')) return rel.slice(0, -'index.md'.length)
  return rel.slice(0, -'.md'.length)
}

function stripInline(s) {
  return s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<(https?:[^>]+)>/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(^|[\s(])[*_]([^*_]+)[*_](?=[\s).,;:]|$)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim()
}

function firstParagraph(body) {
  let para = []
  let done = false
  mapLines(body, (line, inFence) => {
    if (done) return null
    if (inFence) { if (para.length) done = true; return null }
    const t = line.trim()
    const skip = !t || /^(#|>|\||[-*+] |\d+[.)] |:::|<|!\[)/.test(t)
    if (skip) { if (para.length) done = true; return null }
    para.push(t)
    return null
  })
  return stripInline(para.join(' '))
}

function truncate(s, max = 200) {
  if (s.length <= max) return s
  const cut = s.slice(0, max)
  const sentence = /^(.*?[.!?])(\s|$)/.exec(s)
  if (sentence && sentence[1].length <= max) return sentence[1]
  return cut.replace(/\s+\S*$/, '') + '...'
}

function loadPage(srcDir, rel) {
  const file = path.join(srcDir, ...rel.split('/'))
  const raw = fs.readFileSync(file, 'utf8')
  const { data, body: rawBody } = splitFrontmatter(raw)
  let body = resolveIncludes(rawBody, file)
  let heading = null
  let prelude = ''
  if (data.layout === 'home' && data.hero) {
    const h = data.hero
    heading = h.name || null
    prelude += `# ${decodeEntities(h.name || '')}\n\n`
    if (h.text) prelude += `**${decodeEntities(h.text)}**\n\n`
    if (h.tagline) prelude += `${decodeEntities(h.tagline)}\n\n`
    const links = (h.actions || []).filter((a) => a.link && a.text)
    if (links.length) prelude += links.map((a) => `- [${a.text}](${a.link})`).join('\n') + '\n\n'
    if (Array.isArray(data.features) && data.features.length) {
      prelude += data.features.map((f) => `- **${decodeEntities(f.title)}**: ${decodeEntities(f.details || '')}`).join('\n') + '\n\n'
    }
  }
  let cleaned = cleanBody(body)
  const hm = /^#\s+(.+?)\s*$/m.exec(cleaned)
  const title = data.title ? String(data.title) : heading || (hm ? stripInline(hm[1]) : path.basename(rel, '.md'))
  const description = data.description
    ? String(data.description)
    : data.layout === 'home' && data.hero && data.hero.tagline ? decodeEntities(data.hero.tagline) : firstParagraph(cleaned)
  return { rel, route: pageRoute(rel), title, description: truncate(description), prelude, cleaned, hasH1: !!hm }
}

// ---- generation --------------------------------------------------------------------------------------------------

function sidebarSections(sidebar) {
  const out = []
  const walk = (items, section) => {
    for (const it of items || []) {
      if (it.items) walk(it.items, it.text && !it.link ? it.text : section)
      else if (it.link) out.push({ section, link: it.link.split('#')[0] })
    }
  }
  for (const s of Array.isArray(sidebar) ? sidebar : []) {
    if (s.items) walk(s.items, s.text)
    else if (s.link) out.push({ section: 'Pages', link: s.link.split('#')[0] })
  }
  return out
}

// Site path for a sidebar link ("/guide/studio", "/writing-tests/", "/") -> source-relative md path.
function linkToRel(link) {
  const p = link.replace(/^\//, '')
  if (p === '') return 'index.md'
  if (p.endsWith('/')) return p + 'index.md'
  return p + '.md'
}

/**
 * generate({ srcDir, outDir, base, origin, pages, sidebar, title, description })
 *  pages: source-relative md paths (e.g. "guide/studio.md"). tiered: optional list of pages that have a lite
 *  twin (only changes the llms.txt preamble wording). Returns { files, warnings }.
 */
function generate(opts) {
  const { srcDir, outDir, pages, sidebar, title, description } = opts
  const base = ('/' + (opts.base || '/').replace(/^\/+|\/+$/g, '') + '/').replace(/^\/\/$/, '/')
  const origin = (opts.origin || '').replace(/\/+$/, '')
  const abs = (sitePath) => origin + base + sitePath
  const warnings = []
  const rels = pages.map(posix).filter((r) => r.endsWith('.md')).sort()
  const relSet = new Set(rels)
  const loaded = new Map(rels.map((r) => [r, loadPage(srcDir, r)]))

  const resolveLink = (fromRel) => (url) => {
    if (!url || /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//')) return null // external, mailto:, etc.
    if (url.startsWith('#')) return null
    const m = /^([^#?]*)([?#].*)?$/.exec(url)
    let p = m[1]
    const tail = m[2] || ''
    let target
    if (p.startsWith('/')) target = path.posix.normalize(p.replace(/^\//, ''))
    else target = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), p))
    if (target === '.') target = ''
    const candidates = []
    if (target === '' || target.endsWith('/')) candidates.push(target + 'index.md')
    else if (target.endsWith('.md')) candidates.push(target)
    else if (target.endsWith('.html')) candidates.push(target.slice(0, -5) + '.md', target.slice(0, -5) + '/index.md')
    else if (!path.posix.extname(target)) candidates.push(target + '.md', target + '/index.md')
    const hit = candidates.find((c) => relSet.has(c))
    if (hit) return abs(hit) + tail
    // Static assets (images etc.) live in docs/public.
    if (fs.existsSync(path.join(srcDir, 'public', ...target.split('/'))) && path.posix.extname(target)) return abs(target) + tail
    warnings.push(`${fromRel}: link does not resolve to a docs page or asset: ${url}`)
    return null
  }

  const files = []
  for (const rel of rels) {
    const pg = loaded.get(rel)
    let text = pg.prelude + pg.cleaned
    if (!pg.hasH1 && !pg.prelude) text = `# ${pg.title}\n\n${text}`
    text = rewriteLinks(text, resolveLink(rel)).replace(/\n{3,}/g, '\n\n').trim() + '\n'
    const dest = path.join(outDir, ...rel.split('/'))
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, text)
    files.push(rel)
  }

  // llms.txt
  const sections = []
  const seen = new Set()
  for (const { section, link } of sidebarSections(sidebar)) {
    const rel = linkToRel(link)
    if (!relSet.has(rel)) { warnings.push(`sidebar link has no page: ${link}`); continue }
    if (seen.has(rel)) continue
    seen.add(rel)
    let s = sections.find((x) => x.name === section)
    if (!s) sections.push((s = { name: section, rels: [] }))
    s.rels.push(rel)
  }
  const rest = rels.filter((r) => !seen.has(r))
  if (rest.length) sections.push({ name: 'Optional', rels: rest })

  let txt = `# ${title}\n\n> ${description} `
  if (opts.tiered && opts.tiered.length) {
    txt += 'These pages are the full documentation. The website shows a shorter version of each page at the same address, with a Full guide link to /full/<path>; add ".md" to either address\'s page path to get this full Markdown copy. '
  } else {
    txt += 'These pages are the same documentation as the website, one Markdown file per page: add ".md" to a page URL to get its plain-Markdown copy. '
  }
  txt += `The Agents section lists the agent skills and the MCP server, and the skills carry the safety rules for using a real device.\n`
  for (const s of sections) {
    txt += `\n## ${s.name}\n\n`
    for (const r of s.rels) {
      const pg = loaded.get(r)
      txt += `- [${pg.title}](${abs(r)})${pg.description ? ': ' + pg.description : ''}\n`
    }
  }
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(path.join(outDir, 'llms.txt'), txt)
  return { files, warnings, llms: 'llms.txt' }
}

// Public origin for absolute links: BRIGHTTEST_DOCS_ORIGIN, else package.json "homepage" origin.
function siteOrigin(repoRoot) {
  if (process.env.BRIGHTTEST_DOCS_ORIGIN) return process.env.BRIGHTTEST_DOCS_ORIGIN.replace(/\/+$/, '')
  try {
    const hp = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).homepage
    return new URL(hp).origin
  } catch {
    return 'https://ramon-lobo.github.io'
  }
}

module.exports = { generate, siteOrigin, cleanBody, rewriteLinks, splitFrontmatter, firstParagraph, pageRoute, sidebarSections }
