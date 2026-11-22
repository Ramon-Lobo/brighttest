import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

// NET-N-T14: observe-only 8085 breadcrumbs, headless on the fork engine. The BT_config body comes from the real
// renderBtConfig and BT_net.brs is the real runtime. Observe mode prints one line per BT_url call and never rewrites.
const require = createRequire(import.meta.url)
const { renderBtConfig } = require('../../lib/instrument/build')
const brsCli = path.resolve(__dirname, '../../node_modules/.bin/brs-cli')
const strip = (t) => t.split('\n').filter((l) => !l.startsWith('#')).join('\n')
const NET = strip(fs.readFileSync(path.resolve(__dirname, '../../lib/instrument/runtime/source/bt/BT_net.brs'), 'utf8'))
// The line format, as documented in BT_net.brs.
const CRUMB = /^\[bt:net\] url=(\S*)$/

let tmp
beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-crumb-')) })
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

function run(name, instrument, calls) {
  const main = calls.map((c, i) => `    print "R${i}:" + BT_url(${c})`).join('\n')
  const file = path.join(tmp, name + '.brs')
  fs.writeFileSync(file, `${strip(renderBtConfig('0'.repeat(32), instrument))}\n${NET}\nsub main()\n${main}\nend sub\n`)
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [brsCli, file], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), 30000)
    child.stdout.on('data', (d) => { out += d }); child.stderr.on('data', (d) => { out += d })
    child.on('close', () => { clearTimeout(timer); resolve(out.split(/\r?\n/)) })
  })
}

describe('observe-only breadcrumbs (headless)', () => {
  it('prints one line per http(s) call, strips query and fragment, and returns the URL unchanged', async () => {
    const lines = await run('on', { net: { observe: true } }, ['"https://api.example.test/v1/home?token=SECRET#frag"', '"http://api.example.test/v1/plain"', '"pkg:/images/a.png"'])
    const crumbs = lines.filter((l) => l.startsWith('[bt:net]'))
    expect(crumbs).toEqual(['[bt:net] url=https://api.example.test/v1/home?', '[bt:net] url=http://api.example.test/v1/plain'])
    for (const c of crumbs) expect(c).toMatch(CRUMB)
    expect(lines).toContain('R0:https://api.example.test/v1/home?token=SECRET#frag')
    expect(lines).toContain('R1:http://api.example.test/v1/plain')
    expect(lines).toContain('R2:pkg:/images/a.png')
    expect(crumbs.join('')).not.toContain('SECRET')
  }, 40000)

  it('drops userinfo from the authority and keeps path segments as they are', async () => {
    const lines = await run('userinfo', { net: { observe: true } }, ['"https://bob:hunter2@api.example.test/v1/a@b?x=1"', '"http://tok@api.example.test?k=v"', '"https://api.example.test:8443/p"'])
    const crumbs = lines.filter((l) => l.startsWith('[bt:net]'))
    expect(crumbs).toEqual(['[bt:net] url=https://api.example.test/v1/a@b?', '[bt:net] url=http://api.example.test?', '[bt:net] url=https://api.example.test:8443/p'])
    expect(crumbs.join('')).not.toMatch(/bob|hunter2|tok@/)
  }, 40000)

  it('prints nothing when observe is not configured', async () => {
    const lines = await run('off', {}, ['"https://api.example.test/v1/home"'])
    expect(lines.some((l) => l.startsWith('[bt:net]'))).toBe(false)
    expect(lines).toContain('R0:https://api.example.test/v1/home')
  }, 40000)
})
