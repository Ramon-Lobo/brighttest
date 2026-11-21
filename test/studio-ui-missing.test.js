import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
process.env.BRIGHTTEST_CACHE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bt-studio-cache-')), 'devices.json')
const studio = require('../lib/studio/server.js')

const __dirname_ = path.dirname(new URL(import.meta.url).pathname)
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)) }) })
const canConnect = (port) => new Promise((r) => { const c = net.connect(port, '127.0.0.1'); c.on('connect', () => { c.destroy(); r(true) }); c.on('error', () => r(false)) })

describe('studio with no built UI', () => {
  it('rejects with the missing bundle path and the build command, and binds no port', async () => {
    const missing = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-studio-nopublic-'))
    const port = await freePort()
    const err = await studio.start({ port, rootDir: missing, publicDir: missing, requireUi: true }).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.code).toBe('UI_NOT_BUILT')
    expect(err.message).toContain(path.join(missing, 'index.html'))
    expect(err.message).toContain('npm run studio:build')
    expect(await canConnect(port)).toBe(false)
  })

  it('starts when the bundle is present', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-studio-public-'))
    fs.writeFileSync(path.join(dir, 'index.html'), '<html></html>')
    const s = await studio.start({ port: 0, rootDir: dir, publicDir: dir, requireUi: true })
    try { expect(s.address().port).toBeGreaterThan(0) } finally { s.close() }
  })

  it('the CLI passes requireUi and no longer checks the bundle itself', () => {
    const src = fs.readFileSync(path.join(__dirname_, '..', 'bin', 'cli.js'), 'utf8')
    expect(src).toMatch(/requireUi: true/)
    expect(src).not.toContain('the studio UI is not built yet')
  })
})
