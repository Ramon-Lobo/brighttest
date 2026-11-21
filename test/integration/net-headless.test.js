import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeProject, runCli, readFile, exists, cleanupTemp } from './helpers.js'

// NET-N-T5: headless lane wiring for `net` (config fixtures, --net-record, --net-unmatched, run NDJSON).
// Everything talks to 127.0.0.1 only: the "origin" is an in-process http server. The CLI runs async here so
// that server keeps answering while the simulator runs.
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'cli.js')

function runAsync(dir, args = [], timeoutMs = 110000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.on('error', reject)
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, output: out }) })
  })
}

function spec(name, url, expected, matcher = 'assertEqual') {
  return [
    'namespace tests',
    `  @suite("${name}")`,
    `  class ${name}Tests extends rooibos.BaseTestSuite`,
    '    @describe("net")',
    '    @it("fetches")',
    '    function _()',
    `      m.${matcher}(fetchText("${url}"), ${expected})`,
    '    end function',
    '  end class',
    'end namespace',
    '',
  ].join('\n')
}

const ndjson = (dir) => readFile(dir, '.brighttest/net/last-run.ndjson').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))

afterAll(cleanupTemp)

describe('config fixtures serve mocks in the fast lane and write the run NDJSON', () => {
  let res, dir
  beforeAll(async () => { dir = makeProject('net-headless'); res = await runAsync(dir, ['--no-sgnode']) })

  it('passes against the fixture rules, no network involved', () => {
    expect(res.status).toBe(0)
    expect(res.output).toContain('✓ fixtures > serves the mocked home feed')
    expect(res.output).toContain('1 passed, 0 failed')
  })

  it('writes .brighttest/net/last-run.ndjson with request and response events', () => {
    const ev = ndjson(dir)
    expect(ev.map((e) => e.kind)).toEqual(['net.request', 'net.response'])
    expect(ev[0].data.lane).toBe('headless')
    expect(ev[1].data.source).toBe('fixture')
  })
})

describe('the scene lane (--coverage) serves the same fixtures', () => {
  it('passes and writes the NDJSON', async () => {
    const dir = makeProject('net-headless')
    const res = await runAsync(dir, ['--coverage'])
    expect(res.status).toBe(0)
    expect(res.output).toContain('1 passed, 0 failed')
    expect(exists(dir, '.brighttest/net/last-run.ndjson')).toBe(true)
  })
})

describe('unmatched requests fail by default and are listed in the summary', () => {
  it('answers 599 and prints the network failures', async () => {
    const dir = makeProject('net-headless')
    fs.writeFileSync(path.join(dir, 'source/tests/Feed.spec.bs'), spec('feed', 'https://api.example.com/v1/other', '"no rule matched"', 'assertStringContains'))
    const res = await runAsync(dir, ['--no-sgnode'])
    expect(res.output).toContain('Network failures (1)')
    expect(res.output).toContain('unmatched: GET https://api.example.com/v1/other')
    expect(ndjson(dir).some((e) => e.kind === 'net.error' && e.data.kind === 'unmatched')).toBe(true)
  })

  it('--net-unmatched passthrough without an allow-list is refused, not fetched', async () => {
    const dir = makeProject('net-headless')
    fs.writeFileSync(path.join(dir, 'source/tests/Feed.spec.bs'), spec('feed', 'http://127.0.0.1:9/x', '"x"', 'assertNotInvalid'))
    const res = await runAsync(dir, ['--no-sgnode', '--net-unmatched', 'passthrough'])
    const ev = ndjson(dir)
    expect(ev.some((e) => e.kind === 'net.error' && e.data.kind === 'upstream' && /refused/.test(e.data.detail))).toBe(true)
    expect(res.output).toContain('Network failures')
  })
})

describe('--net-record records a redacted HAR from a local origin that replays offline', () => {
  let origin, port, dir, harFile
  beforeAll(async () => {
    origin = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'sid=abc' }); res.end('{"ok":true}') })
    await new Promise((r) => origin.listen(0, '127.0.0.1', r))
    port = origin.address().port
  })
  afterAll(async () => { await new Promise((r) => origin.close(r)) })

  it('records, then replays green with the origin down', async () => {
    dir = makeProject('net-headless')
    const url = `http://127.0.0.1:${port}/v1/live`
    fs.writeFileSync(path.join(dir, 'source/tests/Feed.spec.bs'), spec('feed', url, '"{""ok"":true}"'))
    const cfg = JSON.parse(readFile(dir, 'brighttest.json'))
    cfg.instrument.net.fixtures = ['fixtures/net/feed.rules.json']
    cfg.instrument.net.upstreamHosts = [`127.0.0.1:${port}`]
    fs.writeFileSync(path.join(dir, 'brighttest.json'), JSON.stringify(cfg))
    harFile = path.join(dir, 'fixtures/net/rec.har')
    const rec = await runAsync(dir, ['--no-sgnode', '--net-record', harFile])
    expect(rec.status).toBe(0)
    expect(rec.output).toContain(`upstream hosts: 127.0.0.1:${port}`)
    const har = JSON.parse(fs.readFileSync(harFile, 'utf8'))
    expect(har.log.entries.length).toBe(1)
    expect(JSON.stringify(har)).not.toContain('sid=abc')

    await new Promise((r) => origin.close(r))
    cfg.instrument.net.fixtures = ['fixtures/net/rec.har']
    delete cfg.instrument.net.upstreamHosts
    fs.writeFileSync(path.join(dir, 'brighttest.json'), JSON.stringify(cfg))
    const replay = await runAsync(dir, ['--no-sgnode'])
    expect(replay.status).toBe(0)
    expect(replay.output).toContain('1 passed, 0 failed')
    origin = http.createServer().listen(0, '127.0.0.1') // keep the afterAll close valid
  })

  it('--net-record without upstreamHosts is a usage error (exit 2)', async () => {
    const d = makeProject('net-headless')
    const res = await runAsync(d, ['--no-sgnode', '--net-record'])
    expect(res.status).toBe(2)
    expect(res.output).toContain('upstreamHosts')
  })
})

describe('net flags are headless-only', () => {
  it('--device with --net-record exits 2 before touching a device', () => {
    const r = runCli(makeProject('net-headless'), ['--device', '--net-record'])
    expect(r.status).toBe(2)
    expect(r.output).toContain('headless lanes only')
  })

  it('a bad --net-unmatched value exits 2', () => {
    const r = runCli(makeProject('net-headless'), ['--net-unmatched', 'maybe'])
    expect(r.status).toBe(2)
  })
})
