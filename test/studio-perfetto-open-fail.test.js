import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { PerfettoCapture } = require('../lib/studio/perfetto.js')

// Fake WebSocket whose open always fails (no real network).
class FailWS {
  constructor() {
    this.readyState = 0
    setTimeout(() => { this.readyState = 3; this.onerror && this.onerror() }, 1)
  }
  close() {}
}
FailWS.OPEN = 1

describe('Perfetto failed websocket open (PRF-01c)', () => {
  let dir, savedWS, realCreate, streams
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-pf-openfail-'))
    streams = []
    realCreate = fs.createWriteStream
    fs.createWriteStream = (...a) => { const s = realCreate.apply(fs, a); streams.push(s); return s }
    savedWS = globalThis.WebSocket
    globalThis.WebSocket = FailWS
  })
  afterEach(() => {
    fs.createWriteStream = realCreate
    globalThis.WebSocket = savedWS
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('closes the trace stream, removes the empty file, and resets state when open fails', async () => {
    const pf = new PerfettoCapture({ host: '127.0.0.1', dir, ecpPort: 1 })
    await expect(pf.start()).rejects.toThrow(/could not open perfetto-session/)
    expect(streams).toHaveLength(1)
    const s = streams[0]
    if (!s.closed) await new Promise((r) => { const t = setTimeout(r, 2000); s.once('close', () => { clearTimeout(t); r() }) })
    expect(s.destroyed).toBe(true)
    expect(s.closed).toBe(true)
    expect(pf.tracing).toBe(false)
    expect(pf.socket).toBeNull()
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.perfetto-trace'))).toEqual([])
  })

  it('error text does not assert an unchecked OS floor', async () => {
    const pf = new PerfettoCapture({ host: '127.0.0.1', dir, ecpPort: 1 })
    await expect(pf.start()).rejects.not.toThrow(/15\.2/)
  })
})
