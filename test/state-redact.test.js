import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import { parseFlow } from '../lib/e2e/flow.js'
const require = createRequire(import.meta.url)
const { execStep } = require('../lib/e2e/run')
const { redactStateOn, makeShown } = require('../lib/e2e/appstate')

// STA-MASK-F1: assertState failure text and step detail hide app values when redaction is on (off by default).
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
