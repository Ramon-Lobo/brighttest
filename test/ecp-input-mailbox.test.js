import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

// STA-S-T13: ECP /input mailbox. Sender (ecp.js input / buildInputChunks) against a loopback server, and the agent
// receiver (BT_input* in BT_write.brs) on the fork engine. No device: the Task/Agent thread hand-over (observer
// re-fire, back-to-back delivery) and roInput coexistence are not exercised here.
const require = createRequire(import.meta.url)
const { createDevice, buildInputChunks, INPUT_CHUNK_MAX } = require('../lib/e2e/ecp.js')
const { endpointKind, DEFAULT_GAPS } = require('../lib/e2e/ecpq.js')
const brsCli = path.resolve(__dirname, '../node_modules/.bin/brs-cli')
const SRC = path.resolve(__dirname, '../lib/instrument/runtime/source/bt')
const strip = (f) => fs.readFileSync(path.join(SRC, f), 'utf8').split('\n').filter((l) => !l.startsWith('#')).join('\n')
const RUNTIME = `${strip('BT_core.brs')}\n${strip('BT_write.brs')}`
const TOKEN = 'a1'.repeat(16)
const parse = (q) => Object.fromEntries(new URLSearchParams(q))
const COMMAND = (n) => JSON.stringify({ op: 'set', id: 'c1', args: { layer: 'global', path: 'a:b/c', value: 'x:/'.repeat(n) } })
const OVERHEAD = `bt=abc&tk=${TOKEN}&s=9999&n=9999&d=`.length

describe('buildInputChunks', () => {
  it('splits a long command into chunks of at most 3,500 chars with : and / encoded, token included', () => {
    const text = COMMAND(3000)
    const { chunks } = buildInputChunks(text, { id: 'abc', token: TOKEN })
    expect(chunks.length).toBeGreaterThan(2)
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(3500)
      expect(c.length).toBeLessThan(4082)
      expect(c).not.toMatch(/[:/]/)
      expect(parse(c).tk).toBe(TOKEN)
    }
    const got = chunks.map(parse)
    expect(got.every((g, i) => g.bt === 'abc' && g.s === String(i) && g.n === String(chunks.length))).toBe(true)
    expect(got.map((g) => g.d).join('')).toBe(text)
  })
  it('a command at the cap is one request; one more encoded char makes two', () => {
    const fits = buildInputChunks('a'.repeat(INPUT_CHUNK_MAX - OVERHEAD), { id: 'abc', token: TOKEN })
    expect(fits.chunks).toHaveLength(1)
    expect(fits.chunks[0].length).toBeLessThanOrEqual(3500)
    expect(buildInputChunks('a'.repeat(INPUT_CHUNK_MAX - OVERHEAD + 1), { id: 'abc', token: TOKEN }).chunks).toHaveLength(2)
  })
  it('no chunk exceeds the cap with multibyte text, and the text round-trips', () => {
    const t = 'é/:日本語😀'.repeat(900)
    const { chunks } = buildInputChunks(t, { id: 'q', token: TOKEN })
    expect(Math.max(...chunks.map((c) => c.length))).toBeLessThanOrEqual(3500)
    expect(chunks.map((c) => parse(c).d).join('')).toBe(t)
  })
  it('rejects bad ids, a missing token, an empty command, a lone surrogate, and more than 64 chunks', () => {
    expect(() => buildInputChunks('x', { id: 'a b', token: TOKEN })).toThrow(/id/)
    expect(() => buildInputChunks('x', { id: 'a' })).toThrow(/hub token is required/)
    expect(() => buildInputChunks('', { token: TOKEN })).toThrow(/empty/)
    expect(() => buildInputChunks('a\ud800b', { token: TOKEN })).toThrow(/lone surrogate/)
    expect(() => buildInputChunks('x'.repeat(3500 * 70), { id: 'a', token: TOKEN })).toThrow(/64/)
  })
  it('the /input endpoint has its own 220 ms gap in the ECP queue', () => {
    expect(endpointKind('/input?bt=a')).toBe('input')
    expect(DEFAULT_GAPS.input).toBe(220)
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
      req.on('end', () => { seen.push({ method: req.method, url: req.url, body, at: Date.now() }); res.statusCode = status; res.end() })
    })
    await new Promise((r) => srv.listen(0, '127.0.0.1', r))
    port = srv.address().port
  })
  afterAll(() => new Promise((r) => srv.close(r)))

  it('POSTs each chunk in seq order to /input with no body, spaced by the gap', async () => {
    const dev = createDevice({ host: '127.0.0.1', ecpPort: port, hubToken: TOKEN })
    const r = await dev.input(JSON.parse(COMMAND(2500)), { id: 'zed' })
    expect(r.chunks).toBe(seen.length)
    expect(r.chunks).toBeGreaterThan(1)
    seen.forEach((s, i) => {
      expect(s.method).toBe('POST')
      expect(s.body).toBe('')
      expect(s.url.startsWith('/input?')).toBe(true)
      expect(s.url.length).toBeLessThanOrEqual('/input?'.length + 3500)
      expect(parse(s.url.slice(7)).s).toBe(String(i))
      expect(parse(s.url.slice(7)).tk).toBe(TOKEN)
      if (i > 0) expect(s.at - seen[i - 1].at).toBeGreaterThanOrEqual(200)
    })
  }, 30000)
  it('needs a token, and throws when a chunk is refused', async () => {
    const dev = createDevice({ host: '127.0.0.1', ecpPort: port })
    await expect(dev.input('{"op":"ping"}', { id: 'bad' })).rejects.toThrow(/hub token is required/)
    status = 400
    await expect(dev.input('{"op":"ping"}', { id: 'bad', token: TOKEN })).rejects.toThrow(/HTTP 400/)
    status = 200
  }, 30000)
})

let tmp
beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-input-')) })
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

const PRELUDE = [
  'function BT_config() as object',
  '    return { caps: {}, publish: {}, callFuncAllow: [] }',
  'end function',
  RUNTIME,
  'function BTT(b as boolean) as string',
  '    if b then return "true"',
  '    return "false"',
  'end function',
  // an event as roInput delivers it: all values strings
  'function EV(cid, s, n, d, tk = "' + TOKEN + '") as object',
  '    return { bt: cid, tk: tk, s: s.toStr().trim(), n: n.toStr().trim(), d: d }',
  'end function',
  'function GOT(r) as string',
  '    if r = invalid then return "-"',
  '    return r.id + "=" + r.text',
  'end function',
].join('\n')

function runBrs(name, main) {
  const file = path.join(tmp, name + '.brs')
  fs.writeFileSync(file, `${PRELUDE}\nsub main()\n${main}\nend sub\n`)
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [brsCli, file], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), 30000)
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    child.on('close', () => { clearTimeout(timer); resolve(out) })
  })
}
const val = (out, tag) => { const l = out.split(/\r?\n/).find((x) => x.startsWith(tag + ':')); return l ? l.slice(tag.length + 1) : null }
const T = `"${TOKEN}"`

describe('agent /input receiver (headless, fork engine)', () => {
  let out
  const text = COMMAND(1500)
  const { chunks } = buildInputChunks(text, { id: 'k1', token: TOKEN, max: 1200 })
  const N = chunks.length
  const br = (c) => { const p = parse(c); return `EV("${p.bt}", ${p.s}, ${p.n}, "${p.d.replace(/"/g, '""')}")` }
  beforeAll(async () => {
    const main = [
      `    tk = ${T}`,
      `    c = [${chunks.map(br).join(', ')}]`,
      `    total = ${N}`,
      '    st = BT_inputNew()',
      // A: out of order, last chunk first; completes only on the final chunk
      '    fin = invalid : early = 0',
      `    for each i in [total - 1, ${Array.from({ length: N - 1 }, (_, i) => i).join(', ')}]`,
      '        r = BT_inputFeed(st, c[i], 1000, tk)',
      '        if r <> invalid then fin = r else early = early + 1',
      '    end for',
      '    print "A:" + early.toStr().trim() + ":" + fin.text.len().toStr().trim()',
      '    print "B:" + fin.text',
      '    print "B2:" + fin.id',
      // C: duplicates do not double-apply; replay of a finished id (still inside the last 32) is ignored
      '    st = BT_inputNew() : cnt = 0',
      '    for each i in [0, 0, 1, 1, 0]',
      '        if BT_inputFeed(st, c[i], 1000, tk) <> invalid then cnt = cnt + 1',
      '    end for',
      '    for i = 2 to total - 1',
      '        if BT_inputFeed(st, c[i], 1000, tk) <> invalid then cnt = cnt + 1',
      '    end for',
      '    for i = 0 to total - 1',
      '        if BT_inputFeed(st, c[i], 1100, tk) <> invalid then cnt = cnt + 1',
      '    end for',
      '    print "C:" + cnt.toStr().trim()',
      // C2: the finished-id memory is bounded at 32 ids: id 1 is forgotten after 33 later commands, id 33 is not
      '    st = BT_inputNew()',
      '    for i = 1 to 33',
      '        BT_inputFeed(st, EV("id" + i.toStr().trim(), 0, 1, "{}"), 0, tk)',
      '    end for',
      '    print "C2:" + GOT(BT_inputFeed(st, EV("id1", 0, 1, "{}"), 0, tk)) + "," + GOT(BT_inputFeed(st, EV("id33", 0, 1, "{}"), 0, tk))',
      // D: a missing chunk is never completed, dropped after the wait (sliding from the last accepted chunk)
      '    st = BT_inputNew() : cnt = 0',
      '    for i = 1 to total - 1',
      '        if BT_inputFeed(st, c[i], 1000, tk) <> invalid then cnt = cnt + 1',
      '    end for',
      '    print "D:" + cnt.toStr().trim() + ":" + st.pending.count().toStr().trim()',
      '    print "E:" + BT_inputSweep(st, 1000 + BT_inputTtlMs() - 1, BT_inputTtlMs()).toStr().trim() + ":" + st.pending.count().toStr().trim()',
      '    print "F:" + BT_inputSweep(st, 1000 + BT_inputTtlMs(), BT_inputTtlMs()).toStr().trim() + ":" + st.pending.count().toStr().trim()',
      '    print "G:" + BTT(BT_inputFeed(st, c[0], 20000, tk) = invalid)',
      // H: sliding window: a chunk every 6 s keeps the sequence alive far past one TTL, then it completes
      '    st = BT_inputNew() : r = invalid : t = 0',
      '    for i = 0 to total - 1',
      '        r = BT_inputFeed(st, c[i], t, tk)',
      '        t = t + 6000',
      '    end for',
      '    print "H:" + BTT(r <> invalid)',
      // H2: without activity the sequence is dropped
      '    st = BT_inputNew() : BT_inputFeed(st, c[0], 0, tk)',
      '    BT_inputFeed(st, EV("zz", 0, 2, "x"), BT_inputTtlMs() + 5, tk)',
      '    print "H2:" + st.pending.count().toStr().trim() + ":" + BTT(st.pending.doesExist("k1"))',
      // I: foreign / malformed events and s >= n, n above the cap
      '    st = BT_inputNew()',
      '    print "I:" + BTT(BT_inputFeed(st, { displayMode: "720p" }, 0, tk) = invalid) + BTT(BT_inputFeed(st, EV("q", 2, 2, "x"), 0, tk) = invalid) + BTT(BT_inputFeed(st, EV("q", 5, 2, "x"), 0, tk) = invalid) + BTT(BT_inputFeed(st, EV("q", 0, 65, "x"), 0, tk) = invalid) + BTT(BT_inputFeed(st, EV("q", 0, 0, "x"), 0, tk) = invalid) + BTT(st.pending.count() = 0)',
      // J: n changing mid-sequence is rejected and does not corrupt the sequence
      '    st = BT_inputNew()',
      '    BT_inputFeed(st, EV("m", 0, 3, "a"), 0, tk)',
      '    x1 = BT_inputFeed(st, EV("m", 1, 4, "b"), 0, tk)',
      '    BT_inputFeed(st, EV("m", 1, 3, "b"), 0, tk)',
      '    print "J:" + BTT(x1 = invalid) + ":" + GOT(BT_inputFeed(st, EV("m", 2, 3, "c"), 0, tk))',
      // K: a duplicate chunk with different data keeps the first
      '    st = BT_inputNew()',
      '    BT_inputFeed(st, EV("d", 0, 2, "first"), 0, tk)',
      '    BT_inputFeed(st, EV("d", 0, 2, "SECOND"), 0, tk)',
      '    print "K:" + GOT(BT_inputFeed(st, EV("d", 1, 2, "-end"), 0, tk))',
      // L: token: wrong, missing, shorter, longer, empty-configured all drop with no state
      '    st = BT_inputNew()',
      '    bad = ["b1" + Mid(tk, 3), Left(tk, 31), tk + "x", ""]',
      '    ok = true',
      '    for each b in bad',
      '        if BT_inputFeed(st, EV("t", 0, 1, "{}", b), 0, tk) <> invalid then ok = false',
      '        if BT_inputFeed(st, EV("t", 0, 2, "{}", b), 0, tk) <> invalid then ok = false',
      '    end for',
      '    if BT_inputFeed(st, { bt: "t", s: "0", n: "1", d: "{}" }, 0, tk) <> invalid then ok = false',
      '    if BT_inputFeed(st, EV("t", 0, 1, "{}"), 0, "") <> invalid then ok = false',
      '    if BT_inputFeed(st, EV("t", 0, 1, "{}"), 0, invalid) <> invalid then ok = false',
      '    print "L:" + BTT(ok) + ":" + st.pending.count().toStr().trim() + ":" + st.done.count().toStr().trim() + ":" + GOT(BT_inputFeed(st, EV("t", 0, 1, "{}"), 0, tk))',
      // M: n=1 takes no pending slot, so eight half-done sequences are not evicted by it
      '    st = BT_inputNew()',
      '    for i = 1 to 8',
      '        BT_inputFeed(st, EV("p" + i.toStr().trim(), 0, 2, "x"), i, tk)',
      '    end for',
      '    one = BT_inputFeed(st, EV("single", 0, 1, "{}"), 20, tk)',
      '    print "M:" + GOT(one) + ":" + st.pending.count().toStr().trim() + ":" + BTT(st.pending.doesExist("p1"))',
      // N: the cap evicts the oldest; junk n=64 chunks cannot block a legitimate command
      '    for i = 1 to 12',
      '        BT_inputFeed(st, EV("junk" + i.toStr().trim(), 0, 64, "x"), 100 + i, tk)',
      '    end for',
      '    BT_inputFeed(st, EV("real", 0, 2, "ab"), 200, tk)',
      '    print "N:" + st.pending.count().toStr().trim() + ":" + BTT(st.pending.doesExist("p1")) + ":" + BTT(st.pending.doesExist("junk12")) + ":" + GOT(BT_inputFeed(st, EV("real", 1, 2, "cd"), 201, tk))',
      // O: command parse: seq is forced to 0, id defaults to the chunk id
      '    cmd = BT_inputCmd("{" + Chr(34) + "op" + Chr(34) + ":" + Chr(34) + "ping" + Chr(34) + "," + Chr(34) + "seq" + Chr(34) + ":77}", "cid9")',
      '    print "O:" + cmd.op + ":" + cmd.seq.toStr().trim() + ":" + cmd.id',
      '    cmd2 = BT_inputCmd("{" + Chr(34) + "op" + Chr(34) + ":" + Chr(34) + "ping" + Chr(34) + "," + Chr(34) + "id" + Chr(34) + ":" + Chr(34) + "own" + Chr(34) + "}", "cid9")',
      '    print "O2:" + cmd2.id',
      '    print "P:" + BTT(BT_inputCmd("{not json", "a") = invalid) + BTT(BT_inputCmd("[1]", "a") = invalid) + BTT(BT_inputCmd("{}", "a") = invalid) + BTT(BT_inputCmd("{" + Chr(34) + "op" + Chr(34) + ":5}", "a") = invalid)',
      // R: n mismatch at a position inside the sequence: different data per chunk, the odd chunk must not count
      '    st = BT_inputNew()',
      '    BT_inputFeed(st, EV("w", 0, 3, "a"), 0, tk)',
      '    BT_inputFeed(st, EV("w", 1, 3, "b"), 0, tk)',
      '    odd = BT_inputFeed(st, EV("w", 2, 4, "X"), 0, tk)',
      '    print "R:" + BTT(odd = invalid) + ":" + GOT(BT_inputFeed(st, EV("w", 2, 3, "c"), 0, tk))',
      // S: s and n must be canonical decimal strings
      '    st = BT_inputNew()',
      '    mk = function(s, n)',
      '        return { bt: "cn", tk: "' + TOKEN + '", s: s, n: n, d: "{}" }',
      '    end function',
      '    print "S:" + BTT(BT_inputFeed(st, mk("00", "1"), 0, tk) = invalid) + BTT(BT_inputFeed(st, mk("0", "01"), 0, tk) = invalid) + BTT(BT_inputFeed(st, mk(" 0", "1"), 0, tk) = invalid) + BTT(BT_inputFeed(st, mk("0", "1.0"), 0, tk) = invalid) + GOT(BT_inputFeed(st, mk("0", "1"), 0, tk))',
      // T: an empty configured token never matches, not even an empty incoming one
      '    st = BT_inputNew()',
      '    print "T:" + BTT(BT_inputFeed(st, EV("e", 0, 1, "{}", ""), 0, "") = invalid) + BTT(BT_inputTokenOk("", "") = false) + BTT(BT_inputTokenOk(tk, tk))',
      // U: chunk id limit is 32 characters
      '    st = BT_inputNew() : id32 = String(32, "a") : id33 = String(33, "a")',
      '    print "U:" + GOT(BT_inputFeed(st, EV(id32, 0, 1, "{}"), 0, tk)) + ":" + BTT(BT_inputFeed(st, EV(id33, 0, 1, "{}"), 0, tk) = invalid) + BTT(BT_inputFeed(st, EV("", 0, 1, "{}"), 0, tk) = invalid)',
      // Q: UTF-8 multibyte survives the hand-over string
      '    pk = BT_inputPack("mb", "caf" + Chr(233) + Chr(9731))',
      '    print "Q:" + pk.len().toStr().trim() + ":" + Mid(pk, 1, 3)',
    ].join('\n')
    out = await runBrs('recv', main)
  }, 60000)

  it('reassembles chunks that arrive out of order, completing only on the last', () => {
    expect(val(out, 'A')).toBe(`${N - 1}:${text.length}`)
    expect(val(out, 'B')).toBe(text)
    expect(val(out, 'B2')).toBe('k1')
  })
  it('duplicates do not double-apply; a replayed id is ignored while inside the last 32', () => {
    expect(val(out, 'C')).toBe('1')
    expect(val(out, 'C2')).toBe('id1={},-')
  })
  it('never completes a sequence with a missing chunk, and drops it after the bounded wait', () => {
    expect(val(out, 'D')).toBe('0:1')
    expect(val(out, 'E')).toBe('0:1')
    expect(val(out, 'F')).toBe('1:0')
    expect(val(out, 'G')).toBe('true')
    expect(val(out, 'H2')).toBe('1:false')
  })
  it('the wait slides: a spaced-out sequence completes', () => {
    expect(val(out, 'H')).toBe('true')
  })
  it('rejects s >= n, n above the cap, n changing mid-sequence; a duplicate keeps the first data', () => {
    expect(val(out, 'I')).toBe('truetruetruetruetruetrue')
    expect(val(out, 'J')).toBe('true:m=abc')
    expect(val(out, 'K')).toBe('d=first-end')
  })
  it('a wrong, missing, shorter, longer or empty token drops silently with no state', () => {
    expect(val(out, 'L')).toBe('true:0:0:t={}')
  })
  it('n=1 takes no pending slot; the cap evicts the oldest; junk cannot block', () => {
    expect(val(out, 'M')).toBe('single={}:8:true')
    expect(val(out, 'N')).toBe('8:false:true:real=abcd')
  })
  it('forces seq 0 and defaults the id to the chunk id; malformed commands are ignored', () => {
    expect(val(out, 'O')).toBe('ping:0:cid9')
    expect(val(out, 'O2')).toBe('own')
    expect(val(out, 'P')).toBe('truetruetruetrue')
  })
  it('rejects an n that changes at a later position, and non-canonical s and n', () => {
    expect(val(out, 'R')).toBe('true:w=abc')
    expect(val(out, 'S')).toBe('truetruetruetruecn={}')
  })
  it('an empty configured token never matches; chunk ids are limited to 32 characters', () => {
    expect(val(out, 'T')).toBe('truetruetrue')
    expect(val(out, 'U')).toBe(`${'a'.repeat(32)}={}:truetrue`)
  })
  it('keeps multibyte text in the packed hand-over', () => {
    expect(val(out, 'Q')).toBe('8:mb' + String.fromCharCode(10).slice(0, 0))
  })
})

describe('agent apply half and ack queue (headless, fork engine)', () => {
  let out
  beforeAll(async () => {
    const main = [
      '    g = CreateObject("roSGNode", "Node")',
      '    g.addFields({ count: 3 })',
      '    ctx = { global: g, scene: CreateObject("roSGNode", "Node"), cfg: BT_config(), state: { subscribed: false } }',
      '    q = Chr(34)',
      '    body = "{" + q + "op" + q + ":" + q + "set" + q + "," + q + "seq" + q + ":99," + q + "args" + q + ":{" + q + "layer" + q + ":" + q + "global" + q + "," + q + "path" + q + ":" + q + "count" + q + "," + q + "value" + q + ":4}}"',
      '    r = BT_inputRun(BT_inputPack("cid1", body), ctx, "")',
      '    print "A:" + BTT(r.ok) + ":" + r.cmd.id + ":" + r.cmd.seq.toStr().trim() + ":" + r.last.phase + ":" + g.count.toStr().trim() + ":" + r.acks.count().toStr().trim()',
      // the same command twice applies twice here (dedupe is the receiver's job, by chunk id); a bad value reports not ok
      '    bad = Left(body, Len(body) - 3) + q + "x" + q + "}}"',
      '    r2 = BT_inputRun(BT_inputPack("cid2", bad), ctx, "")',
      '    print "B:" + BTT(r2.ok) + ":" + g.count.toStr().trim()',
      '    print "C:" + BTT(BT_inputRun("nolinefeed", ctx, "") = invalid) + BTT(BT_inputRun(BT_inputPack("c", "{}"), ctx, "") = invalid)',
      // the reflected phase: asked for and the op worked; a failing op stays applied
      '    rf = "{" + q + "op" + q + ":" + q + "set" + q + "," + q + "ack" + q + ":" + q + "reflected" + q + "," + q + "args" + q + ":{" + q + "layer" + q + ":" + q + "global" + q + "," + q + "path" + q + ":" + q + "count" + q + "," + q + "value" + q + ":5}}"',
      '    r3 = BT_inputRun(BT_inputPack("cid3", rf), ctx, "")',
      '    r4 = BT_inputRun(BT_inputPack("cid4", Left(rf, Len(rf) - 3) + q + "x" + q + "}}"), ctx, "")',
      '    print "H:" + r3.last.phase + ":" + BTT(r3.last.ok) + ":" + r4.last.phase + ":" + BTT(r4.last.ok)',
      // ack queue: dropped without a live hub, bounded with one
      '    qq = []',
      '    BT_wQueueAcks(qq, ["a", "b"], false, 3)',
      '    print "D:" + qq.count().toStr().trim()',
      '    for i = 1 to 5',
      '        BT_wQueueAcks(qq, [i.toStr().trim()], true, 3)',
      '    end for',
      '    print "E:" + qq.count().toStr().trim() + ":" + qq[0] + qq[2]',
      // the Label carries the last mailbox result
      '    lj = ParseJson(BT_labelJson(1, g, ctx.scene, BT_config(), 0, r.last))',
      '    print "F:" + lj.input.id + ":" + lj.input.phase + ":" + BTT(lj.input.ok)',
      '    print "G:" + BTT(ParseJson(BT_labelJson(1, g, ctx.scene, BT_config(), 0)).input = invalid)',
    ].join('\n')
    out = await runBrs('apply', main)
  }, 60000)
  it('applies a command with forced seq 0 and the chunk id as default id', () => {
    expect(val(out, 'A')).toBe('true:cid1:0:applied:4:2')
    expect(val(out, 'B')).toBe('false:4')
    expect(val(out, 'C')).toBe('truetrue')
  })
  it('reports the reflected phase only when asked for and the op worked', () => {
    expect(val(out, 'H')).toBe('reflected:true:applied:false')
  })
  it('queues no acks without a live hub and bounds the queue with one', () => {
    expect(val(out, 'D')).toBe('0')
    expect(val(out, 'E')).toBe('3:35')
  })
  it('publishes the last mailbox result in the Label, and nothing before one', () => {
    expect(val(out, 'F')).toBe('cid1:applied:true')
    expect(val(out, 'G')).toBe('true')
  })
})

describe('agent wiring (template check; the thread hand-over needs a device)', () => {
  const RT = path.resolve(__dirname, '../lib/instrument/runtime/components/bt')
  const rd = (f) => fs.readFileSync(path.join(RT, f), 'utf8')
  it('icmd and acks notify on every set, the Task gates on the token and on no live hub session', () => {
    const xml = rd('BT_AgentTask.xml')
    expect(xml).toMatch(/id="icmd"[^>]*alwaysNotify="true"/)
    expect(xml).toMatch(/id="acks"[^>]*alwaysNotify="true"/)
    const task = rd('BT_AgentTask.brs')
    expect(task).toContain('CreateObject("roInput")')
    expect(task).toMatch(/if session = "" then\s+done = BT_inputFeed\(inbox, msg\.GetInfo\(\), clock\.TotalMilliseconds\(\), cfg\.token\)/)
    expect(task).toContain('msg.getData()')
    expect(rd('BT_Agent.brs')).toContain('BT_inputRun(ev.getData()')
  })
})
