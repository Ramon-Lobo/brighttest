import { describe, it, expect, afterEach } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { studioStartOptions, parseStudioArgs } = require('../bin/cli')

describe('brighttest studio passes the raw host and password', () => {
  it('without --host the server gets no host, so it never receives a CLI-chosen cached device', () => {
    const o = studioStartOptions(parseStudioArgs([]), { port: 8700 })
    expect(o.host).toBeFalsy()
    expect(o.password).toBeFalsy()
  })
  it('passes --host and --password through untouched', () => {
    const o = studioStartOptions(parseStudioArgs(['--host', '192.0.2.9', '--password', 'x']), { port: 1 })
    expect(o).toMatchObject({ host: '192.0.2.9', password: 'x', port: 1 })
  })
})

describe('brighttest studio --as', () => {
  it('becomes the lease holder label; absent leaves leaseOpts unset', () => {
    expect(studioStartOptions(parseStudioArgs(['--as', 'dev#2']), {}).leaseOpts).toEqual({ acquireOpts: { agent: 'dev#2' } })
    expect(studioStartOptions(parseStudioArgs(['--as=qa:1']), {}).leaseOpts.acquireOpts.agent).toBe('qa:1')
    expect(studioStartOptions(parseStudioArgs([]), {}).leaseOpts).toBeUndefined()
  })
})

describe('brighttest studio --simulator', () => {
  const { studioExitCode, studioTargetLabel } = require('../bin/cli')
  const engines = require('../lib/engines')
  const os = require('node:os')
  const fs = require('node:fs')
  const path = require('node:path')
  const { spawnSync } = require('node:child_process')
  const made = []
  afterEach(() => { for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })
  const runStudio = (args) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-sim-cli-')); made.push(cwd)
    return spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'cli.js'), 'studio', ...args], { cwd, encoding: 'utf8', timeout: 30000 })
  }

  it('parses the flag and passes it to the server', () => {
    expect(parseStudioArgs([]).simulator).toBe(false)
    const o = parseStudioArgs(['--simulator', '--port', '9000'])
    expect(o.simulator).toBe(true)
    expect(studioStartOptions(o, { port: 1 }).simulator).toBe(true)
    expect(studioStartOptions(parseStudioArgs([]), {}).simulator).toBe(false)
  })
  it('--simulator with --host exits 2 and says why', () => {
    const r = runStudio(['--simulator', '--host', '1.2.3.4'])
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('--simulator cannot be combined with --host')
  })
  it('--simulator=<value> is a usage error, never a silent device-mode start', () => {
    const r = runStudio(['--simulator=true'])
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('takes no value')
    expect(parseStudioArgs(['--simulator=false']).simulator).toBe(false)
  })
  it('--password with --simulator warns on stderr', () => {
    const r = runStudio(['--simulator', '--password', 'x', '--host', '1.2.3.4'])
    expect(r.stderr).toContain('--password is ignored with --simulator')
    expect(r.stderr).not.toContain('--password x')
  })
  it('maps USAGE and a missing UI bundle to exit 2, other failures to 1', () => {
    expect(studioExitCode(Object.assign(new Error('x'), { code: 'USAGE' }))).toBe(2)
    expect(studioExitCode(Object.assign(new Error('x'), { code: 'UI_NOT_BUILT' }))).toBe(2)
    expect(studioExitCode(Object.assign(new Error('x'), { code: 'EADDRINUSE' }))).toBe(1)
    expect(studioExitCode(new Error('x'))).toBe(1)
  })
  it('a missing stock engine exits 1 with the npm i brs-node hint', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-sim-noeng-'))
    let err
    try { engines.resolveEngine('brsNode', 'stock', { paths: [empty] }) } catch (e) { err = e }
    expect(err.code).toBe('ENGINE_MISSING')
    expect(err.message).toContain('npm i brs-node')
    expect(studioExitCode(err)).toBe(1)
  })
  it('the banner names the resolved simulator engine and flavor, or the device', () => {
    const sim = { info: () => ({ engine: { name: 'brs-node', version: '2.7.0', flavor: 'stock', source: 'default' } }) }
    expect(studioTargetLabel({}, sim, () => { throw new Error('no device lookup') })).toBe('simulator brs-node@2.7.0 (stock)')
    expect(studioTargetLabel({ host: '192.0.2.9' }, null, () => ({}))).toBe('device 192.0.2.9')
  })
})
