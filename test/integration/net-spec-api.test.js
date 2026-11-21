import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeProject, readFile, cleanupTemp } from './helpers.js'

// NET-N-T6: the BTNet_* per-test spec API (mock, fault, useFixture, requests, reset) in the headless lanes.
// Everything talks to 127.0.0.1: the "origin" below is an in-process http server, the hub is the CLI's own.
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

const ndjson = (dir) => readFile(dir, '.brighttest/net/last-run.ndjson').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))

afterAll(cleanupTemp)

describe('BTNet_ spec suite on the fast lane', () => {
  let res, dir
  beforeAll(async () => { dir = makeProject('net-spec-api'); res = await runAsync(dir, ['--no-sgnode']) })

  it('passes every per-test API case', () => {
    expect(res.status).toBe(0)
    expect(res.output).toContain('8 passed, 0 failed')
    for (const name of ['mocks a JSON response', 'plays a response sequence', 'times limits', 'injects a status fault', 'logs requests since the reset', 'loads a rules file']) {
      expect(res.output).toContain(`✓ BTNet_ per-test API > ${name}`)
    }
  })

  it('records mocks, faults and unmatched requests in the run NDJSON', () => {
    const ev = ndjson(dir)
    expect(ev.some((e) => e.kind === 'net.response' && e.data.source === 'mock')).toBe(true)
    expect(ev.some((e) => e.kind === 'net.response' && e.data.status === 503)).toBe(true)
    expect(ev.filter((e) => e.kind === 'net.error' && e.data.kind === 'unmatched')).toHaveLength(2)
  })
})

describe('BTNet_ spec suite on the scene lane (--coverage)', () => {
  it('passes the same cases', async () => {
    const dir = makeProject('net-spec-api')
    const res = await runAsync(dir, ['--coverage'])
    expect(res.status).toBe(0)
    expect(res.output).toContain('8 passed, 0 failed')
  })
})

describe('a BTNet_ rule can send one request upstream to a loopback fake and the log shows it', () => {
  let origin, port
  beforeAll(async () => {
    origin = http.createServer((req, res) => { res.writeHead(201, { 'content-type': 'text/plain' }); res.end('upstream-ok') })
    await new Promise((r) => origin.listen(0, '127.0.0.1', r))
    port = origin.address().port
  })
  afterAll(async () => { await new Promise((r) => origin.close(r)) })

  it('passthrough rule reaches the fake, status and source are logged', async () => {
    const dir = makeProject('net-spec-api')
    fs.rmSync(path.join(dir, 'source/tests/NetApi.spec.bs'))
    const url = `http://127.0.0.1:${port}/v1/live`
    fs.writeFileSync(path.join(dir, 'source/tests/Live.spec.bs'), [
      'namespace tests',
      '  @suite("live")',
      '  class LiveTests extends rooibos.BaseTestSuite',
      '    @describe("passthrough")',
      '    @beforeEach',
      '    function reset()',
      '      BTNet_reset()',
      '    end function',
      '    @it("reaches the loopback fake")',
      '    function _()',
      `      BTNet_mock({ url: "${url}", passthrough: true })`,
      `      m.assertEqual(fetchText("${url}"), "upstream-ok")`,
      '      reqs = BTNet_requests()',
      '      m.assertEqual(reqs.count(), 1)',
      '      m.assertEqual(reqs[0].status, 201)',
      '      m.assertEqual(reqs[0].source, "passthrough")',
      '    end function',
      '  end class',
      'end namespace',
      '',
    ].join('\n'))
    const cfg = JSON.parse(readFile(dir, 'brighttest.json'))
    cfg.instrument.net.upstreamHosts = [`127.0.0.1:${port}`]
    fs.writeFileSync(path.join(dir, 'brighttest.json'), JSON.stringify(cfg))
    const res = await runAsync(dir, ['--no-sgnode'])
    expect(res.output).toContain('1 passed, 0 failed')
    expect(res.status).toBe(0)
  })
})
