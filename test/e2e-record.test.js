import { describe, it, expect } from 'vitest'
import { Recorder, runRecord, bestSelector, serializeScalar } from '../lib/e2e/record.js'
import { parseFlow } from '../lib/e2e/flow.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

describe('Recorder', () => {
  it('starts with an implicit launch and coalesces repeated presses', () => {
    const r = new Recorder({ appId: 'dev' })
    r.press('Right').press('Right').press('Down').press('Down').press('Down')
    expect(r.steps).toEqual([
      { op: 'launch' },
      { op: 'press', key: 'Right', count: 2 },
      { op: 'press', key: 'Down', count: 3 },
    ])
  })
  it('does not coalesce across a different key', () => {
    const r = new Recorder()
    r.press('Right').press('Down').press('Right')
    expect(r.steps.filter((s) => s.op === 'press').map((s) => `${s.key}x${s.count}`)).toEqual(['Rightx1', 'Downx1', 'Rightx1'])
  })
  it('records back/home/text/screenshot and assertions with the best selector', () => {
    const r = new Recorder()
    r.back().home().text('hi').screenshot('a.png')
    r.assertFocused({ id: 'tile', subtype: 'Button' })
    r.assertVisible({ id: null, text: 'Play', subtype: 'Label' })
    r.assertText({ id: 'hdr', subtype: 'Label', text: 'Settings' })
    const ops = r.steps.map((s) => s.op)
    expect(ops).toEqual(['launch', 'back', 'home', 'text', 'screenshot', 'assertFocused', 'assertVisible', 'assertText'])
    expect(r.steps[5].selector).toEqual({ id: 'tile' })      // id preferred
    expect(r.steps[6].selector).toEqual({ text: 'Play' })     // falls back to text
    expect(r.steps[7]).toMatchObject({ selector: { id: 'hdr' }, equals: 'Settings' })
  })
  it('bestSelector prefers id → text → subtype', () => {
    expect(bestSelector({ id: 'x', text: 't', subtype: 'S' })).toEqual({ id: 'x' })
    expect(bestSelector({ id: null, text: 't', subtype: 'S' })).toEqual({ text: 't' })
    expect(bestSelector({ id: null, text: null, subtype: 'S' })).toEqual({ subtype: 'S' })
  })
  it('serializeScalar quotes only when unsafe', () => {
    expect(serializeScalar('cell00')).toBe('cell00')
    expect(serializeScalar('home.png')).toBe('home.png')
    expect(serializeScalar('hello world')).toBe('"hello world"')
    expect(serializeScalar(3)).toBe('3')
    expect(serializeScalar('true')).toBe('"true"')
  })
})

describe('Recorder → YAML round-trips through the parser', () => {
  it('produces a flow the parser accepts and normalizes back', () => {
    const r = new Recorder({ appId: 'dev' })
    r.press('Right').press('Right').press('Down')
    r.assertFocused({ id: 'cell21' })
    r.text('hello world')
    r.screenshot('done.png')
    const yaml = r.toYAML()
    const flow = parseFlow(yaml)
    expect(flow.appId).toBe('dev')
    expect(flow.steps.map((s) => s.op)).toEqual(['launch', 'press', 'press', 'assertFocused', 'text', 'screenshot'])
    expect(flow.steps[1]).toMatchObject({ key: 'Right', count: 2 })
    expect(flow.steps[3].selector).toEqual({ id: 'cell21' })
    expect(flow.steps[4].value).toBe('hello world')
  })
})

// A fake device + fake TTY to exercise the interactive wiring without hardware.
function fakeDevice() {
  const focusedTree = '<sgnodes><All_Nodes><Default name="" />' +
    '<Scene name="root" bounds="{0,0,1920,1080}"><Button name="tile" text="Go" focused="true" bounds="{10,10,100,40}" /></Scene>' +
    '</All_Nodes><status>OK</status></sgnodes>'
  const log = []
  return {
    log,
    hasPassword: false,
    async launch() { log.push('launch'); },
    async keypress(k) { log.push('key:' + k); },
    async ecpGet() { return { status: 200, text: focusedTree }; },
  }
}
function fakeIo() {
  let listener = null
  const out = []
  const stdin = {
    isTTY: true, isRaw: false,
    setRawMode(v) { this.isRaw = !!v; return this },
    resume() {}, pause() {},
    on(ev, cb) { if (ev === 'data') listener = cb },
    removeListener(ev, cb) { if (ev === 'data' && listener === cb) listener = null },
    hasListener: () => !!listener,
    async emit(s) { if (listener) await listener(Buffer.from(s)) },
  }
  return { stdin, stdout: { write: (s) => out.push(s) }, out }
}

describe('runRecord (fake device + TTY)', () => {
  it('maps keys to steps and returns YAML on quit', async () => {
    const device = fakeDevice()
    const io = fakeIo()
    const p = runRecord(device, { app: 'dev' }, io)
    // wait until the raw-mode listener is attached (after launch + settle)
    for (let i = 0; i < 200 && !io.stdin.hasListener(); i++) await sleep(10)
    await io.stdin.emit('\x1b[C')  // Right
    await io.stdin.emit('\x1b[C')  // Right (coalesces)
    await io.stdin.emit('\r')      // Select
    await io.stdin.emit('a')       // assertFocused on #tile
    await io.stdin.emit('q')       // save & quit
    const yaml = await p
    const flow = parseFlow(yaml)
    expect(flow.steps.map((s) => s.op)).toEqual(['launch', 'press', 'press', 'assertFocused'])
    expect(flow.steps[1]).toMatchObject({ key: 'Right', count: 2 })
    expect(flow.steps[2]).toMatchObject({ key: 'Select' })
    expect(flow.steps[3].selector).toEqual({ id: 'tile' })
    expect(device.log).toContain('key:Right')
  }, 15000)
})
