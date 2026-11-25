import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { buildGraph, hashGraph } = require('../lib/features/graph')

const FILES = {
  'manifest': 'title=Sites\n',
  'source/main.brs': 'sub Main()\n  s = CreateObject("roSGScene")\nend sub\n',
  'components/Child.xml': '<?xml version="1.0" encoding="utf-8" ?>\n<component name="Child" extends="Group">\n  <interface><field id="value" type="string"/><function name="doIt"/></interface>\n  <script type="text/brightscript" uri="Child.brs"/>\n</component>\n',
  'components/Child.brs': 'sub init()\nend sub\nfunction doIt(a)\n  return a\nend function\n',
  'components/Host.xml': '<?xml version="1.0" encoding="utf-8" ?>\n<component name="Host" extends="Group">\n  <children><Child id="kid"/></children>\n  <script type="text/brightscript" uri="Host.brs"/>\n</component>\n',
  // ground truth by hand: callFunc sites on lines 3, 4 (twice), 6, 12, 15; observeField sites on lines 7, 9, 10, 11
  'components/Host.brs': [
    'sub init()',
    '  kid = m.top.findNode("kid")',
    '  kid.callFunc("doIt", 1)',
    '  kid.callfunc("doIt", 1) : kid.callFunc("doIt", 2)',
    '  n = "doIt"',
    '  kid.callFunc(n, 1)',
    '  kid.observeField("value", "onValue")',
    '  f = "value"',
    '  kid.observeField(f, "onValue")',
    '  m.top.observeField("visible", "onValue")',
    '  m.top.findNode("kid").observeField("value", "onValue")',
    '  x = someFn().callFunc("doIt")',
    "  ' kid.callFunc(\"doIt\") in a comment",
    '  s = "kid.observeField(x)"',
    '  m.top.findNode("kid").callFunc("missing")',
    'end sub',
    'sub onValue()',
    'end sub',
    '',
  ].join('\n'),
}

let dir; let g
beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-sites-'))
  for (const [rel, text] of Object.entries(FILES)) { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text) }
  g = await buildGraph(dir)
})
afterAll(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }) })
const of = (kind) => g.edges.filter((e) => e.kind === kind)

describe('feature graph: callFunc and observeField sites', () => {
  it('emits one edge per callFunc site, none for the comment or the string', () => {
    const cf = of('callfunc')
    expect(cf).toHaveLength(6)
    expect(cf.map((e) => e.at.split(':')[1]).sort()).toEqual(['12', '15', '3', '4', '4', '6'])
  })
  it('keeps two callFunc sites on one line apart by column', () => {
    const same = of('callfunc').filter((e) => e.at.endsWith(':4'))
    expect(same.map((e) => e.col).sort((a, b) => a - b)).toHaveLength(2)
    expect(new Set(same.map((e) => e.col)).size).toBe(2)
    expect(of('callfunc').filter((e) => !e.at.endsWith(':4')).every((e) => e.col === undefined)).toBe(true)
  })
  it('resolves a callFunc by a string name and marks a variable name dynamic and an unknown name unresolved', () => {
    const byLine = (n) => of('callfunc').filter((e) => e.at.endsWith(`:${n}`))
    expect(byLine(3)[0]).toMatchObject({ to: 'comp:Child', conf: 'name' })
    expect(byLine(6)[0]).toMatchObject({ to: null, conf: 'dynamic' })
    expect(byLine(12)[0]).toMatchObject({ to: 'comp:Child', conf: 'name' })
    expect(byLine(15)[0]).toMatchObject({ to: null, conf: 'unresolved' })
  })
  it('emits one edge per observeField site, with a literal or a variable field name', () => {
    const ob = of('observes')
    expect(ob.map((e) => e.at.split(':')[1]).sort()).toEqual(['10', '11', '7', '9'])
    expect(ob.find((e) => e.at.endsWith(':7'))).toMatchObject({ to: 'comp:Child', conf: 'name' })
    expect(ob.find((e) => e.at.endsWith(':9'))).toMatchObject({ to: 'comp:Child', conf: 'name' })
    expect(ob.find((e) => e.at.endsWith(':10'))).toMatchObject({ to: 'comp:Host', conf: 'name' })
    expect(ob.find((e) => e.at.endsWith(':11'))).toMatchObject({ to: 'comp:Child', conf: 'name' })
  })
  it('reports the per-kind site split in resolution.sites and the text uncertainty stays exact', () => {
    expect(g.resolution.sites.callfunc).toEqual({ sites: 6, resolved: 4, unresolved: 2 })
    expect(g.resolution.sites.observes).toEqual({ sites: 4, resolved: 4, unresolved: 0 })
    expect(g.uncertainty.counts['dynamic-callfunc']).toBe(1)
  })
  it('is stable across builds', async () => {
    const again = await buildGraph(dir)
    expect(again.hash).toBe(g.hash)
  })
})

describe('feature graph: same-line sites', () => {
  const build = async (hostBrs) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-sites2-'))
    try {
      for (const [rel, text] of Object.entries({ ...FILES, 'components/Host.brs': hostBrs })) { fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true }); fs.writeFileSync(path.join(d, rel), text) }
      return await buildGraph(d)
    } finally { fs.rmSync(d, { recursive: true, force: true }) }
  }
  it('reports one dynamic-callfunc uncertainty per site when two share a line', async () => {
    const x = await build('sub init()\n  kid = m.top.findNode("kid")\n  n = "a" : kid.callFunc(n) : kid.callFunc(n)\nend sub\n')
    expect(x.uncertainty.counts['dynamic-callfunc']).toBe(2)
    expect(x.resolution.sites.callfunc.unresolved).toBe(2)
  })
  it('orders same-line columns numerically', async () => {
    const x = await build('sub init()\n  kid = m.top.findNode("kid")\n  kid.callFunc("doIt") : kid.callFunc("doIt") : kid.callFunc("doIt") : kid.callFunc("doIt") : kid.callFunc("doIt")\nend sub\n')
    const cols = x.edges.filter((e) => e.kind === 'callfunc').map((e) => e.col)
    expect(cols).toHaveLength(5)
    expect(cols.some((c) => c >= 10)).toBe(true)
    expect(cols).toEqual([...cols].sort((a, b) => a - b))
  })
  it('keeps the hash independent of the derived sites tally', async () => {
    const x = await build('sub init()\n  kid = m.top.findNode("kid")\n  kid.callFunc("doIt", 1)\nend sub\n')
    const { hash, app, ...rest } = x // eslint-disable-line no-unused-vars
    const { sites, ...res } = rest.resolution // eslint-disable-line no-unused-vars
    expect(hashGraph(x)).toBe(hashGraph({ ...rest, resolution: res }))
    expect(hashGraph({ ...rest, resolution: { ...res, sites: { bogus: 1 } } })).toBe(x.hash)
  })
})
