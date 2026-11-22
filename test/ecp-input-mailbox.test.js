import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

// STA-S-T13: ECP /input mailbox. Sender (ecp.js input / buildInputChunks) against a loopback server, and the agent
// receiver (BT_inputFeed / BT_inputSweep / BT_inputCmd in BT_write.brs) on the fork engine. No device.
const require = createRequire(import.meta.url)
const { createDevice, buildInputChunks, INPUT_CHUNK_MAX } = require('../lib/e2e/ecp.js')
const brsCli = path.resolve(__dirname, '../node_modules/.bin/brs-cli')
const SRC = path.resolve(__dirname, '../lib/instrument/runtime/source/bt')
const strip = (f) => fs.readFileSync(path.join(SRC, f), 'utf8').split('\n').filter((l) => !l.startsWith('#')).join('\n')
const RUNTIME = `${strip('BT_core.brs')}\n${strip('BT_write.brs')}`
const parse = (q) => Object.fromEntries(new URLSearchParams(q))
const COMMAND = (n) => JSON.stringify({ op: 'set', id: 'c1', args: { layer: 'global', path: 'a:b/c', value: 'x:/'.repeat(n) } })

describe('buildInputChunks', () => {
  it('splits a long command into chunks of at most 3,500 chars with : and / encoded', () => {
    const text = COMMAND(3000)
    const { chunks } = buildInputChunks(text, { id: 'abc' })
    expect(chunks.length).toBeGreaterThan(2)
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(3500)
      expect(c.length).toBeLessThan(4082)
      expect(c).not.toMatch(/[:/]/)
    }
    const got = chunks.map(parse)
    expect(got.every((g, i) => g.bt === 'abc' && g.s === String(i) && g.n === String(chunks.length))).toBe(true)
    expect(got.map((g) => g.d).join('')).toBe(text)
  })
  it('a command at the cap is one request; one more encoded char makes two', () => {
    const base = 'bt=abc&s=0&n=1&d='.length
    const fits = buildInputChunks('a'.repeat(INPUT_CHUNK_MAX - 'bt=abc&s=9999&n=9999&d='.length), { id: 'abc' })
    expect(fits.chunks).toHaveLength(1)
    expect(fits.chunks[0].length).toBeLessThanOrEqual(3500)
    const over = buildInputChunks('a'.repeat(INPUT_CHUNK_MAX - 'bt=abc&s=9999&n=9999&d='.length + 1), { id: 'abc' })
    expect(over.chunks).toHaveLength(2)
    expect(base).toBeLessThan(3500)
  })
  it('a chunk exactly 3,500 long is allowed and none exceeds it (max option)', () => {
    const { chunks } = buildInputChunks('é/:'.repeat(2000), { id: 'q', max: 3500 })
    expect(Math.max(...chunks.map((c) => c.length))).toBeLessThanOrEqual(3500)
    expect(chunks.map((c) => decodeURIComponent(parse(c).d)).join('')).toBe('é/:'.repeat(2000))
  })
  it('rejects bad ids and commands needing more than 64 chunks', () => {
    expect(() => buildInputChunks('x', { id: 'a b' })).toThrow(/id/)
    expect(() => buildInputChunks('x'.repeat(3500 * 70), { id: 'a' })).toThrow(/64/)
  })
})

describe('device.input (loopback fake)', () => {
  let srv, port
  const seen = []
  let status = 200
  beforeAll(async () => {
    srv = http.createServer((req, res) => {
      let body = ''
      req.on('data', (d) => { body += d })
      req.on('end', () => { seen.push({ method: req.method, url: req.url, body }); res.statusCode = status; res.end() })
    })
    await new Promise((r) => srv.listen(0, '127.0.0.1', r))
    port = srv.address().port
  })
  afterAll(() => new Promise((r) => srv.close(r)))

  it('POSTs each chunk in seq order to /input with no body', async () => {
    const dev = createDevice({ host: '127.0.0.1', ecpPort: port })
    const r = await dev.input(JSON.parse(COMMAND(2500)), { id: 'zed' })
    expect(r.chunks).toBe(seen.length)
    expect(r.chunks).toBeGreaterThan(1)
    seen.forEach((s, i) => {
      expect(s.method).toBe('POST')
      expect(s.body).toBe('')
      expect(s.url.startsWith('/input?')).toBe(true)
      expect(s.url.length).toBeLessThanOrEqual('/input?'.length + 3500)
      expect(parse(s.url.slice(7)).s).toBe(String(i))
    })
  }, 30000)
  it('throws when a chunk is refused', async () => {
    status = 400
    const dev = createDevice({ host: '127.0.0.1', ecpPort: port })
    await expect(dev.input('{"op":"ping"}', { id: 'bad' })).rejects.toThrow(/HTTP 400/)
    status = 200
  }, 30000)
})

let tmp
beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-input-')) })
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

function runBrs(name, main) {
  const file = path.join(tmp, name + '.brs')
  fs.writeFileSync(file, `function BT_config() as object\n    return { caps: {}, publish: {} }\nend function\n${RUNTIME}\nfunction BTT(b as boolean) as string\n    if b then return "true"\n    return "false"\nend function\nsub main()\n${main}\nend sub\n`)
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [brsCli, file], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), 30000)
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    child.on('close', () => { clearTimeout(timer); resolve(out) })
  })
}
const lines = (out, tag) => out.split(/\r?\n/).filter((l) => l.startsWith(tag)).map((l) => l.slice(tag.length))

describe('agent /input receiver (headless, fork engine)', () => {
  let out
  const text = COMMAND(1500)
  const { chunks } = buildInputChunks(text, { id: 'k1', max: 1200 })
  const info = (q) => { const p = parse(q); return `{ bt: "${p.bt}", s: "${p.s}", n: "${p.n}", d: "${p.d.replace(/"/g, '""')}" }` }
  beforeAll(async () => {
    const I = chunks.map(info)
    const order = [chunks.length - 1, ...Array.from({ length: chunks.length - 1 }, (_, i) => i)]
    const main = [
      '    st = BT_inputNew()',
      `    c = [${I.join(', ')}]`,
      // 1: out of order, last chunk first; the full text appears only after the final chunk arrives
      `    order = [${order.join(', ')}]`,
      '    fin = invalid : early = 0',
      '    for each i in order',
      '        r = BT_inputFeed(st, c[i], 1000)',
      '        if r <> invalid then fin = r else early = early + 1',
      '    end for',
      `    print "A:" + str(early).trim() + ":" + str(len(fin)).trim()`,
      '    print "B:" + fin',
      // 2: duplicate chunks do not double-apply, and a finished id is ignored
      '    st = BT_inputNew() : n = 0',
      '    for each i in [0, 0, 1, 1, 0]',
      '        if BT_inputFeed(st, c[i], 1000) <> invalid then n = n + 1',
      '    end for',
      '    for i = 2 to c.count() - 1',
      '        if BT_inputFeed(st, c[i], 1000) <> invalid then n = n + 1',
      '    end for',
      '    for each i in [0, 1, 2]',
      '        if BT_inputFeed(st, c[i], 1100) <> invalid then n = n + 1',
      '    end for',
      '    print "C:" + str(n).trim()',
      // 3: a missing chunk is never executed, and the partial sequence is dropped after the wait
      '    st = BT_inputNew() : n = 0',
      '    for i = 1 to c.count() - 1',
      '        if BT_inputFeed(st, c[i], 1000) <> invalid then n = n + 1',
      '    end for',
      '    print "D:" + str(n).trim() + ":" + str(st.pending.count()).trim()',
      '    print "E:" + str(BT_inputSweep(st, 1000 + BT_inputTtlMs() - 1, BT_inputTtlMs())).trim() + ":" + str(st.pending.count()).trim()',
      '    print "F:" + str(BT_inputSweep(st, 1000 + BT_inputTtlMs(), BT_inputTtlMs())).trim() + ":" + str(st.pending.count()).trim()',
      // after the drop, a late chunk 0 starts a new sequence and still cannot complete it alone
      '    print "G:" + BTT(BT_inputFeed(st, c[0], 20000) = invalid)',
      // 4: stale partial dropped on the next feed; junk events ignored; command parse
      '    st = BT_inputNew() : BT_inputFeed(st, c[0], 0)',
      '    BT_inputFeed(st, { bt: "zz", s: "0", n: "2", d: "x" }, BT_inputTtlMs() + 5)',
      '    print "H:" + str(st.pending.count()).trim() + ":" + BTT(st.pending.doesExist("k1"))',
      '    print "I:" + BTT(BT_inputFeed(st, { displayMode: "720p" }, 0) = invalid) + BTT(BT_inputFeed(st, { bt: "q", s: "5", n: "2", d: "x" }, 0) = invalid) + BTT(BT_inputFeed(st, { bt: "q", s: "0", n: "999", d: "x" }, 0) = invalid)',
      '    cmd = BT_inputCmd(fin)',
      '    print "J:" + cmd.op + ":" + str(cmd.seq).trim() + ":" + cmd.id',
      '    print "K:" + BTT(BT_inputCmd("{not json") = invalid) + BTT(BT_inputCmd("[1]") = invalid) + BTT(BT_inputCmd("{}") = invalid)',
    ].join('\n')
    out = await runBrs('recv', main)
  }, 60000)

  it('reassembles chunks that arrive out of order, completing only on the last', () => {
    const [early, len] = lines(out, 'A:')[0].split(':').map(Number)
    expect(early).toBe(chunks.length - 1)
    expect(len).toBe(text.length)
    expect(lines(out, 'B:')[0]).toBe(text)
  })
  it('duplicated chunks and a replayed command id do not apply twice', () => {
    expect(lines(out, 'C:')[0]).toBe('1')
  })
  it('never completes a sequence with a missing chunk, and drops it after the bounded wait', () => {
    expect(lines(out, 'D:')[0]).toBe('0:1')
    expect(lines(out, 'E:')[0]).toBe('0:1')
    expect(lines(out, 'F:')[0]).toBe('1:0')
    expect(lines(out, 'G:')[0]).toBe('true')
    expect(lines(out, 'H:')[0]).toBe('1:false')
  })
  it('ignores foreign and malformed events, and parses the complete command', () => {
    expect(lines(out, 'I:')[0]).toBe('truetruetrue')
    expect(lines(out, 'J:')[0]).toBe('set:0:c1')
    expect(lines(out, 'K:')[0]).toBe('truetruetrue')
  })
})

describe('agent wiring (template check)', () => {
  const RT = path.resolve(__dirname, '../lib/instrument/runtime/components/bt')
  it('the Task owns the roInput receiver and the agent applies its complete commands', () => {
    const task = fs.readFileSync(path.join(RT, 'BT_AgentTask.brs'), 'utf8')
    expect(task).toContain('CreateObject("roInput")')
    expect(task).toContain('BT_inputSweep(')
    expect(task).toContain('BT_inputFeed(')
    expect(fs.readFileSync(path.join(RT, 'BT_AgentTask.xml'), 'utf8')).toContain('id="icmd"')
    expect(fs.readFileSync(path.join(RT, 'BT_Agent.brs'), 'utf8')).toContain('BT_inputCmd(')
  })
})
