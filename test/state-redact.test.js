import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseFlow } from '../lib/e2e/flow.js'
const require = createRequire(import.meta.url)
const { execStep } = require('../lib/e2e/run')
const { redactStateOn, makeShown } = require('../lib/e2e/appstate')

// assertState failure text and step detail hide app values when redaction is on (off by default).
const agentXml = (layers) => {
  const doc = JSON.stringify({ v: 1, seq: 1, snapshot: { layers }, truncated: [] }).replace(/"/g, '&quot;')
  return `<sgnodes><All_Nodes><Default name="" /><Scene name="root"><Label name="__bt_agent" text="${doc}" /></Scene></All_Nodes><status>OK</status></sgnodes>`
}
const layers = { global: { authToken: 'hunter2-live', user: { email: 'a@b.c', pin: '4321', prefs: { theme: 'dark', apiSecret: 'zzz' } }, channel: 'Open Cinema' } }
const device = { async ecpGet() { return { status: 200, text: agentXml(layers) } } }
const mk = (extra = {}) => ({ device, stepTimeoutMs: 250, ...extra })
const fail = (step, ctx) => execStep({ op: 'assertState', layer: 'global', ...step }, ctx).catch((e) => e)

describe('assertState redaction', () => {
  it('off by default: shows the real value', async () => {
    const e = await fail({ path: 'authToken', equals: 'x' }, mk())
    expect(e.message).toMatch(/got "hunter2-live"/)
  })
  it('on: a sensitive key hides the value and the expected value', async () => {
    const e = await fail({ path: 'authToken', equals: 'hunter2-live2' }, mk({ opts: { redactState: true } }))
    expect(e.message).toMatch(/got "<redacted:authToken>"/)
    expect(e.message).not.toMatch(/hunter2/)
    const ok = await execStep({ op: 'assertState', layer: 'global', path: 'authToken', equals: 'hunter2-live' }, mk({ opts: { redactState: true } }))
    expect(JSON.stringify(ok)).not.toMatch(/hunter2/)
  })
  it('on: a configured mask path hides the value, wildcard and parent masks included', async () => {
    const cfg = { instrument: { state: { redact: { paths: ['global.user.pin', 'global.user.prefs.*'] } } } }
    const c = mk({ cfg, opts: { redactState: true } })
    expect((await fail({ path: 'user.pin', equals: '0' }, c)).message).toMatch(/got "<redacted:pin>"/)
    expect((await fail({ path: 'user.prefs.theme', equals: 'light' }, c)).message).toMatch(/got "<redacted:theme>"/)
    expect((await fail({ path: 'channel', equals: 'x' }, c)).message).toMatch(/got "Open Cinema"/)
    const obj = (await fail({ path: 'user', deepEquals: { a: 1 } }, c)).message
    expect(obj).toMatch(/a@b\.c/)
    expect(obj).not.toMatch(/4321|zzz|dark/)
  })
  it('on: a sensitive key nested in an object is scrubbed', async () => {
    const m = (await fail({ path: 'user', deepEquals: { a: 1 } }, mk({ opts: { redactState: true } }))).message
    expect(m).not.toMatch(/zzz/)
    expect(m).toMatch(/<redacted:apiSecret>/)
  })
  it('on: non-sensitive values still show', async () => {
    expect((await fail({ path: 'channel', equals: 'x' }, mk({ opts: { redactState: true } }))).message).toMatch(/got "Open Cinema"/)
  })
})

describe('redaction switch', () => {
  it('reads option, env, flow config and project config; default off', () => {
    expect(redactStateOn({}, {})).toBe(false)
    expect(redactStateOn({ cfg: { redactState: true } }, {})).toBe(true)
    expect(redactStateOn({ cfg: { redactState: true }, flow: { config: { redactState: false } } }, {})).toBe(false)
    expect(redactStateOn({ flow: { config: { redactState: false } } }, { BRIGHTTEST_REDACT_STATE: '1' })).toBe(true)
    expect(redactStateOn({ opts: { redactState: false }, cfg: { redactState: true } }, { BRIGHTTEST_REDACT_STATE: '1' })).toBe(false)
    expect(redactStateOn({}, { BRIGHTTEST_REDACT_STATE: 'off' })).toBe(false)
  })
  it('flow config key is validated', () => {
    expect(parseFlow('config: { redactState: true }\nsteps:\n  - home\n').config.redactState).toBe(true)
    expect(() => parseFlow('config: { redactState: maybe }\nsteps:\n  - home\n')).toThrow(/redactState must be true or false/)
  })
  it('off: plain JSON', () => { expect(makeShown(false)('global', 'token', 'x')).toBe('"x"') })
})

describe('redaction details', () => {
  it('mask matching ignores case, also for a parent object', async () => {
    const cfg = { instrument: { state: { redact: { paths: ['global.user.PIN'] } } } }
    const c = mk({ cfg, opts: { redactState: true } })
    expect((await fail({ path: 'user.pin', equals: '0' }, c)).message).toMatch(/got "<redacted:pin>"/)
    const obj = (await fail({ path: 'user', deepEquals: { a: 1 } }, c)).message
    expect(obj).not.toMatch(/4321/)
    const cfg2 = { instrument: { state: { redact: { paths: ['GLOBAL.USER.prefs.Theme'] } } } }
    expect((await fail({ path: 'user', deepEquals: { a: 1 } }, mk({ cfg: cfg2, opts: { redactState: true } }))).message).not.toMatch(/dark/)
  })
  it('switch: unrecognised non-empty is on; recognised false, empty and unset are off or fall through', () => {
    const on = (v) => redactStateOn({ opts: { redactState: v } }, {})
    for (const v of ['maybe', 'garbage', 'TRUE', ' On ', 'enabled', 2, {}]) expect(on(v)).toBe(true)
    for (const v of ['false', 'FALSE', ' off ', 'No', '0', 0, false]) expect(on(v)).toBe(false)
    expect(redactStateOn({ opts: { redactState: '  ' }, cfg: { redactState: 'yes' } }, {})).toBe(true)
    expect(redactStateOn({ cfg: { redactState: 'Off' } }, {})).toBe(false)
    expect(redactStateOn({ cfg: { redactState: 'tru' } }, {})).toBe(true)
    expect(redactStateOn({}, { BRIGHTTEST_REDACT_STATE: 'wat' })).toBe(true)
  })
  it('passwd, apikey and api_key are sensitive', () => {
    const s = makeShown(true)
    for (const k of ['passwd', 'apiKey', 'API_KEY']) expect(s('global', k, 'v')).toBe(`"<redacted:${k}>"`)
  })
  it('exists mode shows the expected boolean as-is', async () => {
    const e = await fail({ path: 'authToken', exists: false }, mk({ opts: { redactState: true } }))
    expect(e.message).toMatch(/exists false/)
  })
  it('a ctx built like makeCtx or MCP (flow config on, no ctx.redactState passed in) redacts a subflow', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-redact-'))
    try {
      fs.writeFileSync(path.join(dir, 'sub.e2e.yaml'), 'steps:\n  - assertState: { layer: global, path: authToken, equals: nope }\n')
      const flow = { file: path.join(dir, 'parent.e2e.yaml'), config: { redactState: true }, steps: [] }
      const cfg = {}
      const ctx = mk({ cfg, opts: {}, flow, redactState: redactStateOn({ cfg, opts: {}, flow }, {}) })
      const e = await execStep({ op: 'runFlow', file: 'sub.e2e.yaml' }, ctx).catch((x) => x)
      expect(e.message).toMatch(/<redacted:authToken>/)
      expect(e.message).not.toMatch(/hunter2/)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
  it('a subflow inherits the setting and cannot turn it off', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-redact-'))
    try {
      const sub = (cfg) => `${cfg}steps:\n  - assertState: { layer: global, path: authToken, equals: nope }\n`
      fs.writeFileSync(path.join(dir, 'plain.e2e.yaml'), sub(''))
      fs.writeFileSync(path.join(dir, 'off.e2e.yaml'), sub('config: { redactState: false }\n'))
      const parent = (cfg) => mk({ cfg, flow: { file: path.join(dir, 'parent.e2e.yaml'), config: {}, steps: [] }, redactState: true })
      for (const f of ['plain', 'off']) {
        const e = await execStep({ op: 'runFlow', file: `${f}.e2e.yaml` }, parent({})).catch((x) => x)
        expect(e.message).toMatch(/<redacted:authToken>/)
        expect(e.message).not.toMatch(/hunter2/)
      }
      const live = await execStep({ op: 'runFlow', file: 'off.e2e.yaml' }, { ...parent({}), redactState: false }).catch((x) => x)
      expect(live.message).toMatch(/hunter2-live/)
      fs.writeFileSync(path.join(dir, 'on.e2e.yaml'), sub('config: { redactState: true }\n'))
      const e2 = await execStep({ op: 'runFlow', file: 'on.e2e.yaml' }, { ...parent({}), redactState: false }).catch((x) => x)
      expect(e2.message).not.toMatch(/hunter2/)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('assertState redaction of array elements and index syntax', () => {
  const cart = { items: [{ sku: 'a', price: 1 }, { sku: 'b', price: 2 }], 'odd[1]': 'lit' }
  const run = (masks, layer, p, v) => makeShown(true, masks)(layer, p, v)
  it('hides an element mask when a parent array or object is printed', () => {
    for (const m of ['global.cart.items[1]', 'global.cart.items.1', 'GLOBAL.Cart.Items[1]']) {
      const out = run([m], 'global', 'cart', cart)
      expect(out).toContain('<redacted:1>')
      expect(out).not.toContain('"b"')
      expect(out).toContain('"a"')
      const out2 = run([m], 'global', 'cart.items', cart.items)
      expect(out2).toBe('[{"sku":"a","price":1},"<redacted:1>"]')
    }
  })
  it('hides the element itself when its path is printed', () => {
    expect(run(['global.cart.items[1]'], 'global', 'cart.items.1', cart.items[1])).toBe('"<redacted:1>"')
    expect(run(['global.cart.items.1'], 'global', 'cart.items.1', cart.items[1])).toBe('"<redacted:1>"')
  })
  it('handles a field inside an element, [*], list.* and literal bracket keys', () => {
    expect(run(['global.cart.items[0].sku'], 'global', 'cart', cart)).toContain('"sku":"<redacted:sku>"')
    expect(run(['global.cart.items[*]'], 'global', 'cart.items', cart.items)).toBe('["<redacted:0>","<redacted:1>"]')
    expect(run(['global.cart.items.*'], 'global', 'cart.items', cart.items)).toBe('["<redacted:0>","<redacted:1>"]')
    expect(run(['global.cart.items[*].price'], 'global', 'cart', cart)).not.toMatch(/"price":\d/)
    expect(run(['global.cart.odd[1]'], 'global', 'cart', cart)).toContain('"odd[1]":"<redacted:odd[1]>"')
  })
})
