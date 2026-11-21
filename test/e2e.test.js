import { describe, it, expect, vi } from 'vitest'
import { parseTree, parseTuple, flatten, focusSignature } from '../lib/e2e/sgnodes.js'
import { matchAll, matchOne, describe as describeSel } from '../lib/e2e/select.js'
import { parseFlow, normalizeStep, FlowError } from '../lib/e2e/flow.js'
import { parseChallenge, buildDigestHeader, multipart } from '../lib/e2e/ecp.js'
import { parseE2eArgs } from '../bin/cli.js'
import { execStep, inspectNodes } from '../lib/e2e/run.js'
import { extractAppState } from '../lib/e2e/appstate.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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
  it('parses a millisecond wait as a scalar or a { ms } map', () => {
    const flow = parseFlow('steps:\n  - launch\n  - wait: 500\n  - wait: { ms: 1200 }\n')
    expect(flow.steps.map((s) => s.op)).toEqual(['launch', 'wait', 'wait'])
    expect(flow.steps[1]).toMatchObject({ op: 'wait', ms: 500 })
    expect(flow.steps[2]).toMatchObject({ op: 'wait', ms: 1200 })
  })
  it('rejects a missing or negative wait duration', () => {
    expect(() => parseFlow('steps:\n  - wait:\n')).toThrow(/wait needs a duration in ms/)
    expect(() => parseFlow('steps:\n  - wait: -5\n')).toThrow(/non-negative number of milliseconds/)
  })
  it('parses assertField with a field and equals/contains', () => {
    const flow = parseFlow('steps:\n  - assertField: { id: hero, field: uri, equals: "pkg:/hero.png" }\n  - assertField: { subtype: Label, field: opacity, contains: "0.5" }\n')
    expect(flow.steps[0]).toMatchObject({ op: 'assertField', selector: { id: 'hero' }, field: 'uri', equals: 'pkg:/hero.png' })
    expect(flow.steps[1]).toMatchObject({ op: 'assertField', selector: { subtype: 'Label' }, field: 'opacity', contains: '0.5' })
  })
  it('parses assertState with a path and equals/contains', () => {
    const flow = parseFlow('steps:\n  - assertState: { path: global.channel, equals: "Open Cinema" }\n  - assertState: { path: watchlist.0.id, contains: steel }\n')
    expect(flow.steps[0]).toMatchObject({ op: 'assertState', path: 'global.channel', equals: 'Open Cinema' })
    expect(flow.steps[1]).toMatchObject({ op: 'assertState', path: 'watchlist.0.id', contains: 'steel' })
  })
  it('rejects assertState without a path or a comparison', () => {
    expect(() => parseFlow('steps:\n  - assertState: { equals: 1 }\n')).toThrow(/assertState needs path:/)
    expect(() => parseFlow('steps:\n  - assertState: { path: current }\n')).toThrow(/needs equals: or contains:/)
  })
  it('rejects assertField without a field or a comparison', () => {
    expect(() => parseFlow('steps:\n  - assertField: { id: x, equals: 1 }\n')).toThrow(/assertField needs field:/)
    expect(() => parseFlow('steps:\n  - assertField: { id: x, field: uri }\n')).toThrow(/needs equals: or contains:/)
  })
})

describe('runFlow (subflows)', () => {
  it('parses file + env, and rejects a missing file', () => {
    const flow = parseFlow('steps:\n  - runFlow: { file: login.e2e.yaml, env: { user: demo } }\n')
    expect(flow.steps[0]).toMatchObject({ op: 'runFlow', file: 'login.e2e.yaml', env: { user: 'demo' } })
    expect(() => parseFlow('steps:\n  - runFlow: { env: { a: 1 } }\n')).toThrow(/runFlow needs/)
  })

  const XML = '<sgnodes><All_Nodes><Default name="" />' +
    '<Scene name="root"><Label name="hero" text="Hi" /></Scene></All_Nodes><status>OK</status></sgnodes>'
  const dev = { async ecpGet() { return { status: 200, text: XML } } }
  const tmpFlow = (body) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-sub-')); fs.writeFileSync(path.join(d, 'child.e2e.yaml'), body); return d }

  it('runs a subflow relative to the parent, substituting ${env}', async () => {
    const dir = tmpFlow('appId: dev\nsteps:\n  - assertText: { id: hero, equals: "${greeting}" }\n')
    const ctx = { device: dev, stepTimeoutMs: 500, opts: {}, flow: { file: path.join(dir, 'parent.e2e.yaml') }, launchParams: {} }
    await expect(execStep({ op: 'runFlow', file: 'child.e2e.yaml', env: { greeting: 'Hi' } }, ctx))
      .resolves.toMatchObject({ detail: expect.stringContaining('child.e2e.yaml') })
  })

  it('fails with the subflow step path when a sub-step fails', async () => {
    const dir = tmpFlow('appId: dev\nsteps:\n  - assertText: { id: hero, equals: "Nope" }\n')
    const ctx = { device: dev, stepTimeoutMs: 300, opts: {}, flow: { file: path.join(dir, 'p.e2e.yaml') }, launchParams: {} }
    await expect(execStep({ op: 'runFlow', file: 'child.e2e.yaml', env: {} }, ctx)).rejects.toThrow(/runFlow child\.e2e\.yaml .*step 1/)
  })
})

describe('execStep assertField (fake device)', () => {
  const XML = '<sgnodes><All_Nodes><Default name="" />' +
    '<Scene name="root"><Poster name="hero" uri="pkg:/hero.png" opacity="0.5" /></Scene>' +
    '</All_Nodes><status>OK</status></sgnodes>'
  const ctx = (timeoutMs = 400) => ({ device: { async ecpGet() { return { status: 200, text: XML } } }, stepTimeoutMs: timeoutMs })

  it('passes on a matching field (equals string, equals number, contains)', async () => {
    await expect(execStep({ op: 'assertField', selector: { id: 'hero' }, field: 'uri', equals: 'pkg:/hero.png' }, ctx())).resolves.toBeTruthy()
    await expect(execStep({ op: 'assertField', selector: { id: 'hero' }, field: 'opacity', equals: 0.5 }, ctx())).resolves.toBeTruthy()
    await expect(execStep({ op: 'assertField', selector: { id: 'hero' }, field: 'uri', contains: 'hero' }, ctx())).resolves.toBeTruthy()
  })
  it('fails distinctly on a wrong value vs an absent field', async () => {
    await expect(execStep({ op: 'assertField', selector: { id: 'hero' }, field: 'uri', equals: 'nope' }, ctx(300)))
      .rejects.toThrow(/got "pkg:\/hero\.png"/)
    await expect(execStep({ op: 'assertField', selector: { id: 'hero' }, field: 'color', equals: 'x' }, ctx(300)))
      .rejects.toThrow(/field "color" not present/)
  })
})

describe('app state (__bt_state) extraction', () => {
  // Roku entity-encodes attribute values, so the JSON arrives with &quot; — extractAppState decodes it.
  const withState = (json) =>
    '<sgnodes><All_Nodes><Default name="" /><Scene name="root">' +
    `<Label name="__bt_state" visible="false" text="${json.replace(/"/g, '&quot;')}" />` +
    '</Scene></All_Nodes><status>OK</status></sgnodes>'

  it('parses the published snapshot into an object', () => {
    const { roots } = parseTree(withState('{"current":"HomePanel","global":{"n":7}}'))
    const res = extractAppState(roots)
    expect(res.present).toBe(true)
    expect(res.state).toMatchObject({ current: 'HomePanel', global: { n: 7 } })
  })
  it('reports absent when the app publishes nothing', () => {
    const { roots } = parseTree('<sgnodes><All_Nodes><Scene name="root" /></All_Nodes><status>OK</status></sgnodes>')
    expect(extractAppState(roots)).toMatchObject({ present: false, state: null })
  })
  it('flags invalid JSON distinctly from absent', () => {
    const { roots } = parseTree(withState('{not json'))
    const res = extractAppState(roots)
    expect(res.present).toBe(true)
    expect(res.state).toBeNull()
    expect(res.error).toMatch(/invalid JSON/)
  })
})

describe('execStep assertState (fake device)', () => {
  const XML = '<sgnodes><All_Nodes><Default name="" /><Scene name="root">' +
    '<Label name="__bt_state" text="' +
    '{&quot;current&quot;:&quot;PlayerPanel&quot;,&quot;global&quot;:{&quot;channel&quot;:&quot;Open Cinema&quot;},&quot;watchlist&quot;:[{&quot;id&quot;:&quot;tears-of-steel&quot;}]}' +
    '" /></Scene></All_Nodes><status>OK</status></sgnodes>'
  const ctx = (timeoutMs = 400, xml = XML) => ({ device: { async ecpGet() { return { status: 200, text: xml } } }, stepTimeoutMs: timeoutMs })

  it('passes on a matching path (equals + nested + array index + contains)', async () => {
    await expect(execStep({ op: 'assertState', path: 'current', equals: 'PlayerPanel' }, ctx())).resolves.toBeTruthy()
    await expect(execStep({ op: 'assertState', path: 'global.channel', equals: 'Open Cinema' }, ctx())).resolves.toBeTruthy()
    await expect(execStep({ op: 'assertState', path: 'watchlist.0.id', contains: 'steel' }, ctx())).resolves.toBeTruthy()
  })
  it('fails distinctly on wrong value, missing path, and no published state', async () => {
    await expect(execStep({ op: 'assertState', path: 'current', equals: 'HomePanel' }, ctx(300)))
      .rejects.toThrow(/got "PlayerPanel"/)
    await expect(execStep({ op: 'assertState', path: 'global.nope', equals: 'x' }, ctx(300)))
      .rejects.toThrow(/path "global\.nope" not found/)
    const empty = '<sgnodes><All_Nodes><Scene name="root" /></All_Nodes><status>OK</status></sgnodes>'
    await expect(execStep({ op: 'assertState', path: 'current', equals: 'x' }, ctx(300, empty)))
      .rejects.toThrow(/no app state published/)
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
  it('parses inspect node-detail selector flags and --assert', () => {
    const o = parseE2eArgs(['inspect', '--subtype', 'Poster', '--index', '1', '--focused', '--assert', 'text', '--out', 'flows/x.e2e.yaml'])
    expect(o.sel).toEqual({ subtype: 'Poster', index: 1, focused: true })
    expect(o.assert).toBe('text')
    expect(o.out).toBe('flows/x.e2e.yaml')
  })
  it('keeps --text-contains distinct from --text', () => {
    expect(parseE2eArgs(['inspect', '--text-contains', 'Continue']).sel).toEqual({ textContains: 'Continue' })
    expect(parseE2eArgs(['inspect', '--text=Play']).sel).toEqual({ text: 'Play' })
  })
  it('parses --assert field with --field', () => {
    const o = parseE2eArgs(['inspect', '--id', 'hero', '--assert', 'field', '--field', 'uri', '--out', 'flows/x.e2e.yaml'])
    expect(o).toMatchObject({ assert: 'field', field: 'uri', out: 'flows/x.e2e.yaml' })
    expect(o.sel).toEqual({ id: 'hero' })
  })
})

describe('e2e inspect <selector> detail view', () => {
  const XML = `<?xml version="1.0" encoding="UTF-8" ?>
<sgnodes><All_Nodes><Scene name="Root"><Group name="Panel1"><Label name="NodeA" text="One"/></Group><Group name="Panel2"><Label name="NodeA" text="Two"/></Group></Scene></All_Nodes></sgnodes>`
  const plain = { bold: (s) => s, dim: (s) => s, red: (s) => s, green: (s) => s, yellow: (s) => s }
  function capture(xml, selector) {
    const parsed = parseTree(xml)
    const roots = parsed.roots || parsed
    let out = ''
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out += s; return true })
    try { inspectNodes(roots, selector, {}, plain) } finally { spy.mockRestore() }
    return out
  }
  it('counts each matched node once (duplicate ids under two parents)', () => {
    const out = capture(XML, { id: 'NodeA' })
    expect(out).toContain('2 node(s) matched')
    expect((out.match(/Node  Label #NodeA/g) || []).length).toBe(2)
  })
  it('says custom fields are not visible over ECP, and shows published app state when present', () => {
    expect(capture(XML, { id: 'Panel1' })).toMatch(/custom interface fields and m\.global are not visible over ECP/)
    const withState = XML.replace('</Scene>', '<Label name="__bt_state" text="{&quot;user&quot;:&quot;a&quot;}"/></Scene>')
    expect(capture(withState, { id: 'Panel1' })).toContain('App state')
  })
})
