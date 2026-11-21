import { describe, it, expect, afterEach } from 'vitest'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLogs, assertLog, expectNoLog, parseBacktrace, stripAnsi, writeFailureBundle } from '../lib/e2e/logs.js'
import { parseFlow } from '../lib/e2e/flow.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const cleanup = []
afterEach(() => { while (cleanup.length) cleanup.pop()() })

// Fake 8085: writes `greeting` on connect; `sockets` lets a test push more bytes.
async function fakeConsole(greeting = '') {
  const sockets = []
  const server = net.createServer((s) => { sockets.push(s); s.on('error', () => {}); if (greeting) s.write(greeting) })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  cleanup.push(() => { sockets.forEach((s) => s.destroy()); server.close() })
  return { port: server.address().port, write: (t) => sockets.forEach((s) => s.write(t)), sockets }
}

async function reader(fake, o = {}) {
  const logs = createLogs('127.0.0.1', { port: fake.port, replayIdleMs: 40, flushMs: 250, ...o })
  cleanup.push(() => logs.close())
  const r = await logs.connect()
  expect(r.ok).toBe(true)
  return logs
}

describe('log reader', () => {
  it('discards replayed history and keeps only live lines', async () => {
    const f = await fakeConsole('old one\r\nold two\r\n')
    const logs = await reader(f)
    await sleep(120) // replay burst ends at the first idle gap
    logs.beginFlow()
    f.write('live a\r\nlive b\r\n')
    await sleep(40)
    expect(logs.lines().map((l) => l.text)).toEqual(['live a', 'live b'])
    expect(logs.all().map((l) => l.text)).toContain('old one') // still in the ring, hidden from the flow
  })

  it('hides everything until the replay burst has ended', async () => {
    const f = await fakeConsole('h1\r\nh2\r\n')
    const logs = await reader(f, { replayIdleMs: 200 })
    await sleep(30)
    expect(logs.lines()).toEqual([])
  })

  it('flushes a partial line after 250 ms, not before', async () => {
    const f = await fakeConsole()
    const logs = await reader(f)
    await sleep(100)
    logs.beginFlow()
    f.write('PARTIAL')
    await sleep(120)
    expect(logs.lines()).toEqual([])
    await sleep(200)
    expect(logs.lines().map((l) => l.text)).toEqual(['PARTIAL'])
  })

  it('strips ANSI escapes', async () => {
    const f = await fakeConsole()
    const logs = await reader(f)
    await sleep(100)
    logs.beginFlow()
    f.write('\u001b[31mRED\u001b[0m text\r\n')
    await sleep(40)
    expect(logs.lines()[0].text).toBe('RED text')
    expect(stripAnsi('\u001b[1;32mok\u001b[0m')).toBe('ok')
  })

  it('numbers lines with a monotonic seq and caps the ring', async () => {
    const f = await fakeConsole('a\r\nb\r\n')
    const logs = await reader(f, { ringSize: 4 })
    await sleep(100)
    f.write('c\r\nd\r\ne\r\nf\r\n')
    await sleep(40)
    const seqs = logs.all().map((l) => l.seq)
    expect(seqs).toEqual([3, 4, 5, 6])
    expect(logs.lines(4).map((l) => l.text)).toEqual(['e', 'f'])
  })

  it('reassembles lines split across chunks', async () => {
    const f = await fakeConsole()
    const logs = await reader(f)
    await sleep(100)
    logs.beginFlow()
    f.write('hel'); await sleep(20); f.write('lo\r\nwor'); await sleep(20); f.write('ld\r\n')
    await sleep(40)
    expect(logs.lines().map((l) => l.text)).toEqual(['hello', 'world'])
  })

  it('Debugger prompt is a crash with a parsed backtrace', async () => {
    const f = await fakeConsole()
    const logs = await reader(f)
    await sleep(100)
    logs.beginFlow()
    f.write([
      '------ Runtime Error: Type Mismatch. (runtime error &h18) in pkg:/components/Home.brs(42)',
      'Backtrace:', '#0  Function onKey(key as String) As Boolean', '   file/line: pkg:/components/Home.brs(42)',
      'Brightscript Debugger> ',
    ].join('\r\n'))
    await sleep(40) // far below the 250 ms flush: the prompt is recognized immediately
    const c = logs.crash()
    expect(c.backtrace.location).toBe('pkg:/components/Home.brs(42)')
    expect(c.summary).toMatch(/Type Mismatch.*Home\.brs\(42\)/)
  })

  it('a second client refusal is reported clearly', async () => {
    const f = await fakeConsole('Console connection is already in use.\r\n')
    const logs = await reader(f)
    await sleep(80)
    expect(logs.error).toMatch(/already in use.*8085/)
    await expect(assertLog(logs, 'x', 100)).rejects.toThrow(/already in use/)
  })

  it('connect failure resolves with an error instead of hanging', async () => {
    const f = await fakeConsole(); const port = f.port
    f.sockets.length = 0
    const dead = net.createServer(); await new Promise((r) => dead.listen(0, '127.0.0.1', r)); const p = dead.address().port; dead.close()
    const logs = createLogs('127.0.0.1', { port: p, connectTimeoutMs: 500 })
    const r = await logs.connect()
    expect(r.ok).toBe(false)
    expect(logs.error).toMatch(/8085/)
    await expect(assertLog(logs, 'x', 50)).rejects.toThrow(/unavailable/)
    expect(port).toBeGreaterThan(0)
  })
})

describe('assertLog / expectNoLog', () => {
  it('assertLog matches a live line (string and /regex/) and times out otherwise', async () => {
    const f = await fakeConsole()
    const logs = await reader(f)
    await sleep(100)
    logs.beginFlow()
    setTimeout(() => f.write('FakeApp: live line 3\r\n'), 30)
    expect((await assertLog(logs, 'live line 3', 1000)).detail).toMatch(/seq/)
    await assertLog(logs, '/live line \\d/', 200)
    await expect(assertLog(logs, 'never here', 100)).rejects.toThrow(/not seen within/)
  })

  it('expectNoLog fails on a match and passes otherwise', async () => {
    const f = await fakeConsole()
    const logs = await reader(f)
    await sleep(100)
    logs.beginFlow()
    f.write('fine\r\n'); await sleep(40)
    expectNoLog(logs, 'ERROR')
    f.write('ERROR: bad\r\n'); await sleep(40)
    expect(() => expectNoLog(logs, 'ERROR')).toThrow(/expectNoLog.*matched seq \d+.*ERROR: bad/)
  })

  it('assertLog fails fast with the crash when the app drops into the debugger', async () => {
    const f = await fakeConsole()
    const logs = await reader(f)
    await sleep(100)
    logs.beginFlow()
    setTimeout(() => f.write('Brightscript Debugger> '), 30)
    await expect(assertLog(logs, 'never', 3000)).rejects.toThrow(/app crashed first/)
  })
})

describe('parseBacktrace', () => {
  it('returns null without an error', () => { expect(parseBacktrace(['hello', 'world'])).toBeNull() })
  it('parses frames, message, code and location', () => {
    const bt = parseBacktrace([
      'BRIGHTSCRIPT: ERROR: roSGNode.setField: Type Mismatch. (runtime error &h18) in pkg:/components/Home.brs(42)',
      '------ Runtime Error: Type Mismatch. (runtime error &h18) in pkg:/components/Home.brs(42)',
      'Backtrace:', '#1  Function inner() As Void', '   file/line: pkg:/a.brs(7)', '#0  Function onKey(key as String) As Boolean', '   file/line: pkg:/components/Home.brs(42)',
      'Local Variables:',
    ])
    expect(bt).toMatchObject({ message: 'Type Mismatch', code: '&h18', file: 'pkg:/components/Home.brs', line: 42 })
    expect(bt.frames).toEqual([
      { index: 1, fn: 'inner() As Void', file: 'pkg:/a.brs', line: 7 },
      { index: 0, fn: 'onKey(key as String) As Boolean', file: 'pkg:/components/Home.brs', line: 42 },
    ])
  })
  it('keeps a clean message when the banner has a period before the code (no "&hec)" garble)', () => {
    const bt = parseBacktrace(['BRIGHTSCRIPT: ERROR: Runtime Error. (runtime error &hec) in pkg:/components/scenes/LegacyScene.brs(95)'])
    expect(bt.code).toBe('&hec')
    expect(bt.summary).toBe('Runtime Error (runtime error &hec) at pkg:/components/scenes/LegacyScene.brs(95)')
    expect(bt.summary).not.toMatch(/^&hec\)/)
    const bt2 = parseBacktrace(['------ Runtime Error. (runtime error &hec) in pkg:/a.brs(95)'])
    expect(bt2.summary).toMatch(/^runtime error \(runtime error &hec\) at pkg:\/a\.brs\(95\)$/)
  })
})

describe('failure bundle and flow parsing', () => {
  it('writes error.json, log-tail.txt (last N) and screenshot-error.json', async () => {
    const f = await fakeConsole('a\r\nb\r\nc\r\n')
    const logs = await reader(f)
    await sleep(100)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-bundle-'))
    cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }))
    await writeFailureBundle(path.join(dir, 'b'), { flow: 'x', step: { op: 'assertVisible', line: 3 }, error: new Error('boom'), logs, shot: { error: 'no shot' }, tailLines: 2 })
    expect(fs.readFileSync(path.join(dir, 'b', 'log-tail.txt'), 'utf8').trim().split('\n')).toEqual(['2\tb', '3\tc'])
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'b', 'error.json'), 'utf8')).message).toBe('boom')
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'b', 'screenshot-error.json'), 'utf8')).error).toBe('no shot')
    logs.writeArtifact(path.join(dir, 'flow.log'))
    expect(fs.existsSync(path.join(dir, 'flow.log'))).toBe(true)
  })

  it('parses assertLog / expectNoLog steps', () => {
    const flow = parseFlow('steps:\n  - assertLog: "live line 3"\n  - assertLog: { pattern: "/ok/", timeout: 4 }\n  - expectNoLog: ERROR\n')
    expect(flow.steps).toMatchObject([
      { op: 'assertLog', pattern: 'live line 3' }, { op: 'assertLog', pattern: '/ok/', timeout: 4 }, { op: 'expectNoLog', pattern: 'ERROR' },
    ])
    expect(() => parseFlow('steps:\n  - assertLog\n')).toThrow(/unknown step/)
    expect(() => parseFlow('steps:\n  - expectNoLog: ""\n')).toThrow(/needs a pattern/)
  })
})
