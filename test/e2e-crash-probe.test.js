import { describe, it, expect } from 'vitest'
import { execStep } from '../lib/e2e/run.js'
import { waitForSettle } from '../lib/e2e/sgnodes.js'

const TREE = '<sgnodes><All_Nodes><Default name="" /><Scene name="root"><Label name="other" text="x" /></Scene></All_Nodes><status>OK</status></sgnodes>'
const GONE = '<sgnodes><status>Channel not running</status></sgnodes>'
const app = (id, home = false) => ({ id, name: id, home })

// Fake device: counts sgnodes polls and active-app reads; `crashed` flips what the device reports.
function fake({ crashed, sgText = TREE, active }) {
  const calls = { tree: 0, active: 0 }
  const device = {
    async ecpGet() { calls.tree++; return { status: 200, text: crashed ? GONE : sgText } },
    async activeApp() { calls.active++; if (active instanceof Error) throw active; return active || (crashed ? app('native-ui', true) : app('dev')) },
  }
  return { device, calls }
}

describe('crash probe in wait loops (APP_CRASHED)', () => {
  it('reports APP_CRASHED within one poll when the app is no longer in front', async () => {
    const { device, calls } = fake({ crashed: true })
    const t0 = Date.now()
    const err = await execStep({ op: 'waitFor', selector: { id: 'hero' } }, { device, stepTimeoutMs: 5000 }).catch((e) => e)
    expect(err.code).toBe('APP_CRASHED')
    expect(err.retryable).toBe(false)
    expect(err.message).toMatch(/Home/)
    expect(calls.tree).toBeLessThan(2)
    expect(Date.now() - t0).toBeLessThan(1000)
  })
  it('covers assertText/assertFocused/assertField the same way', async () => {
    for (const step of [
      { op: 'assertText', selector: { id: 'hero' }, equals: 'a' },
      { op: 'assertFocused', selector: { id: 'hero' } },
      { op: 'assertField', selector: { id: 'hero' }, field: 'uri', equals: 'a' },
    ]) {
      const { device, calls } = fake({ crashed: true })
      const err = await execStep(step, { device, stepTimeoutMs: 5000 }).catch((e) => e)
      expect(err.code).toBe('APP_CRASHED')
      expect(calls.tree).toBeLessThan(2)
    }
  })
  it('a different foreground app (not Home) also counts as a crash', async () => {
    const { device } = fake({ crashed: false, active: app('12345') })
    const err = await execStep({ op: 'waitFor', selector: { id: 'hero' } }, { device, stepTimeoutMs: 5000 }).catch((e) => e)
    expect(err.code).toBe('APP_CRASHED')
  })
  it('honors the flow app id', async () => {
    const { device } = fake({ crashed: false, active: app('555') })
    await expect(execStep({ op: 'waitFor', selector: { id: 'other' } }, { device, stepTimeoutMs: 400, flow: { appId: '555' } })).resolves.toBeTruthy()
  })
  it('selector timeout with the app still in front is unchanged', async () => {
    const { device, calls } = fake({ crashed: false })
    const err = await execStep({ op: 'waitFor', selector: { id: 'hero' } }, { device, stepTimeoutMs: 400 }).catch((e) => e)
    expect(err.code).toBeUndefined()
    expect(err.message).toMatch(/not visible within/)
    expect(calls.active).toBeGreaterThan(0)
  })
  it('an unreadable active-app does not mask the selector timeout', async () => {
    const { device } = fake({ crashed: false, active: new Error('active-app HTTP 500') })
    await expect(execStep({ op: 'waitFor', selector: { id: 'hero' } }, { device, stepTimeoutMs: 300 })).rejects.toThrow(/not visible within/)
  })
  it('a satisfied wait never probes', async () => {
    const { device, calls } = fake({ crashed: false })
    await execStep({ op: 'waitFor', selector: { id: 'other' } }, { device, stepTimeoutMs: 400 })
    expect(calls.active).toBe(0)
  })
  it('waitForSettle runs the probe when the read fails', async () => {
    const device = { async ecpGet() { return { status: 200, text: GONE } } }
    const boom = Object.assign(new Error('APP_CRASHED'), { code: 'APP_CRASHED' })
    const err = await waitForSettle(device, { probe: async () => { throw boom } }).catch((e) => e)
    expect(err.code).toBe('APP_CRASHED')
  })
  it('runFlow keeps the code of a crashed child step', async () => {
    const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-crash-'))
    try {
      fs.writeFileSync(path.join(dir, 'child.e2e.yaml'), 'steps:\n  - waitFor: { id: hero }\n')
      const { device } = fake({ crashed: true })
      const err = await execStep({ op: 'runFlow', file: 'child.e2e.yaml', env: {} }, { device, stepTimeoutMs: 5000, flow: { file: path.join(dir, 'p.e2e.yaml'), config: {} } }).catch((e) => e)
      expect(err.code).toBe('APP_CRASHED')
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
})
