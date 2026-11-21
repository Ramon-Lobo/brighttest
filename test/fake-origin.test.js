import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createRequire } from 'module'
import fs from 'fs'
import os from 'os'
import path from 'path'
import net from 'net'

const require = createRequire(import.meta.url)
const { createOrigin, parseArgs } = require('./fixtures/fake-origin/server.js')

let origin, base, logFile
beforeAll(async () => {
  logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fo-')), 'req.ndjson')
  origin = createOrigin({ port: 0, logFile })
  base = (await origin.start()).url
})
afterAll(() => origin.stop())

const get = (p, opts) => fetch(base + p, opts)

describe('fake-origin routes', () => {
  it('binds to loopback by default', () => {
    expect(base.startsWith('http://127.0.0.1:')).toBe(true)
  })
  it('serves /home, /catalog, /catalog/:id, /search', async () => {
    expect((await (await get('/home')).json()).rails.length).toBe(1)
    expect((await (await get('/catalog')).json()).items.length).toBe(3)
    expect((await (await get('/catalog/b2')).json()).title).toBe('Item Two')
    expect((await get('/catalog/nope')).status).toBe(404)
    const s = await (await get('/search?q=three')).json()
    expect(s.results.map((r) => r.id)).toEqual(['c3'])
  })
  it('echoes POST bodies and accepts /track', async () => {
    const r = await (await get('/echo', { method: 'POST', body: 'hello' })).json()
    expect(r.body).toBe('hello')
    expect((await get('/track', { method: 'POST', body: '{}' })).status).toBe(204)
  })
  it('/auth requires Authorization', async () => {
    expect((await get('/auth')).status).toBe(401)
    expect((await get('/auth', { headers: { Authorization: 'Bearer x' } })).status).toBe(200)
  })
  it('serves a PNG', async () => {
    const r = await get('/image.png')
    expect(r.headers.get('content-type')).toBe('image/png')
    expect([...Buffer.from(await r.arrayBuffer()).subarray(1, 4)]).toEqual([0x50, 0x4e, 0x47])
  })
  it('/status/:code, /large, /file, /sse', async () => {
    expect((await get('/status/503')).status).toBe(503)
    expect((await get('/status/204')).status).toBe(204)
    expect((await (await get('/large?kb=3')).arrayBuffer()).byteLength).toBe(3072)
    const f = await get('/file/a b.bin')
    expect((await f.arrayBuffer()).byteLength).toBe(256)
    expect(f.headers.get('content-disposition')).toContain('a_b.bin')
    const sse = await get('/sse?n=2')
    expect(sse.headers.get('content-type')).toBe('text/event-stream')
    expect((await sse.text()).match(/event: tick/g).length).toBe(2)
  })
  it('unknown routes 404', async () => {
    expect((await get('/nope')).status).toBe(404)
  })
})

describe('fake-origin faults', () => {
  it('/slow delays', async () => {
    const t = Date.now()
    await get('/slow?ms=150')
    expect(Date.now() - t).toBeGreaterThanOrEqual(140)
  })
  it('/stall never answers', async () => {
    await expect(get('/stall', { signal: AbortSignal.timeout(200) })).rejects.toThrow()
  })
  it('/reset destroys the socket', async () => {
    await expect(get('/reset')).rejects.toThrow()
  })
  it('/redirect follows hops and ?to=', async () => {
    const r1 = await get('/redirect?to=/catalog', { redirect: 'manual' })
    expect(r1.status).toBe(302)
    expect(r1.headers.get('location')).toBe('/catalog')
    const r3 = await get('/redirect?to=/catalog&n=3')
    expect(r3.redirected).toBe(true)
    expect(new URL(r3.url).pathname).toBe('/catalog')
    const hop = await get('/redirect?to=/catalog&n=3', { redirect: 'manual' })
    expect(hop.headers.get('location')).toContain('n=2')
  })
  it('raw socket sees /reset as a close', async () => {
    const port = Number(new URL(base).port)
    await new Promise((resolve) => {
      const s = net.connect(port, '127.0.0.1', () => s.write('GET /reset HTTP/1.1\r\nHost: x\r\n\r\n'))
      s.on('close', resolve)
      s.on('error', () => {})
    })
  })
})

describe('fake-origin request log', () => {
  it('records NDJSON with redacted Authorization and body size', async () => {
    await get('/echo', { method: 'POST', body: '12345', headers: { Authorization: 'Bearer secret-token' } })
    const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    const e = lines.filter((l) => l.path === '/echo').pop()
    expect(e.method).toBe('POST')
    expect(e.bodySize).toBe(5)
    expect(e.headers.authorization).toBe('[redacted]')
    expect(e.time).toMatch(/^\d{4}-/)
    expect(fs.readFileSync(logFile, 'utf8')).not.toContain('secret-token')
    expect(origin.log.length).toBe(lines.length)
  })
  it('parseArgs reads host/port/log', () => {
    expect(parseArgs(['--host', '0.0.0.0', '--port', '9', '--log', 'x'])).toEqual({ host: '0.0.0.0', port: 9, logFile: 'x' })
  })
})
