import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { parseActiveApp, createDevice } from '../lib/e2e/ecp.js'

const fx = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', `active-app-${n}.xml`), 'utf8')

describe('parseActiveApp / Home shapes', () => {
  it.each([
    ['roku', { id: null, name: 'Roku', home: true }],
    ['native-ui', { id: 'native-ui', type: 'appl', uiLocation: 'home', home: true }],
    ['dynamic-menu', { id: '562859', type: 'home', uiLocation: 'home', home: true }],
    ['dev', { id: 'dev', type: 'appl', uiLocation: 'dev', home: false }],
    ['channel', { id: '12345', name: 'Sample Channel', uiLocation: null, home: false }],
  ])('%s', (name, want) => {
    expect(parseActiveApp(fx(name))).toMatchObject(want)
  })

  it('unparseable or empty input is not Home and has no id', () => {
    expect(parseActiveApp('')).toMatchObject({ id: null, home: false })
    expect(parseActiveApp('<html>oops</html>')).toMatchObject({ id: null, home: false })
  })

  it('does not depend on firmware strings', () => {
    expect(parseActiveApp(fx('roku') + '<!-- software-version 9.0 -->').home).toBe(true)
  })
})

describe('device.activeApp()/isHome()', () => {
  afterEach(() => vi.unstubAllGlobals())
  const stub = (status, body) => vi.stubGlobal('fetch', async () => ({ status, text: async () => body }))

  it('classifies via /query/active-app', async () => {
    const dev = createDevice({ host: 'active-app-test-host' })
    stub(200, fx('dynamic-menu'))
    expect(await dev.isHome()).toBe(true)
    stub(200, fx('dev'))
    expect(await dev.activeApp()).toMatchObject({ id: 'dev' })
    expect(await dev.isHome()).toBe(false)
  })

  it('throws on a non-200', async () => {
    const dev = createDevice({ host: 'active-app-test-host-2' })
    stub(404, '')
    await expect(dev.activeApp()).rejects.toThrow(/HTTP 404/)
  })
})
