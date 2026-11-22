import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { diff, main } = require('../scripts/device-diff.js')
const { deviceLabel } = require('../lib/reporter.js')

const A = { host: '127.0.0.1', serial: 'S-A', model: 'Ultra', softwareVersion: '16.0.4', build: '853', ecpSettingMode: 'permissive', checks: [{ id: 'ecp-mode', ok: true }] }
const B = { ...A, host: '127.0.0.2', serial: 'S-B', softwareVersion: '15.3.4', build: '4170' }

function run(a, b) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devdiff-'))
  const pa = path.join(dir, 'a.json'), pb = path.join(dir, 'b.json')
  fs.writeFileSync(pa, JSON.stringify(a)); fs.writeFileSync(pb, JSON.stringify(b))
  let out = ''
  const w = process.stdout.write
  process.stdout.write = (s) => { out += s; return true }
  let code
  try { code = main([pa, pb]) } finally { process.stdout.write = w; fs.rmSync(dir, { recursive: true, force: true }) }
  return { code, out }
}

describe('device-diff', () => {
  it('lists softwareVersion and build only; host and serial are ignored', () => {
    expect(diff(A, B).map((r) => r.key)).toEqual(['build', 'softwareVersion'])
    const r = run(A, B)
    expect(r.code).toBe(1)
    expect(r.out).not.toContain('S-A')
    expect(r.out).toContain('softwareVersion: "16.0.4" -> "15.3.4"')
  })
  it('identical inputs: exit 0, no rows', () => {
    expect(run(A, { ...A, host: 'other' })).toEqual({ code: 0, out: '' })
  })
  it('reports absent keys and nested array differences', () => {
    const r = diff({ x: [1, 2] }, { x: [1, 3], y: 1 })
    expect(r.map((q) => q.key)).toEqual(['x[1]', 'y'])
  })
  it('usage error exits 2', () => { expect(main([])).toBe(2) })
})

describe('deviceLabel', () => {
  it('names model and firmware, never the serial', () => {
    expect(deviceLabel({ host: '1.2.3.4', model: 'Ultra', softwareVersion: '16.0.4', build: '853', serial: 'S' })).toBe('1.2.3.4 · Ultra · firmware 16.0.4 (build 853)')
    expect(deviceLabel({})).toBe('')
  })
})
