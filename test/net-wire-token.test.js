import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createRequire } from 'node:module'

// NET-WIRE: `instrument build --net` bakes the same token the e2e LAN hub accepts (BRIGHTTEST_HUB_TOKEN).
const require = createRequire(import.meta.url)
const JSZip = require('jszip')
const { build } = require('../lib/instrument/build')
const hubMod = require('../lib/instrument/hub')
const { loadConfig } = require('../lib/config')
const { parseInstrumentArgs } = require('../bin/cli')

const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
let tmp
beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-netwire-')) })
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

function mkapp(name) {
  const dir = path.join(tmp, name)
  fs.mkdirSync(path.join(dir, 'source'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'manifest'), 'title=t\nmajor_version=1\nminor_version=0\nbuild_version=1\n')
  fs.writeFileSync(path.join(dir, 'source/main.brs'), 'sub main()\nend sub\n')
  return dir
}
const runBuild = (name, opts) => {
  const dir = mkapp(name); const lines = []
  const out = path.join(tmp, name + '.zip')
  return build({ ...loadConfig(dir), stagingDir: path.join(tmp, 'stage-' + name) }, { log: (l) => lines.push(l), out, ...opts }).then((r) => ({ ...r, lines, zip: out }))
}
const get = (port, p) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: p }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)) }).on('error', reject)
})

describe('NET-WIRE token', () => {
  it('parses --net', () => {
    expect(parseInstrumentArgs(['build', '--net'])).toMatchObject({ net: true })
    expect(parseInstrumentArgs(['build']).net).toBe(false)
  })

  it('bakes the env token and the LAN hub accepts it alongside its own', async () => {
    const r = await runBuild('ok', { net: true, env: { [hubMod.HUB_TOKEN_ENV]: TOKEN } })
    expect(r.exitCode).toBe(0)
    const z = await JSZip.loadAsync(fs.readFileSync(r.zip))
    const baked = /token:\s*"([0-9a-f]{32})"/.exec(await z.file('source/bt/BT_config.brs').async('string'))[1]
    expect(baked).toBe(TOKEN)
    expect(r.lines.join('\n')).not.toContain(TOKEN)

    const lease = { leaseId: 'l1', lost: false, expired: false, onLost: null, onExpire: null }
    const hub = await hubMod.startLanHub({
      deviceHost: '192.168.1.50', lease, tokens: ['run-own-token'], bindHost: '127.0.0.1',
      peerOf: () => '192.168.1.50', env: { [hubMod.HUB_TOKEN_ENV]: TOKEN },
    })
    try {
      expect(await get(hub.port, `/bt/${baked}/hello`)).not.toBe(404)
      expect(await get(hub.port, '/bt/ffffffffffffffffffffffffffffffff/hello')).toBe(404)
    } finally { await hub.stop() }
  })

  it.each([[undefined], [''], ['short'], ['A1B2C3D4E5F60718293A4B5C6D7E8F90']])('fails fast with no usable token (%s)', async (v) => {
    const env = v === undefined ? {} : { [hubMod.HUB_TOKEN_ENV]: v }
    const r = await runBuild('bad' + String(v).length, { net: true, env })
    expect(r.exitCode).toBe(1)
    expect(r.out).toBeNull()
    expect(r.lines.join('\n')).toContain('BRIGHTTEST_HUB_TOKEN')
    expect(fs.existsSync(r.zip)).toBe(false)
  })

  it('without --net the token stays random and the env is ignored', async () => {
    const r = await runBuild('plain', { env: { [hubMod.HUB_TOKEN_ENV]: TOKEN } })
    const z = await JSZip.loadAsync(fs.readFileSync(r.zip))
    expect(/token:\s*"([0-9a-f]{32})"/.exec(await z.file('source/bt/BT_config.brs').async('string'))[1]).not.toBe(TOKEN)
  })
})
