import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

// STA-S-T1b: registry layer end to end, headless on the fork engine. The BT_config body comes from the real
// renderBtConfig (build.js emit), the registry is written with roRegistrySection, and BT_labelJson publishes the layer.
// Device behavior (Label read over ECP) is not covered here; that is STA-S-T4.
const require = createRequire(import.meta.url)
const { renderBtConfig } = require('../../lib/instrument/build')
const brsCli = path.resolve(__dirname, '../../node_modules/.bin/brs-cli')
const CORE = fs.readFileSync(path.resolve(__dirname, '../../lib/instrument/runtime/source/bt/BT_core.brs'), 'utf8')
  .split('\n').filter((l) => !l.startsWith('#')).join('\n')

let tmp
beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-state-')) })
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

const configBody = (instrument) => renderBtConfig('0'.repeat(32), instrument)
  .split('\n').filter((l) => !l.startsWith('#')).join('\n')

function run(name, instrument, writes) {
  const main = [
    ...writes,
    '    raw = BT_labelJson(1, "G", invalid, BT_config(), 0)',
    '    print "B:" + Len(raw).toStr()',
    '    print "J:" + raw',
  ].join('\n')
  const file = path.join(tmp, name + '.brs')
  fs.writeFileSync(file, `${configBody(instrument)}\n${CORE}\nsub main()\n${main}\nend sub\n`)
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [brsCli, file], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), 30000)
    child.stdout.on('data', (d) => { out += d }); child.stderr.on('data', (d) => { out += d })
    child.on('close', () => {
      clearTimeout(timer)
      const line = out.split(/\r?\n/).find((l) => l.startsWith('J:'))
      resolve({ out, bytes: Number((out.match(/^B:(\d+)/m) || [])[1]), doc: line ? JSON.parse(line.slice(2)) : null })
    })
  })
}
const W = (sec, key, val) => `    s = CreateObject("roRegistrySection", "${sec}") : s.Write("${key}", ${val}) : s.Flush()`

describe('registry layer (headless)', () => {
  it('publishes configured sections as registry.<section>.<key>, structured when the value is JSON', async () => {
    const r = await run('ok', { state: { registrySections: ['prefs'] } }, [
      W('prefs', 'theme', '"dark"'), W('prefs', 'list', '"[1,2]"'), W('other', 'x', '"hidden"'),
    ])
    expect(r.doc).not.toBeNull()
    expect(r.doc.snapshot.layers.registry).toEqual({ prefs: { list: [1, 2], theme: 'dark' } })
    expect(Object.keys(r.doc.snapshot.layers).sort()).toEqual(['focus', 'global', 'registry', 'scene'])
  })

  it('redacts a sensitive key as <redacted:key>', async () => {
    const r = await run('redact', { state: { registrySections: ['auth'] } }, [W('auth', 'access_token', '"abc123"'), W('auth', 'user', '"u1"')])
    const reg = r.doc.snapshot.layers.registry
    expect(reg.auth.access_token).toBe('<redacted:access_token>')
    expect(reg.auth.user).toBe('u1')
    expect(r.out).not.toContain('abc123')
    expect(r.out).not.toContain('ERROR')
  })

  it('cuts to maxBytes with a $truncated:bytes marker, valid JSON, no error', async () => {
    const writes = []
    for (let i = 1; i <= 60; i++) writes.push(W('blob', 'k' + i, 'string(1500, "z")'))
    const r = await run('cap', { state: { registrySections: ['blob'], caps: { stringBytes: 4000 } } }, writes)
    expect(r.doc).not.toBeNull()
    expect(r.bytes).toBeLessThanOrEqual(65536)
    expect(r.doc.snapshot.layers.registry.blob).toBe('$truncated:bytes')
    expect(r.doc.truncated).toContain('registry.blob:bytes')
  })

  it('no sections: no registry layer, the other layers keep their shape', async () => {
    const r = await run('none', {}, [W('prefs', 'theme', '"dark"')])
    expect(Object.keys(r.doc.snapshot.layers).sort()).toEqual(['focus', 'global', 'scene'])
    const r2 = await run('empty', { state: { registrySections: [] } }, [])
    expect(Object.keys(r2.doc.snapshot.layers).sort()).toEqual(['focus', 'global', 'scene'])
  })
})
