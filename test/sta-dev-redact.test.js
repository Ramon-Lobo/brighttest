import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'

// STA-DEV-REDACT (headless, fork engine): instrument.state.redact.paths is applied to a wrapped dispatch payload on the
// device side (BT_dwEmit), and gives the same masked result as the host redact() used by Studio and the hub log.
const require = createRequire(import.meta.url)
const { redact } = require('../lib/instrument/events')
const brsCli = path.resolve(__dirname, '../node_modules/@ramonlobo/brs-node/bin/brs.cli.js')
const SRC = path.resolve(__dirname, '../lib/instrument/runtime/source')
const strip = (f) => fs.readFileSync(path.join(SRC, f), 'utf8').split('\n').filter((l) => !l.startsWith('#')).join('\n')
const RUNTIME = ['bt/BT_core.brs', 'bt/BT_write.brs', 'btop/BT_mOp.brs'].map(strip).join('\n')

const PAYLOAD = { user: { token: 'dummy-a', name: 'sample' }, card: ['one', 'two'], keep: { n: 1 } }
const PATHS = ['user.token', 'payload.card.*']
const BRS_PAYLOAD = '{ user: { token: "dummy-a", name: "sample" }, card: ["one", "two"], keep: { n: 1 } }'

let tmp
const run = async (name, cfgRedact) => {
  const body = `function BT_config() as object\n    return { token: "${'a'.repeat(32)}", hub: { host: "127.0.0.1", port: 1 }, caps: {}, publish: {}${cfgRedact} }\nend function\n${RUNTIME}\n` +
    `sub main()\n    g = CreateObject("roSGNode", "Node")\n    g.addFields({ "__btEv": "" })\n` +
    `    BT_dwEmit(g, "dispatchAction", { type: "t", payload: ${BRS_PAYLOAD} }, "h")\n` +
    `    print "E:" + BT_dwDrain(g, "s1")\nend sub\n`
  fs.writeFileSync(path.join(tmp, name), body)
  const child = spawn(process.execPath, [brsCli, '-r', '.', name], { cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  const timer = setTimeout(() => child.kill('SIGKILL'), 60000)
  child.stdout.on('data', (d) => { out += d })
  child.stderr.on('data', (d) => { out += d })
  await new Promise((resolve) => child.on('close', () => { clearTimeout(timer); resolve() }))
  const l = out.split(/\r?\n/).find((x) => x.startsWith('E:'))
  return JSON.parse(l.slice(2)).data.payload
}
let withCfg, noCfg
beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-dev-redact-'))
  withCfg = await run('a.brs', `, redact: { paths: ${JSON.stringify(PATHS)} }`) // a JSON array is a valid BrightScript literal
  noCfg = await run('b.brs', '')
}, 150000)
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

describe('device-side redact.paths on dispatch payloads', () => {
  it('masks the configured paths, both bare and payload-prefixed, and leaves other keys', () => {
    expect(withCfg.user.token).toBe('<redacted:token>')
    expect(withCfg.card).toEqual(['<redacted:0>', '<redacted:1>'])
    expect(withCfg.user.name).toBe('sample')
    expect(withCfg.keep).toEqual({ n: 1 })
  })
  it('without redact config only secret-looking keys are masked (today output)', () => {
    expect(noCfg.user.token).toBe('<redacted:token>') // built-in key rule
    expect(noCfg.card).toEqual(['one', 'two'])
  })
  it('matches the host redact() on the same payload and paths', () => {
    expect(withCfg).toEqual(redact({ payload: PAYLOAD }, PATHS.concat(['payload.user.token'])).payload)
    expect(redact(PAYLOAD, ['user.token']).user.token).toBe(withCfg.user.token)
    expect(redact({ payload: PAYLOAD }, PATHS).payload.card).toEqual(withCfg.card)
  })
})
