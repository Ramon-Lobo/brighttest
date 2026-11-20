import { describe, it, expect, vi, afterEach } from 'vitest'
import { createDevice, sniffImageExt } from '../lib/e2e/ecp.js'

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0])

// Fake installer: POST /plugin_inspect answers `html`; GET <path> answers `img` bytes. Counts POSTs.
function stubInstaller({ html, img }) {
  const calls = { post: 0, get: 0 }
  vi.stubGlobal('fetch', async (url, init = {}) => {
    const post = (init.method || 'GET') === 'POST'
    post ? calls.post++ : calls.get++
    return {
      status: 200,
      headers: { get: () => null },
      text: async () => html,
      arrayBuffer: async () => img.buffer.slice(img.byteOffset, img.byteOffset + img.byteLength),
    }
  })
  return calls
}

describe('screenshot()', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('sniffImageExt reads magic bytes', () => {
    expect(sniffImageExt(JPEG)).toBe('jpg')
    expect(sniffImageExt(PNG)).toBe('png')
    expect(sniffImageExt(Buffer.from('nope'))).toBe(null)
  })

  it('"Screenshot not ok" throws SCREENSHOT_NOT_FOREGROUND after exactly one attempt', async () => {
    const calls = stubInstaller({ html: '<html>Screenshot not ok</html>', img: JPEG })
    const dev = createDevice({ host: 'shot-test-1', password: 'x' })
    await expect(dev.screenshot()).rejects.toMatchObject({ code: 'SCREENSHOT_NOT_FOREGROUND' })
    expect(calls).toEqual({ post: 1, get: 0 })
  })

  it('extension follows the magic bytes, not the URL', async () => {
    stubInstaller({ html: '<img src="/pkgs/dev.jpg">', img: PNG })
    const a = await createDevice({ host: 'shot-test-2', password: 'x' }).screenshot()
    expect(a.ext).toBe('png')
    stubInstaller({ html: '<img src="/pkgs/dev.png">', img: JPEG })
    const b = await createDevice({ host: 'shot-test-3', password: 'x' }).screenshot()
    expect(b.ext).toBe('jpg')
  })

  it('still requires a password', async () => {
    await expect(createDevice({ host: 'shot-test-4' }).screenshot()).rejects.toThrow(/password/)
  })
})
