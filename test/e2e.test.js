import { describe, it, expect } from 'vitest'
import { parseTree, parseTuple, flatten, focusSignature } from '../lib/e2e/sgnodes.js'
import { matchAll, matchOne, describe as describeSel } from '../lib/e2e/select.js'
import { parseFlow, normalizeStep, FlowError } from '../lib/e2e/flow.js'
import { parseChallenge, buildDigestHeader, multipart } from '../lib/e2e/ecp.js'
import { parseE2eArgs } from '../bin/cli.js'

// A trimmed but faithful sgnodes/all response, mirroring what probe 2 captured on real hardware
// (id serialized as name=, {x,y,w,h} bounds, focused flags, nested children).
const SAMPLE = `<?xml version="1.0" encoding="UTF-8" ?>
<sgnodes>
  <timestamp>1784054540602</timestamp>
  <channel-id>dev</channel-id>
  <All_Nodes node-count="5">
    <Default focused="false" focusable="false" name="" index="0" />
    <MainScene name="root" extends="Scene" bounds="{0, 0, 1920, 1080}">
      <Poster uri="/img/bg.png" bounds="{0, 0, 1920, 1080}" />
      <Label name="homeScreen" text="Home" visible="true" bounds="{100, 100, 172, 36}" />
      <RowList name="rail" focusable="true">
        <Label name="settingsTile" text="Settings" focused="true" bounds="{100, 300, 200, 36}" />
        <Label name="searchTile" text="Search" bounds="{320, 300, 200, 36}" />
      </RowList>
    </MainScene>
  </All_Nodes>
  <status>OK</status>
</sgnodes>`

describe('sgnodes parseTree', () => {
  it('parses the tree, dropping the Default placeholder, mapping id⇒name', () => {
    const { status, roots } = parseTree(SAMPLE)
    expect(status).toBe('OK')
    expect(roots).toHaveLength(1)
    const scene = roots[0]
    expect(scene.subtype).toBe('MainScene')
    expect(scene.id).toBe('root')
    expect(scene.bounds).toEqual({ x: 0, y: 0, w: 1920, h: 1080 })
    expect(scene.children.map((n) => n.subtype)).toEqual(['Poster', 'Label', 'RowList'])
  })

  it('flattens depth-first and reads focus/text', () => {
    const { roots } = parseTree(SAMPLE)
    const all = flatten(roots)
    expect(all).toHaveLength(6) // scene + poster + label + rowlist + 2 tiles
    const focused = all.filter((n) => n.focused)
    expect(focused).toHaveLength(1)
    expect(focused[0].id).toBe('settingsTile')
    expect(focused[0].text).toBe('Settings')
  })

  it('surfaces FAILED status with the error string', () => {
    const failed = parseTree('<sgnodes><status>FAILED</status><error>Channel not running: active UI</error></sgnodes>')
    expect(failed.status).toBe('FAILED')
    expect(failed.error).toMatch(/Channel not running/)
    expect(failed.roots).toEqual([])
  })

  it('parseTuple handles 4-tuples, 2-tuples, and junk', () => {
    expect(parseTuple('{1, 2, 3, 4}')).toEqual({ x: 1, y: 2, w: 3, h: 4 })
    expect(parseTuple('{10, 20}')).toEqual({ x: 10, y: 20 })
    expect(parseTuple('nope')).toBeNull()
  })

  it('focusSignature changes when focus moves', () => {
    const a = focusSignature(parseTree(SAMPLE).roots)
    const moved = SAMPLE.replace('name="settingsTile" text="Settings" focused="true"', 'name="settingsTile" text="Settings"')
      .replace('name="searchTile" text="Search"', 'name="searchTile" text="Search" focused="true"')
    const b = focusSignature(parseTree(moved).roots)
    expect(a).not.toBe(b)
  })
})

describe('selector engine', () => {
  const roots = parseTree(SAMPLE).roots
  it('matches by id (name=)', () => {
    expect(matchOne(roots, { id: 'settingsTile' }).text).toBe('Settings')
    expect(matchOne(roots, { id: 'nope' })).toBeNull()
  })
  it('matches by subtype + text, and by index', () => {
    expect(matchAll(roots, { subtype: 'Label' })).toHaveLength(3)
    expect(matchOne(roots, { subtype: 'Label', text: 'Search' }).id).toBe('searchTile')
    expect(matchOne(roots, { subtype: 'Label', index: 2 }).id).toBe('searchTile')
  })
  it('honors focused and textContains filters', () => {
    expect(matchOne(roots, { focused: true }).id).toBe('settingsTile')
    expect(matchOne(roots, { textContains: 'ett' }).id).toBe('settingsTile')
  })
  it('rejects an empty selector', () => {
    expect(() => matchAll(roots, {})).toThrow(/at least one of/)
  })
  it('describes a selector readably', () => {
    expect(describeSel({ id: 'x', index: 0 })).toBe('{id: "x", index: 0}')
  })
})

describe('flow parser', () => {
  const SRC = `# a flow
appId: dev
config: { timeout: 8 }
steps:
  - launch
  - launch: { contentId: abc123, mediaType: movie }
  - press: Select
  - press: { key: Down, count: 3 }
  - pressUntil: { key: Down, visible: { id: settingsTile }, max: 10 }
  - assertVisible: { id: homeScreen }
  - assertText: { id: header, equals: "Settings" }
  - text: "hello world"
  - screenshot: home.png
  - back
  - home
`
  it('parses appId, config, and all step ops', () => {
    const flow = parseFlow(SRC)
    expect(flow.appId).toBe('dev')
    expect(flow.config).toEqual({ timeout: 8 })
    expect(flow.steps.map((s) => s.op)).toEqual([
      'launch', 'launch', 'press', 'press', 'pressUntil',
      'assertVisible', 'assertText', 'text', 'screenshot', 'back', 'home',
    ])
  })
  it('normalizes step args, incl. nested flow maps and defaults', () => {
    const flow = parseFlow(SRC)
    const [, deepLink, press1, press3, pressUntil, , assertText] = flow.steps
    expect(deepLink.params).toEqual({ contentId: 'abc123', mediaType: 'movie' })
    expect(press1).toMatchObject({ key: 'Select', count: 1 })
    expect(press3).toMatchObject({ key: 'Down', count: 3 })
    expect(pressUntil).toMatchObject({ key: 'Down', selector: { id: 'settingsTile' }, max: 10 })
    expect(assertText).toMatchObject({ selector: { id: 'header' }, equals: 'Settings' })
  })
  it('preserves the # inside a quoted string', () => {
    const flow = parseFlow('steps:\n  - assertText: { id: h, equals: "a # b" }\n')
    expect(flow.steps[0].equals).toBe('a # b')
  })
  it('reports the source line for an unknown step', () => {
    expect(() => parseFlow('steps:\n  - launch\n  - frobnicate: x\n')).toThrow(/line 3: unknown step "frobnicate"/)
  })
  it('rejects tabs and empty steps', () => {
    expect(() => parseFlow('steps:\n\t- launch\n')).toThrow(/tabs are not allowed/)
    expect(() => parseFlow('appId: dev\n')).toThrow(/steps:/)
  })
  it('requires equals or contains on assertText', () => {
    const item = { key: 'assertText', arg: { id: 'x' } }
    Object.defineProperty(item, '__line', { value: 7 })
    expect(() => normalizeStep(item)).toThrow(/needs equals: or contains:/)
  })
})

describe('ecp digest + multipart helpers', () => {
  it('parses a Digest challenge header', () => {
    const c = parseChallenge('Digest realm="rokudev", nonce="abc123", qop=auth')
    expect(c).toMatchObject({ realm: 'rokudev', nonce: 'abc123', qop: 'auth' })
  })
  it('builds a qop=auth Authorization header with a response hash', () => {
    const h = buildDigestHeader({
      user: 'rokudev', password: 'Test1234', method: 'GET', uri: '/pkgs/dev.jpg',
      challenge: { realm: 'rokudev', nonce: 'abc123', qop: 'auth' },
    })
    expect(h).toMatch(/^Digest /)
    expect(h).toMatch(/username="rokudev"/)
    expect(h).toMatch(/qop=auth/)
    expect(h).toMatch(/response="[0-9a-f]{32}"/)
  })
  it('builds a multipart body with the boundary and field parts', () => {
    const { body, contentType } = multipart([
      { name: 'mysubmit', value: 'Screenshot' },
      { name: 'archive', filename: '', contentType: 'application/octet-stream', data: Buffer.alloc(0) },
    ])
    const s = body.toString('utf8')
    const boundary = contentType.split('boundary=')[1]
    expect(s).toContain(`--${boundary}`)
    expect(s).toContain('name="mysubmit"')
    expect(s).toContain('Screenshot')
    expect(s).toContain('filename=""')
    expect(s.trimEnd().endsWith(`--${boundary}--`)).toBe(true)
  })
})

describe('cli parseE2eArgs', () => {
  it('defaults action=run, mode=all, collects flow files', () => {
    const o = parseE2eArgs(['run', 'flows/a.e2e.yaml', 'flows/'])
    expect(o.e2eAction).toBe('run')
    expect(o.screenshotsMode).toBe('all')
    expect(o.flows).toEqual(['flows/a.e2e.yaml', 'flows/'])
  })
  it('parses host/password/app and screenshot options (both spellings)', () => {
    const o = parseE2eArgs(['run', '--host=1.2.3.4', '--password', 'pw', '--app', 'dev', '--screenshots-mode', 'failure', '--screenshots=/tmp/s'])
    expect(o).toMatchObject({ host: '1.2.3.4', password: 'pw', app: 'dev', screenshotsMode: 'failure', screenshots: '/tmp/s' })
  })
  it('treats inspect as an action, not a flow file', () => {
    const o = parseE2eArgs(['inspect', '--app', 'dev'])
    expect(o.e2eAction).toBe('inspect')
    expect(o.flows).toEqual([])
  })
})
