import { describe, it, expect } from 'vitest'
import plugin, { stampComponentXml, isComponentXml } from '../lib/e2e/stamp-ids.js'

const COMPONENT = `<?xml version="1.0" encoding="UTF-8"?>
<component name="Home" extends="Scene">
  <interface>
    <field id="count" type="integer" />
  </interface>
  <children>
    <Label text="Hi" />
    <Poster uri="a.png" />
    <Poster id="keepMe" uri="b.png" />
    <RowList>
      <Label text="row" />
    </RowList>
  </children>
</component>`

describe('stampComponentXml', () => {
  it('adds ids to id-less nodes with a per-subtype counter, keeping existing ids', () => {
    const { xml, count } = stampComponentXml(COMPONENT)
    expect(count).toBe(4) // Label, Poster, RowList, nested Label — the pre-id'd Poster is skipped
    expect(xml).toContain('<Label id="e2e_Label_1" text="Hi" />')
    expect(xml).toContain('<Poster id="e2e_Poster_1" uri="a.png" />')
    expect(xml).toContain('<Poster id="keepMe" uri="b.png" />')   // untouched
    expect(xml).toContain('<RowList id="e2e_RowList_1">')
    expect(xml).toContain('<Label id="e2e_Label_2" text="row" />') // nested, counter continues
  })

  it('does not touch the <interface> field id or the <component> tag', () => {
    const { xml } = stampComponentXml(COMPONENT)
    expect(xml).toContain('<field id="count" type="integer" />')
    expect(xml).toMatch(/<component name="Home" extends="Scene">/)
  })

  it('is idempotent — a second pass injects nothing', () => {
    const once = stampComponentXml(COMPONENT).xml
    const twice = stampComponentXml(once)
    expect(twice.count).toBe(0)
    expect(twice.xml).toBe(once)
  })

  it('honors a custom prefix', () => {
    const { xml } = stampComponentXml('<component name="X"><children><Group /></children></component>', { prefix: 'qa_' })
    expect(xml).toContain('<Group id="qa_Group_1" />')
  })

  it('leaves a component with no <children> unchanged', () => {
    const src = '<component name="Widget" extends="Group"><interface><field id="a" type="int" /></interface></component>'
    expect(stampComponentXml(src)).toEqual({ xml: src, count: 0 })
  })

  it('isComponentXml distinguishes component files', () => {
    expect(isComponentXml(COMPONENT)).toBe(true)
    expect(isComponentXml('<manifest/>')).toBe(false)
  })
})

describe('bsc plugin wrapper', () => {
  it('mutates component XML source in beforeFileParse, ignores non-xml/non-component', () => {
    const p = plugin()
    expect(p.name).toBe('brighttest-e2e-id-injector')

    const comp = { srcPath: 'components/Home.xml', source: COMPONENT }
    p.beforeFileParse(comp)
    expect(comp.source).toContain('e2e_Label_1')

    const brs = { srcPath: 'source/main.brs', source: 'sub Main()\nend sub' }
    const orig = brs.source
    p.beforeFileParse(brs)
    expect(brs.source).toBe(orig) // .brs untouched

    const nonComp = { srcPath: 'x.xml', source: '<root><Label/></root>' }
    const before = nonComp.source
    p.beforeFileParse(nonComp)
    expect(nonComp.source).toBe(before) // no <component> → untouched
  })
})
