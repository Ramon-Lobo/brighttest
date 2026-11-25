import { describe, it, expect } from 'vitest'
import path from 'node:path'

const b = require('../scripts/docs-badges.js')

const PAGES = ['index', 'changelog', 'guide/cli', 'guide/mcp', 'guide/index', 'guide/ci']
const RP = {
  schema: 1,
  releases: [
    { version: '0.8.0', pages: ['changelog', 'guide/cli', 'guide/mcp', 'index'] },
    { version: '0.7.0', pages: ['changelog', 'guide/cli', 'index'] },
  ],
}
const LOG = [
  '# Changelog',
  '## Unreleased {#unreleased}',
  '- **CLI:** a ([CLI](/guide/cli#flags)).',
  '- **CI:** b ([CI](./guide/ci.md)).',
  '- **X:** c (https://example.com/guide/mcp) and [ext](https://example.com/guide/mcp).',
  '- **X:** d ([gone](/guide/missing)).',
  '## v0.8.0 - 2026-01-01 {#v0-8-0}',
  '- **MCP:** e ([MCP](guide/mcp.md)) and [guide home](guide/).',
  '',
].join('\n')

describe('computeBadges', () => {
  it('next: baseline is the newest entry; New for absent pages, Updated from Unreleased links', () => {
    const r = b.computeBadges({ pages: PAGES, releasePages: RP, changelogText: LOG, channel: 'next', version: '0.8.0' })
    expect(r).toEqual({ 'guide/cli': 'updated', 'guide/ci': 'new', 'guide/index': 'new' })
  })

  it('absolute, relative and anchored links count; external and unknown links are ignored', () => {
    const r = b.badgeInfo({ pages: PAGES, releasePages: RP, changelogText: LOG, channel: 'dev' })
    expect(r.baseline.version).toBe('0.8.0')
    expect(r.badges['guide/cli']).toBe('updated')
    expect(r.badges['guide/mcp']).toBeUndefined()
    expect(Object.keys(r.badges)).not.toContain('guide/missing')
  })

  it('New wins over Updated', () => {
    const r = b.computeBadges({ pages: PAGES, releasePages: RP, changelogText: LOG, channel: 'next' })
    expect(r['guide/ci']).toBe('new')
  })

  it('latest: previous entry is the baseline, the build version section drives Updated', () => {
    const r = b.computeBadges({ pages: PAGES, releasePages: RP, changelogText: LOG, channel: 'latest', version: '0.8.0' })
    expect(r['guide/mcp']).toBe('new') // absent from 0.7.0
    expect(r['guide/index']).toBe('new')
    expect(r['guide/cli']).toBeUndefined() // only linked from Unreleased, not from v0.8.0
  })

  it('latest: Updated for a page linked from the version section when it existed before', () => {
    const log = LOG.replace('guide/mcp.md', 'guide/cli.md')
    const r = b.computeBadges({ pages: PAGES, releasePages: RP, changelogText: log, channel: 'latest', version: '0.8.0' })
    expect(r['guide/cli']).toBe('updated')
  })

  it('latest with no previous entry gives none', () => {
    const one = { schema: 1, releases: [RP.releases[1]] }
    expect(b.computeBadges({ pages: PAGES, releasePages: one, changelogText: LOG, channel: 'latest', version: '0.7.0' })).toEqual({})
    expect(b.computeBadges({ pages: PAGES, releasePages: RP, changelogText: LOG, channel: 'latest', version: '0.9.0' })).toEqual({})
  })

  it('old gives none', () => {
    expect(b.computeBadges({ pages: PAGES, releasePages: RP, changelogText: LOG, channel: 'old', version: '0.7.0' })).toEqual({})
  })

  it('missing, empty or unknown-schema data gives none and never throws', () => {
    for (const rp of [undefined, null, {}, { schema: 1, releases: [] }, { schema: 2, releases: RP.releases }, { schema: 1, releases: 'x' }, { schema: 1, releases: [{ version: 'bad', pages: [] }] }]) {
      expect(b.computeBadges({ pages: PAGES, releasePages: rp, changelogText: LOG, channel: 'next' })).toEqual({})
    }
    expect(b.badgeInfo({ pages: PAGES, channel: 'next' }).reason).toMatch(/no usable/)
  })

  it('entries are sorted by semver, not file order', () => {
    const rev = { schema: 1, releases: [...RP.releases].reverse() }
    const r = b.badgeInfo({ pages: PAGES, releasePages: rev, changelogText: LOG, channel: 'next' })
    expect(r.baseline.version).toBe('0.8.0')
  })
})

describe('changelogSection and linkedPages', () => {
  it('cuts one section; unknown section is empty', () => {
    expect(b.changelogSection(LOG, null)).toContain('/guide/cli')
    expect(b.changelogSection(LOG, null)).not.toContain('guide/mcp.md')
    expect(b.changelogSection(LOG, '0.8.0')).toContain('guide/mcp.md')
    expect(b.changelogSection(LOG, '9.9.9')).toBe('')
  })

  it('maps x/ to x/index, / to index, drops images and anchors-only', () => {
    const t = '[a](guide/) [b](/) [c](#top) ![img](guide/cli.md)'
    expect([...b.linkedPages(t, PAGES)].sort()).toEqual(['guide/index', 'index'])
  })
})

describe('listPages', () => {
  const dir = path.join(__dirname, 'fixtures', 'docs-badges', 'docs')
  it('skips .vitepress, public, node_modules and underscore files', () => {
    expect(b.listPages(dir)).toEqual(['guide/index', 'guide/mcp', 'index'])
  })
  it('honours srcExclude globs', () => {
    expect(b.listPages(dir, { srcExclude: ['guide/**'] })).toEqual(['index'])
  })
  it('pagesFromFiles applies the same rules to a path list', () => {
    expect(b.pagesFromFiles(['index.md', 'guide/mcp.md', 'guide/_p.md', '.vitepress/n.md', 'public/r.md', 'img/a.png', 'index.md']))
      .toEqual(['guide/mcp', 'index'])
  })
})

describe('labelSidebar', () => {
  it('appends a text label to badged items, nested too, without mutating the input', () => {
    const side = [{ text: 'G', items: [{ text: 'MCP', link: '/guide/mcp' }, { text: 'CLI', link: '/guide/cli' }, { text: 'Home', link: '/' }] }]
    const out = b.labelSidebar(side, { 'guide/mcp': 'new', index: 'updated' })
    expect(out[0].items[0].text).toBe('MCP <span class="bt-badge bt-badge--new">New</span>')
    expect(out[0].items[1].text).toBe('CLI')
    expect(out[0].items[2].text).toContain('Updated')
    expect(side[0].items[0].text).toBe('MCP')
  })
})
