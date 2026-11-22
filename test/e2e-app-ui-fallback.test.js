import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sg from '../lib/e2e/sgnodes.js'
import { matchOne } from '../lib/e2e/select.js'

// test/fixtures/app-ui/q-app-ui.xml is a captured device response from GET /query/app-ui.
const here = path.dirname(fileURLToPath(import.meta.url))
const appUiXml = fs.readFileSync(path.join(here, 'fixtures/app-ui/q-app-ui.xml'), 'utf8')

const sgOk = '<sgnodes><All_Nodes node-count="2"><Default/><Scene name="s"><Label name="title" text="Hi"/></Scene></All_Nodes><status>OK</status></sgnodes>'
const sgFailed = '<sgnodes><status>FAILED</status><error>Something odd</error></sgnodes>'
const sgTimeout = '<sgnodes><status>FAILED</status><error>Plugin RPC event timed out</error></sgnodes>'

function device(sgnodesBodies, appUi = appUiXml) {
  const calls = []
  let n = 0
  return {
    calls,
    ecpGet: async (p) => {
      calls.push(p)
      if (p === '/query/app-ui') return { status: 200, text: appUi }
      const body = sgnodesBodies[Math.min(n++, sgnodesBodies.length - 1)]
      return { status: 200, text: body }
    },
  }
}

describe('app-ui parser (ROB-10)', () => {
  const tree = sg.parseAppUi(appUiXml)
  const all = sg.flatten(tree.roots)

  it('flags the source and the missing parent links', () => {
    expect(tree.source).toBe('app-ui')
    expect(tree.parentLinks).toBe(false)
    expect(tree.status).toBe('OK')
  })

  it('counts the scene nodes (plugin/screen rows are not nodes)', () => {
    expect(tree.roots).toHaveLength(1)
    expect(tree.roots[0].subtype).toBe('MainScene')
    expect(all).toHaveLength(47)
  })

  it('builds nodes with no parent field and works with the selector engine', () => {
    expect(all.every((n) => !('parent' in n))).toBe(true)
    expect(matchOne(tree.roots, { id: 'homeScreen' }).text).toBe('Open Cinema')
    expect(matchOne(tree.roots, { id: 'bg' }).bounds).toEqual({ x: 0, y: 0, w: 1920, h: 1080 })
  })

  it('tolerates a raw > inside attribute values', () => {
    const xml = '<app-ui><status>OK</status><topscreen><plugin id="dev" name="X" /><screen type="SGScreen">' +
      '<Scene><Label name="a" text="Home > Settings" /><Label name="b" text="after" /></Scene></screen></topscreen></app-ui>'
    const t = sg.parseAppUi(xml)
    expect(matchOne(t.roots, { id: 'a' }).text).toBe('Home > Settings')
    expect(matchOne(t.roots, { id: 'b' }).text).toBe('after')
    expect(sg.flatten(t.roots)).toHaveLength(3)
  })

  it('reports FAILED with its error and no roots', () => {
    const t = sg.parseAppUi('<app-ui><status>FAILED</status><error>nope</error></app-ui>')
    expect(t).toMatchObject({ status: 'FAILED', error: 'nope', roots: [], source: 'app-ui' })
  })

  it('requireParentLinks throws a typed error for app-ui trees only', () => {
    expect(() => sg.requireParentLinks(tree)).toThrowError(expect.objectContaining({ code: 'TREE_NO_PARENT_LINKS' }))
    expect(() => sg.requireParentLinks({ source: 'sgnodes', parentLinks: true, roots: [] })).not.toThrow()
  })
})

describe('app-ui fallback trigger (ROB-10)', () => {
  it('documents the threshold', () => {
    expect(sg.APP_UI_FALLBACK_AFTER).toBe(3)
  })

  it('never falls back when sgnodes succeeds on the first try', async () => {
    const d = device([sgOk])
    const t = await sg.fetchTree(d)
    expect(t.source).toBe('sgnodes')
    expect(t.parentLinks).toBe(true)
    expect(d.calls).toEqual(['/query/sgnodes/all'])
  })

  it('never falls back when sgnodes recovers before the threshold', async () => {
    const d = device([sgFailed, sgFailed, sgOk])
    const t = await sg.fetchTree(d, { backoffMs: 1 })
    expect(t.source).toBe('sgnodes')
    expect(d.calls.filter((c) => c === '/query/app-ui')).toHaveLength(0)
  })

  it('falls back to app-ui after 3 consecutive FAILED reads', async () => {
    const d = device([sgFailed])
    const t = await sg.fetchTree(d, { backoffMs: 1 })
    expect(t.source).toBe('app-ui')
    expect(t.parentLinks).toBe(false)
    expect(d.calls.filter((c) => c === '/query/sgnodes/all')).toHaveLength(3)
    expect(d.calls.filter((c) => c === '/query/app-ui')).toHaveLength(1)
    expect(matchOne(t.roots, { id: 'homeScreen' })).not.toBeNull()
  })

  it('falls back after 3 RPC timeouts too', async () => {
    const d = device([sgTimeout])
    const t = await sg.fetchTree(d, { backoffMs: 1 })
    expect(t.source).toBe('app-ui')
    expect(d.calls.filter((c) => c === '/query/sgnodes/all')).toHaveLength(3)
  })

  it('keeps the sgnodes error when app-ui fails too', async () => {
    const d = device([sgFailed], '<app-ui><status>FAILED</status><error>x</error></app-ui>')
    await expect(sg.fetchTree(d, { backoffMs: 1 })).rejects.toMatchObject({ code: 'SGNODES_FAILED' })
  })

  it('does not fall back for Limited mode or a channel that is not running', async () => {
    const lim = device(['<error>not allowed in Limited mode</error>'])
    await expect(sg.fetchTree(lim)).rejects.toMatchObject({ code: 'LIMITED_MODE' })
    const idle = device(['<sgnodes><status>FAILED</status><error>Channel not running</error></sgnodes>'])
    await expect(sg.fetchTree(idle)).rejects.toMatchObject({ code: 'CHANNEL_NOT_RUNNING' })
    expect([...lim.calls, ...idle.calls].includes('/query/app-ui')).toBe(false)
  })
})
