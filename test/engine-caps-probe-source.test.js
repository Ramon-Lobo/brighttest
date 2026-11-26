import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { PROBE_DIR } = require('../lib/engine-caps.js')

const src = fs.readFileSync(path.join(PROBE_DIR, 'source', 'main.brs'), 'utf8')
const mainBody = src.match(/^sub Main\(\)([\s\S]*?)^end sub/m)[1]
const code = (s) => s.split('\n').filter((l) => !/^\s*'/.test(l)).join('\n')

describe('engine-caps probe is host-only (a real Roku crashes on scene-less node creation)', () => {
  it('manifest carries the host-only marker', () => {
    const manifest = fs.readFileSync(path.join(PROBE_DIR, 'manifest'), 'utf8')
    expect(manifest).toMatch(/^brighttest_host_only=1$/m)
  })
  it('source header says HOST-ONLY', () => {
    expect(src).toMatch(/^' HOST-ONLY:/m)
  })
  it('Main refuses with a clear message before it creates any scene-graph node', () => {
    const body = code(mainBody)
    const guard = body.search(/CAP_IsHostEngine\(\)/)
    const firstNode = body.search(/CreateObject\("roSGNode"/)
    expect(guard).toBeGreaterThanOrEqual(0)
    expect(firstNode).toBeGreaterThan(guard)
    expect(body.slice(guard, firstNode)).toMatch(/host-only[\s\S]*return/)
  })
})
